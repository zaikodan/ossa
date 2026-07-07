import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Message, type Participant } from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';
import type {
  ConversationDto,
  MessageDto,
  MessageStatusDto,
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
 * Conversas 1:1 e mensagens (persistência). Recibos derivados dos ponteiros
 * de leitura por participante. O tempo real (push/entregue) entra no Milestone 2.
 */
@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Abre (ou reusa) a conversa 1:1 entre o usuário e um peer. */
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
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (!conv || !this.isParticipant(conv.participants, userId)) {
      throw new NotFoundException('Conversa não encontrada.');
    }
    const peerLastReadAt = this.peer(conv.participants, userId)?.lastReadAt ?? EPOCH;
    const messages = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });
    // Marca as mensagens como lidas do meu lado.
    await this.prisma.participant.updateMany({
      where: { conversationId: id, userId },
      data: { lastReadAt: new Date() },
    });
    return { items: messages.map((m) => this.toMessageDto(m, userId, peerLastReadAt)) };
  }

  async send(userId: string, id: string, text: string): Promise<MessageDto> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (!conv || !this.isParticipant(conv.participants, userId)) {
      throw new ForbiddenException('Você não participa desta conversa.');
    }
    const peerLastReadAt = this.peer(conv.participants, userId)?.lastReadAt ?? EPOCH;
    const now = new Date();
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({ data: { conversationId: id, senderId: userId, text } }),
      this.prisma.conversation.update({ where: { id }, data: { lastMessageAt: now } }),
      this.prisma.participant.updateMany({
        where: { conversationId: id, userId },
        data: { lastReadAt: now },
      }),
    ]);
    return this.toMessageDto(message, userId, peerLastReadAt);
  }

  // --- helpers -------------------------------------------------------------

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
    // Recibo só faz sentido nas minhas mensagens (o peer já leu?).
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
      status,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
