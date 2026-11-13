import { openCatalog } from './catalog.ts';
import { buildServer } from './server.ts';
import { refreshCatalog } from './sync.ts';

const port = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('API_PORT must be between 1 and 65535.');

const refreshInterval = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 0);
if (!Number.isInteger(refreshInterval) || refreshInterval < 0 || refreshInterval > 1440) {
  throw new Error('REFRESH_INTERVAL_MINUTES must be between 0 and 1440.');
}

const catalog = openCatalog(process.env.CATALOG_PATH);
const server = await buildServer(catalog, {
  adminToken: process.env.ADMIN_TOKEN || undefined,
  botToken: process.env.BOT_API_TOKEN || undefined,
  routingOrigin: process.env.ROUTING_ORIGIN || undefined,
  logger: true,
});

let refresh: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
function refreshSources() {
  if (refresh || stopping) return;
  refresh = refreshCatalog(catalog, { onReport: report => server.log.info(report, 'event source refreshed') })
    .then(() => undefined)
    .catch(() => server.log.warn('Source refresh failed. Run npm run refresh to retry.'))
    .finally(() => { refresh = undefined; });
}
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
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

if (process.env.BOOTSTRAP_CATALOG === '1' && !catalog.hasSources()) refreshSources();
if (refreshInterval) timer = setInterval(refreshSources, refreshInterval * 60_000);
