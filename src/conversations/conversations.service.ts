import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import {
  MessageStatus,
  Prisma,
  type Message,
  type MessageReaction,
  type Participant,
} from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { aggregateReactions } from './reactions.util';
import type {
  ConversationDto,
  MessageDto,
  MessageStatusDto,
  ReactionDto,
  ReplyPreviewDto,
  SendMessageInput,
} from './conversations.dto';

const replyPreviewSelect = {
  id: true,
  senderId: true,
  text: true,
  mediaKind: true,
} satisfies Prisma.MessageSelect;

type MessageWithReactions = Message & {
  reactions?: MessageReaction[];
  replyTo?: ReplyPreviewDto | null;
};

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
  private readonly log = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Avisa a plataforma (webhook) que há mensagem p/ um destinatário OFFLINE,
   * para ela enviar push. Fire-and-forget — nunca bloqueia/derruba o envio.
   */
  private notifyOfflineRecipient(payload: {
    recipientId: string;
    conversationId: string;
    senderId: string;
    hasText: boolean;
    hasMedia: boolean;
  }): void {
    const url = this.env.PUSH_WEBHOOK_URL;
    if (!url) return;
    void fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.env.PUSH_WEBHOOK_SECRET
          ? { 'x-ossa-secret': this.env.PUSH_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify(payload),
    }).catch((e) => this.log.warn(`push webhook falhou: ${(e as Error).message}`));
  }

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
      include: { reactions: true, replyTo: { select: replyPreviewSelect } },
    });
    // NÃO marca leitura aqui: isso é feito pela ação explícita `read` (WS). Marcar
    // no GET emitia `message:read`, e como o cliente refaz a busca ao receber esse
    // evento, os dois lados entravam num laço infinito de leitura/refetch.
    return { items: messages.map((m) => this.toMessageDto(m, userId, peerLastReadAt)) };
  }

  /** Normaliza o array de álbum vindo do input (ou do JSON persistido). */
  private parseMediaItems(raw: unknown): { key: string; kind: string }[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => x as { key?: unknown; kind?: unknown; mediaKey?: unknown; mediaKind?: unknown })
      .map((x) => ({
        key: typeof x.key === 'string' ? x.key : typeof x.mediaKey === 'string' ? x.mediaKey : '',
        kind:
          typeof x.kind === 'string' ? x.kind : typeof x.mediaKind === 'string' ? x.mediaKind : 'photo',
      }))
      .filter((x) => x.key);
  }

  /** Envia uma mensagem (texto e/ou mídia). Persiste, entrega e devolve o recibo. */
  async send(userId: string, id: string, input: SendMessageInput): Promise<MessageDto> {
    const text = input.text?.trim() ?? '';
    const mediaKey = input.mediaKey ?? null;
    const album = this.parseMediaItems(input.mediaItems);
    if (!text && !mediaKey && album.length === 0) {
      throw new BadRequestException('Mensagem vazia: informe texto ou mídia.');
    }
    const conv = await this.requireParticipant(userId, id, ForbiddenException);

    // Reply: só aceita citar mensagem da MESMA conversa.
    let replyToId: string | null = null;
    if (input.replyToId) {
      const replied = await this.prisma.message.findUnique({
        where: { id: input.replyToId },
        select: { conversationId: true },
      });
      if (replied?.conversationId === id) replyToId = input.replyToId;
    }
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
          mediaItems: album.length ? album : undefined,
          replyToId,
          status,
        },
        include: { replyTo: { select: replyPreviewSelect } },
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
    } else if (peerId) {
      // Destinatário offline → avisa a plataforma p/ enviar push.
      this.notifyOfflineRecipient({
        recipientId: peerId,
        conversationId: id,
        senderId: userId,
        hasText: !!text,
        hasMedia: !!mediaKey,
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

  private aggregateReactions(
    reactions: MessageReaction[] | undefined,
    userId: string,
  ): ReactionDto[] {
    return aggregateReactions(reactions, userId);
  }

  private toMessageDto(
    m: MessageWithReactions,
    userId: string,
    peerLastReadAt: Date,
  ): MessageDto {
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
      mediaItems: this.parseMediaItems(m.mediaItems),
      reactions: this.aggregateReactions(m.reactions, userId),
      replyTo: m.replyTo ?? null,
      status,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** Alterna (adiciona/remove) uma reação de emoji numa mensagem. */
  async toggleReaction(
    userId: string,
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ messageId: string; reactions: ReactionDto[] }> {
    const conv = await this.requireParticipant(userId, conversationId);
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.conversationId !== conversationId) {
      throw new NotFoundException('Mensagem não encontrada.');
    }
    const existing = await this.prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
    let added: boolean;
    if (existing) {
      await this.prisma.messageReaction.delete({ where: { id: existing.id } });
      added = false;
    } else {
      await this.prisma.messageReaction.create({ data: { messageId, userId, emoji } });
      added = true;
    }
    const reactions = await this.prisma.messageReaction.findMany({ where: { messageId } });
    // Notifica os dois lados (cada um recebe a agregação do SEU ponto de vista).
    for (const p of conv.participants) {
      this.gateway.pushToUser(p.userId, {
        type: 'reaction',
        conversationId,
        messageId,
        emoji,
        userId,
        added,
        reactions: this.aggregateReactions(reactions, p.userId),
      });
    }
    return { messageId, reactions: this.aggregateReactions(reactions, userId) };
  }

  /** Payload de mensagem para o WebSocket (o cliente deriva `fromMe` pelo senderId). */
  private toMessageEvent(m: Message): {
    id: string;
    conversationId: string;
    senderId: string;
    text: string;
    mediaKey: string | null;
    mediaKind: string | null;
    mediaItems: { key: string; kind: string }[];
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
      mediaItems: this.parseMediaItems(m.mediaItems),
      status: m.status.toLowerCase() as MessageStatusDto,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
