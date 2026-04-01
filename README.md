# Optimist Class Scoring (Cloudflare Workers + D1)

Web app for managing Optimist regatta scoring with:
- Sailor management (add, update, delete, merge when valid)
- Regattas identified by name and date range
- Race results entry and update
- Per-regatta sail numbers
- Current regatta and ranking list views
- Public results page (no auth) and admin page (Google auth)

## Tech Stack
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Assets (`public/`)
- Vanilla HTML/CSS/JS frontend

## Scoring Rules
- Low-point scoring (`1` for first place, `2` for second, etc.)
- `DNC` = `N`
- `DNS`, `DNF`, `RET`, `OCS`, `RAF` = `N + 1`
- `DSQ`, `BFD`, `UFD`, `DNE` = `N + 2`
- Discards: `floor(number_of_races / 6)` (applies to current regatta and ranking list)
- Ranking list uses the last 18 races
- Race labels in ranking are normalized as `R1 ... R18` (oldest to newest)
- Tie-break by: net, then best race, then best 2-race sum, best 3-race sum, etc.
- If all tie-break steps are equal, sailors share the same rank

`N` is the number of sailors in the scoring series.

## Prerequisites
- Node.js 20+
- Cloudflare account
- Wrangler CLI login

```bash
npx wrangler login
```

## Setup
1. Install dependencies:

```bash
npm install
```

2. Create D1 databases:

```bash
npx wrangler d1 create optimist-scores
npx wrangler d1 create optimist-scores-preview
```

3. Update `wrangler.toml`:
- set `database_id`
- set `preview_database_id`

4. Set required Worker secrets (never commit secrets in git):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put AUTH_SECRET
```

5. Apply migrations:

```bash
npm run db:migrate
npm run db:migrate:local
```

## Run Locally
```bash
npm run dev
```

Default local URL:
- `http://localhost:8787`

## Deploy
```bash
npm run deploy
```

## App Routes
- Admin UI (auth): `/`
- Public results (no auth): `/results.html`
- Admin API state: `/api/state`
- Public API state: `/api/public-state`

## Repository Notes
- Use `wrangler.toml` as public-safe config.
- Keep local/private values in ignored local files and Wrangler secrets.
- `wrangler.local.toml` is git-ignored.

## Project Structure
- `src/worker.js`: Worker API, auth, ranking logic, D1 access
- `public/index.html`: Admin UI
- `public/results.html`: Public read-only results UI
- `migrations/`: D1 schema migrations
- `wrangler.toml`: public-safe Worker configuration
