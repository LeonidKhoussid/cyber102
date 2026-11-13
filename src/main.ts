import { openCatalog } from './catalog.ts';
import { buildServer } from './server.ts';
import { createTelegramBot } from './bot.ts';
import { refreshCatalog } from './sync.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535.');

const catalog = openCatalog(process.env.CATALOG_PATH);
const server = await buildServer(catalog, { adminToken: process.env.ADMIN_TOKEN || undefined, logger: true });
const token = process.env.BOT_TOKEN?.trim();
const bot = token ? createTelegramBot({
  token, catalog, siteUrl: process.env.PUBLIC_SITE_URL,
  onError: () => server.log.warn('Telegram update failed'),
}) : undefined;

let refresh: Promise<void> | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await bot?.stop();
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

if (bot) {
  void bot.start({ allowed_updates: ['message', 'callback_query'] })
    .catch(() => server.log.warn('Telegram polling stopped. Check BOT_TOKEN and Telegram connectivity.'));
}
