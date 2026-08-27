# Observe a Node.js Backend with Elastic using OpenTelemetry (EDOT)

End-to-end runbook: plain Express + Postgres app → full traces, metrics, and logs
in Elastic Serverless — **with zero code changes**, using the
[Elastic Distribution of OpenTelemetry Node.js](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node) (EDOT).

```
you → curl → [ storefront-api (Express) ] → [ Postgres ]
                     │
                     └── EDOT Node.js (--import, no code changes)
                              │  OTLP (traces, metrics, logs)
                              ▼
                     [ Elastic Cloud Serverless ]  →  Kibana
```

Tested with: Node.js 22, `@elastic/opentelemetry-node` 1.17.0, Express 4, pg 8, pino 10, Postgres 16.

---

## 0. Prerequisites

- **Node.js 20.6+ or 18.19+** (a current LTS like 22 is ideal — `node --import` needs a modern runtime)
- **Docker** (only for Postgres — the app itself runs on bare Node)
- **curl** (traffic generation)
- An email address for the free **Elastic Cloud trial**

---

## 1. Create an Elastic Serverless Observability project

1. Go to **https://cloud.elastic.co** and sign up for the free trial.
2. Create a new project → choose the **Serverless** deployment type → project type **Elastic for Observability**. Pick any cloud provider/region. Wait ~1–2 min for it to provision.
3. In your new project, go to **Add data → Application → OpenTelemetry**.
4. On that page, note two values (keep this tab open):
   - **`OTEL_EXPORTER_OTLP_ENDPOINT`** — the managed OTLP ingest URL. Copy it **verbatim** from the UI.
   - Click **Create API key** and copy the key. It's shown once.

> 🎬 Video note: this page literally shows the exact export commands for your project — great to show on screen.

---

## 2. Run the app (uninstrumented first)

Start Postgres:

```bash
docker run --name storefront-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=storefront \
  -p 5432:5432 -d postgres:16
```

Install and start the app **plain** (no instrumentation yet):

```bash
npm install
npm run start:plain
```

Smoke test in a second terminal:

```bash
curl localhost:3000/health          # {"status":"ok"}
curl localhost:3000/products        # 4 seeded products
curl -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"productId":1,"quantity":2}' # creates an order
curl localhost:3000/products/999    # 404 (logged as a warning)
curl localhost:3000/error           # 500 (deliberate — for the errors demo)
curl localhost:3000/slow            # ~2s (deliberate — for the alert demo)
```

> 🎬 Video beat: open Kibana → Applications now. **Nothing there.** That's the "before".

---

## 3. Instrument with EDOT Node.js — zero code changes

Stop the app (Ctrl+C). The entire instrumentation is: **one package, three env vars, one flag.**

The package is already in `package.json` (`npm install` got it). In a fresh project it would be:

```bash
npm install --save @elastic/opentelemetry-node
```

Configure (paste your two values from step 1):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="<paste the endpoint from Kibana, verbatim>"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=ApiKey <paste your API key>"
export OTEL_SERVICE_NAME="storefront-api"
```

⚠️ The header value is `Authorization=ApiKey <key>` — note the **space** between
`ApiKey` and the key, and no colon. This is the #1 typo.

Start instrumented (this runs `node --import @elastic/opentelemetry-node app.js`):

```bash
npm start
```

Verify it's alive — the **first log line** is EDOT's preamble:

```
{"name":"elastic-otel-node", "preamble":true, "distroVersion":"1.17.0", ... "msg":"start EDOT Node.js"}
```

It even echoes which `OTEL_*` env vars it picked up — a built-in sanity check.

**What you get automatically:** Express + `pg` + HTTP spans (traces), process
CPU/memory metrics, and your `pino` logs shipped via OTLP **with `trace_id`/`span_id`
injected** so every log links to its trace. Still zero lines of OTel code in `app.js`.

---

## 4. Generate traffic

```bash
npm run load        # mixed browsing/orders/404s/occasional 500s — leave running
```

Give it 1–2 minutes. Telemetry is batched, so allow ~30–60 s before expecting data in Kibana.

---

## 5. Explore in Kibana

In your Serverless project (exact labels can shift between releases — note them during your dry run):

1. **Service inventory** — *Applications → Service Inventory*. `storefront-api`
   appears with latency, throughput, and failure rate.
2. **Trace waterfall** — click the service → **Transactions** → open `POST /orders`.
   The waterfall shows the Express route, the two `pg.query` spans, and the ~100 ms
   gap of the fake payment call. This is the money shot.
3. **Errors** — the **Errors** tab shows the deliberate `relation "a_table_that_does_not_exist"`
   failures from `/error`, with stack traces and occurrence charts.
4. **Logs ↔ trace correlation** — inside any transaction, use the related **logs**
   view (or *Discover/Logs* filtered by `service.name: storefront-api`). Open a log
   entry: it carries `trace_id`/`span_id`. Jump from a log line to its exact trace and back.
5. **Metrics** — the service **Metrics** tab shows CPU and memory
   (`process.cpu.*`, `process.memory.*` from EDOT's host-metrics defaults).
6. **Dependencies / service map** — shows `storefront-api → postgresql` as a
   downstream dependency with its own latency stats.

---

## 6. Create a latency alert, then trigger it

Create the rule:

1. Go to **Alerts** → **Manage Rules** → **Create rule** → choose **Latency threshold** (APM).
2. Configure: Service = `storefront-api` · Transaction type = `request` ·
   **When average latency is above `1500` ms for the last `1` minute** · Check every `1` minute.
3. Skip connectors (email/Slack is a great topic for video #2) — triggered alerts
   still appear in the **Alerts** table. Save.

Trigger it:

```bash
npm run load:slow    # hammers /slow (~2 s per request)
```

After 1–2 minutes the alert fires — show it in the Alerts view and as the red
health indicator on the service. Ctrl+C the slow load, switch back to `npm run load`,
and the alert **recovers** a couple of minutes later. Full lifecycle on camera.

---

## Troubleshooting (a.k.a. the gotchas segment)

| Symptom | Cause / fix |
|---|---|
| Service shows as `unknown_service:node` | `OTEL_SERVICE_NAME` wasn't set in the shell that started the app. |
| No data at all in Kibana | Header typo — must be `Authorization=ApiKey <key>` (space, no colon). Also check the endpoint was copied verbatim, and that you waited ~60 s. |
| App works but you want to see telemetry locally | Debug without Elastic: `OTEL_TRACES_EXPORTER=console npm start` prints spans to stdout. |
| `--import` errors | Node too old — needs 18.19+ / 20.6+. Check `node -v`. |
| Weird duplicate data | Never run EDOT alongside the classic `elastic-apm-node` agent in the same process. |
| DB errors on startup | Postgres container not running: `docker start storefront-db`. |

## Route map (what each endpoint is *for*)

| Route | Purpose in the demo |
|---|---|
| `GET /products`, `GET /products/:id` | Clean, fast traces; the 404 path emits a correlated `warn` log |
| `POST /orders` | Multi-span waterfall: SELECT → fake payment delay → INSERT |
| `GET /error` | Error traces + correlated `error` logs (Errors tab) |
| `GET /slow` | ~2 s DB sleep — triggers the latency alert |
| `GET /health` | Boring on purpose |

## Useful links

- EDOT Node.js setup docs — https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/setup
- Quickstart: monitor application performance — https://www.elastic.co/docs/solutions/observability/get-started/quickstart-monitor-your-application-performance
- Full microservices playground (Astronomy Shop, Elastic fork) — https://github.com/elastic/opentelemetry-demo
- No cloud? Local stack in one command: `curl -fsSL https://elastic.co/start-local | sh -s -- --edot`
