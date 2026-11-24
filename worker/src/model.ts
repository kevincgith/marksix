// A group pool: a few bets that several people fill in together, one or two
// numbers each. Everything here is pure - what a pool looks like, what a
// phone may send, and what each change does - so it's the same in the
// Durable Object and in the tests.
//
// Anyone with the link may change anything: there are no owners or
// permissions. Each number remembers who put it in, and the pool keeps a
// short log of who changed what, so a group can see what happened.

export const CODE_ALPHABET = "34679ACDEFGHJKMNPQRTUVWXY"; // nothing that reads like something else
export const CODE_LENGTH = 6;

export const LIMITS = {
  bets: 6, // bets in a pool
  minSize: 6, // numbers in a bet: 6 is a single, more is a multiple
  maxSize: 15, // 5,005 combinations, HK$50,050 - plenty for a pool
  title: 40,
  name: 20, // a person's name
  betName: 24,
  log: 40, // changes kept
  frame: 1024, // bytes in a message from a phone
} as const;

export interface Pick {
  n: number; // 1-49
  by: string; // who put it in
  at: number;
}

export interface Bet {
  id: string;
  name: string;
  size: number; // how many numbers it's meant to have (a target, and a cap)
  picks: Pick[]; // in the order they were added
}

export interface LogEntry {
  at: number;
  by: string;
  text: string;
}

export interface Pool {
  code: string;
  title: string;
  created: number;
  updated: number;
  version: number; // one higher on each change
  bets: Bet[];
  log: LogEntry[]; // newest last
  // Set once the ticket is bought, so the numbers stay as they are on it:
  // nothing can change until someone unlocks it. (Absent in pools made
  // before locking existed: unlocked.)
  locked?: { by: string; at: number } | null;
}

export type Op =
  | { t: "add"; bet: string; n: number; by: string }
  | { t: "remove"; bet: string; n: number; by: string }
  | { t: "size"; bet: string; size: number; by: string }
  | { t: "rename"; bet: string; name: string; by: string }
  | { t: "clear"; bet: string; by: string }
  | { t: "addBet"; by: string }
  | { t: "removeBet"; bet: string; by: string }
  | { t: "title"; title: string; by: string }
  | { t: "lock"; by: string }
  | { t: "unlock"; by: string };

export interface PoolSetup {
  title?: string;
  bets?: number;
  size?: number;
}

// A change the pool turns down, with why (shown to the person).
export class Refusal extends Error {}

// ---- Cleaning text -----------------------------------------------------------

// One line of plain text: no control or invisible characters, no markup
// brackets, whitespace collapsed, at most `max` characters.
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return [...s.normalize("NFC").replace(/[\p{C}<>]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("").trim();
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]{1,12}$/.test(v);

// ---- Making a pool -------------------------------------------------------------

const BET_LETTERS = "ABCDEF";

export function newBetId(pool: { bets: Bet[] }): string {
  for (let i = 1; ; i++) {
    const id = "b" + i;
    if (!pool.bets.some((b) => b.id === id)) return id;
  }
}

function freeBetName(pool: { bets: Bet[] }): string {
  for (const l of BET_LETTERS) {
    const name = "Bet " + l;
    if (!pool.bets.some((b) => b.name === name)) return name;
  }
  return "Bet " + (pool.bets.length + 1);
}

export function newPool(code: string, setup: PoolSetup, now: number): Pool {
  const count = isInt(setup.bets, 1, LIMITS.bets) ? setup.bets : 2;
  const size = isInt(setup.size, LIMITS.minSize, LIMITS.maxSize) ? setup.size : 7;
  const pool: Pool = {
    code,
    title: cleanText(setup.title, LIMITS.title) || "Mark Six pool",
    created: now,
    updated: now,
    version: 1,
    bets: [],
    log: [],
  };
  for (let i = 0; i < count; i++) pool.bets.push({ id: newBetId(pool), name: freeBetName(pool), size, picks: [] });
  return pool;
}

export function parseSetup(body: unknown): PoolSetup {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  return { title: typeof b.title === "string" ? b.title : undefined, bets: typeof b.bets === "number" ? b.bets : undefined, size: typeof b.size === "number" ? b.size : undefined };
}

// ---- Reading a message ----------------------------------------------------------

// What a phone sent, checked field by field; null if it isn't a well-formed
// message. `ping` is answered without touching the pool.
export function parseOp(frame: string): Op | { t: "ping" } | null {
  if (frame.length > LIMITS.frame) return null;
  let m: unknown;
  try {
    m = JSON.parse(frame);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.t === "ping") return { t: "ping" };
  const by = cleanText(o.by, LIMITS.name);
  if (!by) return null;
  switch (o.t) {
    case "add":
    case "remove":
      return isId(o.bet) && isInt(o.n, 1, 49) ? { t: o.t, bet: o.bet, n: o.n, by } : null;
    case "size":
      return isId(o.bet) && isInt(o.size, LIMITS.minSize, LIMITS.maxSize) ? { t: "size", bet: o.bet, size: o.size, by } : null;
    case "rename":
      return isId(o.bet) && typeof o.name === "string" ? { t: "rename", bet: o.bet, name: o.name, by } : null;
    case "clear":
    case "removeBet":
      return isId(o.bet) ? { t: o.t, bet: o.bet, by } : null;
    case "addBet":
    case "lock":
    case "unlock":
      return { t: o.t, by };
    case "title":
      return typeof o.title === "string" ? { t: "title", title: o.title, by } : null;
    default:
      return null;
  }
}

// ---- Applying a change -------------------------------------------------------------

// Apply `op` to `pool` in place. Returns false when it changes nothing (the
// number was already there, the name is the same); throws a Refusal when it
// can't be done.
export function applyOp(pool: Pool, op: Op, now: number): boolean {
  const findBet = (id: string) => {
    const bet = pool.bets.find((b) => b.id === id);
    if (!bet) throw new Refusal("That bet has been removed.");
    return bet;
  };
  if (pool.locked && op.t !== "unlock" && op.t !== "lock")
    throw new Refusal(`The pool is locked (${pool.locked.by} locked it, the ticket's bought). Unlock it to change anything.`);
  let text: string;
  switch (op.t) {
    case "lock": {
      if (pool.locked) return false;
      pool.locked = { by: op.by, at: now };
      text = "locked the pool";
      break;
    }
    case "unlock": {
      if (!pool.locked) return false;
      pool.locked = null;
      text = "unlocked the pool";
      break;
    }
    case "add": {
      const bet = findBet(op.bet);
      if (bet.picks.some((p) => p.n === op.n)) return false;
      if (bet.picks.length >= bet.size) throw new Refusal(`${bet.name} is full (${bet.size} numbers). Remove one first, or make the bet bigger.`);
      bet.picks.push({ n: op.n, by: op.by, at: now });
      text = `added ${op.n} to ${bet.name}`;
      break;
    }
    case "remove": {
      const bet = findBet(op.bet);
      const i = bet.picks.findIndex((p) => p.n === op.n);
      if (i < 0) return false;
      const [gone] = bet.picks.splice(i, 1);
      text = `removed ${op.n} from ${bet.name}` + (gone.by !== op.by ? ` (${gone.by}'s)` : "");
      break;
    }
    case "size": {
      const bet = findBet(op.bet);
      if (bet.size === op.size) return false;
      if (op.size < bet.picks.length) throw new Refusal(`${bet.name} already has ${bet.picks.length} numbers. Remove some first.`);
      bet.size = op.size;
      text = `made ${bet.name} ${op.size} numbers`;
      break;
    }
    case "rename": {
      const bet = findBet(op.bet);
      const name = cleanText(op.name, LIMITS.betName);
      if (!name) throw new Refusal("A bet needs a name.");
      if (name === bet.name) return false;
      text = `renamed ${bet.name} to ${name}`;
      bet.name = name;
      break;
    }
    case "clear": {
      const bet = findBet(op.bet);
      if (!bet.picks.length) return false;
      bet.picks = [];
      text = `cleared ${bet.name}`;
      break;
    }
    case "addBet": {
      if (pool.bets.length >= LIMITS.bets) throw new Refusal(`A pool can have up to ${LIMITS.bets} bets.`);
      const size = pool.bets.at(-1)?.size ?? 7;
      const bet: Bet = { id: newBetId(pool), name: freeBetName(pool), size, picks: [] };
      pool.bets.push(bet);
      text = `added ${bet.name}`;
      break;
    }
    case "removeBet": {
      const bet = findBet(op.bet);
      if (pool.bets.length <= 1) throw new Refusal("A pool needs at least one bet.");
      pool.bets = pool.bets.filter((b) => b !== bet);
      text = `removed ${bet.name}` + (bet.picks.length ? ` (${bet.picks.map((p) => p.n).join(", ")})` : "");
      break;
    }
    case "title": {
      const title = cleanText(op.title, LIMITS.title);
      if (!title) throw new Refusal("The pool needs a name.");
      if (title === pool.title) return false;
      pool.title = title;
      text = `renamed the pool to ${title}`;
      break;
    }
  }
  pool.updated = now;
  pool.version++;
  pool.log.push({ at: now, by: op.by, text });
  if (pool.log.length > LIMITS.log) pool.log.splice(0, pool.log.length - LIMITS.log);
  return true;
}
