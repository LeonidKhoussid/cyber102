import { randomUUID } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { categories, isLocalDate, publicUrl } from './catalog.ts';
import type { Catalog, CatalogEvent } from './catalog.ts';
import { FilterError, localDate, localDay, parseFilters } from './filters.ts';
import type { QueryValues } from './filters.ts';

type BotOptions = {
  token: string;
  catalog: Catalog;
  siteUrl?: string;
  onError?: () => void;
  clock?: () => Date;
};

type Action = (context: Context) => Promise<void>;
type Session = {
  filters: QueryValues;
  page: number;
  enteringDate: boolean;
  buttons: Map<string, Action>;
  lastSeen: number;
  lastUpdate: number;
  rateWindow: number;
  updatesInWindow: number;
};

const sessionLifetime = 30 * 60_000;
const maximumSessions = 10_000;
const pageSize = 5;
const cityPageSize = 8;
const periods = {
  today: 'Сегодня',
  tomorrow: 'Завтра',
  weekend: 'Ближайшие выходные',
  week: 'Ближайшие 7 дней',
  nextWeek: 'Следующая неделя',
} as const;
const prices = [['0', 'Бесплатно'], ['500', 'До 500 ₽'], ['1000', 'До 1 000 ₽'], ['2000', 'До 2 000 ₽']] as const;
const help = 'Напишите название события или площадки. Выберите город, категорию, даты и цену кнопками. Для точной даты отправьте ГГГГ-ММ-ДД. /cancel отменяет ввод даты. /unsubscribe удаляет все подписки.';
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', dateStyle: 'medium', timeStyle: 'short' });
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2, minimumFractionDigits: 0 });

function shorten(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 2).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

function eventPrice(event: CatalogEvent): string {
  if (event.priceMin === undefined) return event.priceMax === undefined ? 'неизвестна' : `до ${money.format(event.priceMax)}`;
  if (event.priceMax !== undefined && event.priceMax !== event.priceMin) {
    return `${money.format(event.priceMin)}–${money.format(event.priceMax)}`;
  }
  return event.priceMin === 0 ? 'бесплатно' : money.format(event.priceMin);
}

export function createTelegramBot({ token, catalog, siteUrl, onError, clock = () => new Date() }: BotOptions) {
  const bot = new Bot(token, { client: { timeoutSeconds: 45 } });
  const site = publicUrl(siteUrl);
  const sessions = new Map<number, Session>();

  bot.catch(() => onError?.());

  function menu(session: Session) {
    const keyboard = new InlineKeyboard();
    const buttons = new Map<string, Action>();
    const screen = randomUUID();
    function button(label: string, action: Action) {
      const payload = `${screen}:${buttons.size}`;
      buttons.set(payload, action);
      keyboard.text(shorten(label, 64), payload);
    }
    async function send(context: Context, text: string) {
      await context.reply(text, { reply_markup: keyboard, link_preview_options: { is_disabled: true } });
      session.buttons = buttons;
    }
    return { keyboard, button, send };
  }

  function filtersFor(session: Session) {
    const now = clock();
    if (session.filters.period !== 'nextWeek') return parseFilters(session.filters, now);
    const today = localDate(now);
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const monday = localDay(today, ((8 - weekday) % 7) || 7);
    return parseFilters({ ...session.filters, period: undefined, from: monday, until: localDay(monday, 6) }, now);
  }

  async function setFilter(context: Context, session: Session, field: string, value?: string) {
    session.filters[field] = value;
    session.page = 1;
    session.enteringDate = false;
    await showResults(context, session);
  }

  async function chooseCity(context: Context, session: Session, page = 0) {
    const cities = catalog.directories().cities.filter(city => city.length <= 100);
    const start = page * cityPageSize;
    const screen = menu(session);
    for (const city of cities.slice(start, start + cityPageSize)) {
      screen.button(city, next => setFilter(next, session, 'city', city));
      screen.keyboard.row();
    }
    if (page > 0) screen.button('← Города', next => chooseCity(next, session, page - 1));
    if (start + cityPageSize < cities.length) screen.button('Города →', next => chooseCity(next, session, page + 1));
    screen.keyboard.row();
    screen.button('Все города', next => setFilter(next, session, 'city'));
    await screen.send(context, cities.length ? 'Выберите город.' : 'Города появятся после добавления событий.');
  }

  async function chooseCategory(context: Context, session: Session) {
    const screen = menu(session);
    for (const [category, label] of Object.entries(categories)) {
      screen.button(label, next => setFilter(next, session, 'category', category));
      screen.keyboard.row();
    }
    screen.button('Все категории', next => setFilter(next, session, 'category'));
    await screen.send(context, 'Выберите категорию.');
  }

  async function choosePeriod(context: Context, session: Session) {
    const screen = menu(session);
    for (const [period, label] of Object.entries(periods)) {
      screen.button(label, async next => {
        session.filters.date = undefined;
        await setFilter(next, session, 'period', period);
      });
      screen.keyboard.row();
    }
    screen.button('Точная дата', async next => {
      session.enteringDate = true;
      const dateScreen = menu(session);
      dateScreen.button('Отмена', async afterCancel => {
        session.enteringDate = false;
        await showResults(afterCancel, session);
      });
      await dateScreen.send(next, 'Отправьте дату в формате ГГГГ-ММ-ДД.');
    });
    screen.button('Все даты', async next => {
      session.filters.date = undefined;
      await setFilter(next, session, 'period');
    });
    await screen.send(context, 'Выберите даты.');
  }

  async function choosePrice(context: Context, session: Session) {
    const screen = menu(session);
    for (const [price, label] of prices) {
      screen.button(label, next => setFilter(next, session, 'maxPrice', price));
      screen.keyboard.row();
    }
    screen.button('Любая цена', next => setFilter(next, session, 'maxPrice'));
    await screen.send(context, 'Выберите цену.');
  }

  function addFilters(screen: ReturnType<typeof menu>, session: Session) {
    screen.button('Город', next => chooseCity(next, session));
    screen.button('Категория', next => chooseCategory(next, session));
    screen.keyboard.row();
    screen.button('Даты', next => choosePeriod(next, session));
    screen.button('Цена', next => choosePrice(next, session));
    screen.keyboard.row();
  }

  async function showDetails(context: Context, session: Session, id: string) {
    const event = catalog.getEvent(id);
    const screen = menu(session);
    if (!event) {
      screen.button('К результатам', next => showResults(next, session));
      await screen.send(context, 'Событие больше недоступно.');
      return;
    }
    const ticket = event.status === 'published' && publicUrl(event.ticketUrl);
    if (ticket) screen.keyboard.url('К билетам', ticket).row();
    const source = publicUrl(event.sources[0]?.url);
    if (source) screen.keyboard.url('Источник', source).row();
    if (site) screen.keyboard.url('На сайте', new URL(`/events/${encodeURIComponent(event.id)}`, site).href).row();
    screen.button('К результатам', next => showResults(next, session));
    await screen.send(context, [
      shorten(event.title, 180),
      event.status === 'cancelled' ? 'Событие отменено' : categories[event.category],
      dateFormatter.format(new Date(event.startsAt)),
      event.endsAt && `До: ${dateFormatter.format(new Date(event.endsAt))}`,
      `${shorten(event.city, 100)}, ${shorten(event.venue, 180)}`,
      event.address && shorten(event.address, 180),
      `Цена: ${eventPrice(event)}`,
      `Возраст: ${event.ageLimit === undefined ? 'неизвестен' : `${event.ageLimit}+`}`,
      event.description && shorten(event.description, 2000),
    ].filter(Boolean).join('\n'));
  }

  async function showResults(context: Context, session: Session) {
    const filters = filtersFor(session);
    const result = catalog.search({ ...filters, page: session.page, limit: pageSize });
    const pageCount = Math.min(10_000, Math.max(1, Math.ceil(result.total / result.limit)));
    if (session.page > pageCount) {
      session.page = pageCount;
      await showResults(context, session);
      return;
    }

    const screen = menu(session);
    for (const [index, event] of result.events.entries()) {
      screen.button(`${index + 1}. ${event.title}`, next => showDetails(next, session, event.id));
      screen.keyboard.row();
    }
    if (result.page > 1) screen.button('← Назад', async next => {
      session.page--;
      await showResults(next, session);
    });
    if (result.page < pageCount) screen.button('Далее →', async next => {
      session.page++;
      await showResults(next, session);
    });
    screen.keyboard.row();
    addFilters(screen, session);
    if (session.filters.q) screen.button('Сбросить поиск', next => setFilter(next, session, 'q'));
    screen.button('Подписаться', async next => {
      const subscriptionScreen = menu(session);
      subscriptionScreen.button('К результатам', back => showResults(back, session));
      if (!filters.city || !filters.category) {
        addFilters(subscriptionScreen, session);
        await subscriptionScreen.send(next, 'Для подписки выберите город и категорию.');
        return;
      }
      catalog.subscribe(String(next.chatId), { city: filters.city, category: filters.category });
      await subscriptionScreen.send(next, `Подписка сохранена: ${filters.city}, ${categories[filters.category]}. /unsubscribe удалит подписки.`);
    });
    const dateLabel = session.filters.date ?? periods[session.filters.period as keyof typeof periods];
    const selected = [filters.query && `«${filters.query}»`, filters.city, filters.category && categories[filters.category], dateLabel,
      filters.maxPrice !== undefined && (filters.maxPrice === 0 ? 'бесплатно' : `до ${money.format(filters.maxPrice)}`)].filter(Boolean);
    const events = result.events.map((event, index) => `${index + 1}. ${shorten(event.title, 120)} — ${dateFormatter.format(new Date(event.startsAt))}, ${shorten(event.city, 80)}`);
    const changeable = [
      filters.maxPrice !== undefined && 'цену', dateLabel && 'даты',
      filters.category && 'категорию', filters.city && 'город', filters.query && 'поисковый запрос',
    ].filter(Boolean);
    const empty = changeable.length
      ? `Событий не найдено. Попробуйте изменить ${changeable[0]}.`
      : 'Событий пока нет. Проверьте каталог позже.';
    const heading = result.total ? `Событий: ${result.total}. Страница ${result.page} из ${pageCount}.` : empty;
    await screen.send(context, [heading, selected.join(' · '), ...events].filter(Boolean).join('\n'));
  }

  bot.use(async (context, next) => {
    const chatId = context.chatId;
    if (context.chat?.type !== 'private' || chatId === undefined || context.from?.id !== chatId) return;

    const now = clock().valueOf();
    for (const [oldChatId, session] of sessions) {
      if (now - session.lastSeen < sessionLifetime) break;
      sessions.delete(oldChatId);
    }
    let session = sessions.get(chatId);
    if (!session) {
      const oldestChat = sessions.keys().next().value;
      if (sessions.size >= maximumSessions && oldestChat !== undefined) sessions.delete(oldestChat);
      session = { filters: {}, page: 1, enteringDate: false, buttons: new Map(), lastSeen: now, lastUpdate: -1, rateWindow: now, updatesInWindow: 0 };
    }
    if (context.update.update_id <= session.lastUpdate) return;
    session.lastUpdate = context.update.update_id;
    session.lastSeen = now;
    sessions.delete(chatId);
    sessions.set(chatId, session);

    if (now - session.rateWindow >= 10_000) {
      session.rateWindow = now;
      session.updatesInWindow = 0;
    }
    if (++session.updatesInWindow > 12) {
      if (session.updatesInWindow === 13) {
        const text = 'Слишком много запросов. Попробуйте через несколько секунд.';
        if (context.callbackQuery) await context.answerCallbackQuery({ text });
        else await context.reply(text);
      }
      return;
    }
    await next();
  });

  bot.command('start', async context => {
    const session = sessions.get(context.chat.id)!;
    session.enteringDate = false;
    const screen = menu(session);
    screen.button('Найти события', next => showResults(next, session));
    screen.keyboard.row();
    addFilters(screen, session);
    if (site) screen.keyboard.url('Открыть сайт', site);
    await screen.send(context, 'Афиша Башкортостана. Выберите фильтры или отправьте название события.');
  });

  bot.command('help', context => context.reply(help));
  bot.command('cancel', async context => {
    const session = sessions.get(context.chat.id)!;
    session.enteringDate = false;
    await showResults(context, session);
  });
  bot.command('unsubscribe', async context => {
    const removed = catalog.unsubscribe(String(context.chat.id));
    await context.reply(removed ? 'Подписки удалены.' : 'Активных подписок нет.');
  });

  bot.on('callback_query', async context => {
    const session = sessions.get(context.chatId!)!;
    const action = context.callbackQuery.data && session.buttons.get(context.callbackQuery.data);
    if (!action) {
      await context.answerCallbackQuery({ text: 'Кнопка устарела. Отправьте /start, чтобы открыть меню.' });
      return;
    }
    await context.answerCallbackQuery();
    await action(context);
  });

  bot.on('message:text', async context => {
    const session = sessions.get(context.chat.id)!;
    const text = context.message.text.trim();
    if (text.startsWith('/')) {
      await context.reply('Неизвестная команда. Отправьте /help.');
      return;
    }
    const dateLike = /^\d{4}-\d{1,2}-\d{1,2}$/.test(text);
    if (session.enteringDate || dateLike) {
      if (!isLocalDate(text)) {
        await context.reply('Проверьте дату и отправьте её в формате ГГГГ-ММ-ДД.');
        return;
      }
      session.filters.period = undefined;
      await setFilter(context, session, 'date', text);
      return;
    }
    try {
      const { query } = parseFilters({ q: text }, clock());
      await setFilter(context, session, 'q', query);
    } catch (error) {
      if (!(error instanceof FilterError)) throw error;
      await context.reply('Введите до 100 символов для поиска.');
    }
  });

  return bot;
}
