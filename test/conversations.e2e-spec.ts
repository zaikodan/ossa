import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';

const SECRET = process.env.JWT_ACCESS_SECRET as string;
const auth = (sub: string): string => `Bearer ${jwt.sign({ sub }, SECRET, { expiresIn: '15m' })}`;

/**
 * E2E do fluxo REST (conversas/mensagens/reações/reply) contra Postgres+Redis.
 * Requer os serviços de pé (docker compose up) e o schema migrado.
 */
describe('Conversations (e2e)', () => {
  let app: INestApplication;
  const A = `e2e_a_${Date.now()}`;
  const B = `e2e_b_${Date.now()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejeita sem token (401)', () => {
    return request(app.getHttpServer()).get('/conversations').expect(401);
  });

  it('cria conversa, envia, reage e responde', async () => {
    const server = app.getHttpServer();

    const conv = (
      await request(server).post('/conversations').set('Authorization', auth(A)).send({ peerId: B }).expect(201)
    ).body;
    expect(conv.peerId).toBe(B);
    expect(conv.unread).toBe(0);

    const m1 = (
      await request(server)
        .post(`/conversations/${conv.id}/messages`)
        .set('Authorization', auth(A))
        .send({ text: 'olá e2e' })
        .expect(201)
    ).body;
    expect(m1.fromMe).toBe(true);
    expect(m1.text).toBe('olá e2e');

    // B reage
    const react = (
      await request(server)
        .post(`/conversations/${conv.id}/messages/${m1.id}/reactions`)
        .set('Authorization', auth(B))
        .send({ emoji: '❤️' })
        .expect(201)
    ).body;
    expect(react.reactions).toContainEqual({ emoji: '❤️', count: 1, mine: true });

    // B responde citando m1
    const m2 = (
      await request(server)
        .post(`/conversations/${conv.id}/messages`)
        .set('Authorization', auth(B))
        .send({ text: 'respondendo', replyToId: m1.id })
        .expect(201)
    ).body;
    expect(m2.replyTo.id).toBe(m1.id);
    // Ossa é identity-agnostic: expõe senderId (o `fromMe` é derivado no BFF).
    expect(m2.replyTo.senderId).toBe(A);

    // A lista e vê a conversa + reação na msg
    const msgs = (
      await request(server)
        .get(`/conversations/${conv.id}/messages`)
        .set('Authorization', auth(A))
        .expect(200)
    ).body;
    const seenM1 = msgs.items.find((m: { id: string }) => m.id === m1.id);
    expect(seenM1.reactions).toContainEqual({ emoji: '❤️', count: 1, mine: false });

    // não-participante não acessa
    await request(server)
      .get(`/conversations/${conv.id}/messages`)
      .set('Authorization', auth('e2e_intruder'))
      .expect(404);
  });
});
