# marksix-pool

The server behind the checker's **👥 Group pool**: a Cloudflare Worker with one Durable Object per
pool. Each pool keeps itself in its own (SQLite-backed) storage, and everyone who has it open holds a
WebSocket to it, accepted with the Hibernation API, so a quiet pool costs nothing while it waits.
It runs on the Workers free plan.

```
src/index.ts   routes: make a pool, look one up, open its WebSocket; the Origin check; rate limits
src/pool.ts    Pool, the Durable Object: applies each change, sends the pool to everyone, expiry
src/model.ts   what a pool is, what a page may send, and what each change does (pure)
test/          tests run inside the Workers runtime against the real Durable Object
```

## Why a Durable Object

Five people tapping numbers at once need one place that applies their changes in order. A Durable
Object is exactly that: one instance per pool, handling one message at a time, with its own storage.
Each tap is sent as a small change ("add 23 to Bet A"), not the whole pool, so two people's taps
never overwrite each other. (Workers KV is eventually consistent and would lose simultaneous edits;
a database plus polling would work but needs more moving parts and isn't live.)

## How it works

- `POST /pools` with `{title?, bets?, size?}` answers `201 {"code":"KQF39E"}`. Codes are 6 characters
  from `34679ACDEFGHJKMNPQRTUVWXY`, in any case.
- `GET /pools/<CODE>` answers the pool, or `404`.
- `GET /pools/<CODE>/ws` is the WebSocket. On connecting the page is sent `{"t":"pool","pool":…}`, and
  again after every change anyone makes.
- A page sends changes, each with `by` (the name the person typed):
  `add`/`remove` `{bet, n}`, `size` `{bet, size}` (6–15), `rename` `{bet, name}`, `clear` `{bet}`,
  `addBet`, `removeBet` `{bet}`, `title` `{title}`, `lock`, `unlock`. While a pool is locked (`pool.locked`
  is `{by, at}`) every change but `unlock` is refused. A change that can't be done (a full bet, the last
  bet) is answered `{"t":"error","message":…}` plus the pool as it is, so the page undoes what it
  showed. `{"t":"ping"}` is answered `{"t":"pong"}` without waking the pool.
- There are no accounts or owners: anyone with the link may change anything. Each number keeps who
  added it, and the pool keeps its last 40 changes.
- Only pages in `ALLOWED_ORIGINS` (and localhost) may use it. Per address, 10 pools a minute may be
  made and 60 lookups or connections a minute opened; each connection may send bursts of 30, then 6 a
  second. Up to 30 connections per pool.
- A pool nobody changed is removed 2 days after it was made; any other 60 days after its last change
  (never while someone has it open).

## Local development

```bash
cd worker
npm install
npm run dev        # http://localhost:8788
```

Serve the page from the repo root (for example `python3 -m http.server 8791`) and open
<http://localhost:8791/>: on localhost the page talks to `http://localhost:8788`, anywhere else to
`https://marksix-api.kevinlhc.com`. Pools made under `wrangler dev` live in `worker/.wrangler/`.

## Tests

```bash
npm test           # in worker/
npm run typecheck
```

## Deploying

`kevinlhc.com` is on Cloudflare, so the Worker is served at `marksix-api.kevinlhc.com` as a Custom
Domain (`routes` in `wrangler.jsonc`): Cloudflare makes the DNS record and certificate on the first
deploy. Check nothing in the kevinlhc.com DNS records already uses `marksix-api`, then:

```bash
cd worker
npx wrangler login   # once, if not already logged in
npm run deploy
curl https://marksix-api.kevinlhc.com/health   # ok
```

The page itself still deploys with GitHub Pages as before. Deploy the Worker first when a change
touches both.
