import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../../config/env';

/**
 * Dois clientes Redis: `pub` (comandos normais + publish) e `sub` (dedicado a
 * subscribe — em modo assinante um cliente não roda outros comandos). Base do
 * fan-out entre instâncias e da presença distribuída.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  readonly pub: Redis;
  readonly sub: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.pub = new Redis(env.REDIS_URL);
    this.sub = new Redis(env.REDIS_URL);
    for (const [name, client] of [['pub', this.pub], ['sub', this.sub]] as const) {
      client.on('error', (e: Error) => this.log.warn(`redis ${name}: ${e.message}`));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
