import jwt from 'jsonwebtoken';
import { verifyUserId } from './token';

const SECRET = 'test-secret-at-least-16-chars-long';

describe('verifyUserId', () => {
  it('extrai o sub de um token válido', () => {
    const token = jwt.sign({ sub: 'user_123' }, SECRET);
    expect(verifyUserId(token, SECRET)).toBe('user_123');
  });

  it('rejeita assinatura errada', () => {
    const token = jwt.sign({ sub: 'user_123' }, 'outro-segredo-1234567');
    expect(verifyUserId(token, SECRET)).toBeNull();
  });

  it('rejeita token expirado', () => {
    const token = jwt.sign({ sub: 'user_123' }, SECRET, { expiresIn: -10 });
    expect(verifyUserId(token, SECRET)).toBeNull();
  });

  it('rejeita token sem sub', () => {
    const token = jwt.sign({ foo: 'bar' }, SECRET);
    expect(verifyUserId(token, SECRET)).toBeNull();
  });

  it('rejeita lixo', () => {
    expect(verifyUserId('nao-e-um-jwt', SECRET)).toBeNull();
  });
});
