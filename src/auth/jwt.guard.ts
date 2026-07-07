import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';
import { verifyUserId } from './token';

/** Request com o userId resolvido do JWT da plataforma. */
export type AuthedRequest = Request & { userId?: string };

/**
 * Autentica requisições REST pelo `Authorization: Bearer <jwt>` emitido pela
 * PLATAFORMA (Ossa não tem login próprio). Anexa `req.userId` = `sub` do token.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token ? verifyUserId(token, this.env.JWT_ACCESS_SECRET) : null;
    if (!userId) throw new UnauthorizedException('Token inválido ou ausente.');
    req.userId = userId;
    return true;
  }
}
