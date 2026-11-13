import { openCatalog } from './catalog.ts';
import { refreshCatalog } from './sync.ts';

const catalog = openCatalog(process.env.CATALOG_PATH);
try {
  const reports = await refreshCatalog(catalog);
  for (const report of reports) console.log(JSON.stringify(report));
  if (!reports.some(report => report.collected > report.rejected.length)) process.exitCode = 1;
} finally {
  catalog.close();
}
