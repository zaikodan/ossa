import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { ConversationsModule } from './conversations/conversations.module';

/**
 * Raiz do Ossa. Domínios entram como módulos:
 * - ConfigModule / PrismaModule / RealtimeModule (infra)
 * - HealthModule (liveness)
 * - ConversationsModule: REST das conversas (realtime em cima, M2).
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RealtimeModule,
    HealthModule,
    ConversationsModule,
  ],
})
export class AppModule {}
