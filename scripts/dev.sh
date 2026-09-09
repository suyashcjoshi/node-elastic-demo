#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || cp .env.example .env

# Start postgres via docker if not already running
if ! docker ps --filter name=skyward-db --filter status=running -q 2>/dev/null | grep -q .; then
  if docker ps -a --filter name=skyward-db -q 2>/dev/null | grep -q .; then
    echo "Starting existing skyward-db container..."
    docker start skyward-db
  else
    echo "Creating skyward-db container..."
    docker run --name skyward-db \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=skyward \
      -p 5432:5432 -d postgres:16
  fi
fi

echo "Waiting for Postgres to be ready..."
for i in $(seq 1 30); do
  if docker exec skyward-db pg_isready -U postgres >/dev/null 2>&1; then
    echo "Postgres ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Postgres did not become ready after 60 s." >&2
    exit 1
  fi
  echo "  attempt $i/30 — retrying in 2 s..."
  sleep 2
done

npm run seed

# Kill any previous instances so re-running is idempotent
pkill -f src/partners.js 2>/dev/null || true
pkill -f src/app.js     2>/dev/null || true
sleep 1

nohup node --env-file=.env src/partners.js >/tmp/partners.log 2>&1 &
echo $! > /tmp/skyward-partners.pid
echo "Partners starting on :4001-4004 (logs: /tmp/partners.log)"

nohup npm run start:plain >/tmp/app.log 2>&1 &
echo $! > /tmp/skyward-app.pid
echo "Skyward starting on :3000 (logs: /tmp/app.log)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " App:      http://localhost:3000"
echo " Partners: http://localhost:4001 .. :4004"
echo " Logs:     /tmp/app.log  /tmp/partners.log"
echo " Stop:     npm run stop:all"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"