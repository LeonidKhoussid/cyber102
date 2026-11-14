import { randomUUID } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { categories, dayPlanLimit } from '@afisha/contracts';
import type { CatalogEvent, Category, DiscoveryContext, DiscoveryResponse, QueryValues } from '@afisha/contracts';
import { BotServiceError } from './client.ts';
import type { BotService } from './client.ts';

type BotOptions = {
  token: string;
  service: BotService;
  siteUrl?: string;
  onError?: () => void;
  clock?: () => Date;
};

type Action = (context: Context) => Promise<void>;
type DayPlan = { city: string; date: string; eventIds: string[] };
type Session = {
  filters: QueryValues & { category?: Category; period?: keyof typeof periods };
  discovery?: DiscoveryContext;
  dayPlan?: DayPlan;
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
const help = 'Напишите, какое событие ищете, например «Концерт в Уфе на двоих до 2000 ₽». Для плана на день добавляйте предложенные события по одному. /start начинает новый поиск. В каталоге можно выбрать город, категорию, даты и цену кнопками. Для точной даты введите ГГГГ-ММ-ДД. /cancel отменяет ввод даты. /unsubscribe удаляет все подписки.';
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' });
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', dateStyle: 'medium', timeStyle: 'short' });
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const nextPlanStep = 'Что дальше по плану?';

function publicUrl(value?: string): string | undefined {
  if (!value || value.length > 2000) return;
  const url = URL.parse(value);
  if (url?.protocol === 'https:' && !url.username && !url.password) return url.href;
}

function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.valueOf()) && day.toISOString().slice(0, 10) === value;
}

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

export function createTelegramBot({ token, service, siteUrl, onError, clock = () => new Date() }: BotOptions) {
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

  function filtersFor(session: Session): QueryValues {
    if (session.filters.period !== 'nextWeek') return session.filters;
    const today = new Date(`${localDate.format(clock())}T00:00:00Z`);
    const monday = ((8 - today.getUTCDay()) % 7) || 7;
    const offset = (days: number) => new Date(today.valueOf() + days * 86_400_000).toISOString().slice(0, 10);
    return { ...session.filters, period: undefined, from: offset(monday), until: offset(monday + 6) };
  }

  async function setFilter<K extends keyof Session['filters']>(
    context: Context, session: Session, field: K, value?: Session['filters'][K],
  ) {
    if (value === undefined) delete session.filters[field];
    else session.filters[field] = value;
    session.page = 1;
    session.enteringDate = false;
    await showResults(context, session);
  }

  async function chooseCity(context: Context, session: Session, page = 0) {
    const cities = (await service.directories()).cities.filter(city => city.length <= 100);
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
      screen.button(label, next => setFilter(next, session, 'category', category as Category));
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
        await setFilter(next, session, 'period', period as keyof typeof periods);
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

  async function showDetails(
    context: Context, session: Session, id: string, back: Action = next => showResults(next, session),
  ) {
    const event = await service.event(id);
    const screen = menu(session);
    if (!event) {
      screen.button('К результатам', back);
      await screen.send(context, 'Событие больше недоступно.');
      return;
    }
    const ticket = event.status === 'published' && publicUrl(event.ticketUrl);
    if (ticket) screen.keyboard.url('К билетам', ticket).row();
    const source = publicUrl(event.sources[0]?.url);
    if (source) screen.keyboard.url('Источник', source).row();
    if (site) screen.keyboard.url('На сайте', new URL(`/events/${encodeURIComponent(event.id)}`, site).href).row();
    screen.button('К результатам', back);
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
    const filters = session.filters;
    const result = await service.search({ ...filtersFor(session), page: String(session.page), limit: String(pageSize) });
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
    screen.button('Подписаться', async next => {
      const subscriptionScreen = menu(session);
      subscriptionScreen.button('К результатам', back => showResults(back, session));
      if (!filters.city || !filters.category) {
        addFilters(subscriptionScreen, session);
        await subscriptionScreen.send(next, 'Для подписки выберите город и категорию.');
        return;
      }
      await service.subscribe(String(next.chatId), { city: filters.city, category: filters.category });
      await subscriptionScreen.send(next, `Подписка сохранена: ${filters.city}, ${categories[filters.category]}. /unsubscribe удалит подписки.`);
    });
    const dateLabel = filters.date ?? (filters.period && periods[filters.period]);
    const selected = [filters.city, filters.category && categories[filters.category], dateLabel,
      filters.maxPrice !== undefined && (filters.maxPrice === '0' ? 'бесплатно' : `до ${money.format(Number(filters.maxPrice))}`)].filter(Boolean);
    const events = result.events.map((event, index) => `${index + 1}. ${shorten(event.title, 120)} — ${dateFormatter.format(new Date(event.startsAt))}, ${shorten(event.city, 80)}`);
    const changeable = [
      filters.maxPrice !== undefined && 'цену', dateLabel && 'даты',
      filters.category && 'категорию', filters.city && 'город',
    ].filter(Boolean);
    const empty = changeable.length
      ? `Событий не найдено. Попробуйте изменить ${changeable[0]}.`
      : 'Событий пока нет. Проверьте каталог позже.';
    const heading = result.total ? `Событий: ${result.total}. Страница ${result.page} из ${pageCount}.` : empty;
    await screen.send(context, [heading, selected.join(' · '), ...events].filter(Boolean).join('\n'));
  }

  async function showDiscovery(context: Context, session: Session, result: DiscoveryResponse) {
    const screen = menu(session);
    const lines = [shorten(result.message, 800)];
    const constraints = result.constraints.map(({ label, value }) => `${label}: ${value}`).join(' · ');
    if (constraints) lines.push(shorten(constraints, 400));
    const cards = result.events.length ? result.events : result.alternatives ?? [];
    const { city, date, planMode, planStep } = result.context;
    const plan = session.dayPlan;
    for (const { event, reasons } of cards.slice(0, pageSize)) {
      screen.button(event.title, next => showDetails(next, session, event.id, back => showDiscovery(back, session, result)));
      screen.keyboard.row();
      const summary = `${shorten(event.title, 120)} — ${dateFormatter.format(new Date(event.startsAt))}, ${shorten(event.city, 80)}`;
      lines.push([summary, shorten(reasons.join(' · '), 320)].filter(Boolean).join('\n'));
      if (planMode === 'day' && planStep?.phase === 'offer' && planStep.eventId === event.id && event.status === 'published' && city === event.city && date) {
        if (plan && plan.eventIds.length > 0 && (plan.city !== city || plan.date !== date)) {
          lines.push('В плане уже есть события другого дня или города. Чтобы начать заново, отправьте /start.');
        } else if (!plan?.eventIds.includes(event.id) && (plan?.eventIds.length ?? 0) < dayPlanLimit) {
          screen.button('Добавить в план', next => discover(next, session, nextPlanStep, { city, date, eventIds: [...(plan?.eventIds ?? []), event.id] }));
          screen.keyboard.row();
        }
      }
    }
    for (const suggestion of result.suggestions.slice(0, planMode === 'day' ? 7 : 3)) {
      screen.button(suggestion, next => discover(next, session, suggestion));
      screen.keyboard.row();
    }
    if (plan?.eventIds.length && planMode === 'day') {
      screen.button('Убрать последнее событие', next => discover(next, session, nextPlanStep, { ...plan, eventIds: plan.eventIds.slice(0, -1) }));
      screen.keyboard.row();
    }
    screen.button('Открыть каталог', next => showResults(next, session));
    await screen.send(context, lines.join('\n\n'));
  }

  async function discover(context: Context, session: Session, text: string, plan = session.dayPlan) {
    if (!text || text.length > 1200) {
      await context.reply('Опишите событие в сообщении до 1200 символов.');
      return;
    }
    const result = await service.discover(text, session.discovery, plan?.eventIds);
    session.discovery = result.context;
    session.dayPlan = plan?.eventIds.length ? plan : undefined;
    await showDiscovery(context, session, result);
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
    try {
      await next();
    } catch (error) {
      if (!(error instanceof BotServiceError)) throw error;
      onError?.();
      await context.reply('Афиша временно недоступна. Попробуйте ещё раз позже.');
    }
  });

  bot.command('start', async context => {
    const session = sessions.get(context.chat.id)!;
    session.enteringDate = false;
    session.discovery = undefined;
    session.dayPlan = undefined;
    const screen = menu(session);
    screen.button('Найти события', next => showResults(next, session));
    screen.keyboard.row();
    addFilters(screen, session);
    if (site) screen.keyboard.url('Открыть сайт', site);
    await screen.send(context, 'Афиша Башкортостана. Выберите фильтры или напишите, какое событие ищете.');
  });

  bot.command('help', context => context.reply(help));
  bot.command('cancel', async context => {
    const session = sessions.get(context.chat.id)!;
    session.enteringDate = false;
    await showResults(context, session);
  });
  bot.command('unsubscribe', async context => {
    const removed = await service.unsubscribe(String(context.chat.id));
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
    if ((session.enteringDate || dateLike) && !isLocalDate(text)) {
      await context.reply('Проверьте дату и отправьте её в формате ГГГГ-ММ-ДД.');
      return;
    }
    if (session.enteringDate || (dateLike && !session.discovery)) {
      session.filters.period = undefined;
      await setFilter(context, session, 'date', text);
      return;
    }
    await discover(context, session, text);
  });

  return bot;
}
