# Skyward: Learn why Node.js app is slow and how to make it fast with OpenTelemetry & Elastic

[![Open in GitHub Codespaces](https://img.shields.io/badge/Open_in-GitHub_Codespaces-181717?style=for-the-badge&logo=github&logoColor=white)](https://codespaces.new/suyashcjoshi/node-elastic-demo?quickstart=1)
[![Observed with Elastic EDOT](https://img.shields.io/badge/Observed_with-Elastic_EDOT-00BFB3?style=for-the-badge&logo=elastic&logoColor=white)](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node)
[![Node 20.6+](https://img.shields.io/badge/node-%E2%89%A5_20.6-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](LICENSE)

Skyward is a small flight-search site that calls four partner APIs, merges the results and shows the cheapest fares. It is slow on purpose. The code contains three common Node.js mistakes, each behind a flag, so you can find them in Elastic Observability, fix them one at a time and watch the page get faster.

The app is plain Express, Postgres and pino. There is no OpenTelemetry code in it. Everything Elastic shows comes from one start-up flag:

```sh
node --import @elastic/opentelemetry-node src/app.js
```

> **This is a learning demo, not a template.** The slow code is intentional. Do not copy the `CHAOS_*` paths into a real service.

<!-- TODO: add screenshots: search page with timer, trace waterfall, /health with no spans, dependencies view -->

## What you will see

| Problem | Symptom | Where Elastic shows it | Fix |
|---|---|---|---|
| Partners called one after another | Page takes the sum of all partner times | Trace waterfall: four HTTP spans in a staircase | `Promise.allSettled` |
| Merge step blocks the event loop | Every request slows down, even `/health` | `GET /health` taking ~700 ms with zero child spans; `nodejs.eventloop.delay` spikes | Map-based dedupe |
| One partner is slow and there is no timeout | A tail of requests waits 4 s, some fail | Dependencies view: one partner red; error trace linked to the pino log line | `AbortSignal.timeout(2000)`, return partial results |

Numbers are approximate and depend on your machine.

## Quick start (Codespaces, nothing to install)

1. Click the **Open in GitHub Codespaces** badge. After about two minutes the app is running on port 3000. If a tab does not open, use the **Ports** panel and click the globe next to port 3000.
2. Search **JFK → LHR** and watch the timer. Nothing is connected to Elastic yet.
3. Connect to Elastic:
   - Don't have Elastic yet? Start a free trial at [cloud.elastic.co/registration](https://cloud.elastic.co/registration) and choose **Serverless → Observability**.
   - In your project open **Add data → Application → OpenTelemetry** and copy the endpoint and API key.
   - In the Codespace, edit `.env`:
     ```
     OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-project>.ingest.<region>.elastic.cloud:443
     OTEL_EXPORTER_OTLP_HEADERS=Authorization=ApiKey <your-api-key>
     ```
   - Run `npm run restart:elastic`. After about a minute, `skyward-search` appears under **Observability → Services**.
4. Change one `CHAOS_*` flag in `.env`, run `npm run restart:elastic`, search again and compare in Kibana. See [The three problems](#the-three-problems).

Tip: save `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` as Codespaces secrets (GitHub **Settings → Codespaces → Secrets**). New Codespaces will then be pre-connected.

Useful in a Codespace: `npm run status` shows what is running, `cat /tmp/app.log` shows app logs, `bash .devcontainer/start.sh` resets everything.

## Quick start (local)

Requirements: Node.js 20.6 or newer, Docker (for Postgres), an Elastic Cloud project.

```bash
git clone https://github.com/suyashcjoshi/node-elastic-demo
cd node-elastic-demo
npm install
cp .env.example .env            # add your Elastic endpoint and API key

docker run --name skyward-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=skyward \
  -p 5432:5432 -d postgres:16
npm run seed

npm run start:partners          # terminal 1: four mock partner APIs
npm run start:plain             # terminal 2: the app, no Elastic yet
```

Open http://localhost:3000, search **JFK → LHR** and watch the timer. Then stop the app and start it with Elastic:

```bash
npm start
```

Optional: add these lines to `/etc/hosts` so the Dependencies view shows partner names instead of `localhost:4001`:

```
127.0.0.1 skyjet.partners.test
127.0.0.1 aeroluz.partners.test
127.0.0.1 nimbus.partners.test
127.0.0.1 zephyr.partners.test
```

## How it works

```
  Browser ── HTTP ──▶ skyward-search (Express · pino · PostgreSQL · EDOT) ── OTLP Collector ──▶ Elastic
                        │                  │
                        │ HTTP             │ SQL
                        ▼                  ▼
          four mock partner APIs (mock,     Postgres
          not instrumented)            search history, fare trends
          :4001 :4002 :4003 :4004
```

#### Stack:
- Node.js 22, Postgres 16, 
- `@elastic/opentelemetry-node` 1.17,
- Elastic Cloud Serverless


`GET /api/search` reads the user's recent searches and the route's average fare from Postgres, records the search, calls the four partners, merges and de-duplicates the fares, and returns the cheapest 50.

The partner APIs are mock servers in `src/partners.js`. They are not instrumented, so they appear in Elastic as external dependencies, the way real third-party APIs would.

Why `OTEL_SERVICE_NAME` matters: it is the name Kibana uses everywhere. Without it your data lands under `unknown_service:node`. This repo uses `skyward-search` for the slow app and `skyward-search-fixed` for the fast one, so you can compare them side by side.

## The three problems

### 1. Partners called one after another

**Look in Kibana:** Observability → Services → `skyward-search` → Transactions → `GET /api/search` → open a trace. The four partner HTTP spans start one after another, like a staircase.

**The code** (`CHAOS_STAIRCASE=true`):
```js
for (const partner of PARTNERS) {
  await fetch(partner.url + qs);   // each waits for the previous one
}
```

**Fix:** set `CHAOS_STAIRCASE=false`. The app uses `Promise.allSettled` and the four spans start together.

### 2. The merge step blocks the event loop

**Look in Kibana:** open a `GET /health` transaction recorded while the load generator is running. It takes about 700 ms and has no child spans: the process was busy running someone else's synchronous code. Then look at `nodejs.eventloop.delay.p50` and `p90` in the service Metrics tab (or in Discover on the OpenTelemetry metrics data stream).

**The code** (`CHAOS_GAP=true`): a nested loop de-duplicates ~12,000 fares by comparing every fare with every other one. Node has one JavaScript thread, so while this runs nothing else does.

**Fix:** set `CHAOS_GAP=false`. The app de-duplicates with a `Map` and event-loop delay drops to a few milliseconds.

### 3. One slow partner with no timeout

**Look in Kibana:** Observability → Services → `skyward-search` → Dependencies (or the Service Map). Zephyr shows much higher latency and an error rate. Open an error trace and switch to its Logs tab: the pino line shows `partner: "Zephyr"` and the reason.

**The code** (`CHAOS_PARTNER=true`): the app calls partners with no timeout, so a slow Zephyr holds every search open for 4 s.

**Fix:** set `CHAOS_PARTNER=false`. The app wraps each call in `AbortSignal.timeout(2000)` and returns the results it has, with "3 of 4 partners responded" on the page. Zephyr is still slow (`ZEPHYR_DEGRADED=true`); you cannot fix a third party, but you can stop it from setting your response time.

## Slow and fast side by side

```bash
npm run start:partners     # terminal 1
npm start                  # terminal 2: all problems on, port 3000, skyward-search
npm run start:fast         # terminal 3: all problems off, port 3001, skyward-search-fixed
npm run load               # terminal 4: load on :3000
npm run load:fast          # terminal 5: same load on :3001
```

Open both ports in two browser windows and search at the same time. Both services appear in Observability → Services, so you can compare latency, errors and event-loop delay over the same time window.

## Configuration

All settings live in `.env`. Copy `.env.example` to start.

**Flags**

| Flag | Read by | `true` (default) | `false` |
|---|---|---|---|
| `CHAOS_STAIRCASE` | app | Partners called one at a time | `Promise.allSettled` |
| `CHAOS_GAP` | app | Nested-loop dedupe blocks the event loop | `Map` dedupe |
| `CHAOS_PARTNER` | app | No outbound timeout | `AbortSignal.timeout(2000)`, partial results |
| `ENABLE_CHAOS` | app | — | Forces the three flags above to `false` |
| `ZEPHYR_DEGRADED` | partners | Zephyr adds 4 s and fails 15% of calls | Zephyr behaves normally |

**Partner latency** (each with ±100 ms jitter): `PARTNER_LATENCY_SKYJET=600`, `PARTNER_LATENCY_AEROLUZ=900`, `PARTNER_LATENCY_NIMBUS=750`, `PARTNER_LATENCY_ZEPHYR=700`.

**Other:** `FARES_PER_PARTNER=3000` (lower it for faster local runs), `LOAD_CONNECTIONS=6`, `LOAD_DURATION_SECONDS=300`, `LOAD_URL`.

**Elastic:** `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `ELASTIC_OTEL_NODE_ENABLE_LOG_SENDING=true` (needed for logs to appear in Elastic).

## Learn more

- [EDOT Node.js setup](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/setup)
- [Quickstart: monitor application performance](https://www.elastic.co/docs/solutions/observability/get-started/quickstart-monitor-your-application-performance)
- [OpenTelemetry demo (Astronomy Shop), Elastic fork](https://github.com/elastic/opentelemetry-demo)
- No cloud account? Run Elastic locally: `curl -fsSL https://elastic.co/start-local | sh -s -- --edot`

<!-- TODO: add video and blog post links when published -->

## Contributing

Issues and pull requests are welcome. Please keep the `CHAOS_*` code paths intact; they are the point of the demo.

## License

Apache-2.0. See [LICENSE](LICENSE).

Elastic, Elasticsearch and Kibana are trademarks of Elastic NV.
