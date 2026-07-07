import 'reflect-metadata';
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { RealtimeGateway } from './realtime/realtime.gateway';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();

  // WebSocket nativo anexado ao mesmo HTTP server do Nest.
  app.get(RealtimeGateway).attach(app.getHttpServer());

  await app.listen(env.PORT);
  new Logger('Ossa').log(
    `Ossa realtime messaging on http://localhost:${env.PORT} (ws em /ws)`,
  );
}

void bootstrap();
