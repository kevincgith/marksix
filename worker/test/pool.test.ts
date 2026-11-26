import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyOp, cleanText, newPool, parseOp, Refusal, type Pool } from "../src/model";
import { isAllowedOrigin, normalizeCode } from "../src/index";
import { IDLE_TTL_MS, UNUSED_TTL_MS } from "../src/pool";

const ORIGIN = "http://localhost:8791";
const BASE = "https://pool.test";

async function createPool(body: object = { title: "Friday", bets: 2, size: 7 }, origin = ORIGIN) {
  const res = await SELF.fetch(`${BASE}/pools`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res;
}

class Client {
  inbox: { t: string; pool?: Pool; message?: string; v?: number }[] = [];
  private wake: (() => void) | null = null;
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      this.inbox.push(JSON.parse(e.data as string));
      this.wake?.();
    });
    ws.accept();
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async next(t: string) {
    const deadline = Date.now() + 2000;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.t === t);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${t}: ${JSON.stringify(this.inbox)}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, left);
      });
    }
  }
  async pool(until: (p: Pool) => boolean = () => true) {
    for (;;) {
      const { pool } = await this.next("pool");
      if (until(pool!)) return pool!;
    }
  }
}

async function connect(code: string) {
  const res = await SELF.fetch(`${BASE}/pools/${code}/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN } });
  expect(res.status).toBe(101);
  return new Client(res.webSocket!);
}

describe("the model", () => {
  it("makes a pool with the bets asked for", () => {
    const p = newPool("ABC", { title: "  Office <b>pool</b> ", bets: 3, size: 8 }, 1);
    expect(p.title).toBe("Office b pool /b");
    expect(p.bets.map((b) => [b.id, b.name, b.size])).toEqual([["b1", "Bet A", 8], ["b2", "Bet B", 8], ["b3", "Bet C", 8]]);
    expect(newPool("ABC", { bets: 99, size: 3 }, 1).bets.map((b) => b.size)).toEqual([7, 7]);
  });

  it("adds, refuses a full bet, removes, resizes", () => {
    const p = newPool("ABC", { bets: 1, size: 6 }, 1);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(applyOp(p, { t: "add", bet: "b1", n, by: "Kev" }, 2)).toBe(true);
    expect(applyOp(p, { t: "add", bet: "b1", n: 3, by: "Amy" }, 3)).toBe(false); // already there
    expect(() => applyOp(p, { t: "add", bet: "b1", n: 7, by: "Amy" }, 3)).toThrow(Refusal);
    expect(applyOp(p, { t: "size", bet: "b1", size: 7, by: "Amy" }, 4)).toBe(true);
    expect(applyOp(p, { t: "add", bet: "b1", n: 7, by: "Amy" }, 5)).toBe(true);
    expect(() => applyOp(p, { t: "size", bet: "b1", size: 6, by: "Amy" }, 6)).toThrow(/already has 7/);
    expect(applyOp(p, { t: "remove", bet: "b1", n: 1, by: "Amy" }, 7)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("removed 1 from Bet A (Kev's)");
    expect(p.bets[0].picks.map((x) => [x.n, x.by])).toEqual([[2, "Kev"], [3, "Kev"], [4, "Kev"], [5, "Kev"], [6, "Kev"], [7, "Amy"]]);
  });

  it("takes bankers: added as one, changed to and from one, five at most", () => {
    const p = newPool("ABC", { bets: 1, size: 7 }, 1);
    expect(applyOp(p, { t: "add", bet: "b1", n: 8, banker: true, by: "Kev" }, 2)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("added 8 to Bet A as a banker");
    expect(applyOp(p, { t: "add", bet: "b1", n: 8, banker: true, by: "Amy" }, 3)).toBe(false); // already a banker
    expect(applyOp(p, { t: "add", bet: "b1", n: 9, by: "Kev" }, 4)).toBe(true);
    // A number already in the bet changes role and stays whose it was.
    expect(applyOp(p, { t: "add", bet: "b1", n: 9, banker: true, by: "Amy" }, 5)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("made 9 a banker in Bet A (Kev's)");
    expect(p.bets[0].picks).toEqual([{ n: 8, by: "Kev", at: 2, banker: true }, { n: 9, by: "Kev", at: 4, banker: true }]);
    expect(applyOp(p, { t: "add", bet: "b1", n: 8, by: "Kev" }, 6)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("made 8 no longer a banker in Bet A");
    expect(p.bets[0].picks[0]).toEqual({ n: 8, by: "Kev", at: 2 });
    // Five bankers at most, whether added or changed; and they count towards the bet's size.
    for (const n of [10, 11, 12, 13]) applyOp(p, { t: "add", bet: "b1", n, banker: true, by: "Kev" }, 7);
    expect(p.bets[0].picks.filter((x) => x.banker).map((x) => x.n)).toEqual([9, 10, 11, 12, 13]);
    expect(() => applyOp(p, { t: "add", bet: "b1", n: 8, banker: true, by: "Kev" }, 8)).toThrow(/already has 5 bankers/);
    expect(() => applyOp(p, { t: "add", bet: "b1", n: 14, banker: true, by: "Kev" }, 8)).toThrow(/already has 5 bankers/);
    expect(applyOp(p, { t: "add", bet: "b1", n: 14, by: "Kev" }, 9)).toBe(true);
    expect(() => applyOp(p, { t: "add", bet: "b1", n: 15, by: "Kev" }, 10)).toThrow(/is full \(7 numbers\)/);
    expect(applyOp(p, { t: "remove", bet: "b1", n: 9, by: "Kev" }, 11)).toBe(true);
    expect(applyOp(p, { t: "add", bet: "b1", n: 8, banker: true, by: "Kev" }, 12)).toBe(true);
  });

  it("keeps who is buying the ticket and what each person has paid, locked or not", () => {
    const p = newPool("ABC", { bets: 1 }, 1);
    expect(applyOp(p, { t: "buyer", name: " Kev ", by: "Kev" }, 2)).toBe(true);
    expect(p.buyer).toBe("Kev");
    expect(p.log.at(-1)!.text).toBe("is buying the ticket");
    expect(applyOp(p, { t: "buyer", name: "Kev", by: "Amy" }, 3)).toBe(false);
    expect(applyOp(p, { t: "buyer", name: "Amy", by: "Kev" }, 3)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("said Amy is buying the ticket");
    expect(applyOp(p, { t: "paid", who: "Kev", amount: 28, by: "Kev" }, 4)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("has paid HK$28");
    expect(applyOp(p, { t: "paid", who: "Kev", amount: 28, by: "Amy" }, 5)).toBe(false);
    expect(applyOp(p, { t: "paid", who: "Ben", amount: 1046.7, by: "Amy" }, 5)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("noted that Ben has paid HK$1,046.70");
    expect(p.paid).toEqual([{ who: "Kev", amount: 28 }, { who: "Ben", amount: 1046.7 }]);
    // Locked: the numbers stay, the buyer and the payments can still be noted.
    applyOp(p, { t: "lock", by: "Amy" }, 6);
    expect(() => applyOp(p, { t: "add", bet: "b1", n: 6, by: "Amy" }, 7)).toThrow(/locked/);
    expect(applyOp(p, { t: "paid", who: "Kev", amount: 30, by: "Amy" }, 7)).toBe(true);
    expect(applyOp(p, { t: "paid", who: "Ben", amount: 0, by: "Amy" }, 8)).toBe(true);
    expect(p.log.at(-1)!.text).toBe("took Ben's payment off");
    expect(applyOp(p, { t: "paid", who: "Ben", amount: 0, by: "Amy" }, 8)).toBe(false); // nothing to take off
    expect(p.paid).toEqual([{ who: "Kev", amount: 30 }]);
    expect(applyOp(p, { t: "buyer", name: "", by: "Amy" }, 9)).toBe(true);
    expect(p.buyer).toBeNull();
    for (let i = 0; i < 39; i++) applyOp(p, { t: "paid", who: "P" + i, amount: 10, by: "Amy" }, 10);
    expect(() => applyOp(p, { t: "paid", who: "One too many", amount: 10, by: "Amy" }, 11)).toThrow(/up to 40 people/);
    expect(parseOp('{"t":"paid","who":" Ben ","amount":28.26,"by":"Amy"}')).toEqual({ t: "paid", who: "Ben", amount: 28.3, by: "Amy" });
    expect(parseOp('{"t":"paid","who":"Ben","amount":-1,"by":"Amy"}')).toBeNull();
    expect(parseOp('{"t":"paid","who":"Ben","amount":"28","by":"Amy"}')).toBeNull();
    expect(parseOp('{"t":"paid","who":"","amount":28,"by":"Amy"}')).toBeNull();
    expect(parseOp('{"t":"buyer","name":"Kev","by":"Amy"}')).toEqual({ t: "buyer", name: "Kev", by: "Amy" });
  });

  it("adds and removes bets, keeps at least one", () => {
    const p = newPool("ABC", { bets: 1 }, 1);
    applyOp(p, { t: "addBet", by: "K" }, 2);
    expect(p.bets.map((b) => b.name)).toEqual(["Bet A", "Bet B"]);
    applyOp(p, { t: "removeBet", bet: "b1", by: "K" }, 3);
    expect(() => applyOp(p, { t: "removeBet", bet: "b2", by: "K" }, 4)).toThrow(/at least one/);
    applyOp(p, { t: "addBet", by: "K" }, 5);
    expect(p.bets.map((b) => [b.id, b.name])).toEqual([["b2", "Bet B"], ["b1", "Bet A"]]);
    expect(() => applyOp(p, { t: "add", bet: "b9", n: 1, by: "K" }, 6)).toThrow(/removed/);
  });

  it("refuses every change while locked, until unlocked", () => {
    const p = newPool("ABC", { bets: 2 }, 1);
    applyOp(p, { t: "add", bet: "b1", n: 5, by: "Kev" }, 2);
    expect(applyOp(p, { t: "lock", by: "Kev" }, 3)).toBe(true);
    expect(p.locked).toEqual({ by: "Kev", at: 3 });
    expect(applyOp(p, { t: "lock", by: "Amy" }, 4)).toBe(false); // already locked: stays Kev's
    for (const op of [
      { t: "add", bet: "b1", n: 6, by: "Amy" },
      { t: "remove", bet: "b1", n: 5, by: "Amy" },
      { t: "size", bet: "b1", size: 8, by: "Amy" },
      { t: "rename", bet: "b1", name: "X", by: "Amy" },
      { t: "clear", bet: "b1", by: "Amy" },
      { t: "addBet", by: "Amy" },
      { t: "removeBet", bet: "b2", by: "Amy" },
      { t: "title", title: "X", by: "Amy" },
    ] as const) expect(() => applyOp(p, op, 5)).toThrow(/locked \(Kev locked it/);
    expect(applyOp(p, { t: "unlock", by: "Amy" }, 6)).toBe(true);
    expect(p.locked).toBeNull();
    expect(applyOp(p, { t: "add", bet: "b1", n: 6, by: "Amy" }, 7)).toBe(true);
    expect(p.log.map((l) => l.text).slice(-3)).toEqual(["locked the pool", "unlocked the pool", "added 6 to Bet A"]);
    expect(parseOp('{"t":"lock","by":"Kev"}')).toEqual({ t: "lock", by: "Kev" });
  });

  it("reads only well-formed messages", () => {
    expect(parseOp('{"t":"add","bet":"b1","n":12,"by":" Amy "}')).toEqual({ t: "add", bet: "b1", n: 12, by: "Amy" });
    expect(parseOp('{"t":"add","bet":"b1","n":12,"banker":true,"by":"Amy"}')).toEqual({ t: "add", bet: "b1", n: 12, banker: true, by: "Amy" });
    expect(parseOp('{"t":"add","bet":"b1","n":12,"banker":false,"by":"Amy"}')).toEqual({ t: "add", bet: "b1", n: 12, by: "Amy" });
    expect(parseOp('{"t":"add","bet":"b1","n":12,"banker":1,"by":"Amy"}')).toBeNull();
    expect(parseOp('{"t":"add","bet":"b1","n":50,"by":"Amy"}')).toBeNull();
    expect(parseOp('{"t":"add","bet":"b1","n":1.5,"by":"Amy"}')).toBeNull();
    expect(parseOp('{"t":"add","bet":"b1","n":12,"by":"  "}')).toBeNull();
    expect(parseOp('{"t":"size","bet":"b1","size":16,"by":"Amy"}')).toBeNull();
    expect(parseOp('{"t":"nope","by":"Amy"}')).toBeNull();
    expect(parseOp("not json")).toBeNull();
    expect(parseOp('{"t":"ping"}')).toEqual({ t: "ping" });
    expect(cleanText("a\u0000b​c   d", 20)).toBe("a b c d");
  });

  it("keeps a joined emoji whole, but not a name of nothing but joiners", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(cleanText(`${family} family`, 40)).toBe(`${family} family`);
    expect(cleanText(england, 40)).toBe(england);
    expect(cleanText("‍ ‌", 20)).toBe("");
    expect(cleanText("a‮b﻿c", 20)).toBe("a b c"); // other invisible characters still go
  });

  it("normalizes codes", () => {
    expect(normalizeCode("ac9-xk3")).toBe("AC9XK3");
    expect(normalizeCode("AC9XK")).toBeNull();
    expect(normalizeCode("AC9XK1")).toBeNull(); // 1 isn't in the alphabet
  });
});

// Make the pool look as if it was last changed `ms` ago.
async function age(code: string, ms: number) {
  await runInDurableObject(env.POOLS.getByName(code), (instance) => {
    (instance as unknown as { pool: Pool }).pool.updated = Date.now() - ms;
  });
}
const exists = async (code: string) => (await SELF.fetch(`${BASE}/pools/${code}`, { headers: { Origin: ORIGIN } })).status === 200;

describe("who may use it", () => {
  it("lets in the listed pages and localhost, and nothing that only looks like them", () => {
    const allowed = "https://app.kevinlhc.com, https://other.example";
    for (const origin of ["https://app.kevinlhc.com", "https://other.example", "http://localhost:8791", "http://127.0.0.1:5500", "http://[::1]:3000"])
      expect(isAllowedOrigin(origin, allowed), origin).toBe(true);
    for (const origin of [null, "", "null", "https://evil.example", "http://app.kevinlhc.com", "https://app.kevinlhc.com.evil.example",
      "https://app.kevinlhc.com/", "http://localhost.evil.example", "https://evil.example/?http://localhost", "file://"])
      expect(isAllowedOrigin(origin, allowed), String(origin)).toBe(false);
  });
});

describe("the worker", () => {
  it("makes a pool only from an allowed page", async () => {
    expect((await createPool({}, "https://evil.example")).status).toBe(403);
    const res = await createPool();
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const { code } = (await res.json()) as { code: string };
    expect(normalizeCode(code)).toBe(code);
    const info = await SELF.fetch(`${BASE}/pools/${code.toLowerCase()}`, { headers: { Origin: ORIGIN } });
    expect(info.status).toBe(200);
    expect((await info.json()) as Pool & { full: boolean }).toMatchObject({ title: "Friday", full: false });
  });

  it("turns down a body that's too big", async () => {
    expect((await createPool({ title: "x".repeat(2000) })).status).toBe(413);
  });

  it("answers 404 for a pool that doesn't exist", async () => {
    expect((await SELF.fetch(`${BASE}/pools/AAAAAA`, { headers: { Origin: ORIGIN } })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/pools/AAAAAA/ws`, { headers: { Origin: ORIGIN, Upgrade: "websocket" } })).status).toBe(404);
  });

  it("shares every change with everyone who has it open", async () => {
    const { code } = (await (await createPool()).json()) as { code: string };
    const kev = await connect(code);
    const amy = await connect(code);
    const hello = await kev.next("pool");
    expect(hello.pool!.bets).toHaveLength(2);
    expect(hello.v).toBe(3); // says what it takes: bankers, and the ticket's buyer and payments
    await amy.pool();

    kev.send({ t: "add", bet: "b1", n: 8, by: "Kevin" });
    amy.send({ t: "add", bet: "b1", n: 23, by: "Amy" });
    amy.send({ t: "add", bet: "b2", n: 8, by: "Amy" }); // the same number may go in another bet
    const seen = await kev.pool((p) => p.version === 4);
    expect(seen.bets[0].picks.map((x) => [x.n, x.by]).sort()).toEqual([[23, "Amy"], [8, "Kevin"]].sort());
    expect(seen.bets[1].picks.map((x) => x.n)).toEqual([8]);
    expect((await amy.pool((p) => p.version === 4)).bets).toEqual(seen.bets);

    // Amy removes Kevin's number: anyone may change anything.
    amy.send({ t: "remove", bet: "b1", n: 8, by: "Amy" });
    expect((await kev.pool((p) => p.version === 5)).log.at(-1)).toMatchObject({ by: "Amy", text: "removed 8 from Bet A (Kevin's)" });

    // A refusal comes back to the sender alone, with the pool as it is.
    kev.send({ t: "size", bet: "b1", size: 15, by: "Kevin" });
    await kev.pool((p) => p.version === 6);
    kev.send({ t: "removeBet", bet: "b2", by: "Kevin" });
    await kev.pool((p) => p.version === 7);
    kev.send({ t: "removeBet", bet: "b1", by: "Kevin" });
    expect((await kev.next("error")).message).toMatch(/at least one/);

    // It's kept: a new page gets the pool as it now stands.
    const ben = await connect(code);
    const now = await ben.pool();
    expect(now.version).toBe(7);
    expect(now.bets.map((b) => [b.name, b.size, b.picks.map((x) => x.n)])).toEqual([["Bet A", 15, [23]]]);
  });

  it("tells everyone when it's locked, and refuses changes", async () => {
    const { code } = (await (await createPool()).json()) as { code: string };
    const kev = await connect(code);
    const amy = await connect(code);
    await kev.pool();
    await amy.pool();
    kev.send({ t: "lock", by: "Kevin" });
    expect((await amy.pool((p) => !!p.locked)).locked!.by).toBe("Kevin");
    amy.send({ t: "add", bet: "b1", n: 3, by: "Amy" });
    expect((await amy.next("error")).message).toMatch(/locked/);
    expect((await amy.pool()).bets[0].picks).toEqual([]);
  });

  it("removes a pool nobody changed after two days, and not before", async () => {
    const { code } = (await (await createPool()).json()) as { code: string };
    const stub = env.POOLS.getByName(code);
    expect(await runDurableObjectAlarm(stub)).toBe(true); // just made: the alarm looks and leaves it
    expect(await exists(code)).toBe(true);
    await age(code, UNUSED_TTL_MS - 60_000);
    await runDurableObjectAlarm(stub);
    expect(await exists(code)).toBe(true);
    await age(code, UNUSED_TTL_MS + 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await exists(code)).toBe(false);
    expect(await runDurableObjectAlarm(stub)).toBe(false); // and it leaves no alarm behind
  });

  it("keeps a pool that was changed for sixty days, and while anyone has it open", async () => {
    const { code } = (await (await createPool()).json()) as { code: string };
    const stub = env.POOLS.getByName(code);
    const c = await connect(code);
    await c.pool();
    c.send({ t: "add", bet: "b1", n: 8, by: "Kevin" });
    await c.pool((p) => p.version === 2);
    await age(code, UNUSED_TTL_MS + 60_000); // past the unused limit, but it has been used
    await runDurableObjectAlarm(stub);
    expect(await exists(code)).toBe(true);
    await age(code, IDLE_TTL_MS + 60_000); // past its time, but still open
    await runDurableObjectAlarm(stub);
    expect(await exists(code)).toBe(true);
    c.ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
    await runDurableObjectAlarm(stub);
    expect(await exists(code)).toBe(false);
  });

  it("turns down a malformed message without closing", async () => {
    const { code } = (await (await createPool()).json()) as { code: string };
    const c = await connect(code);
    await c.pool();
    c.send({ t: "add", bet: "b1", n: 99, by: "Kevin" });
    expect((await c.next("error")).message).toMatch(/understood/);
    await c.pool(); // and the pool as it is, so the page can undo what it showed
    c.send({ t: "ping" });
    await c.next("pong");
  });

  it("answers a message over the rate with the pool too", async () => {
    const { code } = (await (await createPool()).json()) as { code: string };
    const c = await connect(code);
    await c.pool();
    for (let i = 0; i < 40; i++) c.send({ t: "title", title: `Pool ${i}`, by: "Kevin" });
    expect((await c.next("error")).message).toMatch(/Slow down/);
    for (let i = 0; i < 40; i++) await c.pool(); // one for every message, turned down or not
  });
});
