# Skyward

You open the search page and hit **Search flights**. The timer climbs past six seconds. Your colleagues ping you before lunch. Three complaints, same route.

The application has no errors. CPU is fine. The database is fast. Nothing is obviously broken — and that is exactly the problem.

Skyward is a deliberately crippled online-travel-agency flight aggregator wired with [Elastic Distribution of OpenTelemetry Node.js (EDOT)](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node) so you can watch Kibana diagnose three concurrent antipatterns: a sequential partner-call staircase, an event-loop–blocking dedupe, and a slow third-party API with no timeout. The app is completely standard — Express, Postgres, pino — with **zero OTel code**. Instrumentation happens at process startup via `--import`.

---

## Architecture

```
              ╔═══════════════════════════════════════════╗
              ║   + EDOT Node.js  ·  0 lines of OTel code ║
  Browser /   ║  ┌───────────────────────────────────────┐ ║  OTLP  ┌─────────────────────┐
  curl  ──────╫─▶│         Your Node.js app              │─╫───────▶│       Elastic       │
  HTTP        ║  │     Express · pino · pg · app.js      │ ║ traces │  Kibana · Serverless│
              ║  └────────────────────┬──────────────────┘ ║ metrics└─────────────────────┘
              ╚═══════════════════════╪═══════════════════╝  logs
                                     │ SQL
                                     ▼
                              ┌──────────────┐
                              │   Postgres   │
                              │   (docker)   │
                              └──────────────┘

  node --import @elastic/opentelemetry-node app.js   ← the only change
  config: OTEL_EXPORTER_OTLP_ENDPOINT · OTEL_API_KEY · OTEL_SERVICE_NAME
```

What Elastic captures automatically, with no code changes:
- **Traces** — waterfall per request, spans for every HTTP call and SQL query
- **Metrics** — Node.js event-loop delay, CPU, memory, GC
- **Logs** — pino output correlated to traces by `trace_id`
- **Errors** — stack traces with the exact span that threw

---

## Setup

### 1. Elastic Serverless project

Create a free trial at [cloud.elastic.co](https://cloud.elastic.co/registration) → **New project → Serverless → Observability**.

Go to **Add data → APM → OpenTelemetry** and copy your endpoint + API key.

### 2. Clone and install

```bash
git clone https://github.com/suyashcjoshi/node-elastic-demo
cd node-elastic-demo
npm install
cp .env.example .env        # paste your endpoint and API key here
```

**Optional:** set `KIBANA_URL` in `.env` to your Kibana deployment URL. This enables the **Open in Kibana ↗** link inside the app's debug drawer.

**Why does `OTEL_SERVICE_NAME` matter?**
It is the primary key in every Kibana view — service inventory, APM transactions, dependency map, correlated logs. Without a meaningful name all your signals land in one undifferentiated bucket. With `skyward-search` you can open two services side-by-side in the same time window (`skyward-search` and `skyward-search-fixed`) and watch latency drop as you flip each chaos flag.

### 3. Start Postgres and seed data

```bash
docker run --name skyward-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=skyward \
  -p 5432:5432 -d postgres:16

npm run seed
```

### 4. Start everything

```bash
# Terminal 1 — four mock partner APIs (SkyJet :4001, AeroLuz :4002, Nimbus :4003, Zephyr :4004)
npm run start:partners

# Terminal 2 — skyward-search on :3000, sending telemetry to Elastic
npm start
```

Open **http://localhost:3000**, search JFK → LHR, and watch the timer. Expect 6–12 seconds with all chaos flags on.

After the search completes, a dot appears on the **Debug with Elastic** button in the header. Click it to open the investigation guide alongside a direct link to your Kibana deployment.

---

## The investigation

### Reveal 1 — the staircase

**Symptom:** every search takes ≥ 4× longer than any single partner response.

**Where to look in Kibana:** Observability → Services → `skyward-search` → Transactions → `GET /api/search` → open any trace. In the **waterfall**, the four outbound HTTP spans are arranged as a staircase: AeroLuz starts only after SkyJet finishes. Each partner takes ~80–100 ms, but sequenced they add up to ~400 ms before the response can even start processing.

**Why it happens:** `CHAOS_STAIRCASE=true` uses:
```js
for (const partner of PARTNERS) {
  await fetch(partner.url + qs)   // each waits for the previous
}
```

**Fix:** set `CHAOS_STAIRCASE=false` in `.env` and restart. The waterfall now shows all four spans starting simultaneously. Partner time drops from ~400 ms to ~100 ms.

---

### Reveal 2 — the event-loop freeze

**Symptom:** even after fixing the staircase, searches still take 700–900 ms. The `/health` endpoint — which does no I/O — starts responding slowly too.

**Where to look in Kibana:**

1. Observability → Services → `skyward-search` → **Metrics** tab. Find `nodejs.eventloop.delay.p99`. You will see spikes of 700+ ms coinciding exactly with search requests.

2. Observability → **Logs Explorer**, filter `url.path: /health`. Even the health check shows the same latency spikes. A health endpoint that blocks is a textbook sign of synchronous CPU work on the JavaScript thread.

**Why it happens:** `CHAOS_GAP=true` deduplicates fares with a synchronous O(n²) nested loop:
```js
for (let i = 0; i < allFares.length; i++) {
  for (let j = 0; j < unique.length; j++) {
    if (allFares[i].id === unique[j].id) { dup = true; break; }
  }
}
```
At `FARES_PER_PARTNER=3000` there are 12,000 fares across four partners. The inner loop grows to ~8,000 comparisons per outer iteration — roughly 72 million string comparisons on the JS thread — targeting ~700 ms of blocking per request.

**Fix:** set `CHAOS_GAP=false`. The app switches to a Map-keyed O(n) dedupe. Event-loop delay returns to single-digit milliseconds.

---

### Reveal 3 — the zombie partner

**Symptom:** after fixing reveals 1 and 2, most searches are fast but a tail of requests still spikes above 4 seconds with only 3 of 4 partners responding.

**Where to look in Kibana:**

1. Observability → **Service Map** (or Services → `skyward-search` → Dependencies). You will see `localhost:4004` with dramatically higher p99 latency and a non-trivial error rate compared to the other three partners.

2. Click through to an error trace on that dependency. The Zephyr span is red. Switch to the **Logs** tab inside the trace — the correlated pino log line shows `"partners_responded": 3`.

**Why it happens:** `CHAOS_PARTNER=true` makes the Zephyr mock (port 4004) add 4,000 ms of latency and return HTTP 503 15% of the time. Crucially, `app.js` sets **no outbound timeout**, so every slow Zephyr call holds the request open for the full 4 seconds.

**Fix:** set `CHAOS_PARTNER=false`. Zephyr behaves like the other partners, and `app.js` wraps every fetch in `AbortSignal.timeout(2000)` — Zephyr is cut off at 2 seconds and the search returns partial results immediately.

---

## Run chaos and fixed side by side

```bash
# Terminal 1 — partners (serves both)
npm run start:partners

# Terminal 2 — all chaos on, :3000, service name: skyward-search
npm start

# Terminal 3 — all chaos off, :3001, service name: skyward-search-fixed
npm run start:fast

# Terminal 4 — load both ports
npm run load
```

In Kibana's **Observability → Services** both services appear simultaneously. Compare their latency distributions, error rates, and event-loop metrics in the same time window. The difference is stark.

---

## Generate load

```bash
npm run load
```

Runs autocannon with 15 concurrent connections against `/api/search` with randomised origins, destinations, dates, and users for 5 minutes, plus a 1 req/s trickle to `/health`. The health latency in the results tells you exactly how badly the event loop is blocked.

---

## npm scripts

| Script | What it does |
|---|---|
| `npm run seed` | Create tables and seed users + fare trends in Postgres |
| `npm run start:partners` | Start all four mock partner servers (one process, ports 4001–4004) |
| `npm start` | Start skyward-search on :3000 with EDOT and all chaos flags on |
| `npm run start:fast` | Start skyward-search on :3001 with all chaos off (`skyward-search-fixed`) |
| `npm run load` | Run the autocannon load test against :3000 |

## Chaos flags (`.env`)

| Flag | true (default) | false |
|---|---|---|
| `CHAOS_STAIRCASE` | Sequential partner fetches | `Promise.allSettled` fan-out |
| `CHAOS_GAP` | O(n²) dedupe blocks event loop | Map-keyed O(n) dedupe |
| `CHAOS_PARTNER` | Zephyr: +4 s latency, 15% 503, no timeout | Zephyr normal, `AbortSignal.timeout(2000)` |
| `ENABLE_CHAOS` | — | Forces all three off |

`FARES_PER_PARTNER=3000` is calibrated to produce ~700 ms of blocking with `CHAOS_GAP=true`. Lower it for faster iteration during development.

Set `KIBANA_URL=https://your-deployment.kb.region.aws.elastic.cloud` to enable the **Open in Kibana ↗** deep-link in the app's debug drawer.

---

## Useful links

- [Companion Skyward blog post](#) — full walkthrough with Kibana screenshots
- [EDOT Node.js setup docs](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/setup)
- [Quickstart: monitor application performance](https://www.elastic.co/docs/solutions/observability/get-started/quickstart-monitor-your-application-performance)
- [Full microservices playground (Astronomy Shop)](https://github.com/elastic/opentelemetry-demo)
- No cloud? `curl -fsSL https://elastic.co/start-local | sh -s -- --edot`
