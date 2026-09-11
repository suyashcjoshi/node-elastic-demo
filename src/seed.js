import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/skyward',
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS search_history (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id),
    origin      CHAR(3) NOT NULL,
    destination CHAR(3) NOT NULL,
    date        DATE NOT NULL,
    purpose     TEXT,
    searched_at TIMESTAMPTZ DEFAULT now()
  )
`);

// Migrate existing tables that predate the purpose column
await pool.query(`
  ALTER TABLE search_history ADD COLUMN IF NOT EXISTS purpose TEXT
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS fare_trends (
    id              SERIAL PRIMARY KEY,
    origin          CHAR(3) NOT NULL,
    destination     CHAR(3) NOT NULL,
    avg_price_cents INT NOT NULL,
    month           INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    UNIQUE (origin, destination, month)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS bookings (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id),
    flight_id   TEXT NOT NULL,
    airline     TEXT NOT NULL,
    price_cents INT NOT NULL,
    partner     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'partner',
    booked_at   TIMESTAMPTZ DEFAULT now()
  )
`);

const { rows: existing } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
if (existing[0].n === 0) {
  await pool.query(`
    INSERT INTO users (name, email) VALUES
      ('Sam Taylor',     'sam@northwind.example'),
      ('Jordan Lee',     'jordan@northwind.example'),
      ('Alex Rivera',    'alex@northwind.example'),
      ('Morgan Chen',    'morgan@northwind.example'),
      ('Casey Walsh',    'casey@northwind.example'),
      ('Drew Patel',     'drew@northwind.example'),
      ('Robin Osei',     'robin@northwind.example'),
      ('Quinn Müller',   'quinn@northwind.example'),
      ('Blake Souza',    'blake@northwind.example'),
      ('Avery Kim',      'avery@northwind.example')
  `);
  console.log('seeded users');
}

const { rows: trends } = await pool.query('SELECT COUNT(*)::int AS n FROM fare_trends');
if (trends[0].n === 0) {
  // Primary route: LHR→SFO avg ~$720 so "vs route average" reads sensibly.
  // Secondary routes filled with reasonable baselines.
  const routes = [
    ['LHR', 'SFO', 72000], ['LHR', 'JFK', 55000], ['LHR', 'LAX', 68000], ['LHR', 'ORD', 52000],
    ['LHR', 'DFW', 58000], ['LHR', 'BOS', 53000], ['LHR', 'ATL', 56000], ['LHR', 'MIA', 60000],
    ['SFO', 'LHR', 72000], ['SFO', 'JFK', 28000], ['SFO', 'LAX', 9000],  ['SFO', 'ORD', 25000],
    ['JFK', 'LHR', 55000], ['JFK', 'SFO', 28000], ['JFK', 'LAX', 26000], ['JFK', 'CDG', 67000],
    ['CDG', 'JFK', 67000], ['CDG', 'LAX', 78000], ['CDG', 'SFO', 74000], ['CDG', 'LHR', 18000],
    ['AMS', 'JFK', 58000], ['AMS', 'SFO', 70000], ['AMS', 'LAX', 72000], ['AMS', 'LHR', 16000],
  ];
  const seasonalMult = [1.05, 1.00, 0.92, 0.88, 0.95, 1.20, 1.30, 1.25, 1.10, 0.95, 0.90, 1.15];

  const values = [];
  for (const [orig, dest, base] of routes) {
    for (let month = 1; month <= 12; month++) {
      const avg = Math.round(base * seasonalMult[month - 1]);
      values.push(`('${orig}','${dest}',${avg},${month})`);
    }
  }
  await pool.query(
    `INSERT INTO fare_trends (origin, destination, avg_price_cents, month) VALUES ${values.join(',')}`
  );
  console.log('seeded fare_trends');
}

console.log('database ready');
await pool.end();
