# Skyward Demo App

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/suyashcjoshi/node-elastic-demo?quickstart=1)

Skyward is a deliberately slow online travel agency flight aggregator demo wired with [Elastic Distribution of OpenTelemetry Node.js (EDOT)](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node) so you can watch Kibana diagnose three concurrent anti-patterns in a completely standard Node.js app — a sequential partner-call staircase, an event-loop–blocking dedupe, and a slow third-party API with no timeout. The app uses Express, Postgres, and pino with **zero OTel code**; all traces, metrics, and logs are captured automatically.

## Architecture

```
  Browser ────HTTP────▶  ┌────────────────────────────────────┐
                          │  skyward-search                    │──OTLP──▶ Elastic
                          │  Express · pino · pg               │          Kibana
                          │  + EDOT (zero OTel code)           │
                          └────────┬──────────────┬────────────┘
                                   │ HTTP          │ SQL
               ┌───────────────────┘               ▼
               │  partner APIs (uninstrumented)  Postgres
               │  skyjet.partners.test:4001
               │  aeroluz.partners.test:4002
               │  nimbus.partners.test:4003
               └─ zephyr.partners.test:4004
```

```sh
node --import @elastic/opentelemetry-node src/app.js   ← the only change
config: OTEL_EXPORTER_OTLP_ENDPOINT · OTEL_EXPORTER_OTLP_HEADERS · OTEL_SERVICE_NAME
```

What Elastic captures automatically, with no code changes:
- **Traces** — waterfall per request, spans for every HTTP call and SQL query
- **Metrics** — Node.js event-loop delay, CPU, memory, GC
- **Logs** — pino output correlated to traces by `trace_id`
- **Errors** — stack traces with the exact span that threw

## Try it in GitHub Codespaces

No local tooling required. A 2-core Codespace includes Node.js 22 and Postgres; Elastic stays in your Cloud account.

**Step 1 — launch the Codespace**

Click the badge at the top of this page (or [open directly](https://codespaces.new/suyashcjoshi/node-elastic-demo?quickstart=1)). After about two minutes the environment is ready and a browser tab opens automatically at port 3000. Search **JFK → LHR** and watch the timer. Nothing is connected to Elastic yet — you can see the app and explore the chaos flags without any credentials.

**Step 2 — connect to Elastic Cloud**

1. In [Elastic Cloud](https://cloud.elastic.co), open your Observability project → **Add data → Application → OpenTelemetry**. Copy the endpoint URL and the API key.
2. In the Codespace terminal, edit `.env`:
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-project>.ingest.<region>.elastic.cloud:443
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=ApiKey <your-api-key>
   ```
3. Restart the app with EDOT:
   ```bash
   npm run restart:elastic
   ```
After about a minute the service `skyward-search` appears in **Observability → Services** in Kibana.

**Step 3 — flip a chaos flag and compare**

Edit a `CHAOS_*` flag in `.env`, run `npm run restart:elastic` again, search again, and compare traces before and after in Kibana. See [The investigation](#the-investigation) below for what to look for.

> **Tip — save as Codespaces secrets:** Go to **GitHub Settings → Codespaces → Secrets** and add `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, and optionally `KIBANA_URL`. Future Codespaces will be pre-connected to Elastic and step 2 is just the `restart:elastic` command.

### Codespaces notes

- A 2-core machine is enough; Elastic is not running inside the Codespace.
- Ports are private to you — the forwarded URLs are not publicly accessible.
- The four mock partner APIs (ports 4001–4004) run inside the Codespace and are not exposed.
- `cat /tmp/app.log` — app logs. `cat /tmp/partners.log` — partner logs.
- `bash .devcontainer/start.sh` — reset everything (re-seeds the database, restarts both processes).

---

## Setup

### 1. Elastic Serverless project

Create a free trial at [cloud.elastic.co](https://cloud.elastic.co/registration) → **New project → Serverless → Observability**.

Go to **Add data → OpenTelemetry** and copy your endpoint + API key.

### 2. Clone and install

```bash
git clone https://github.com/suyashcjoshi/node-elastic-demo
cd node-elastic-demo
npm install
cp .env.example .env        # paste your endpoint and OTEL_EXPORTER_OTLP_HEADERS value here
```

**Optional:** set `KIBANA_URL` in `.env` to your Kibana deployment URL. This enables the **Open in Kibana ↗** link inside the app's debug drawer (visible with `?debug=1`).

**Why does `OTEL_SERVICE_NAME` matter?**
It is the primary key in every Kibana view — service inventory, transactions, dependency map, correlated logs. Without a meaningful name all your signals land in one undifferentiated bucket. With `skyward-search` you can open two services side-by-side in the same time window (`skyward-search` and `skyward-search-fixed`) and watch latency drop as you flip each chaos flag.

### 3. Add partner hostnames to /etc/hosts

```bash
sudo tee -a /etc/hosts <<'EOF'
127.0.0.1 skyjet.partners.test
127.0.0.1 aeroluz.partners.test
127.0.0.1 nimbus.partners.test
127.0.0.1 zephyr.partners.test
EOF
```

These aliases let Elastic display each partner by name in the Service Map and Dependency graph instead of showing all four partners as `localhost`. Without them every partner dependency resolves to the same node.

### 4. Start Postgres and seed data

```bash
docker run --name skyward-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=skyward \
  -p 5432:5432 -d postgres:16

npm run seed
```

### 5. Start everything

```bash
# Terminal 1 — four mock partner APIs (SkyJet :4001, AeroLuz :4002, Nimbus :4003, Zephyr :4004)
npm run start:partners

# Terminal 2 — skyward-search on :3000, sending telemetry to Elastic
npm start
```

Open **http://localhost:3000**, search **JFK → LHR**, and watch the timer. Expect ~3–4 s with all chaos flags on (partners are called serially; AeroLuz alone takes ~900 ms).

**Debug drawer:** it is hidden by default. Add `?debug=1` to the URL (`http://localhost:3000?debug=1`) or set `SHOW_DEBUG_GUIDE=true` in `.env` to reveal the investigation guide and the **Open in Kibana ↗** link. After a search completes a dot appears on the button to indicate traces were captured.


## The investigation

### Reveal 1 — the staircase

**Symptom:** every search takes ≥ 3× longer than the slowest single partner response.

**Where to look in Kibana:** Observability → Services → `skyward-search` → Transactions → `GET /api/search` → open any trace. In the **waterfall**, the four outbound HTTP spans are arranged as a staircase: SkyJet ~600 ms, then AeroLuz ~900 ms, then Nimbus ~750 ms, then Zephyr ~700 ms (each with ±100 ms jitter). Sequenced, they total ~3 s before the response can even start processing.

**Why it happens:** `CHAOS_STAIRCASE=true` uses:
```js
for (const partner of PARTNERS) {
  await fetch(partner.url + qs)   // each waits for the previous
}
```

**Fix:** set `CHAOS_STAIRCASE=false` in `.env` and restart. The waterfall now shows all four spans starting simultaneously. Partner time drops to ~0.9 s (dominated by AeroLuz).

---

### Reveal 2 — the event-loop freeze

**Symptom:** even after fixing the staircase, searches still take 700–900 ms. The `/health` endpoint — which does no I/O — starts responding slowly too.

**Where to look in Kibana:**

1. Observability → Services → `skyward-search` → Transactions → `GET /health`. Open a sampled transaction during load: it shows ~700 ms wall time with **zero child spans** — the process was running someone else's synchronous code when this request arrived.

2. Find `nodejs.eventloop.delay.p50` and `nodejs.eventloop.delay.p90` on the **Metrics** tab. If they are not visible there, use Discover or Lens on the `metrics-apm.*` data stream.

**Why it happens:** `CHAOS_GAP=true` deduplicates fares with a synchronous O(n²) nested loop:
```js
for (let i = 0; i < allFares.length; i++) {
  for (let j = 0; j < unique.length; j++) {
    if (allFares[i].id === unique[j].id) { dup = true; break; }
  }
}
```
At `FARES_PER_PARTNER=3000` there are 12,000 fares across four partners — roughly 72 million string comparisons on the JS thread — targeting ~700 ms of blocking per request.

**Fix:** set `CHAOS_GAP=false`. The app switches to a Map-keyed O(n) dedupe. Event-loop delay returns to single-digit milliseconds.

---

### Reveal 3 — the zombie partner

**Symptom:** after fixing reveals 1 and 2, most searches are fast but a tail of requests still spikes above 4 seconds with only 3 of 4 partners responding.

**Where to look in Kibana:**

1. Observability → **Service Map** (or Services → `skyward-search` → Dependencies). `zephyr.partners.test:4004` shows dramatically higher p99 latency and a non-trivial error rate compared to the other three partners.

2. Click through to an error trace on that dependency. The Zephyr span is red. Switch to the **Logs** tab inside the trace — the correlated pino log line shows `"partner": "Zephyr"` and `"reason": "timeout"` or `"non-2xx"`.

**Why it happens:** `ZEPHYR_DEGRADED=true` (read by `partners.js`) makes the Zephyr mock add 4,000 ms of latency and return HTTP 503 15% of the time. This is a **third-party problem** — you cannot fix Zephyr. The fix is to stop letting it set your p95: set `CHAOS_PARTNER=false` in `.env` so the app wraps every outbound fetch in `AbortSignal.timeout(2000)` and returns partial results in ≤2 s instead of waiting 4 s.

**Important distinction:** `CHAOS_PARTNER` in `app.js` controls **only** whether the app applies that timeout. `ZEPHYR_DEGRADED` in `.env` controls the partner server's actual bad behaviour. You can leave `ZEPHYR_DEGRADED=true` while flipping `CHAOS_PARTNER=false` to show that you can't fix third parties — you can only protect yourself.

---

## Run chaos and fixed side by side

```bash
# Terminal 1 — partners (serves both)
npm run start:partners

# Terminal 2 — all chaos on, :3000, service name: skyward-search
npm start

# Terminal 3 — all chaos off, :3001, service name: skyward-search-fixed
npm run start:fast

# Terminal 4 — load :3000     Terminal 5 — load :3001 (identical pressure)
npm run load                   npm run load:fast
```

Run both load generators simultaneously so both services are under identical load during the recording. Both appear in Kibana's **Observability → Services** simultaneously. Compare their latency distributions, error rates, and event-loop metrics in the same time window. The difference is stark.

## Generate load

```bash
npm run load          # targets :3000
npm run load:fast     # targets :3001 (LOAD_URL=http://localhost:3001)
```

Runs autocannon with 6 concurrent connections (`LOAD_CONNECTIONS`) for 5 minutes (`LOAD_DURATION_SECONDS=300`) against `/api/search` with randomised origins, destinations, dates, and users, plus a 1 req/s trickle to `/health`. Timeout is 30 s per request so Zephyr-side requests are not counted as network errors. The health latency in the results reveals exactly how badly the event loop is blocked.

## npm scripts & commands

| Script | What it does |
|---|---|
| `npm run seed` | Create tables and seed users + fare trends in Postgres |
| `npm run start:partners` | Start all four mock partner servers (reads `.env` for latency/chaos vars) |
| `npm start` | Start skyward-search on :3000 with EDOT and all chaos flags on |
| `npm run start:fast` | Start skyward-search on :3001 with all chaos off (`skyward-search-fixed`) |
| `npm run load` | Load test against :3000 (6 connections, 5 min) |
| `npm run load:fast` | Load test against :3001 |

## Chaos flags (`.env`)

| Flag | Location | true (default) | false |
|---|---|---|---|
| `CHAOS_STAIRCASE` | app | Sequential partner fetches | `Promise.allSettled` fan-out |
| `CHAOS_GAP` | app | O(n²) dedupe blocks event loop | Map-keyed O(n) dedupe |
| `CHAOS_PARTNER` | app | No outbound timeout → Zephyr holds requests open | `AbortSignal.timeout(2000)` per partner |
| `ZEPHYR_DEGRADED` | partners | Zephyr adds +4 s latency and 15% 503 | Zephyr uses normal latency |
| `ENABLE_CHAOS` | app | — | Forces all three app flags off |

`ZEPHYR_DEGRADED` lives in `partners.js` and is independent of the app chaos flags. You can leave `ZEPHYR_DEGRADED=true` (simulating a broken third party) while setting `CHAOS_PARTNER=false` (app-side fix: add a timeout). This mirrors reality — you can't fix a third party; the fix is to stop letting it set your p95.

`SHOW_DEBUG_GUIDE=true` reveals the **Debug with Elastic** button and guide drawer. Alternatively, load the page with `?debug=1`. Default is hidden so the UI is clean for demos.

`FARES_PER_PARTNER=3000` is calibrated to produce ~700 ms of blocking with `CHAOS_GAP=true`. Lower it for faster iteration during development.

Set `KIBANA_URL=https://your-deployment.kb.region.aws.elastic.cloud` to enable the **Open in Kibana ↗** deep-link in the debug drawer.

## Per-partner latency tuning

| Env var | Default | Partner |
|---|---|---|
| `PARTNER_LATENCY_SKYJET` | 600 ms | SkyJet |
| `PARTNER_LATENCY_AEROLUZ` | 900 ms | AeroLuz |
| `PARTNER_LATENCY_NIMBUS` | 750 ms | Nimbus |
| `PARTNER_LATENCY_ZEPHYR` | 700 ms | Zephyr |

All values have ±100 ms random jitter applied. Override any of them in `.env`.

## Useful links

- [Companion Skyward blog post](#) — full walkthrough with Kibana screenshots
- [EDOT Node.js setup docs](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/setup)
- [Quickstart: monitor application performance](https://www.elastic.co/docs/solutions/observability/get-started/quickstart-monitor-your-application-performance)
- [Full microservices playground (Astronomy Shop)](https://github.com/elastic/opentelemetry-demo)
- No cloud? `curl -fsSL https://elastic.co/start-local | sh -s -- --edot`
