import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './jwt.guard';

/** Injeta o userId autenticado (resolvido pelo JwtGuard) no handler. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.userId as string;
  },
);
