// Skyward for Business — search API
// Zero OTel code; instrumented at startup via:
//   node --import @elastic/opentelemetry-node src/app.js
import express from 'express';
import pg from 'pg';
import pino from 'pino';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/skyward',
});


const PARTNERS = [
  { name: 'PuffinAir',   url: 'http://localhost:4001/fares', port: 4001 },
  { name: 'GooseJet',    url: 'http://localhost:4002/fares', port: 4002 },
  { name: 'Pelican Air', url: 'http://localhost:4003/fares', port: 4003 },
  { name: 'Penguin Air', url: 'http://localhost:4004/fares', port: 4004 },
];

const PARTNER_PORT = Object.fromEntries(PARTNERS.map(p => [p.name, p.port]));

// ── In-memory fare cache (flight_id → { fare, partnerPort }) ─────────────────
// Populated by each /api/search response; used by /api/book for confirmation.
const fareCache = new Map();
let lastSearchMeta = null; // { origin, destination, lowestPriceCents }

// ── Middleware ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

app.use((req, _res, next) => {
  req.id  = 'req_' + crypto.randomBytes(6).toString('hex');
  req.log = log.child({ request_id: req.id });
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Request-Id', _req.id);
  next();
});

// ── /health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ── /api/search ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res, next) => {
  const { origin, destination, date, user: userId, purpose, sort = 'fastest' } = req.query;
  const t0 = Date.now();

  try {
    const [historyResult, trendResult] = await Promise.all([
      pool.query(
        `SELECT origin, destination, date::text, purpose, searched_at
           FROM search_history WHERE user_id = $1
           ORDER BY searched_at DESC LIMIT 5`,
        [userId || null]
      ),
      pool.query(
        `SELECT avg_price_cents FROM fare_trends
           WHERE origin = $1 AND destination = $2 AND month = $3`,
        [origin, destination, new Date(date).getMonth() + 1]
      ),
    ]);

    const recentSearches = historyResult.rows;
    const trendAvgCents  = trendResult.rows[0]?.avg_price_cents ?? null;

    if (userId) {
      await pool.query(
        `INSERT INTO search_history (user_id, origin, destination, date, purpose)
           VALUES ($1, $2, $3, $4, $5)`,
        [userId, origin, destination, date, purpose || null]
      );
    }

    const qs = `?origin=${origin}&destination=${destination}&date=${date}`;
    const responded = [];

    // Sequential partner calls — each waits for the previous to complete
    for (const partner of PARTNERS) {
      try {
        const r = await fetch(partner.url + qs);
        if (r.ok) responded.push({ partner, fares: await r.json() });
      } catch { /* skip */ }
    }

    const allFares = responded.flatMap(({ fares }) => fares);

    // O(n²) dedupe — compares every fare against every already-seen fare
    const unique = [];
    for (let i = 0; i < allFares.length; i++) {
      let dup = false;
      for (let j = 0; j < unique.length; j++) {
        if (allFares[i].id === unique[j].id) {
          if (allFares[i].priceCents < unique[j].priceCents) unique[j] = allFares[i];
          dup = true; break;
        }
      }
      if (!dup) unique.push(allFares[i]);
    }

    // Attach partner port for booking lookup
    const withPort = unique.map(f => ({
      ...f,
      in_policy: f.priceCents < 120000,
    }));

    // Sort
    const sortFn = {
      fastest:  (a, b) => a.durationMins - b.durationMins || a.priceCents - b.priceCents,
      cheapest: (a, b) => a.priceCents - b.priceCents,
      best:     (a, b) => (a.priceCents * a.durationMins) - (b.priceCents * b.durationMins),
    }[sort] || ((a, b) => a.durationMins - b.durationMins);

    withPort.sort(sortFn);
    const flights = withPort.slice(0, 50);
    const elapsed_ms = Date.now() - t0;

    // Update fare cache for /api/book
    const partnerByName = Object.fromEntries(responded.map(({ partner }) => [partner.name, partner]));
    for (const fare of withPort) {
      const partnerPort = PARTNER_PORT[fare.partner] ?? null;
      fareCache.set(fare.id, { fare, partnerPort });
    }
    const lowestPriceCents = withPort.length ? withPort.reduce((m, f) => Math.min(m, f.priceCents), Infinity) : null;
    lastSearchMeta = { origin, destination, lowestPriceCents };

    req.log.info({
      user: userId, origin, destination, date, purpose,
      partners_responded: responded.length,
      sort, ms: elapsed_ms,
    }, 'search complete');

    res.json({
      flights,
      partners_responded: responded.length,
      partners_total: PARTNERS.length,
      trend_avg_cents: trendAvgCents,
      recent_searches: recentSearches,
      elapsed_ms,
    });
  } catch (err) {
    next(err);
  }
});

// ── /api/insights ─────────────────────────────────────────────────────────────
app.get('/api/insights', async (req, res, next) => {
  const { origin, destination, user: userId } = req.query;
  const t0 = Date.now();
  try {
    const currentMonth = new Date().getMonth() + 1;
    const prevMonth    = currentMonth === 1 ? 12 : currentMonth - 1;

    const [trendResult, historyResult] = await Promise.all([
      pool.query(
        `SELECT month, avg_price_cents FROM fare_trends
           WHERE origin = $1 AND destination = $2 AND month IN ($3, $4)`,
        [origin, destination, currentMonth, prevMonth]
      ),
      pool.query(
        `SELECT origin, destination, date::text, purpose, searched_at
           FROM search_history WHERE user_id = $1
           ORDER BY searched_at DESC LIMIT 5`,
        [userId || null]
      ),
    ]);

    const current  = trendResult.rows.find(r => r.month === currentMonth);
    const previous = trendResult.rows.find(r => r.month === prevMonth);
    let pct_change = null;
    if (current && previous && previous.avg_price_cents > 0) {
      pct_change = Math.round(
        (current.avg_price_cents - previous.avg_price_cents) / previous.avg_price_cents * 100
      );
    }

    const lowest_price_today =
      lastSearchMeta?.origin === origin && lastSearchMeta?.destination === destination
        ? lastSearchMeta.lowestPriceCents
        : null;

    const elapsed_ms = Date.now() - t0;
    req.log.info({ origin, destination, user: userId, ms: elapsed_ms }, 'insights');

    res.json({
      avg_price_cents: current?.avg_price_cents ?? null,
      pct_change,
      recent_searches: historyResult.rows,
      lowest_price_today,
    });
  } catch (err) {
    next(err);
  }
});

// ── /api/chat ─────────────────────────────────────────────────────────────────
const CHAT_REPLIES = {
  direct:    'PN401 is the only direct flight today from LHR to SFO — departs 08:30, arrives 11:10 (10h 40m), operated by Penguin Air.',
  stops:     'One-stop options are available via JFK, ORD, LAX, BOS, ATL and DFW, from $490 per person.',
  baggage:   'Economy includes one carry-on (10 kg) and one checked bag (23 kg). Additional bags cost $45 each.',
  change:    'You can change a flight up to 24 hours before departure. Northwind policy allows one free change per booking.',
  cancel:    'Cancellations more than 7 days before departure receive a full refund. Within 7 days a $150 change fee applies.',
  refund:    'Refunds are processed within 5–10 business days to your original payment method.',
  policy:    'Northwind policy covers Economy fares up to $1,200 per leg. Fares above that need manager approval (cost centre CC-4471).',
  approval:  'For fares above $1,200, submit a travel approval request to your manager citing cost centre CC-4471.',
  default:   'I can help with flight times, baggage, changes, cancellations or the Northwind travel policy. What would you like to know?',
};

function chatReply(message) {
  const m = message.toLowerCase();
  if (m.includes('direct'))                                return CHAT_REPLIES.direct;
  if (m.includes('stop') || m.includes('connection'))      return CHAT_REPLIES.stops;
  if (m.includes('baggage') || m.includes('bag') || m.includes('luggage')) return CHAT_REPLIES.baggage;
  if (m.includes('change'))                                return CHAT_REPLIES.change;
  if (m.includes('cancel'))                                return CHAT_REPLIES.cancel;
  if (m.includes('refund'))                                return CHAT_REPLIES.refund;
  if (m.includes('policy') || m.includes('in-policy') || m.includes('in policy')) return CHAT_REPLIES.policy;
  if (m.includes('approval') || m.includes('approve'))     return CHAT_REPLIES.approval;
  if (m.includes('10:40') || m.includes('10h40') || m.includes('pn401') || m.includes('fastest')) return CHAT_REPLIES.direct;
  return CHAT_REPLIES.default;
}

app.post('/api/chat', async (req, res, next) => {
  const { message, user: userId } = req.body;
  try {
    // Bug: missing await — pool.query() returns a Promise, not a QueryResult.
    // Accessing .rows on a Promise is undefined; reading [0] from it throws TypeError.
    const history = pool.query(
      'SELECT destination FROM search_history WHERE user_id = $1 ORDER BY searched_at DESC LIMIT 1',
      [userId || null]
    );
    const lastDest = history.rows[0].destination;

    const reply = chatReply(message);
    req.log.info({ user: userId, lastDest }, 'chat reply sent');
    res.json({ reply, request_id: req.id });
  } catch (err) {
    next(err);
  }
});

// ── /api/book ─────────────────────────────────────────────────────────────────
app.post('/api/book', (req, res) => {
  const { flight_id, user: userId } = req.body;
  req.log.warn({ user: userId, flight_id }, 'booking rejected — flight no longer available');
  res.status(410).json({
    error: 'flight_not_available',
    message: 'Please contact customer care to book this flight as it is not available anymore.',
    request_id: req.id,
  });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  req.log.error({ err, path: req.path }, 'request failed');
  res.status(500).json({ error: 'internal_server_error', request_id: req.id });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3000');
app.listen(port, () => {
  log.info({ port }, 'skyward-search listening');
});
