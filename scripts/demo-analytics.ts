import { openCatalog } from '../apps/api/src/catalog.ts';
import { buildServer } from '../apps/api/src/server.ts';
import { importAnalyticsFixture } from '../test/fixtures/analytics/import.ts';

const clock = () => new Date('2026-11-13T00:00:00+05:00');
const catalog = openCatalog(':memory:', clock);
const { report } = importAnalyticsFixture(catalog, process.argv.includes('--clean') ? 'clean' : 'full');
const server = await buildServer(catalog, { clock, disableModel: true });
await server.listen({ port: 3012, host: '127.0.0.1' });
console.log(`Synthetic test data only; no live feeds or AI. ${report.added} events at http://127.0.0.1:3012`);
const stop = async () => { await server.close(); catalog.close(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
