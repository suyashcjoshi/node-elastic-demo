# AGENTS.md

Skyward for Business is a demo Node.js app that is **BROKEN ON PURPOSE**. It contains four intentional bugs:

1. **CHAOS_STAIRCASE** — sequential partner `await`s in `src/app.js`
2. **CHAOS_GAP** — O(n²) dedupe blocks the event loop in `src/app.js`
3. **CHAOS_PARTNER** — no outbound timeout on Penguin Air in `src/app.js`
4. **Missing `await`** — `pool.query()` in `/api/chat` is not awaited → TypeError → 500

Do **NOT** refactor, optimise or "fix" any of these. The CHAOS flags already have correct implementations behind the `false` path. The missing-await bug in `/api/chat` is intentional and must stay.

## Run

    cp -n .env.example .env
    npm install
    npm run dev          # starts postgres (docker), seeds, starts partners + app
    npm run verify       # checks /health, /api/search, /api/insights, /api/chat, /api/book; exits 0 on success
    npm run stop:all

## Ports

    3000  app (all chaos on)
    3001  app-fixed (ENABLE_CHAOS=false)
    4001  PuffinAir (PF)
    4002  GooseJet (GJ)
    4003  Pelican Air (PA)
    4004  Penguin Air (PN) — flaky when PENGUIN_DEGRADED=true
    5432  postgres

## API endpoints

    GET  /health                                              — liveness check
    GET  /api/search?origin&destination&date&user&sort&purpose — fan-out to 4 partners, dedupe, return top 50
    GET  /api/insights?origin&destination&user               — avg price + pct change vs prev month + recent searches
    POST /api/chat     { message, user }                     — keyword-based canned reply; has a missing-await bug → 500
    POST /api/book     { flight_id, user }                   — confirm with partner; 502 when CHAOS_PARTNER=true

    Each partner also exposes:
    GET /confirm?flight_id=<id>  — confirmation endpoint called by /api/book

## Chaos flags

| Flag | `true` (default) | `false` |
|---|---|---|
| `CHAOS_STAIRCASE` | Partners called one at a time (staircase in traces) | `Promise.allSettled` fan-out |
| `CHAOS_GAP` | O(n²) dedupe blocks event loop ~700 ms | `Map`-based O(n) dedupe |
| `CHAOS_PARTNER` | No outbound timeout; Penguin's 5.2 s latency flows through | `AbortSignal.timeout(1500)`, held-fare fallback |
| `ENABLE_CHAOS` | — | Forces all three flags to `false` |
| `PENGUIN_DEGRADED` | Penguin Air adds 5.2 s + 15% 503 | Penguin behaves normally |

## Elastic

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` in `.env`,
then `npm run restart:elastic`. Never commit `.env`.

## Repo

https://github.com/suyashcjoshi/elastic-observability-nodejs-demo

## Deploy

    docker compose up -d      # db, partners, app, app-fixed

## Conventions

- ESM only (`"type": "module"` in package.json). No CommonJS `require()` in `src/`.
- No OpenTelemetry code in `src/` — EDOT is loaded via `--import @elastic/opentelemetry-node`.
- Node >= 20.6 (required for `--env-file` and `--import`).
- Run `npm run verify` after any change to confirm the golden path still works.
- Run `npm test` to run the smoke test suite.
- Every response carries `X-Request-Id: req_<12hex>` — generated per-request by request ID middleware.
