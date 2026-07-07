import jwt from 'jsonwebtoken';

/**
 * Ossa não tem login próprio: confia no access token JWT emitido pela
 * PLATAFORMA (segredo compartilhado). Valida a assinatura e extrai o `sub`
 * (userId). Retorna null se inválido/expirado.
 */
export function verifyUserId(token: string, secret: string): string | null {
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload === 'object' && payload && typeof payload.sub === 'string') {
      return payload.sub;
    }
    return null;
  } catch {
    return null;
  }
}
