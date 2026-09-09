// Smoke test: spawns partners + app, verifies /health and /api/search, then shuts down.
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

  // Wait for all partner ports and the app port to accept connections
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

test('GET /health returns ok', async () => {
  const res = await fetch(`http://localhost:${appPort}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET /api/search returns flights from all 4 partners', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);

  const res = await fetch(
    `http://localhost:${appPort}/api/search?origin=JFK&destination=LHR&date=${date}&user=1`,
  );
  const body = await res.json();

  assert.equal(body.partners_total, 4, 'partners_total should be 4');
  assert.ok(Array.isArray(body.flights) && body.flights.length > 0, 'flights should be non-empty');
});
