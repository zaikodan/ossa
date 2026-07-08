/**
 * DTOs do Ossa — identity-agnostic: o motor lida com `userId`/`peerId` (strings
 * do domínio da plataforma), sem perfis. Enriquecer peerId -> Author é papel do
 * adapter na plataforma consumidora.
 */

export type MessageStatusDto = 'sent' | 'delivered' | 'read';

/** Reações agregadas por emoji (do ponto de vista do viewer). */
export interface ReactionDto {
  emoji: string;
  count: number;
  mine: boolean;
}

/** Preview da mensagem citada (reply/quote). */
export interface ReplyPreviewDto {
  id: string;
  senderId: string;
  text: string;
  mediaKind: string | null;
}

export interface ConversationDto {
  id: string;
  /** userId do outro participante (1:1). */
  peerId: string;
  lastMessage: string;
  /** ISO-8601. */
  lastMessageAt: string;
  unread: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  fromMe: boolean;
  text: string;
  /** Chave da mídia no storage da plataforma (Ossa não serve arquivos). */
  mediaKey: string | null;
  mediaKind: string | null;
  reactions: ReactionDto[];
  replyTo: ReplyPreviewDto | null;
  status: MessageStatusDto;
  /** ISO-8601. */
  createdAt: string;
}

/** Entrada de envio: texto e/ou mídia (pelo menos um). */
export interface SendMessageInput {
  text?: string;
  mediaKey?: string;
  mediaKind?: string;
  replyToId?: string;
}
