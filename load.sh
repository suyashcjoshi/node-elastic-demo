#!/bin/bash
# Traffic generator for the storefront-api demo.
#
#   ./load.sh          normal mixed traffic (browsing, orders, some 404s/errors)
#   ./load.sh slow     hammer the /slow endpoint to trigger the latency alert
#
# Stop with Ctrl+C.

BASE="${BASE_URL:-http://localhost:3000}"
MODE="${1:-normal}"

echo "Sending $MODE traffic to $BASE (Ctrl+C to stop)..."

if [ "$MODE" = "slow" ]; then
  while true; do
    curl -s -o /dev/null -w "GET /slow -> %{http_code} (%{time_total}s)\n" "$BASE/slow"
  done
fi

while true; do
  R=$((RANDOM % 100))
  if [ "$R" -lt 40 ]; then
    curl -s -o /dev/null -w "GET /products -> %{http_code}\n" "$BASE/products"
  elif [ "$R" -lt 70 ]; then
    ID=$(( (RANDOM % 4) + 1 ))
    curl -s -o /dev/null -w "GET /products/$ID -> %{http_code}\n" "$BASE/products/$ID"
  elif [ "$R" -lt 90 ]; then
    ID=$(( (RANDOM % 4) + 1 ))
    QTY=$(( (RANDOM % 3) + 1 ))
    curl -s -o /dev/null -w "POST /orders -> %{http_code}\n" \
      -X POST "$BASE/orders" \
      -H 'Content-Type: application/json' \
      -d "{\"productId\":$ID,\"quantity\":$QTY}"
  elif [ "$R" -lt 96 ]; then
    curl -s -o /dev/null -w "GET /products/999 -> %{http_code}\n" "$BASE/products/999"
  else
    curl -s -o /dev/null -w "GET /error -> %{http_code}\n" "$BASE/error"
  fi
  sleep 0.4
done
