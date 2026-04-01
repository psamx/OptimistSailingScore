# Optimist Class Scoring App (Cloudflare Workers + D1)

This project is a web app to manage Optimist sailor scoring:
- Add sailors
- Define regattas by name
- Enter race-by-race results
- Select an existing regatta when adding scores
- Update existing race scores without deleting races
- Use different sail numbers per sailor for each regatta
- Race names are auto-generated as `R#` inside each regatta based on add order
- Default race status in the score form is `OK`
- Auto-calculate leaderboard totals and net score
- Store data in Cloudflare D1

## Stack
- Cloudflare Workers (API + hosting)
- Cloudflare Assets (`public/` frontend)
- Cloudflare D1 (SQL database)

## Scoring Rules Implemented
- Low-point scoring (`1` for first place, `2` for second, etc.)
- `DNC` (did not participate) = `N` points
- `DNS`, `DNF`, `RET`, `OCS`, `RAF` = `N + 1` points
- `DSQ`, `BFD`, `UFD`, `DNE` = `N + 2` points
- Current Regatta view: discard `1` race for every `6` races (`floor(races / 6)`)
- Ranking List view: uses the last `18` races and discards `1` race for every `6` races in that 18-race window
- Current Regatta is determined by the most recent regatta (by end date)
- A regatta spans multiple race dates; its start/end dates are updated automatically

`N` = number of sailors in the series.

## 1) Prerequisites
- Node.js 20+
- Cloudflare account
- Wrangler CLI auth (`npx wrangler login`)

## 2) Install
```bash
npm install
```

## 3) Create D1 databases
```bash
npx wrangler d1 create optimist-scores
npx wrangler d1 create optimist-scores-preview
```

Then copy the returned `database_id` values into [`wrangler.toml`](/Users/psamx/Documents/Projects/sailing/wrangler.toml):
- `database_id`
- `preview_database_id`

## 4) Apply migrations
```bash
npm run db:migrate
npm run db:migrate:local
```

If you already had data before regatta support, make sure the latest migration (`0002_regattas.sql`) is applied.
For per-regatta sail numbers, also apply migration `0003_sail_numbers_per_regatta.sql`.

## 5) Run locally
```bash
npm run dev
```

Open the local URL shown by Wrangler.

## 6) Deploy
```bash
npm run deploy
```

Wrangler prints the deployed Worker URL.

## Project Files
- [`/Users/psamx/Documents/Projects/sailing/src/worker.js`](/Users/psamx/Documents/Projects/sailing/src/worker.js): Worker API routes and D1 data layer
- [`/Users/psamx/Documents/Projects/sailing/public/index.html`](/Users/psamx/Documents/Projects/sailing/public/index.html): Frontend UI
- [`/Users/psamx/Documents/Projects/sailing/migrations/0001_init.sql`](/Users/psamx/Documents/Projects/sailing/migrations/0001_init.sql): D1 schema migration
- [`/Users/psamx/Documents/Projects/sailing/migrations/0002_regattas.sql`](/Users/psamx/Documents/Projects/sailing/migrations/0002_regattas.sql): Regatta model migration
- [`/Users/psamx/Documents/Projects/sailing/migrations/0003_sail_numbers_per_regatta.sql`](/Users/psamx/Documents/Projects/sailing/migrations/0003_sail_numbers_per_regatta.sql): Sail numbers per regatta migration
- [`/Users/psamx/Documents/Projects/sailing/wrangler.toml`](/Users/psamx/Documents/Projects/sailing/wrangler.toml): Worker + D1 + assets config
