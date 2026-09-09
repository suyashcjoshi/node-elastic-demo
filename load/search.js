import autocannon from 'autocannon';

const BASE = process.env.LOAD_URL || 'http://localhost:3000';

const ORIGINS = ['JFK', 'LAX', 'ORD', 'ATL', 'DFW', 'SFO', 'SEA', 'BOS', 'MIA', 'AMS'];
const DESTS   = ['LHR', 'CDG', 'NRT', 'SYD', 'DXB', 'GRU', 'LAX', 'JFK', 'ATL', 'DFW'];
const USERS   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1 + Math.floor(Math.random() * 89));
  return d.toISOString().slice(0, 10);
}

// Pre-generate 2000 distinct search paths; autocannon cycles through them.
const searchPaths = Array.from({ length: 2000 }, () => {
  let orig, dest;
  do { orig = rand(ORIGINS); dest = rand(DESTS); } while (orig === dest);
  return `/api/search?origin=${orig}&destination=${dest}&date=${randomDate()}&user=${rand(USERS)}`;
});

console.log(`Starting load against ${BASE} — 5 min, 15 connections`);

// Primary: randomised flight searches
const searchRun = autocannon({
  url: BASE,
  connections: 15,
  duration: 300,
  requests: searchPaths.map((path) => ({ method: 'GET', path })),
});

// Secondary: 1 req/s health checks (measures event-loop blocking)
const healthRun = autocannon({
  url: BASE,
  connections: 1,
  duration: 300,
  requests: [{ method: 'GET', path: '/health' }],
  overallRate: 1,
});

autocannon.track(searchRun, { renderProgressBar: true });

searchRun.on('done', (result) => {
  console.log('\n── Search results ──────────────────────────────────');
  console.log(`Requests : ${result.requests.total}`);
  console.log(`Errors   : ${result.errors + result.non2xx}`);
  console.log(`Latency  p50=${result.latency.p50}ms  p95=${result.latency.p95}ms  p99=${result.latency.p99}ms`);
  console.log(`Throughput: ${result.requests.average} req/s`);
});

healthRun.on('done', (result) => {
  console.log('\n── Health results ──────────────────────────────────');
  console.log(`Requests : ${result.requests.total}`);
  console.log(`Latency  p50=${result.latency.p50}ms  p99=${result.latency.p99}ms`);
  console.log('(high health latency = event loop blocked by CHAOS_GAP)');
});
