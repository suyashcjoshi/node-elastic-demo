// Mock partner fare APIs — NOT instrumented with EDOT.
// Four HTTP servers on ports 4001–4004.
import http from 'node:http';

const FARES_PER_PARTNER = parseInt(process.env.FARES_PER_PARTNER || '3000');
const BASE_LATENCY_MS   = parseInt(process.env.PARTNER_LATENCY_MS || '80');
const FAIL_RATE         = parseFloat(process.env.PARTNER_FAIL_RATE || '0.03');

const PARTNERS = {
  4001: { name: 'PuffinAir',   code: 'PF' },
  4002: { name: 'GooseJet',    code: 'GJ' },
  4003: { name: 'Pelican Air', code: 'PA' },
  4004: { name: 'Penguin Air', code: 'PN' },
};

// ── Realistic LHR→SFO schedule ────────────────────────────────────────────────
// carriers: [] = all partners; [4004] = Penguin Air exclusive
const LHR_SFO = [
  // Direct (640–670 min ≈ 10h40m–11h10m)
  { id:'PN401', airline:'Penguin Air', code:'PN', fn:'PN401', dep:'08:30', arr:'11:10', dur:640, stops:0, via:null,  base:78000,  carriers:[4004] },
  { id:'PF101', airline:'PuffinAir',   code:'PF', fn:'PF101', dep:'09:15', arr:'12:05', dur:650, stops:0, via:null,  base:84900,  carriers:[] },
  { id:'GJ201', airline:'GooseJet',    code:'GJ', fn:'GJ201', dep:'11:00', arr:'13:50', dur:650, stops:0, via:null,  base:77500,  carriers:[] },
  { id:'PA301', airline:'Pelican Air', code:'PA', fn:'PA301', dep:'14:30', arr:'17:20', dur:650, stops:0, via:null,  base:92000,  carriers:[] },
  { id:'PF102', airline:'PuffinAir',   code:'PF', fn:'PF102', dep:'16:45', arr:'19:45', dur:660, stops:0, via:null,  base:98500,  carriers:[] },
  { id:'GJ202', airline:'GooseJet',    code:'GJ', fn:'GJ202', dep:'19:00', arr:'22:00', dur:660, stops:0, via:null,  base:105000, carriers:[] },
  { id:'PA302', airline:'Pelican Air', code:'PA', fn:'PA302', dep:'22:30', arr:'01:40', dur:670, stops:0, via:null,  base:71900,  carriers:[] },
  // 1-stop (780–960 min ≈ 13h–16h)
  { id:'PN402', airline:'Penguin Air', code:'PN', fn:'PN402', dep:'07:00', arr:'15:45', dur:825, stops:1, via:'JFK', base:52000,  carriers:[4004] },
  { id:'PF103', airline:'PuffinAir',   code:'PF', fn:'PF103', dep:'10:00', arr:'19:30', dur:870, stops:1, via:'ORD', base:49000,  carriers:[] },
  { id:'GJ203', airline:'GooseJet',    code:'GJ', fn:'GJ203', dep:'08:00', arr:'20:05', dur:905, stops:1, via:'LAX', base:56000,  carriers:[] },
  { id:'PA303', airline:'Pelican Air', code:'PA', fn:'PA303', dep:'09:30', arr:'18:20', dur:830, stops:1, via:'BOS', base:61000,  carriers:[] },
  { id:'PF104', airline:'PuffinAir',   code:'PF', fn:'PF104', dep:'11:30', arr:'20:30', dur:840, stops:1, via:'ATL', base:58000,  carriers:[] },
  { id:'GJ204', airline:'GooseJet',    code:'GJ', fn:'GJ204', dep:'13:00', arr:'23:00', dur:900, stops:1, via:'DFW', base:54500,  carriers:[] },
  { id:'PA304', airline:'Pelican Air', code:'PA', fn:'PA304', dep:'15:00', arr:'23:50', dur:830, stops:1, via:'BOS', base:63000,  carriers:[] },
];

// Deterministic price variance per flight/partner/date — $0–$35
function priceVariance(flightId, port, date) {
  const s = `${flightId}|${port}|${date}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h % 3500;
}

function buildRealisticFare(f, port, date) {
  return {
    id:          `${f.id}_${date}`,
    airline:     f.airline,
    code:        f.code,
    flightNumber:f.fn,
    origin:      'LHR',
    destination: 'SFO',
    depart:      f.dep,
    arrive:      f.arr,
    durationMins:f.dur,
    stops:       f.stops,
    via:         f.via,
    priceCents:  f.base + priceVariance(f.id, port, date),
    partner:     PARTNERS[port].name,
  };
}

function getRealisticFares(port, origin, destination, date) {
  if (origin !== 'LHR' || destination !== 'SFO') return [];
  return LHR_SFO
    .filter(f => f.carriers.length === 0 || f.carriers.includes(port))
    .map(f => buildRealisticFare(f, port, date));
}

// Filler fares — priced above $1,200 and very long duration so they never reach top-50
// results, but provide FARES_PER_PARTNER volume for the O(n²) dedupe workload.
function generateFillerFares(port, origin, destination, date, count) {
  const { name: airline, code } = PARTNERS[port];
  const portOffset = port - 4001;
  const fares = [];
  for (let i = 0; i < count; i++) {
    const flightNum = `${code}${String(800 + i).padStart(4, '0')}`;
    const depHour = 6 + (i % 16);
    const depMin  = ((i * 7) % 12) * 5;
    const dur     = 1200 + (i % 400);
    const arrMins = depHour * 60 + depMin + dur;
    const pad = n => String(n).padStart(2, '0');
    fares.push({
      id:          `${flightNum}_${date}`,
      airline,
      code,
      flightNumber:flightNum,
      origin, destination,
      depart:      `${pad(depHour)}:${pad(depMin)}`,
      arrive:      `${pad(Math.floor(arrMins / 60) % 24)}:${pad(arrMins % 60)}`,
      durationMins:dur,
      stops:       2,
      via:         null,
      priceCents:  130000 + ((i * 97 + portOffset * 1500) % 40000),
      partner:     PARTNERS[port].name,
    });
  }
  return fares;
}

function createPartnerServer(port) {
  const isPenguin = port === 4004;

  async function applyLatency() {
    if (isPenguin) {
      // Penguin Air is degraded: fixed 5.2 s delay + 15% 503.
      // Sequential calls (CHAOS_STAIRCASE) accumulate all four latencies, pushing total > 5 s.
      if (Math.random() < 0.15) return 503;
      await new Promise(r => setTimeout(r, 5200));
    } else {
      if (Math.random() < FAIL_RATE) return 503;
      await new Promise(r => setTimeout(r, BASE_LATENCY_MS));
    }
    return 200;
  }

  const server = http.createServer(async (req, res) => {
    const url  = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    if (req.method !== 'GET' || (path !== '/fares' && path !== '/confirm')) {
      res.writeHead(404); res.end('Not found'); return;
    }

    // ── /confirm ─────────────────────────────────────────────────────────────
    if (path === '/confirm') {
      const flightId = url.searchParams.get('flight_id') || '';
      const status = await applyLatency();
      if (status !== 200) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ confirmed: true, flight_id: flightId, partner: PARTNERS[port].name }));
      return;
    }

    // ── /fares ───────────────────────────────────────────────────────────────
    const { origin, destination, date } = Object.fromEntries(url.searchParams);
    const status = await applyLatency();
    if (status !== 200) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service unavailable');
      return;
    }

    const realistic = getRealisticFares(port, origin, destination, date);
    const fillerCount = Math.max(0, FARES_PER_PARTNER - realistic.length);
    const fares = [...realistic, ...generateFillerFares(port, origin, destination, date, fillerCount)];

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
