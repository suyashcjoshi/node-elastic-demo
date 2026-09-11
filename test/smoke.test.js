// Smoke test: spawns partners + app, verifies all key endpoints, then shuts down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForPort(port, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    function attempt() {
      const sock = net.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`port ${port} not open after ${timeout}ms`));
        setTimeout(attempt, 250);
      });
    }
    attempt();
  });
}

let appPort;
let partnersProc;
let appProc;

const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/skyward';

const nextThursday = (() => {
  const d = new Date();
  const gap = (4 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + gap);
  return d.toISOString().slice(0, 10);
})();

let cachedFareId = null;

before(async () => {
  appPort = await freePort();

  const baseEnv = {
    ...process.env,
    DATABASE_URL: DB_URL,
    FARES_PER_PARTNER: '50',
    ENABLE_CHAOS: 'false',
    PARTNER_LATENCY_MS: '10',
    PARTNER_FAIL_RATE: '0',
  };

  partnersProc = spawn('node', ['src/partners.js'], { cwd: ROOT, env: baseEnv, stdio: 'pipe' });
  appProc = spawn('node', ['src/app.js'], {
    cwd: ROOT,
    env: { ...baseEnv, PORT: String(appPort) },
    stdio: 'pipe',
  });

  partnersProc.on('error', (err) => { throw err; });
  appProc.on('error', (err) => { throw err; });

  await Promise.all([
    waitForPort(4001),
    waitForPort(4002),
    waitForPort(4003),
    waitForPort(4004),
    waitForPort(appPort),
  ]);
});

after(() => {
  partnersProc?.kill();
  appProc?.kill();
});

test('GET /health returns ok with X-Request-Id', async () => {
  const res = await fetch(`http://localhost:${appPort}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(
    res.headers.get('x-request-id')?.startsWith('req_'),
    'X-Request-Id header missing or wrong format'
  );
});

test('GET /api/search LHR→SFO returns ≥10 fares in valid ranges', async () => {
  const res = await fetch(
    `http://localhost:${appPort}/api/search?origin=LHR&destination=SFO&date=${nextThursday}&user=1&sort=fastest`
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-request-id')?.startsWith('req_'), 'X-Request-Id missing');

  const body = await res.json();
  assert.equal(body.partners_total, 4, 'partners_total should be 4');
  assert.ok(Array.isArray(body.flights) && body.flights.length >= 10, `only ${body.flights?.length} flights`);

  // Filler fares (>1100 min, >$1200) pad the volume for O(n²) workload.
  // At least 10 realistic LHR→SFO fares must be within expected ranges.
  const realistic = body.flights.filter(f =>
    f.durationMins >= 600 && f.durationMins <= 1100 &&
    f.priceCents >= 40000 && f.priceCents <= 120000
  );
  assert.ok(realistic.length >= 10, `only ${realistic.length} realistic fares in range`);

  const direct = realistic.find(f => f.stops === 0);
  assert.ok(direct, 'no direct flight among realistic results');

  cachedFareId = body.flights[0].id;
});

test('GET /api/insights returns 200 with avg_price_cents and X-Request-Id', async () => {
  const res = await fetch(
    `http://localhost:${appPort}/api/insights?origin=LHR&destination=SFO&user=1`
  );
  assert.equal(res.status, 200, 'insights status should be 200');
  assert.ok(res.headers.get('x-request-id')?.startsWith('req_'), 'X-Request-Id missing');

  const body = await res.json();
  assert.ok('avg_price_cents' in body, 'body should have avg_price_cents');
  assert.ok(Array.isArray(body.recent_searches), 'body should have recent_searches array');
});

test('POST /api/chat returns 503 service_unavailable with X-Request-Id', async () => {
  const res = await fetch(`http://localhost:${appPort}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Is the direct flight available?', user: 1 }),
  });
  assert.equal(res.status, 503, 'chat status should be 503');
  assert.ok(res.headers.get('x-request-id')?.startsWith('req_'), 'X-Request-Id missing');

  const body = await res.json();
  assert.equal(body.error, 'service_unavailable', 'error should be service_unavailable');
  assert.ok(
    typeof body.request_id === 'string' && body.request_id.startsWith('req_'),
    `request_id missing or malformed: ${JSON.stringify(body)}`
  );
});

test('POST /api/book returns 410 flight_not_available with message and request_id', async () => {
  const flight_id = cachedFareId || `PN401_${nextThursday}`;
  const res = await fetch(`http://localhost:${appPort}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flight_id, user: 1 }),
  });
  assert.ok(res.headers.get('x-request-id')?.startsWith('req_'), 'X-Request-Id missing');
  assert.equal(res.status, 410, `expected 410, got ${res.status}`);

  const body = await res.json();
  assert.equal(body.error, 'flight_not_available', 'error should be flight_not_available');
  assert.ok(typeof body.message === 'string' && body.message.length > 0, 'message missing');
  assert.ok(
    typeof body.request_id === 'string' && body.request_id.startsWith('req_'),
    `request_id missing or malformed: ${JSON.stringify(body)}`
  );
});
