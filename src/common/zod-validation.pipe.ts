import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Valida o corpo/params contra um schema Zod; 400 com mensagem clara se falhar. */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((i) => i.message).join('; '),
      );
    }
    return result.data;
  }
}
