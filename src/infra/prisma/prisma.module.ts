import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Prisma global — qualquer módulo injeta PrismaService sem reimportar. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
