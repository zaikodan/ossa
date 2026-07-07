import { Module } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { RealtimeMessagingService } from './realtime-messaging.service';

/**
 * Conversas 1:1 + mensagens. REST (controller) + protocolo realtime
 * (RealtimeMessagingService liga o RealtimeGateway ao domínio).
 */
@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService, RealtimeMessagingService, JwtGuard],
})
export class ConversationsModule {}
