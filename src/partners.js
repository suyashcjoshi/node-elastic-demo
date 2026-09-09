// Mock partner fare APIs — intentionally NOT instrumented with EDOT.
// Stands in for four real third-party airline search APIs.
// One process, four HTTP servers on ports 4001–4004.
import http from 'node:http';

const FARES_PER_PARTNER = parseInt(process.env.FARES_PER_PARTNER || '3000');
const BASE_LATENCY_MS   = parseInt(process.env.PARTNER_LATENCY_MS || '80');
const FAIL_RATE         = parseFloat(process.env.PARTNER_FAIL_RATE || '0.03');
const chaosEnabled      = process.env.ENABLE_CHAOS !== 'false';
const CHAOS_PARTNER     = chaosEnabled && process.env.CHAOS_PARTNER !== 'false';

const PARTNERS = {
  4001: { name: 'SkyJet',  code: 'SJ' },
  4002: { name: 'AeroLuz', code: 'AL' },
  4003: { name: 'Nimbus',  code: 'NB' },
  4004: { name: 'Zephyr',  code: 'ZP' },
};

// Partners share ~67% of flights (codeshares) so deduplication is meaningful.
// Prices differ per partner on the same flight, enabling cheapest-wins dedupe.
function generateFares(port, origin, destination, date) {
  const { name, code } = PARTNERS[port];
  const portOffset = port - 4001; // 0–3
  const fares = [];

  for (let i = 0; i < FARES_PER_PARTNER; i++) {
    const isShared = i % 3 !== 2;
    const flightNum = isShared ? `MW${String(i).padStart(4, '0')}` : `${code}${String(1000 + i).padStart(4, '0')}`;
    const airline   = isShared ? 'MultiAir' : name;

    const depHour = 6 + (i % 16);
    const depMin  = ((i * 7) % 12) * 5;
    const dur     = 90 + (i % 300);
    const arrMins = depHour * 60 + depMin + dur;

    const pad = (n) => String(n).padStart(2, '0');
    const departure = `${pad(depHour)}:${pad(depMin)}`;
    const arrival   = `${pad(Math.floor(arrMins / 60) % 24)}:${pad(arrMins % 60)}`;

    // Deterministic base; portOffset shifts price ~$5–20 per partner
    const priceCents = Math.max(5000, 8000 + ((i * 97 + portOffset * 1500) % 42000));

    fares.push({ id: `${flightNum}_${date}`, airline, flightNumber: flightNum, origin, destination, departure, arrival, durationMins: dur, priceCents });
  }
  return fares;
}

function createPartnerServer(port) {
  const isZephyr = port === 4004;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method !== 'GET' || url.pathname !== '/fares') {
      res.writeHead(404); res.end('Not found'); return;
    }

    const { origin, destination, date } = Object.fromEntries(url.searchParams);

    // Zephyr chaos: extreme latency + 503s when CHAOS_PARTNER is on
    if (isZephyr && CHAOS_PARTNER) {
      if (Math.random() < 0.15) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service unavailable');
        return;
      }
      await new Promise((r) => setTimeout(r, 4000));
    } else {
      // Regular random failures for all partners
      if (Math.random() < FAIL_RATE) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service unavailable');
        return;
      }
      await new Promise((r) => setTimeout(r, BASE_LATENCY_MS));
    }

    const fares = generateFares(port, origin, destination, date);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fares));
  });

  server.listen(port, () => {
    console.log(`${PARTNERS[port].name} listening on :${port}`);
  });
}

for (const port of [4001, 4002, 4003, 4004]) {
  createPartnerServer(port);
}
