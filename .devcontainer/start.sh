#!/usr/bin/env bash
set -uo pipefail

WORKSPACE=/workspaces/node-elastic-demo
cd "$WORKSPACE"

# Wait for Postgres to accept connections, then seed.
# psql is not installed in the app image, so we retry npm run seed instead.
echo "⏳ Waiting for Postgres…"
seeded=false
for i in $(seq 1 30); do
  if npm run seed > /tmp/seed.log 2>&1; then
    seeded=true
    break
  fi
  echo "   attempt $i/30 — retrying in 2 s…"
  sleep 2
done

if [ "$seeded" = false ]; then
  echo "❌ Postgres did not become ready after 60 s. Check /tmp/seed.log" >&2
  exit 1
fi
echo "✅ Database ready"

# Kill any previous instances so re-running this script is safe.
pkill -f src/partners.js 2>/dev/null || true
pkill -f src/app.js     2>/dev/null || true
sleep 1

# Start mock partners (SkyJet :4001, AeroLuz :4002, Nimbus :4003, Zephyr :4004).
# Reads latency/chaos vars from .env; DATABASE_URL from the container environment takes precedence.
nohup node --env-file=.env src/partners.js > /tmp/partners.log 2>&1 &
echo "🤝 Mock partners starting (logs: /tmp/partners.log)"

# Start the app without EDOT — works without an Elastic Cloud project.
# To connect Elastic, edit .env and run: npm run restart:elastic
nohup npm run start:plain > /tmp/app.log 2>&1 &
echo "✈  Skyward starting on :3000 (logs: /tmp/app.log)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Skyward is running on port 3000 — no Elastic connected yet."
echo " A browser tab should open automatically."
echo " Search JFK → LHR and watch the timer."
echo ""
echo " To connect to Elastic Cloud:"
echo "   1. Edit .env: set OTEL_EXPORTER_OTLP_ENDPOINT and"
echo "                     OTEL_EXPORTER_OTLP_HEADERS"
echo "   2. Run: npm run restart:elastic"
echo ""
echo " See README → 'Try it in GitHub Codespaces' for full instructions."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
