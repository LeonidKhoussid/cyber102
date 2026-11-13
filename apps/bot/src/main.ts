import { createTelegramBot } from './bot.ts';
import { createBotService } from './client.ts';

const token = process.env.BOT_TOKEN?.trim();
const apiToken = process.env.BOT_API_TOKEN?.trim();
if (!token || !apiToken) {
  console.error('Set BOT_TOKEN and BOT_API_TOKEN to start Telegram polling.');
  process.exitCode = 1;
} else {
  try {
    const service = createBotService(process.env.API_ORIGIN?.trim() || 'http://127.0.0.1:3001', apiToken);
    const bot = createTelegramBot({
      token, service, siteUrl: process.env.PUBLIC_SITE_URL,
      onError: () => console.warn('Telegram update failed.'),
    });
    let stopping = false;
    const stop = () => {
      stopping = true;
      void bot.stop().catch(() => console.warn('Telegram polling shutdown failed.'));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    try {
      await bot.start({ allowed_updates: ['message', 'callback_query'] });
    } catch {
      if (!stopping) {
        console.error('Telegram polling stopped. Check BOT_TOKEN and connectivity.');
        process.exitCode = 1;
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } catch {
    console.error('Telegram bot configuration is invalid. Check API_ORIGIN.');
    process.exitCode = 1;
  }
}
