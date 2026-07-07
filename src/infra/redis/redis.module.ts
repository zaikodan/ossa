import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/** Redis global — usado pelo fan-out realtime e pela presença distribuída. */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
