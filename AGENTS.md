# AGENTS.md

Skyward is a demo Node.js app that is **SLOW ON PURPOSE**. The code behind the
`CHAOS_*` flags in `src/app.js` contains intentional anti-patterns (sequential
awaits, an O(n²) dedupe, missing timeouts). Do **NOT** refactor, optimise or
"fix" them. Fixes are already implemented behind the flags (`false` path).

## Run

    cp -n .env.example .env
    npm install
    npm run dev          # starts postgres (docker), seeds, starts partners + app
    npm run verify       # curls /health and /api/search, exits 0 on success
    npm run stop:all

## Ports

    3000  app (all chaos on)
    3001  app-fixed (ENABLE_CHAOS=false)
    4001–4004  mock partners (SkyJet, AeroLuz, Nimbus, Zephyr)
    5432  postgres

## Elastic

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` in `.env`,
then `npm run restart:elastic`. Never commit `.env`.

## Deploy

    docker compose up -d      # db, partners, app, app-fixed

## Conventions

- ESM only (`"type": "module"` in package.json). No CommonJS `require()` in `src/`.
- No OpenTelemetry code in `src/` — EDOT is loaded via `--import @elastic/opentelemetry-node`.
- Node >= 20.6 (required for `--env-file` and `--import`).
- Run `npm run verify` after any change to confirm the golden path still works.
- Run `npm test` to run the smoke test suite.
