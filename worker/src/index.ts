// The Worker's front door. It answers these and hands the rest to the pool's
// Durable Object:
//
//   POST /pools             make a pool; body {title?, bets?, size?}; answers 201 {"code": "3AC9XK"}
//   GET  /pools/:code       the pool as it is now, or 404
//   GET  /pools/:code/ws    the pool's WebSocket (Upgrade: websocket)
//   GET  /health            "ok"
//
// Only the pages in ALLOWED_ORIGINS, and localhost, may use the pool routes.

import { CODE_ALPHABET, CODE_LENGTH, parseSetup } from "./model";
import { Pool } from "./pool";

export { Pool };

export interface Env {
  POOLS: DurableObjectNamespace<Pool>;
  ALLOWED_ORIGINS: string;
  CREATE_LIMIT?: RateLimit;
  OPEN_LIMIT?: RateLimit;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedOrigin(origin: string | null, allowed: string): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if ((url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname)) return true;
  return allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

// Codes in any case, with spaces or dashes tolerated; null if it can't be one.
export function normalizeCode(s: string): string | null {
  const code = s.toUpperCase().replace(/[\s-]/g, "");
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

// Uniform over the alphabet: bytes past the last whole multiple are skipped.
export function randomCode(): string {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % n];
    }
  }
  return code;
}

// Whether this address is within `limiter`'s rate (a request with no address
// - a test, local development - isn't counted).
async function within(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!limiter || !ip) return true;
  try {
    return (await limiter.limit({ key: ip })).success;
  } catch {
    return true;
  }
}

const cors = (origin: string) => ({ "Access-Control-Allow-Origin": origin, Vary: "Origin" });
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/pools") {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin not allowed" }, 403);
      const h = cors(origin!);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: { ...h, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST", ...h });
      if (!(await within(env.CREATE_LIMIT, request))) return json({ error: "Too many pools made - try again in a minute." }, 429, { "Retry-After": "60", ...h });
      let body: unknown = null;
      try {
        const text = await request.text();
        if (text.length > 1024) return json({ error: "too large" }, 413, h);
        body = text ? JSON.parse(text) : null;
      } catch {
        return json({ error: "bad JSON" }, 400, h);
      }
      const setup = parseSetup(body);
      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        if (await env.POOLS.getByName(code).create(code, setup)) return json({ code }, 201, h);
      }
      return json({ error: "no free code, try again" }, 503, h);
    }

    const info = url.pathname.match(/^\/pools\/([^/]+)$/);
    if (info) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin not allowed" }, 403);
      const h = cors(origin!);
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET", ...h });
      if (!(await within(env.OPEN_LIMIT, request))) return json({ error: "Too many tries - wait a minute." }, 429, { "Retry-After": "60", ...h });
      const code = normalizeCode(info[1]);
      const pool = code ? await env.POOLS.getByName(code).info() : null;
      return pool ? json(pool, 200, h) : json({ error: "no such pool" }, 404, h);
    }

    const ws = url.pathname.match(/^\/pools\/([^/]+)\/ws$/);
    if (ws) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return new Response("origin not allowed", { status: 403 });
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
      if (!(await within(env.OPEN_LIMIT, request))) return new Response("too many tries - wait a minute", { status: 429 });
      const code = normalizeCode(ws[1]);
      if (!code) return new Response("no such pool", { status: 404 });
      return env.POOLS.getByName(code).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
