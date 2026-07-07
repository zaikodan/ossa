import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv, type Env } from './env';

/** Config global: valida o ambiente uma vez e disponibiliza via DI (@Inject(ENV)). */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
