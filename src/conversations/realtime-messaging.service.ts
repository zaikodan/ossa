import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  RealtimeGateway,
  type ClientEvent,
} from '../realtime/realtime.gateway';
import { ConversationsService } from './conversations.service';

/**
 * Cola entre o transporte (RealtimeGateway) e o domínio (ConversationsService).
 * Registra os handlers no bootstrap: traduz eventos do cliente
 * (`message:send`, `typing`, `read`) em ações e reage a mudanças de presença.
 *
 * Padrão de callback (não injeção) para evitar dependência circular:
 * o gateway só conhece ENV; quem depende dele é este serviço.
 */
@Injectable()
export class RealtimeMessagingService implements OnModuleInit {
  private readonly log = new Logger(RealtimeMessagingService.name);

  constructor(
    private readonly conversations: ConversationsService,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.gateway.setClientEventHandler((userId, event) =>
      void this.handleClientEvent(userId, event),
    );
    this.gateway.setPresenceHandler((userId, online) =>
      void this.handlePresence(userId, online),
    );
  }

  private async handleClientEvent(userId: string, event: ClientEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'message:send':
          if (event.conversationId && event.text?.trim()) {
            await this.conversations.send(userId, event.conversationId, event.text.trim());
          }
          break;
        case 'read':
          if (event.conversationId) {
            await this.conversations.markRead(userId, event.conversationId);
          }
          break;
        case 'typing':
          if (event.conversationId) {
            await this.conversations.relayTyping(userId, event.conversationId, !!event.typing);
          }
          break;
        default:
          break;
      }
    } catch (err) {
      this.log.warn(`evento ${event.type} de ${userId} falhou: ${(err as Error).message}`);
    }
  }

  private async handlePresence(userId: string, online: boolean): Promise<void> {
    try {
      if (online) await this.conversations.deliverPending(userId);
      await this.conversations.broadcastPresence(userId, online);
    } catch (err) {
      this.log.warn(`presença de ${userId} falhou: ${(err as Error).message}`);
    }
  }
}
