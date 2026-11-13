import { openCatalog } from './catalog.ts';
import { buildServer } from './server.ts';
import { refreshCatalog } from './sync.ts';

const port = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('API_PORT must be between 1 and 65535.');

const catalog = openCatalog(process.env.CATALOG_PATH);
const server = await buildServer(catalog, {
  adminToken: process.env.ADMIN_TOKEN || undefined,
  botToken: process.env.BOT_API_TOKEN || undefined,
  routingOrigin: process.env.ROUTING_ORIGIN || undefined,
  logger: true,
});

let refresh: Promise<void> | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await refresh;
  await server.close();
  catalog.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await server.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
} catch (error) {
  await stop();
  throw error;
}

if (process.env.BOOTSTRAP_CATALOG === '1' && !catalog.hasSources()) {
  refresh = refreshCatalog(catalog)
    .then(reports => {
      for (const report of reports) server.log.info(report, 'event source refreshed');
    })
    .catch(() => server.log.warn('Initial source refresh failed. Run npm run refresh to retry.'));
}
