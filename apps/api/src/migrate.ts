import { openDatabase } from './database.ts';
import { initializeCatalog, migrateSqliteCatalog } from './postgres-catalog.ts';

const filename = process.argv[2] || process.env.CATALOG_PATH || 'data/catalog.sqlite';
const pool = openDatabase();
try {
  await initializeCatalog(pool);
  await migrateSqliteCatalog(pool, filename);
  console.log('PostgreSQL catalog migration complete.');
} finally {
  await pool.end();
}
