import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { ConversationsService } from './conversations.service';
import type { ConversationDto, MessageDto } from './conversations.dto';

const StartInput = z.object({ peerId: z.string().min(1).max(200) });
type StartInput = z.infer<typeof StartInput>;

const SendInput = z
  .object({
    text: z.string().trim().max(4000).optional(),
    mediaKey: z.string().max(200).optional(),
    mediaKind: z.enum(['photo', 'video']).optional(),
  })
  .refine((v) => !!v.text || !!v.mediaKey, {
    message: 'Informe texto ou mídia.',
  });
type SendInput = z.infer<typeof SendInput>;

const ReactInput = z.object({ emoji: z.string().min(1).max(16) });
type ReactInput = z.infer<typeof ReactInput>;

/**
 * REST das conversas. Tudo autenticado pelo JWT da plataforma; cada rota
 * confere participação. Paridade com o contrato consumido pela plataforma
 * (identity-agnostic: usa peerId).
 */
@Controller('conversations')
@UseGuards(JwtGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentUserId() userId: string): Promise<{ items: ConversationDto[] }> {
    return this.conversations.list(userId);
  }

  /** Abre (ou reusa) a conversa com um peer. */
  @Post()
  start(
    @Body(new ZodValidationPipe(StartInput)) body: StartInput,
    @CurrentUserId() userId: string,
  ): Promise<ConversationDto> {
    return this.conversations.getOrCreate(userId, body.peerId);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
    @Res() res: Response,
  ): Promise<void> {
    // res.json garante o literal `null` no corpo p/ conversa inexistente/alheia.
    res.json(await this.conversations.get(userId, id));
  }

  @Get(':id/messages')
  messages(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
  ): Promise<{ items: MessageDto[] }> {
    return this.conversations.getMessages(userId, id);
  }

  @Post(':id/messages')
  send(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SendInput)) body: SendInput,
    @CurrentUserId() userId: string,
  ): Promise<MessageDto> {
    return this.conversations.send(userId, id, body);
  }

  /** Alterna uma reação (emoji) numa mensagem. */
  @Post(':id/messages/:messageId/reactions')
  react(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(ReactInput)) body: ReactInput,
    @CurrentUserId() userId: string,
  ) {
    return this.conversations.toggleReaction(userId, id, messageId, body.emoji);
  }
}
