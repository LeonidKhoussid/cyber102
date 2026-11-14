import { openDatabase } from './database.ts';
import { initializeCatalog, openPostgresCatalog } from './postgres-catalog.ts';
import { refreshCatalog } from './sync.ts';

const pool = openDatabase();
const catalog = openPostgresCatalog(pool);
try {
  await initializeCatalog(pool);
  const reports = await refreshCatalog(catalog, { onReport: report => console.log(JSON.stringify(report)) });
  if (!reports.some(report => report.collected > report.rejected.length)) process.exitCode = 1;
} finally {
  await catalog.close();
}
