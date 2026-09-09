// Smoke-check the running app: /health and /api/search.
// Exits 0 on success, 1 on any failure.
const BASE = process.env.VERIFY_URL || 'http://localhost:3000';

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const date = tomorrow.toISOString().slice(0, 10);

let passed = 0;
let failed = 0;

async function check(label, url, assertions) {
  try {
    const res = await fetch(url);
    const body = await res.json();
    const errors = assertions(body, res).filter(([, ok]) => !ok).map(([msg]) => msg);
    if (errors.length === 0) {
      console.log(`PASS  ${label}`);
      passed++;
    } else {
      console.log(`FAIL  ${label}`);
      for (const e of errors) console.log(`      ✗ ${e}`);
      console.log('      body:', JSON.stringify(body).slice(0, 200));
      failed++;
    }
  } catch (err) {
    console.log(`FAIL  ${label} — ${err.message}`);
    failed++;
  }
}

await check('/health', `${BASE}/health`, (b) => [
  ['ok === true', b.ok === true],
]);

await check(
  '/api/search',
  `${BASE}/api/search?origin=JFK&destination=LHR&date=${date}&user=1`,
  (b) => [
    ['partners_total === 4', b.partners_total === 4],
    ['flights is a non-empty array', Array.isArray(b.flights) && b.flights.length > 0],
  ],
);

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
