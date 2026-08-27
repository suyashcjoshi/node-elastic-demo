// Storefront API — a tiny Express + Postgres app used to demo
// Elastic Observability with EDOT Node.js (OpenTelemetry).
//
// NOTE: There is deliberately ZERO OpenTelemetry code in this file.
// All instrumentation happens at startup via:
//   node --import @elastic/opentelemetry-node app.js

const express = require('express');
const { Pool } = require('pg');
const pino = require('pino');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5432/storefront',
});

const app = express();
app.use(express.json());

// --- one-time setup: create tables and seed a few products ---------------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INT NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES products(id),
      quantity INT NOT NULL,
      total_cents INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (rows[0].n === 0) {
    await pool.query(`
      INSERT INTO products (name, price_cents) VALUES
        ('Telescope', 24900),
        ('Star Map', 1900),
        ('Meteorite Fragment', 9900),
        ('Astronaut Ice Cream', 500)`);
    log.info('seeded products table');
  }
}

// --- routes ---------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Normal happy path: one SELECT → clean, fast trace.
app.get('/products', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY id');
    log.info({ count: rows.length }, 'listed products');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Single product; 404 path produces a warn log tied to the trace.
app.get('/products/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [
      req.params.id,
    ]);
    if (rows.length === 0) {
      log.warn({ productId: req.params.id }, 'product not found');
      return res.status(404).json({ error: 'product not found' });
    }
    log.info({ productId: req.params.id }, 'fetched product');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Multi-step request: SELECT + fake payment call + INSERT.
// Produces a nice multi-span trace waterfall.
app.post('/orders', async (req, res, next) => {
  try {
    const { productId = 1, quantity = 1 } = req.body || {};

    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [
      productId,
    ]);
    if (rows.length === 0) {
      log.warn({ productId }, 'order rejected: unknown product');
      return res.status(400).json({ error: 'unknown product' });
    }
    const product = rows[0];

    // Simulate calling a payment provider (50–150 ms).
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

    const total = product.price_cents * quantity;
    const insert = await pool.query(
      'INSERT INTO orders (product_id, quantity, total_cents) VALUES ($1, $2, $3) RETURNING id',
      [productId, quantity, total]
    );

    log.info(
      { orderId: insert.rows[0].id, productId, quantity, total },
      'order placed'
    );
    res.status(201).json({ orderId: insert.rows[0].id, total });
  } catch (err) {
    next(err);
  }
});

// Deliberately slow (~2 s in the database) — used to trigger the latency alert.
app.get('/slow', async (req, res, next) => {
  try {
    await pool.query('SELECT pg_sleep(2)');
    log.info('slow query finished');
    res.json({ status: 'finally done' });
  } catch (err) {
    next(err);
  }
});

// Deliberately broken — used to demo error traces + error logs.
app.get('/error', async (req, res, next) => {
  try {
    await pool.query('SELECT * FROM a_table_that_does_not_exist');
    res.json({ status: 'unreachable' });
  } catch (err) {
    next(err);
  }
});

// Error handler: log with the error object so it lands in Elastic
// correlated with the failing trace.
app.use((err, req, res, next) => {
  log.error({ err, path: req.path }, 'request failed');
  res.status(500).json({ error: 'internal server error' });
});

// --- start ----------------------------------------------------------------

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  log.info({ port }, 'storefront-api listening');
  try {
    await init();
    log.info('database ready');
  } catch (err) {
    log.error({ err }, 'database init failed — is Postgres running?');
  }
});
