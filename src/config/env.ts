import { z } from 'zod';

/**
 * Validação do ambiente na subida — falha cedo com mensagem clara se algo
 * estiver faltando, em vez de quebrar no meio de um request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  /**
   * Segredo compartilhado com a PLATAFORMA que emite os JWTs dos usuários.
   * O Ossa não tem login próprio: valida o access token da plataforma e extrai
   * o `sub` (userId). Ver README.
   */
  JWT_ACCESS_SECRET: z.string().min(16),
  /** Origem web permitida no CORS (o front consome via contrato). */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Presença distribuída: heartbeat da instância, TTL e intervalo do reaper. */
  PRESENCE_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
  PRESENCE_TTL_SEC: z.coerce.number().int().positive().default(30),
  PRESENCE_REAP_MS: z.coerce.number().int().positive().default(15_000),
});

export type Env = z.infer<typeof EnvSchema>;

export const ENV = 'ENV';

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
  }
  return parsed.data;
}
