import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MessageStatus,
  Prisma,
  type Message,
  type Participant,
} from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type {
  ConversationDto,
  MessageDto,
  MessageStatusDto,
  SendMessageInput,
} from './conversations.dto';

const EPOCH = new Date(0);

const convInclude = {
  participants: true,
  messages: { orderBy: { createdAt: 'desc' }, take: 1 },
} satisfies Prisma.ConversationInclude;

type ConvRow = Prisma.ConversationGetPayload<{
  include: { participants: true; messages: true };
}>;

/**
 * Conversas 1:1 + mensagens. Persistência (Prisma) + emissão em tempo real
 * (RealtimeGateway): entrega ao destinatário, recibos DELIVERED/READ ao vivo,
 * e entrega das pendentes quando o usuário reconecta.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
  ) {}

  async getOrCreate(userId: string, peerId: string): Promise<ConversationDto> {
    if (userId === peerId) {
      throw new BadRequestException('Não é possível conversar consigo mesmo.');
    }
    let conv = await this.prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: peerId } } },
        ],
      },
      include: convInclude,
    });
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: { participants: { create: [{ userId }, { userId: peerId }] } },
        include: convInclude,
      });
    }
    return this.toConversationDto(conv, userId);
  }

  async list(userId: string): Promise<{ items: ConversationDto[] }> {
    const rows = await this.prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      include: convInclude,
      orderBy: { lastMessageAt: 'desc' },
    });
    const items = await Promise.all(rows.map((r) => this.toConversationDto(r, userId)));
    return { items };
  }

  async get(userId: string, id: string): Promise<ConversationDto | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: convInclude,
    });
    if (!conv || !this.isParticipant(conv.participants, userId)) return null;
    return this.toConversationDto(conv, userId);
  }

  async getMessages(userId: string, id: string): Promise<{ items: MessageDto[] }> {
    const conv = await this.requireParticipant(userId, id);
    const peerLastReadAt = this.peer(conv.participants, userId)?.lastReadAt ?? EPOCH;
    const messages = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });
    // Abrir a conversa = marcar como lida (atualiza ponteiro + avisa o peer).
    await this.markRead(userId, id);
    return { items: messages.map((m) => this.toMessageDto(m, userId, peerLastReadAt)) };
  }

  /** Envia uma mensagem (texto e/ou mídia). Persiste, entrega e devolve o recibo. */
  async send(userId: string, id: string, input: SendMessageInput): Promise<MessageDto> {
    const text = input.text?.trim() ?? '';
    const mediaKey = input.mediaKey ?? null;
    if (!text && !mediaKey) {
      throw new BadRequestException('Mensagem vazia: informe texto ou mídia.');
    }
    const conv = await this.requireParticipant(userId, id, ForbiddenException);
    const peer = this.peer(conv.participants, userId);
    const peerId = peer?.userId;
    const peerLastReadAt = peer?.lastReadAt ?? EPOCH;
    const now = new Date();
    const delivered = !!peerId && (await this.gateway.isOnline(peerId));
    const status = delivered ? MessageStatus.DELIVERED : MessageStatus.SENT;

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId: id,
          senderId: userId,
          text,
          mediaKey,
          mediaKind: mediaKey ? (input.mediaKind ?? null) : null,
          status,
        },
      }),
      this.prisma.conversation.update({ where: { id }, data: { lastMessageAt: now } }),
      this.prisma.participant.updateMany({
        where: { conversationId: id, userId },
        data: { lastReadAt: now },
      }),
      ...(delivered && peerId
        ? [
            this.prisma.participant.updateMany({
              where: { conversationId: id, userId: peerId },
              data: { lastDeliveredAt: now },
            }),
          ]
        : []),
    ]);

    // Tempo real: entrega ao peer + eco pros outros aparelhos do remetente.
    const event = this.toMessageEvent(message);
    if (peerId) this.gateway.pushToUser(peerId, { type: 'message:new', message: event });
    this.gateway.pushToUser(userId, { type: 'message:new', message: event });
    if (delivered) {
      this.gateway.pushToUser(userId, {
        type: 'message:delivered',
        conversationId: id,
        messageId: message.id,
      });
    }
    return this.toMessageDto(message, userId, peerLastReadAt);
  }

  /** Marca as mensagens do peer como lidas e avisa o peer (recibo azul). */
  async markRead(userId: string, id: string): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (!conv || !this.isParticipant(conv.participants, userId)) return;
    const peerId = this.peer(conv.participants, userId)?.userId;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.participant.updateMany({
        where: { conversationId: id, userId },
        data: { lastReadAt: now },
      }),
      this.prisma.message.updateMany({
        where: {
          conversationId: id,
          senderId: peerId ?? '',
          status: { not: MessageStatus.READ },
        },
        data: { status: MessageStatus.READ },
      }),
    ]);
    if (peerId) {
      this.gateway.pushToUser(peerId, {
        type: 'message:read',
        conversationId: id,
        readerId: userId,
        readAt: now.toISOString(),
      });
    }
  }

  /** Relay efêmero de "digitando…" para o peer (sem persistir). */
  async relayTyping(userId: string, id: string, typing: boolean): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (!conv || !this.isParticipant(conv.participants, userId)) return;
    const peerId = this.peer(conv.participants, userId)?.userId;
    if (peerId) {
      this.gateway.pushToUser(peerId, { type: 'typing', conversationId: id, userId, typing });
    }
  }

  /** Quando o usuário fica online: entrega as mensagens pendentes e avisa remetentes. */
  async deliverPending(userId: string): Promise<void> {
    const convs = await this.prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      select: { id: true },
    });
    const convIds = convs.map((c) => c.id);
    if (convIds.length === 0) return;
    const pending = await this.prisma.message.findMany({
      where: {
        conversationId: { in: convIds },
        senderId: { not: userId },
        status: MessageStatus.SENT,
      },
    });
    if (pending.length === 0) return;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.message.updateMany({
        where: { id: { in: pending.map((m) => m.id) } },
        data: { status: MessageStatus.DELIVERED },
      }),
      this.prisma.participant.updateMany({
        where: { conversationId: { in: convIds }, userId },
        data: { lastDeliveredAt: now },
      }),
    ]);
    for (const m of pending) {
      this.gateway.pushToUser(m.senderId, {
        type: 'message:delivered',
        conversationId: m.conversationId,
        messageId: m.id,
      });
    }
  }

  /** Propaga presença (online/offline) para os peers em conversas com o usuário. */
  async broadcastPresence(userId: string, online: boolean): Promise<void> {
    const convs = await this.prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      include: { participants: true },
    });
    const peers = new Set<string>();
    for (const c of convs) {
      for (const p of c.participants) if (p.userId !== userId) peers.add(p.userId);
    }
    // Publica pra cada peer; o canal só entrega a quem estiver conectado.
    for (const peerId of peers) {
      this.gateway.pushToUser(peerId, { type: 'presence', userId, online });
    }
  }

  // --- helpers -------------------------------------------------------------

  private async requireParticipant(
    userId: string,
    id: string,
    Exception: typeof NotFoundException | typeof ForbiddenException = NotFoundException,
  ): Promise<Prisma.ConversationGetPayload<{ include: { participants: true } }>> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (!conv || !this.isParticipant(conv.participants, userId)) {
      throw new Exception(
        Exception === ForbiddenException
          ? 'Você não participa desta conversa.'
          : 'Conversa não encontrada.',
      );
    }
    return conv;
  }

  private isParticipant(participants: Participant[], userId: string): boolean {
    return participants.some((p) => p.userId === userId);
  }

  private peer(participants: Participant[], userId: string): Participant | undefined {
    return participants.find((p) => p.userId !== userId);
  }

  private async toConversationDto(conv: ConvRow, userId: string): Promise<ConversationDto> {
    const peerId = this.peer(conv.participants, userId)?.userId ?? userId;
    const myLastReadAt =
      conv.participants.find((p) => p.userId === userId)?.lastReadAt ?? EPOCH;
    const unread = await this.prisma.message.count({
      where: { conversationId: conv.id, senderId: peerId, createdAt: { gt: myLastReadAt } },
    });
    return {
      id: conv.id,
      peerId,
      lastMessage: conv.messages[0]?.text ?? '',
      lastMessageAt: conv.lastMessageAt.toISOString(),
      unread,
    };
  }

  private toMessageDto(m: Message, userId: string, peerLastReadAt: Date): MessageDto {
    const fromMe = m.senderId === userId;
    const status: MessageStatusDto =
      fromMe && peerLastReadAt >= m.createdAt
        ? 'read'
        : (m.status.toLowerCase() as MessageStatusDto);
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      fromMe,
      text: m.text,
      mediaKey: m.mediaKey,
      mediaKind: m.mediaKind,
      status,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** Payload de mensagem para o WebSocket (o cliente deriva `fromMe` pelo senderId). */
  private toMessageEvent(m: Message): {
    id: string;
    conversationId: string;
    senderId: string;
    text: string;
    mediaKey: string | null;
    mediaKind: string | null;
    status: MessageStatusDto;
    createdAt: string;
  } {
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      text: m.text,
      mediaKey: m.mediaKey,
      mediaKind: m.mediaKind,
      status: m.status.toLowerCase() as MessageStatusDto,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
