import { Module } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

/** Conversas 1:1 + mensagens (REST). Realtime entra via RealtimeModule (M2). */
@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService, JwtGuard],
})
export class ConversationsModule {}
