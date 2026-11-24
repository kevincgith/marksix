// One pool: a Durable Object keyed by its code, keeping the pool in its own
// storage and talking to everyone who has it open over WebSockets accepted
// with the Hibernation API - so a quiet pool costs nothing while it waits,
// sockets and all.
//
// Every change goes through here one at a time (a Durable Object handles one
// message at a time), so two people tapping at once can't lose each other's
// numbers: each tap is a small change - "add 23 to Bet A" - applied to the
// pool as it is now, then the whole pool is sent to everyone.

import { DurableObject } from "cloudflare:workers";
import { applyOp, newPool, parseOp, Refusal, type Pool as PoolState, type PoolSetup } from "./model";
import type { Env } from "./index";

// Open connections per pool.
export const MAX_CONNECTIONS = 30;
// Per connection: bursts of this many messages, then this many a second; a
// connection over the limit this many times in a row is closed.
const RATE_BURST = 30;
const RATE_PER_SECOND = 6;
const RATE_STRIKES = 15;
// A pool no one has changed since it was made is removed after this long;
// any other, this long after its last change (never while anyone has it
// open - it's looked at again later).
export const UNUSED_TTL_MS = 2 * 24 * 3600_000;
export const IDLE_TTL_MS = 60 * 24 * 3600_000;
const RECHECK_MS = 3600_000;

// The heartbeat: pages send exactly this every 25s and are answered without
// waking the pool.
const PING = JSON.stringify({ t: "ping" });
const PONG = JSON.stringify({ t: "pong" });

interface Conn {
  tokens: number;
  at: number;
  strikes: number;
}

export class Pool extends DurableObject<Env> {
  private pool: PoolState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      this.pool = (await ctx.storage.get<PoolState>("pool")) ?? null;
    });
  }

  // ---- Called by the Worker -------------------------------------------------

  // A fresh random code: true if the pool is new (and now exists), false if
  // the code is taken.
  async create(code: string, setup: PoolSetup): Promise<boolean> {
    if (this.pool) return false;
    this.pool = newPool(code, setup, Date.now());
    await this.ctx.storage.put("pool", this.pool);
    await this.ctx.storage.setAlarm(this.expiry());
    return true;
  }

  // The pool as it is, or null when there's no such pool. `full` says no more
  // connections fit, so a page that was turned away can say why.
  async info(): Promise<(PoolState & { full: boolean }) | null> {
    return this.pool && { ...this.pool, full: this.ctx.getWebSockets().length >= MAX_CONNECTIONS };
  }

  async fetch(_request: Request): Promise<Response> {
    if (!this.pool) return new Response("no such pool", { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return new Response("this pool is full", { status: 503 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ tokens: RATE_BURST, at: Date.now(), strikes: 0 } satisfies Conn);
    this.send(server, { t: "pool", pool: this.pool });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Messages ----------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer) {
    if (!this.pool) return ws.close(1011, "no such pool");
    if (!this.admit(ws)) return;
    const op = typeof frame === "string" ? parseOp(frame) : null;
    if (!op) return this.refuse(ws, "That message wasn't understood. Reload the page.");
    if (op.t === "ping") return this.send(ws, { t: "pong" });
    let changed: boolean;
    try {
      changed = applyOp(this.pool, op, Date.now());
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      return this.refuse(ws, e.message);
    }
    if (!changed) return this.send(ws, { t: "pool", pool: this.pool });
    await this.ctx.storage.put("pool", this.pool);
    await this.ctx.storage.setAlarm(this.expiry());
    const msg = JSON.stringify({ t: "pool", pool: this.pool });
    for (const s of this.ctx.getWebSockets()) {
      try {
        s.send(msg);
      } catch {
        // closing - nothing to do
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
  }

  // ---- Clean-up ------------------------------------------------------------------

  private expiry(): number {
    const p = this.pool!;
    return p.updated + (p.version <= 1 ? UNUSED_TTL_MS : IDLE_TTL_MS);
  }

  async alarm() {
    if (!this.pool) return;
    const now = Date.now();
    if (now < this.expiry()) return this.ctx.storage.setAlarm(this.expiry());
    if (this.ctx.getWebSockets().length) return this.ctx.storage.setAlarm(now + RECHECK_MS);
    this.pool = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---- Helpers --------------------------------------------------------------------

  private send(ws: WebSocket, msg: object) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // closing - its close handler tidies up
    }
  }

  // Turned down: say why, and send the pool as it is so the page can drop the
  // change it showed straight away.
  private refuse(ws: WebSocket, message: string) {
    this.send(ws, { t: "error", message });
    this.send(ws, { t: "pool", pool: this.pool });
  }

  // Token bucket: true if this message may go through.
  private admit(ws: WebSocket): boolean {
    const c = ws.deserializeAttachment() as Conn;
    const now = Date.now();
    c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.at) / 1000) * RATE_PER_SECOND);
    c.at = now;
    const ok = c.tokens >= 1;
    if (ok) {
      c.tokens -= 1;
      c.strikes = 0;
    } else c.strikes++;
    ws.serializeAttachment(c);
    if (ok) return true;
    if (c.strikes >= RATE_STRIKES) ws.close(1008, "too many messages");
    else this.refuse(ws, "Slow down a little.");
    return false;
  }
}
