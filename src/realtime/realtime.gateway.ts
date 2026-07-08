import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ENV, type Env } from '../config/env';
import { RedisService } from '../infra/redis/redis.service';
import { verifyUserId } from '../auth/token';

const HEARTBEAT_MS = 30_000;
/** Canal de fan-out por usuário e hash global de presença (contagem de conexões). */
const userChannel = (userId: string): string => `ossa:user:${userId}`;
const CONNS_KEY = 'ossa:conns';

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
  mediaKey?: string;
  mediaKind?: string;
  typing?: boolean;
}

export type ClientEventHandler = (userId: string, event: ClientEvent) => void;
export type PresenceHandler = (userId: string, online: boolean) => void;

/**
 * Servidor WebSocket nativo (`ws`) com fan-out via Redis — pronto p/ rodar em
 * várias instâncias:
 *  - autentica pelo JWT da plataforma (`?token=`);
 *  - registro LOCAL userId -> sockets desta instância;
 *  - `pushToUser` PUBLICA no canal `ossa:user:{id}`; cada instância assina os
 *    canais dos usuários que segura e entrega aos sockets locais;
 *  - presença DISTRIBUÍDA: contador global no Redis (`ossa:conns`), com evento
 *    só nas transições globais offline<->online;
 *  - heartbeat ping/pong.
 */
@Injectable()
export class RealtimeGateway implements OnModuleInit {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly instanceId = randomUUID().slice(0, 8);
  private wss?: WebSocketServer;
  private readonly local = new Map<string, Set<UserSocket>>();
  private clientEventHandler?: ClientEventHandler;
  private presenceHandler?: PresenceHandler;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    // Entrega o que chega pelos canais assinados aos sockets locais.
    this.redis.sub.on('message', (channel: string, payload: string) => {
      const userId = channel.slice('ossa:user:'.length);
      this.deliverLocal(userId, payload);
    });
  }

  setClientEventHandler(handler: ClientEventHandler): void {
    this.clientEventHandler = handler;
  }

  setPresenceHandler(handler: PresenceHandler): void {
    this.presenceHandler = handler;
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket: UserSocket, req) => {
      void this.onConnection(socket, req);
    });
    const heartbeat = setInterval(() => {
      this.wss?.clients.forEach((client) => {
        const s = client as UserSocket;
        if (s.isAlive === false) return s.terminate();
        s.isAlive = false;
        s.ping();
      });
    }, HEARTBEAT_MS);
    this.wss.on('close', () => clearInterval(heartbeat));
    this.log.log(`WebSocket server anexado em /ws (instância ${this.instanceId})`);
  }

  private async onConnection(socket: UserSocket, req: IncomingMessage): Promise<void> {
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
    socket.on('message', (raw) => this.onMessage(socket, raw.toString()));
    socket.on('close', () => void this.unregister(userId, socket));

    await this.register(userId, socket);
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
    if (socket.userId) this.clientEventHandler?.(socket.userId, msg);
  }

  // --- Registro local + presença distribuída --------------------------------

  private async register(userId: string, socket: UserSocket): Promise<void> {
    let set = this.local.get(userId);
    if (!set) {
      this.local.set(userId, (set = new Set()));
      await this.redis.sub.subscribe(userChannel(userId)); // 1º socket local desta instância
    }
    set.add(socket);
    const globalCount = await this.redis.pub.hincrby(CONNS_KEY, userId, 1);
    this.log.log(`conectado ${userId} (local ${set.size}, global ${globalCount})`);
    if (globalCount === 1) this.presenceHandler?.(userId, true); // transição global -> online
  }

  private async unregister(userId: string, socket: UserSocket): Promise<void> {
    const set = this.local.get(userId);
    if (set) {
      set.delete(socket);
      if (set.size === 0) {
        this.local.delete(userId);
        await this.redis.sub.unsubscribe(userChannel(userId));
      }
    }
    const globalCount = await this.redis.pub.hincrby(CONNS_KEY, userId, -1);
    this.log.log(`desconectado ${userId} (global ${Math.max(0, globalCount)})`);
    if (globalCount <= 0) {
      await this.redis.pub.hdel(CONNS_KEY, userId);
      this.presenceHandler?.(userId, false); // transição global -> offline
    }
  }

  /** Presença cluster-wide: online se há alguma conexão em qualquer instância. */
  async isOnline(userId: string): Promise<boolean> {
    const n = await this.redis.pub.hget(CONNS_KEY, userId);
    return Number(n) > 0;
  }

  // --- Envio ----------------------------------------------------------------

  private send(socket: WebSocket, data: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
  }

  private deliverLocal(userId: string, payload: string): void {
    const set = this.local.get(userId);
    if (!set) return;
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  /**
   * Empurra um payload para todas as conexões de um usuário, em qualquer
   * instância: publica no canal do usuário; quem o segura entrega localmente.
   */
  pushToUser(userId: string, data: unknown): void {
    void this.redis.pub.publish(userChannel(userId), JSON.stringify(data));
  }
}
