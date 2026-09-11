// Smoke-check the running app. Exits 0 on success, 1 on any failure.
const BASE = process.env.VERIFY_URL || 'http://localhost:3000';

const nextThursday = (() => {
  const d = new Date();
  const gap = (4 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + gap);
  return d.toISOString().slice(0, 10);
})();

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${label} — ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── /health ───────────────────────────────────────────────────────────────────
await check('/health', async () => {
  const res = await fetch(`${BASE}/health`);
  const b = await res.json();
  assert(b.ok === true, 'ok !== true');
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id header');
});

// ── /api/search — LHR→SFO must return ≥10 real fares ─────────────────────────
let searchedFareId = null;
await check('/api/search (LHR→SFO)', async () => {
  const res = await fetch(
    `${BASE}/api/search?origin=LHR&destination=SFO&date=${nextThursday}&user=1&sort=fastest`
  );
  assert(res.ok, `HTTP ${res.status}`);
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  const b = await res.json();
  assert(b.partners_total === 4, `partners_total ${b.partners_total} !== 4`);
  assert(Array.isArray(b.flights) && b.flights.length >= 10, `only ${b.flights?.length} flights`);
  // Realistic LHR→SFO fares are 600–1100 min and $400–$1200; filler fares (longer/pricier)
  // pad the response for O(n²) workload — at least 10 realistic fares must be present.
  const realistic = b.flights.filter(f =>
    f.durationMins >= 600 && f.durationMins <= 1100 &&
    f.priceCents >= 40000 && f.priceCents <= 120000
  );
  assert(realistic.length >= 10, `only ${realistic.length} realistic fares in range (600–1100 min, $400–$1200)`);
  const direct = realistic.filter(f => f.stops === 0);
  assert(direct.length >= 1, 'no direct flight among realistic results');
  searchedFareId = b.flights[0].id;
});

// ── /api/insights ─────────────────────────────────────────────────────────────
await check('/api/insights', async () => {
  const res = await fetch(`${BASE}/api/insights?origin=LHR&destination=SFO&user=1`);
  assert(res.ok, `HTTP ${res.status}`);
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  const b = await res.json();
  assert('avg_price_cents' in b, 'missing avg_price_cents');
  assert(Array.isArray(b.recent_searches), 'missing recent_searches array');
});

// ── /api/chat ─────────────────────────────────────────────────────────────────
await check('/api/chat (503 service unavailable)', async () => {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Is the direct flight available?', user: 1 }),
  });
  assert(res.status === 503, `expected 503, got ${res.status}`);
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  const b = await res.json();
  assert(b.error === 'service_unavailable', 'expected error=service_unavailable');
  assert(typeof b.request_id === 'string' && b.request_id.startsWith('req_'), 'missing request_id in body');
});

// ── /api/book ─────────────────────────────────────────────────────────────────
await check('/api/book (410 flight_not_available with message)', async () => {
  const flight_id = searchedFareId || `PN401_${nextThursday}`;
  const res = await fetch(`${BASE}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flight_id, user: 1 }),
  });
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  assert(res.status === 410, `expected 410, got ${res.status}`);
  const b = await res.json();
  assert(b.error === 'flight_not_available', 'expected error=flight_not_available');
  assert(typeof b.message === 'string' && b.message.length > 0, 'missing message in body');
  assert(typeof b.request_id === 'string' && b.request_id.startsWith('req_'),
    `missing or malformed request_id in body: ${JSON.stringify(b)}`);
});

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
