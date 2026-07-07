import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ENV, type Env } from '../config/env';
import { verifyUserId } from '../auth/token';

const HEARTBEAT_MS = 30_000;

/** Socket com estado anexado (userId + vivo p/ heartbeat). */
interface UserSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

/** Evento vindo do cliente pelo WebSocket. */
export interface ClientEvent {
  type: string;
  conversationId?: string;
  text?: string;
  typing?: boolean;
}

export type ClientEventHandler = (userId: string, event: ClientEvent) => void;
export type PresenceHandler = (userId: string, online: boolean) => void;

/**
 * Servidor WebSocket nativo (`ws`). Núcleo do tempo real do Ossa:
 *  - autentica a conexão pelo JWT da plataforma (`?token=`);
 *  - mantém um registro userId -> sockets (multi-dispositivo);
 *  - heartbeat ping/pong (derruba conexões mortas);
 *  - `pushToUser` entrega payloads em tempo real; `isOnline` = presença.
 *
 * O protocolo de mensagens (message:send/new, typing, receipts) e o fan-out
 * via Redis entram em cima destas primitivas.
 */
@Injectable()
export class RealtimeGateway {
  private readonly log = new Logger(RealtimeGateway.name);
  private wss?: WebSocketServer;
  private readonly clients = new Map<string, Set<UserSocket>>();
  private clientEventHandler?: ClientEventHandler;
  private presenceHandler?: PresenceHandler;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Registra quem trata os eventos do cliente (message:send, typing, read). */
  setClientEventHandler(handler: ClientEventHandler): void {
    this.clientEventHandler = handler;
  }

  /** Registra quem trata mudanças de presença (online/offline). */
  setPresenceHandler(handler: PresenceHandler): void {
    this.presenceHandler = handler;
  }

  /** Anexa o WS ao mesmo HTTP server do Nest (chamado no bootstrap). */
  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket: UserSocket, req) => this.onConnection(socket, req));

    const heartbeat = setInterval(() => {
      this.wss?.clients.forEach((client) => {
        const s = client as UserSocket;
        if (s.isAlive === false) return s.terminate();
        s.isAlive = false;
        s.ping();
      });
    }, HEARTBEAT_MS);
    this.wss.on('close', () => clearInterval(heartbeat));
    this.log.log('WebSocket server anexado em /ws');
  }

  private onConnection(socket: UserSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    const userId = token ? verifyUserId(token, this.env.JWT_ACCESS_SECRET) : null;
    if (!userId) {
      socket.close(4401, 'unauthorized');
      return;
    }

    socket.userId = userId;
    socket.isAlive = true;
    socket.on('pong', () => (socket.isAlive = true));
    this.register(userId, socket);

    const first = this.count(userId) === 1;
    this.log.log(`conectado ${userId} (${this.count(userId)} sockets)`);
    if (first) this.onPresenceChange(userId, true);

    socket.on('message', (raw) => this.onMessage(socket, raw.toString()));
    socket.on('close', () => {
      this.unregister(userId, socket);
      this.log.log(`desconectado ${userId} (${this.count(userId)} sockets)`);
      if (this.count(userId) === 0) this.onPresenceChange(userId, false);
    });

    this.send(socket, { type: 'ready', userId });
  }

  private onMessage(socket: UserSocket, raw: string): void {
    let msg: ClientEvent;
    try {
      msg = JSON.parse(raw) as ClientEvent;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') {
      this.send(socket, { type: 'pong', t: Date.now() });
      return;
    }
    // Protocolo de mensageria (message:send, typing, read) — tratado fora.
    if (socket.userId) this.clientEventHandler?.(socket.userId, msg);
  }

  // --- Registro / presença -----------------------------------------------

  private register(userId: string, socket: UserSocket): void {
    let set = this.clients.get(userId);
    if (!set) this.clients.set(userId, (set = new Set()));
    set.add(socket);
  }

  private unregister(userId: string, socket: UserSocket): void {
    const set = this.clients.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.clients.delete(userId);
  }

  private count(userId: string): number {
    return this.clients.get(userId)?.size ?? 0;
  }

  isOnline(userId: string): boolean {
    return this.count(userId) > 0;
  }

  private onPresenceChange(userId: string, online: boolean): void {
    this.log.debug(`presença ${userId} -> ${online ? 'online' : 'offline'}`);
    this.presenceHandler?.(userId, online);
  }

  // --- Envio ---------------------------------------------------------------

  private send(socket: WebSocket, data: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
  }

  /** Empurra um payload para todas as conexões de um usuário. True se entregou. */
  pushToUser(userId: string, data: unknown): boolean {
    const set = this.clients.get(userId);
    if (!set) return false;
    let delivered = false;
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(data));
        delivered = true;
      }
    }
    return delivered;
  }
}
