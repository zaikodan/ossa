import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ENV, type Env } from '../config/env';
import { RedisService } from '../infra/redis/redis.service';
import { verifyUserId } from '../auth/token';

const WS_PING_MS = 30_000;
/** Canal de fan-out por usuário e hash global de presença (contagem de conexões). */
const userChannel = (userId: string): string => `ossa:user:${userId}`;
const CONNS_KEY = 'ossa:conns';
// Presença distribuída resiliente a crash: cada instância tem um heartbeat com
// TTL e rastreia suas próprias conexões; um reaper reconcilia instâncias mortas.
const INSTANCES_SET = 'ossa:instances';
const aliveKey = (id: string): string => `ossa:inst:${id}:alive`;
const instConnsKey = (id: string): string => `ossa:inst:${id}:conns`;

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
  replyToId?: string;
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
export class RealtimeGateway implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly instanceId = randomUUID().slice(0, 8);
  private wss?: WebSocketServer;
  private readonly local = new Map<string, Set<UserSocket>>();
  private clientEventHandler?: ClientEventHandler;
  private presenceHandler?: PresenceHandler;
  private timers: ReturnType<typeof setInterval>[] = [];

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
    // Presença resiliente: heartbeat da instância + reaper de instâncias mortas.
    void this.heartbeat();
    this.timers.push(setInterval(() => void this.heartbeat(), this.env.PRESENCE_HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.reap(), this.env.PRESENCE_REAP_MS));
  }

  async onModuleDestroy(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    // Shutdown gracioso: devolve as minhas conexões ao contador global.
    try {
      const mine = await this.redis.pub.hgetall(instConnsKey(this.instanceId));
      for (const [uid, cntStr] of Object.entries(mine)) {
        const cnt = Number(cntStr);
        if (cnt > 0) await this.decrementGlobal(uid, cnt);
      }
      await this.redis.pub
        .multi()
        .del(instConnsKey(this.instanceId))
        .del(aliveKey(this.instanceId))
        .srem(INSTANCES_SET, this.instanceId)
        .exec();
    } catch {
      /* redis pode já estar fechando */
    }
  }

  /** Renova o heartbeat (com TTL) e registra a instância como viva. */
  private async heartbeat(): Promise<void> {
    await this.redis.pub
      .multi()
      .set(aliveKey(this.instanceId), '1', 'EX', this.env.PRESENCE_TTL_SEC)
      .sadd(INSTANCES_SET, this.instanceId)
      .exec();
  }

  /** Decrementa o contador global; dispara presença offline na transição p/ 0. */
  private async decrementGlobal(userId: string, by: number): Promise<void> {
    const now = await this.redis.pub.hincrby(CONNS_KEY, userId, -by);
    if (now <= 0) {
      await this.redis.pub.hdel(CONNS_KEY, userId);
      this.presenceHandler?.(userId, false);
    }
  }

  /**
   * Reconcilia instâncias mortas: se o heartbeat expirou mas ainda há conexões
   * contabilizadas, reivindica-as (RENAME atômico = exatamente uma vez) e as
   * devolve ao contador global.
   */
  private async reap(): Promise<void> {
    const ids = await this.redis.pub.smembers(INSTANCES_SET);
    for (const id of ids) {
      if (id === this.instanceId) continue;
      if (await this.redis.pub.exists(aliveKey(id))) continue; // ainda viva
      const claim = `ossa:reap:${id}:${this.instanceId}`;
      try {
        await this.redis.pub.rename(instConnsKey(id), claim); // reivindica
      } catch {
        await this.redis.pub.srem(INSTANCES_SET, id); // sem conns → só limpa
        continue;
      }
      const conns = await this.redis.pub.hgetall(claim);
      for (const [uid, cntStr] of Object.entries(conns)) {
        const cnt = Number(cntStr);
        if (cnt > 0) await this.decrementGlobal(uid, cnt);
      }
      await this.redis.pub.multi().del(claim).srem(INSTANCES_SET, id).exec();
      this.log.warn(
        `instância morta ${id} reconciliada (${Object.keys(conns).length} usuários)`,
      );
    }
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
    const ping = setInterval(() => {
      this.wss?.clients.forEach((client) => {
        const s = client as UserSocket;
        if (s.isAlive === false) return s.terminate();
        s.isAlive = false;
        s.ping();
      });
    }, WS_PING_MS);
    this.wss.on('close', () => clearInterval(ping));
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
    // Conta no global (presença) e no rastreio desta instância (crash-recovery).
    await this.redis.pub.hincrby(instConnsKey(this.instanceId), userId, 1);
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
    await this.redis.pub.hincrby(instConnsKey(this.instanceId), userId, -1);
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
