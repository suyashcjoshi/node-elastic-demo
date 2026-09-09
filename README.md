# Skyward — see why a Node.js app is slow, with zero instrumentation code

[![Open in GitHub Codespaces](https://img.shields.io/badge/Open_in-GitHub_Codespaces-181717?style=for-the-badge&logo=github&logoColor=white)](https://codespaces.new/suyashcjoshi/node-elastic-demo?quickstart=1)
[![Observed with Elastic EDOT](https://img.shields.io/badge/Observed_with-Elastic_EDOT-00BFB3?style=for-the-badge&logo=elastic&logoColor=white)](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node)
[![Node 20.6+](https://img.shields.io/badge/node-%E2%89%A5_20.6-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![CI](https://img.shields.io/github/actions/workflow/status/suyashcjoshi/node-elastic-demo/ci.yml?style=for-the-badge&label=CI)](https://github.com/suyashcjoshi/node-elastic-demo/actions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](LICENSE)

Skyward is a small flight-search site that calls four partner APIs, merges the results and shows the cheapest fares. It is slow on purpose. The code contains three common Node.js mistakes, each behind a flag, so you can find them in Elastic Observability, fix them one at a time and watch the page get faster.

The app is plain Express, Postgres and pino. There is no OpenTelemetry code in it. Everything Elastic shows comes from one start-up flag:

```sh
node --import @elastic/opentelemetry-node src/app.js
```

> **This is a learning demo, not a template.** The slow code is intentional. Do not copy the `CHAOS_*` paths into a real service.
>
> **Using an AI coding tool?** Point it at [AGENTS.md](AGENTS.md). It has the run, verify and deploy commands and the rule about not "fixing" the intentional slow code.

<!-- TODO: add screenshots: search page with timer, trace waterfall, /health with no spans, dependencies view -->

## What you will see

| Problem | Symptom | Where Elastic shows it | Fix |
|---|---|---|---|
| Partners called one after another | Page takes the sum of all partner times | Trace waterfall: four HTTP spans in a staircase | `Promise.allSettled` |
| Merge step blocks the event loop | Every request slows down, even `/health` | `GET /health` taking ~700 ms with zero child spans; `nodejs.eventloop.delay` spikes | Map-based dedupe |
| One partner is slow and there is no timeout | A tail of requests waits 4 s, some fail | Dependencies view: one partner red; error trace linked to the pino log line | `AbortSignal.timeout(2000)`, return partial results |

Numbers are approximate and depend on your machine.

## Quick start

The same five commands work on your laptop, in a Codespace and for an AI coding tool.

**Requirements:** Node.js 20.6 or newer and Docker (for Postgres). An Elastic Cloud project is only needed for step 3.

### Step 1 — run the slow app

```bash
git clone https://github.com/suyashcjoshi/node-elastic-demo && cd node-elastic-demo
npm install
cp .env.example .env
npm run dev          # starts Postgres, seeds it, starts the partners and the app
npm run verify       # PASS means everything is working
```

Open http://localhost:3000, search **JFK → LHR** and watch the timer. Nothing is connected to Elastic yet; this is the "before".

**In a Codespace:** click the badge at the top instead of cloning. After about two minutes the app is running on port 3000. If a tab does not open, use the **Ports** panel and click the globe next to port 3000.

### Step 2 — connect to Elastic

1. Don't have Elastic yet? Start a free trial at [cloud.elastic.co/registration](https://cloud.elastic.co/registration) and choose **Serverless → Observability**.
2. In your project open **Add data → Application → OpenTelemetry** and copy the endpoint and API key.
3. Edit `.env`:
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-project>.ingest.<region>.elastic.cloud:443
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=ApiKey <your-api-key>
   ```
4. Run `npm run restart:elastic`. After about a minute, `skyward-search` appears under **Observability → Services**.

Tip for Codespaces: save the two values as Codespaces secrets (GitHub **Settings → Codespaces → Secrets**). New Codespaces will then be pre-connected and step 2 is just the restart command.

### Step 3 — fix one problem at a time

Change one `CHAOS_*` flag in `.env`, run `npm run restart:elastic`, search again and compare in Kibana. See [The three problems](#the-three-problems) for what to look for.

### Expected results

- `curl localhost:3000/health` returns `{"ok":true}`.
- The app log (`cat /tmp/app.log`) contains a JSON line with `"msg":"listening"` and `"port":3000`.
- A JFK → LHR search takes several seconds with all flags on and about a second with all flags off.
- `npm run verify` prints `PASS` and exits 0.
- `npm run stop:all` stops everything; `npm run status` then shows nothing running.

## How it works

```
  Browser ──HTTP──▶ skyward-search (Express · pino · pg · EDOT) ──OTLP──▶ Elastic
                        │                  │
                        │ HTTP             │ SQL
                        ▼                  ▼
          four partner APIs (mock,     Postgres
          not instrumented)            search history, fare trends
          :4001 :4002 :4003 :4004
```

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
npm run dev                # partners + slow app on :3000 (skyward-search)
npm run start:fast         # fixed app on :3001 (skyward-search-fixed)
npm run load               # load on :3000
npm run load:fast          # same load on :3001
```

Open both ports in two browser windows and search at the same time. Both services appear in Observability → Services, so you can compare latency, errors and event-loop delay over the same time window.

## Run each process separately

If you want to watch each process's output (for example while recording), start them in their own terminals instead of using `npm run dev`:

```bash
docker run --name skyward-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=skyward \
  -p 5432:5432 -d postgres:16
npm run seed
npm run start:partners     # terminal 1: four mock partner APIs
npm run start:plain        # terminal 2: the app without Elastic
npm start                  # ...or the app with Elastic
```

**Optional, requires sudo, skip in automation:** add these lines to `/etc/hosts` so the Dependencies view shows partner names instead of `localhost:4001`. Everything works without this step.

```
127.0.0.1 skyjet.partners.test
127.0.0.1 aeroluz.partners.test
127.0.0.1 nimbus.partners.test
127.0.0.1 zephyr.partners.test
```

## Deploy with Docker

```bash
docker compose up -d       # db, partners, app (:3000) and app-fixed (:3001)
docker compose down
```

All configuration comes from `.env`, so set the Elastic values there first if you want telemetry from the containers.

## Configuration

All settings live in `.env`. Copy `.env.example` to start; it lists every variable with a comment.

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

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start Postgres (Docker), seed, start partners and the app without Elastic |
| `npm run verify` | Check `/health` and `/api/search`; prints PASS or FAIL |
| `npm run status` | Show whether the app and partners are running |
| `npm run stop:all` | Stop everything started by `dev` |
| `npm run restart:elastic` | Restart the app with Elastic (EDOT) |
| `npm run start:fast` | Start the fixed app on :3001 as `skyward-search-fixed` |
| `npm run load` / `npm run load:fast` | Load test :3000 / :3001 |
| `npm test` | Smoke test used by CI |
| `npm run seed`, `start:partners`, `start:plain`, `npm start` | Individual processes, see above |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Service appears as `unknown_service:node` | `OTEL_SERVICE_NAME` not set | Set it in `.env` and restart |
| Traces appear but no logs | Log sending is off by default | `ELASTIC_OTEL_NODE_ENABLE_LOG_SENDING=true` |
| Nothing appears in Kibana | Endpoint or API key typo, or app started before `.env` was edited | Check `.env`, run `npm run restart:elastic`, wait a minute |
| 502 in Codespaces | App is not running | `npm run status`, then `npm run dev` |
| `bad option: --env-file` | Node older than 20.6 | Upgrade Node |
| `ECONNREFUSED 5432` | Postgres not running | `npm run dev` (starts it) or start the Docker container |
| `npm run verify` fails right after `dev` | App still starting | Wait a few seconds and run it again |
| Partners show as `localhost:400x` | No hostnames mapped | Optional `/etc/hosts` step above |

## Tested with

Node.js 22, Postgres 16, `@elastic/opentelemetry-node` 1.17, Elastic Cloud Serverless (September 2026).

## Learn more

- [EDOT Node.js setup](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/setup)
- [Quickstart: monitor application performance](https://www.elastic.co/docs/solutions/observability/get-started/quickstart-monitor-your-application-performance)
- [OpenTelemetry demo (Astronomy Shop), Elastic fork](https://github.com/elastic/opentelemetry-demo)
- No cloud account? Run Elastic locally: `curl -fsSL https://elastic.co/start-local | sh -s -- --edot`

<!-- TODO: add video and blog post links when published -->

## Contributing

Issues and pull requests are welcome. Please keep the `CHAOS_*` code paths intact; they are the point of the demo. Run `npm run verify` and `npm test` before opening a PR.

## License

Apache-2.0. See [LICENSE](LICENSE).

Elastic, Elasticsearch and Kibana are trademarks of Elasticsearch B.V. This is a personal demo repository. See [Elastic's brand guidelines](https://brandfolder.com/elastic) before reusing the logo.