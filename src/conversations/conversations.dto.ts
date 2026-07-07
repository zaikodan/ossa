/**
 * DTOs do Ossa — identity-agnostic: o motor lida com `userId`/`peerId` (strings
 * do domínio da plataforma), sem perfis. Enriquecer peerId -> Author é papel do
 * adapter na plataforma consumidora.
 */

export type MessageStatusDto = 'sent' | 'delivered' | 'read';

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
  status: MessageStatusDto;
  /** ISO-8601. */
  createdAt: string;
}
