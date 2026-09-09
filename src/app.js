// Skyward search API — zero OTel code; instrumented at startup:
//   node --env-file=.env --import @elastic/opentelemetry-node src/app.js
import express from 'express';
import pg from 'pg';
import pino from 'pino';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/skyward',
});

// ── Chaos flags ──────────────────────────────────────────────────────────────
// ENABLE_CHAOS=false forces all three off regardless of individual settings.
const chaosEnabled    = process.env.ENABLE_CHAOS !== 'false';
const CHAOS_STAIRCASE = chaosEnabled && process.env.CHAOS_STAIRCASE !== 'false';
const CHAOS_GAP       = chaosEnabled && process.env.CHAOS_GAP       !== 'false';
const CHAOS_PARTNER   = chaosEnabled && process.env.CHAOS_PARTNER   !== 'false';

const PARTNERS = [
  { name: 'SkyJet',  url: 'http://localhost:4001/fares' },
  { name: 'AeroLuz', url: 'http://localhost:4002/fares' },
  { name: 'Nimbus',  url: 'http://localhost:4003/fares' },
  { name: 'Zephyr',  url: 'http://localhost:4004/fares' },
];

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/search', async (req, res, next) => {
  const { origin, destination, date, user: userId } = req.query;
  const t0 = Date.now();

  try {
    // 1. Read search context and trend from DB in parallel
    const [historyResult, trendResult] = await Promise.all([
      pool.query(
        `SELECT origin, destination, date::text, searched_at
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

    const recentSearches  = historyResult.rows;
    const trendAvgCents   = trendResult.rows[0]?.avg_price_cents ?? null;

    // 2. Record this search
    if (userId) {
      await pool.query(
        `INSERT INTO search_history (user_id, origin, destination, date)
           VALUES ($1, $2, $3, $4)`,
        [userId, origin, destination, date]
      );
    }

    // 3. Fan out to the four partner APIs
    const qs = `?origin=${origin}&destination=${destination}&date=${date}`;
    const responded = [];

    if (CHAOS_STAIRCASE) {
      // Sequential awaits → creates a staircase waterfall in the trace
      for (const partner of PARTNERS) {
        try {
          const r = await fetch(partner.url + qs);
          if (r.ok) responded.push(await r.json());
        } catch { /* skip failed partner */ }
      }
    } else {
      // Proper parallel fan-out with optional per-partner timeout
      const settled = await Promise.allSettled(
        PARTNERS.map((partner) => {
          const opts = CHAOS_PARTNER ? {} : { signal: AbortSignal.timeout(2000) };
          return fetch(partner.url + qs, opts)
            .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
        })
      );
      for (const s of settled) {
        if (s.status === 'fulfilled') responded.push(s.value);
      }
    }

    // 4. Merge + dedupe across all partners
    const allFares = responded.flat();
    let unique;

    if (CHAOS_GAP) {
      // O(n²) nested loop — synchronously blocks the event loop
      // At FARES_PER_PARTNER=3000 this targets ~700 ms of blocking.
      const blockStart = performance.now();
      unique = [];
      for (let i = 0; i < allFares.length; i++) {
        let dup = false;
        for (let j = 0; j < unique.length; j++) {
          if (allFares[i].id === unique[j].id) { dup = true; break; }
        }
        if (!dup) unique.push(allFares[i]);
      }
      log.debug({ blockMs: (performance.now() - blockStart).toFixed(1) }, 'dedupe block duration');
    } else {
      // O(n) Map-keyed dedupe — keeps cheapest price per flight
      const seen = new Map();
      for (const fare of allFares) {
        const prev = seen.get(fare.id);
        if (!prev || fare.priceCents < prev.priceCents) seen.set(fare.id, fare);
      }
      unique = [...seen.values()];
    }

    unique.sort((a, b) => a.priceCents - b.priceCents);
    const flights    = unique.slice(0, 50);
    const elapsed_ms = Date.now() - t0;

    log.info({
      user: userId, origin, destination, date,
      partners_responded: responded.length,
      ms: elapsed_ms,
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

app.use((err, req, res, _next) => {
  log.error({ err, path: req.path }, 'request failed');
  res.status(500).json({ error: 'internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3000');
app.listen(port, () => {
  log.info({ port, CHAOS_STAIRCASE, CHAOS_GAP, CHAOS_PARTNER }, 'skyward-search listening');
});
