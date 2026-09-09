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
    searched_at TIMESTAMPTZ DEFAULT now()
  )
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

const { rows: existing } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
if (existing[0].n === 0) {
  await pool.query(`
    INSERT INTO users (name, email) VALUES
      ('Alice Chen',    'alice@example.com'),
      ('Bob Martínez',  'bob@example.com'),
      ('Chloe Dupont',  'chloe@example.com'),
      ('Dmitri Volkov',  'dmitri@example.com'),
      ('Eva Müller',    'eva@example.com'),
      ('Faisal Al-Amin','faisal@example.com'),
      ('Grace Kim',     'grace@example.com'),
      ('Hassan Osei',   'hassan@example.com'),
      ('Isabela Souza', 'isabela@example.com'),
      ('Jin Park',      'jin@example.com')
  `);
  console.log('seeded users');
}

const { rows: trends } = await pool.query('SELECT COUNT(*)::int AS n FROM fare_trends');
if (trends[0].n === 0) {
  const routes = [
    ['JFK', 'LAX'], ['JFK', 'LHR'], ['JFK', 'CDG'], ['JFK', 'NRT'],
    ['LAX', 'JFK'], ['LAX', 'LHR'], ['LAX', 'NRT'], ['LAX', 'SYD'],
    ['ORD', 'LAX'], ['ORD', 'LHR'], ['ORD', 'CDG'], ['ORD', 'ATL'],
    ['ATL', 'JFK'], ['ATL', 'LAX'], ['ATL', 'LHR'], ['ATL', 'DFW'],
    ['DFW', 'LAX'], ['DFW', 'LHR'], ['DFW', 'JFK'], ['DFW', 'NRT'],
    ['SFO', 'JFK'], ['SFO', 'LHR'], ['SFO', 'NRT'], ['SFO', 'SYD'],
    ['SEA', 'JFK'], ['SEA', 'LHR'], ['SEA', 'NRT'], ['SEA', 'LAX'],
    ['BOS', 'LAX'], ['BOS', 'LHR'], ['BOS', 'CDG'], ['BOS', 'JFK'],
    ['MIA', 'JFK'], ['MIA', 'LAX'], ['MIA', 'LHR'], ['MIA', 'CDG'],
    ['LHR', 'JFK'], ['LHR', 'LAX'], ['LHR', 'NRT'], ['LHR', 'DXB'],
    ['CDG', 'JFK'], ['CDG', 'LAX'], ['CDG', 'NRT'], ['CDG', 'DXB'],
    ['AMS', 'JFK'], ['AMS', 'LAX'], ['AMS', 'NRT'], ['AMS', 'DXB'],
  ];
  // Rough seasonal base prices in cents
  const basePrices = {
    'JFK-LAX': 28000, 'JFK-LHR': 65000, 'JFK-CDG': 67000, 'JFK-NRT': 98000,
    'LAX-JFK': 28000, 'LAX-LHR': 72000, 'LAX-NRT': 85000, 'LAX-SYD': 120000,
    'LHR-JFK': 65000, 'LHR-LAX': 72000, 'LHR-NRT': 95000, 'LHR-DXB': 45000,
    'CDG-JFK': 67000, 'CDG-LAX': 78000, 'CDG-NRT': 98000, 'CDG-DXB': 48000,
  };
  const seasonalMult = [1.1, 1.0, 0.9, 0.85, 0.95, 1.2, 1.3, 1.25, 1.1, 0.95, 0.9, 1.2];

  const values = [];
  for (const [orig, dest] of routes) {
    const key = `${orig}-${dest}`;
    const base = basePrices[key] || 55000;
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
