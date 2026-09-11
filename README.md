# Skyward for Business — Node.js observability demo with Elastic EDOT

[![Open in GitHub Codespaces](https://img.shields.io/badge/Open_in-GitHub_Codespaces-181717?style=for-the-badge&logo=github&logoColor=white)](https://codespaces.new/suyashcjoshi/elastic-observability-nodejs-demo?quickstart=1)
[![Observed with Elastic EDOT](https://img.shields.io/badge/Observed_with-Elastic_EDOT-00BFB3?style=for-the-badge&logo=elastic&logoColor=white)](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node)
[![Node 20.6+](https://img.shields.io/badge/node-%E2%89%A5_20.6-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![CI](https://img.shields.io/github/actions/workflow/status/suyashcjoshi/elastic-observability-nodejs-demo/ci.yml?style=for-the-badge&label=CI)](https://github.com/suyashcjoshi/elastic-observability-nodejs-demo/actions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](LICENSE)

A realistic Node.js web app with four intentional bugs — three behind feature flags and one plain coding mistake. Use Elastic Observability to find each one, fix it, and watch the app recover.

The app is plain Express, Postgres and pino. There is no OpenTelemetry code in it. Everything Elastic shows comes from one startup flag:

```sh
node --import @elastic/opentelemetry-node src/app.js
```

> **This is a learning demo, not a template.** The slow code is intentional. Do not copy the `CHAOS_*` paths into a real service.
>
> **Using an AI coding tool?** Point it at [AGENTS.md](AGENTS.md). It has the run, verify and deploy commands and the rule about not "fixing" the intentional slow code.

## Demo App Probelm & Solution with help of Elastic's Observability

| What User sees | Root cause | Elastic shows it | Fix |
|---|---|---|---|
| Flights timer climbs around 5 seconds; results trickle in slowly | `CHAOS_STAIRCASE`: partners called one after another with sequential `await` | Trace waterfall — four HTTP spans in a staircase, each starting after the previous ends | `CHAOS_STAIRCASE=false` → `Promise.allSettled` |
| "Customer Care" chat shows typing dots then "Error: unexpected server response." | Missing `await` on `pool.query()` in `/api/chat` → `TypeError: Cannot read properties of undefined` → 500 | Error traces in Elastic with `TypeError` and stack pointing to the missing `await` | Add `await` before `pool.query(...)` |
| After fixing the chat bug, replies are very slow; browser shows "Still connecting..." | `CHAOS_GAP`: O(n²) nested-loop dedupe blocks the Node.js event loop | `GET /health` takes ~700 ms with zero child spans; `nodejs.eventloop.delay` spikes | `CHAOS_GAP=false` → Map-based O(n) dedupe |
| Booking fails with an error and a request ID even for real flights | `CHAOS_PARTNER`: no outbound timeout on Penguin Air's `/confirm` call; Penguin takes 4 s + 15% 503 | Dependencies view: Penguin Air red; error traces linked to pino log lines | `CHAOS_PARTNER=false` → `AbortSignal.timeout(1500)`, held-fare fallback |

Numbers depend on your machine. `FARES_PER_PARTNER=3000` gives ~700 ms event-loop blocking; lower it for faster local runs. Penguin Air's fixed 5.2 s delay plus the sequential staircase puts the total consistently above 5 s.

## Quick start

The same five commands work on your laptop, in a Codespace and for an AI coding tool.

**Requirements:** Node.js 20.6 or newer and Docker (for Postgres). An Elastic Cloud project is only needed for step 2.

### Step 1 — run the slow app

```bash
git clone https://github.com/suyashcjoshi/elastic-observability-nodejs-demo && cd elastic-observability-nodejs-demo
npm install
cp .env.example .env
npm run dev          # starts Postgres, seeds it, starts the partners and the app
npm run verify       # PASS means everything is working
```

Open http://localhost:3000, search **LHR → SFO** (pre-filled), date defaults to tomorrow — click Search.

**In a Codespace:** click the badge at the top instead of cloning. After about two minutes the app is running on port 3000.

### Step 2 — connect to Elastic

1. Don't have Elastic yet? Start a free trial at [cloud.elastic.co/registration](https://cloud.elastic.co/registration) and choose **Serverless → Observability**.
2. In your project open **Add data → Application → OpenTelemetry** and copy the endpoint and API key.
3. Edit `.env`:
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-project>.ingest.<region>.elastic.cloud:443
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=ApiKey <your-api-key>
   ```
4. Run `npm run restart:elastic`. After about a minute, `skyward-search` appears under **Observability → Services**.

### Step 3 — fix one problem at a time

Change one `CHAOS_*` flag in `.env`, run `npm run restart:elastic`, search again, compare in Kibana.

### Expected results

- `curl localhost:3000/health` returns `{"ok":true}` with `X-Request-Id` header.
- A LHR → SFO search takes 5–6 s with all flags on and under 2 s with all flags off.
- `npm run verify` prints 5 PASS and exits 0.
- `npm run stop:all` stops everything.

## How it works

```
  Browser (Skyward UI)
    ├── GET  /api/search   ──▶  skyward-search (Express · pino · EDOT)  ──OTLP──▶ Elastic
    ├── GET  /api/insights ──▶       │                    │
    ├── POST /api/book     ──▶       │ HTTP               │ SQL
    └── POST /api/chat     ──▶       │                    ▼
         (Customer Care widget)      │              Postgres :5432
                                     ▼         users · search_history
                         four mock partner APIs   fare_trends · bookings
                         PuffinAir  :4001
                         GooseJet   :4002
                         Pelican Air :4003
                         Penguin Air :4004  ← flaky (5.2 s + 15% 503)
```

`GET /api/search` reads the user's recent searches and the route's average fare from Postgres, records the search, fans out to all four partners, merges and de-duplicates fares, then returns the top 50 sorted by fastest/cheapest/best.

`POST /api/book` looks up the fare in an in-memory cache populated by the preceding search, then calls `/confirm` on the selling partner's port. With `CHAOS_PARTNER=true` there is no timeout, so Penguin Air's 5.2 s latency flows through and the 15% 503 rate produces booking failures with a traceable request ID.

`POST /api/chat` replies with canned keyword-matched answers and personalises the response using the user's last search destination. The chat widget shows "Still connecting…" if the response takes more than 4 s, which happens when `CHAOS_GAP` blocks the event loop. A separate coding bug (missing `await` on the database call) currently makes every chat request return 500; that bug is found and fixed independently of the CHAOS flags.

Partner APIs are mock HTTP servers in `src/partners.js`. They are not instrumented, so they appear in Elastic as external dependencies — the way real third-party APIs would.

## The three problems

### 1. Partners called one after another (CHAOS_STAIRCASE)

**Look in Kibana:** Observability → Services → `skyward-search` → Transactions → `GET /api/search` → open a trace. The four partner HTTP spans start one after another like a staircase.

```js
// CHAOS_STAIRCASE=true: sequential awaits
for (const partner of PARTNERS) {
  await fetch(partner.url + qs);
}
// Fix: Promise.allSettled (all four start at once)
```

### 2. Merge step blocks the event loop (CHAOS_GAP)

**Look in Kibana:** open a `GET /health` transaction recorded while the load generator is running. It takes ~700 ms and has no child spans — the process was running synchronous JavaScript. Look at `nodejs.eventloop.delay.p50` in the service Metrics tab.

```js
// CHAOS_GAP=true: O(n²) nested loop on ~12,000 fares
for (let i = 0; i < allFares.length; i++) {
  for (let j = 0; j < unique.length; j++) { /* compare */ }
}
// Fix: Map-based dedup — O(n)
```

### 3. One partner is slow with no timeout (CHAOS_PARTNER)

**Look in Kibana:** Observability → Services → `skyward-search` → Dependencies. Penguin Air shows much higher latency and an error rate. Open an error trace and switch to Logs tab.

```js
// CHAOS_PARTNER=true: no timeout
const r = await fetch(confirmUrl);
// Fix: AbortSignal.timeout(1500) + held-fare fallback
const r = await fetch(confirmUrl, { signal: AbortSignal.timeout(1500) });
```

### 4. Chat always returns 500 (coding bug — no CHAOS flag)

**Look in Kibana:** Observability → Services → `skyward-search` → Errors. Every `POST /api/chat` shows a `TypeError: Cannot read properties of undefined (reading '0')`. Open the trace — the stack points straight to the missing `await`.

```js
// Bug: pool.query() is async; without await, history is a Promise object.
// Promise.rows is undefined, so [0] throws TypeError.
const history = pool.query('SELECT destination FROM search_history …');
const lastDest = history.rows[0].destination;   // ← TypeError

// Fix: add await
const history = await pool.query('SELECT destination FROM search_history …');
const lastDest = history.rows[0]?.destination;
```

## Slow and fast side by side

```bash
npm run dev                # partners + slow app on :3000
npm run start:fast         # fixed app on :3001
npm run load               # load on :3000
npm run load:fast          # same load on :3001
```

## Run each process separately

```bash
docker run --name skyward-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=skyward \
  -p 5432:5432 -d postgres:16
npm run seed
npm run start:partners     # terminal 1: four mock partner APIs
npm run start:plain        # terminal 2: the app without Elastic
npm start                  # ...or the app with Elastic
```

## Deploy with Docker

```bash
docker compose up -d       # db, partners, app (:3000) and app-fixed (:3001)
docker compose down
```

## Configuration

All settings live in `.env`. Copy `.env.example` to start.

**Chaos flags**

| Flag | Read by | `true` (default) | `false` |
|---|---|---|---|
| `CHAOS_STAIRCASE` | app | Sequential partner calls | `Promise.allSettled` |
| `CHAOS_GAP` | app | O(n²) dedupe blocks event loop | `Map` dedupe |
| `CHAOS_PARTNER` | app | No outbound timeout | `AbortSignal.timeout(1500)`, held-fare fallback |
| `ENABLE_CHAOS` | app | — | Forces all three to `false` |
| `PENGUIN_DEGRADED` | partners | Penguin Air adds 5.2 s + 15% 503 | Penguin behaves normally |

**Partner latency:** `PARTNER_LATENCY_MS=80` ms flat per request (global default, Penguin Air ignores this and always uses its own fixed delay).

**Other:** `FARES_PER_PARTNER=3000` (lower for faster local runs), `LOAD_CONNECTIONS=6`, `LOAD_DURATION_SECONDS=300`, `LOAD_URL`.

**Elastic:** `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `ELASTIC_OTEL_NODE_ENABLE_LOG_SENDING=true`.

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start Postgres (Docker), seed, start partners and app without Elastic |
| `npm run verify` | Check all endpoints; prints PASS or FAIL |
| `npm run status` | Show whether the app and partners are running |
| `npm run stop:all` | Stop everything started by `dev` |
| `npm run restart:elastic` | Restart the app with Elastic (EDOT) |
| `npm run start:fast` | Start the fixed app on :3001 as `skyward-search-fixed` |
| `npm run load` / `npm run load:fast` | Load test :3000 / :3001 |
| `npm test` | Smoke test suite |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Service appears as `unknown_service:node` | `OTEL_SERVICE_NAME` not set | Set it in `.env` and restart |
| Traces appear but no logs | Log sending is off by default | `ELASTIC_OTEL_NODE_ENABLE_LOG_SENDING=true` |
| Nothing in Kibana | Endpoint or API key wrong | Check `.env`, run `npm run restart:elastic`, wait a minute |
| 502 in Codespaces | App not running | `npm run status`, then `npm run dev` |
| `bad option: --env-file` | Node older than 20.6 | Upgrade Node |
| `ECONNREFUSED 5432` | Postgres not running | `npm run dev` or start the Docker container |
| `npm run verify` fails right after `dev` | App still starting | Wait a few seconds and retry |
| Booking shows error with request ID | `CHAOS_PARTNER=true` + Penguin degraded | Expected — the error code is traceable in Elastic; set `CHAOS_PARTNER=false` to see the fix |

## Tested with

Node.js 22, Postgres 16, `@elastic/opentelemetry-node` 1.17, Elastic Cloud Serverless (September 2026).

## Learn more

- [EDOT Node.js setup](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/setup)
- [Quickstart: monitor application performance](https://www.elastic.co/docs/solutions/observability/get-started/quickstart-monitor-your-application-performance)
- [OpenTelemetry demo (Astronomy Shop), Elastic fork](https://github.com/elastic/opentelemetry-demo)
- No cloud account? Run Elastic locally: `curl -fsSL https://elastic.co/start-local | sh -s -- --edot`

## Contributing

Issues and pull requests are welcome. Keep the `CHAOS_*` code paths intact — they are the point of the demo. Run `npm run verify` and `npm test` before opening a PR.

## License

Apache-2.0. See [LICENSE](LICENSE).

Elastic, Elasticsearch and Kibana are trademarks of Elastic NV.
