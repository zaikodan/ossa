import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/** Tempo real (WebSocket nativo). Global: outros módulos empurram eventos. */
@Global()
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
