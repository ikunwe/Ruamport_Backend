// Optional isolated PostgreSQL-compatible runtime; no production credentials.
// npm install --prefix tmp/cost-basis-validation --no-save --package-lock=false --ignore-scripts @electric-sql/pglite
// node verify-investment-sql.cjs tmp/cost-basis-validation
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const { PGlite } = require(require.resolve('@electric-sql/pglite', { paths: [path.resolve(process.argv[2] || '.')] }));
  const root = __dirname;
  const db = new PGlite(); // Memory only: no server, .env, tokens, or real user data.
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      insert into auth.users values ('00000000-0000-4000-8000-000000000001');`);
    const migrationDir = path.join(root, 'supabase', 'migrations');
    const files = (await fs.readdir(migrationDir)).filter(name => /^(00[7-9]|01[0-8])_.*\.sql$/.test(name)).sort();
    for (const name of files) {
      await db.exec(await fs.readFile(path.join(migrationDir, name), 'utf8'));
      console.log('Migration OK:', name);
    }
    for (const name of ['order-deduplication.integration.sql', 'holdings-rounding.integration.sql',
      'mutual-fund-holdings.integration.sql', 'holdings-money.integration.sql',
      'holdings-gross-fees.integration.sql', 'holdings-average-cost.integration.sql',
      'holdings-compressed-fifo.integration.sql', 'holdings-asset-cost-methods.integration.sql',
      'holdings-mutual-fund-average-cost.integration.sql']) {
      await db.exec(await fs.readFile(path.join(root, 'test', name), 'utf8'));
      console.log('SQL test OK:', name);
    }
  } finally {
    await db.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
