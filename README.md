# Ossa

**Realtime 1:1 messaging engine** — native WebSocket + Redis, built with NestJS.
A self-contained chat backend with **presence**, **typing indicators** and
**delivery/read receipts** (WhatsApp-style `sent → delivered → read`).

> Status: **early WIP.** The realtime foundation (authenticated WebSocket server,
> connection registry, heartbeat, presence, per-user push) is in place. Message
> protocol, receipts and Redis fan-out are being built on top. See the roadmap.

## Why "engine"?

Ossa is designed as a **standalone service** consumed over a small contract, so
any product can drop it in as its messaging backend without coupling. It has **no
user table of its own**: it trusts a JWT issued by the host platform (shared
secret) and uses the token's `sub` as the user id.

## Architecture

- **NestJS** (HTTP + DI) with a **native `ws`** WebSocket server attached to the
  same HTTP server — no `socket.io`, clients use the standard `WebSocket` API.
- **PostgreSQL** (Prisma) for conversations/messages; **Redis** for presence and
  cross-instance pub/sub (horizontal scale).
- Realtime primitives live in [`src/realtime/realtime.gateway.ts`](src/realtime/realtime.gateway.ts):
  auth on connect, `userId → sockets` registry (multi-device), ping/pong
  heartbeat, `pushToUser`, `isOnline`.

```
WebSocket client ──(JWT ?token=)──► /ws ──► RealtimeGateway ──► registry + heartbeat
                                                     │
REST (contract) ──► Nest controllers ──► Prisma ◄────┘ (push on new message)
                                          Redis  ◄──── presence + fan-out
```

## Quickstart

```bash
cp .env.example .env          # ajuste os valores (segredo do JWT etc.)
docker compose up -d          # Postgres (5433) + Redis (6379)
pnpm install
pnpm prisma:migrate           # cria o schema
pnpm start:dev                # http://localhost:4000  (health em /health, ws em /ws)
```

Connect a client (native WebSocket):

```js
const ws = new WebSocket("ws://localhost:4000/ws?token=<platform-jwt>");
ws.onmessage = (e) => console.log(JSON.parse(e.data)); // { type: "ready", userId }
```

## Data model

`Conversation` · `Participant` (per-side `lastReadAt`/`lastDeliveredAt`) ·
`Message` (`SENT | DELIVERED | READ`). N participants (1:1 today, group-ready).
See [`prisma/schema.prisma`](prisma/schema.prisma).

## Roadmap

- [x] Scaffold: NestJS + Prisma + Redis + docker-compose + CI
- [x] Authenticated WebSocket server (JWT), registry, heartbeat, presence, push
- [ ] REST parity with the messaging contract (list/get/messages/send/start)
- [ ] Realtime protocol: `message:send/new`, `typing`, `read` + receipts
- [ ] Redis pub/sub fan-out (multi-instance) + distributed presence
- [ ] Media messages (gated/signed URLs), push notifications, reactions, reply
- [ ] Tests + coverage

## License

[MIT](LICENSE).
