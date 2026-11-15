import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InlineKeyboardButton, MenuButton, Update } from 'grammy/types';
import { configureMiniApp, createTelegramBot } from '../src/bot.ts';
import type { CatalogEvent, DiscoveryContext, DiscoveryResponse } from '@afisha/contracts';
import { createBotService } from '../src/client.ts';
import { openCatalog } from '../../api/src/catalog.ts';
import { buildServer } from '../../api/src/server.ts';

const fixedDate = new Date('2026-11-13T10:00:00+05:00');
const botUser = { id: 99, is_bot: true, first_name: 'Афиша', username: 'afisha_test_bot', can_join_groups: false,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false,
  supports_guest_queries: false, supports_join_request_queries: false } as const;

function event(title: string, startsAt: string, extra: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    id: title, title, startsAt, city: 'Уфа', venue: 'Филармония', category: 'concert',
    status: 'published', sources: [{ name: 'Филармония', url: 'https://example.com/venue' }], ...extra,
  };
}

function api(events: CatalogEvent[] = []) {
  const requests: { method: string; url: URL; body: unknown; authorization: string | null }[] = [];
  const subscriptions = new Map<string, Set<string>>();
  let discover: ((body: unknown) => DiscoveryResponse | Response) | undefined;
  const service = createBotService('http://api.test', 'test-token', async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.body ? await request.json() : undefined;
    const authorization = request.headers.get('authorization');
    requests.push({ method: request.method, url, body, authorization });
    switch (url.pathname) {
      case '/api/v1/directories':
        return Response.json({ cities: [...new Set(events.map(item => item.city))], venues: [], categories: [] });
      case '/api/v1/events': {
        const city = url.searchParams.get('city');
        const category = url.searchParams.get('category');
        const maxPrice = url.searchParams.get('maxPrice');
        const date = url.searchParams.get('date');
        const from = url.searchParams.get('from');
        const until = url.searchParams.get('until');
        const period = url.searchParams.get('period');
        const page = Number(url.searchParams.get('page'));
        const limit = Number(url.searchParams.get('limit'));
        const matching = events.filter(item => {
          const day = item.startsAt.slice(0, 10);
          return item.status === 'published' && (!city || item.city === city) && (!category || item.category === category)
            && (maxPrice === null || (item.priceMin !== undefined && item.priceMin <= Number(maxPrice)))
            && (!date || day === date) && (!from || day >= from) && (!until || day <= until)
            && (!period || (period === 'today' && day === '2026-11-13')
              || (period === 'tomorrow' && day === '2026-11-14')
              || (period === 'weekend' && ['2026-11-14', '2026-11-15'].includes(day)));
        });
        return Response.json({ events: matching.slice((page - 1) * limit, page * limit), page, limit, total: matching.length });
      }
      case '/api/v1/discover': {
        assert.ok(discover);
        const result = discover(body);
        return result instanceof Response ? result : Response.json(result);
      }
      case '/api/v1/bot/subscriptions': {
        assert.equal(authorization, 'Bearer test-token');
        const { subscriber, city, category } = body as { subscriber: string; city?: string; category?: string };
        if (request.method === 'DELETE') {
          const removed = subscriptions.get(subscriber)?.size ?? 0;
          subscriptions.delete(subscriber);
          return Response.json({ removed });
        }
        assert.equal(request.method, 'PUT');
        const existing = subscriptions.get(subscriber) ?? new Set();
        existing.add(JSON.stringify({ city, category }));
        subscriptions.set(subscriber, existing);
        return new Response(null, { status: 204 });
      }
      default: {
        assert.ok(url.pathname.startsWith('/api/v1/events/'));
        const item = events.find(item => item.id === decodeURIComponent(url.pathname.slice('/api/v1/events/'.length)));
        return item ? Response.json(item) : new Response(null, { status: 404 });
      }
    }
  });
  return { service, requests, subscriptions, discover: (handler: typeof discover) => { discover = handler; } };
}

function harness({ service }: Pick<ReturnType<typeof api>, 'service'>, siteUrl?: string) {
  let time = fixedDate.valueOf();
  let errors = 0;
  const bot = createTelegramBot({ token: 'offline', service, siteUrl, clock: () => new Date(time), onError: () => { errors++; } });
  type RecordedPayload = { text?: string; reply_markup?: { inline_keyboard: InlineKeyboardButton[][] }; menu_button?: MenuButton };
  const calls: { method: string; payload: RecordedPayload }[] = [];
  bot.botInfo = botUser;
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as RecordedPayload });
    return { ok: true, result: true } as never;
  });

  let updateId = 0;
  const chat = (id: number) => ({ id, type: 'private', first_name: 'Тест' }) as const;
  const user = (id: number) => ({ id, is_bot: false, first_name: 'Тест' });
  async function message(text: string, id = 1, inGroup = false) {
    const messageChat = inGroup ? { id: -1, type: 'group', title: 'Тест' } as const : chat(id);
    await bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 1, chat: messageChat, from: user(id), text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [],
    } });
  }
  function latest() {
    const call = calls.findLast(call => call.method === 'sendMessage');
    assert.ok(call);
    return { text: call.payload.text ?? '', buttons: call.payload.reply_markup?.inline_keyboard.flat() ?? [] };
  }
  function data(label: string | RegExp) {
    const button = latest().buttons.find(button => typeof label === 'string' ? button.text === label : label.test(button.text));
    assert.ok(button && 'callback_data' in button && button.callback_data, String(label));
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    return button.callback_data;
  }
  async function callback(payload: string, chatId = 1, userId = chatId, reuseUpdate = false) {
    if (!reuseUpdate) updateId++;
    const update: Update = { update_id: updateId, callback_query: {
      id: String(updateId), from: user(userId), chat_instance: String(chatId), data: payload,
      message: { message_id: 1, date: 1, chat: chat(chatId), text: 'Тест' },
    } };
    await bot.handleUpdate(update);
  }
  return { bot, calls, message, latest, data, callback, errors: () => errors, click: (label: string | RegExp) => callback(data(label)),
    advance: (milliseconds: number) => { time += milliseconds; } };
}

test('opens the public site as a Mini App from the default menu and private start message', async () => {
  const telegram = harness(api(), 'https://afisha.example');
  await configureMiniApp(telegram.bot, 'https://afisha.example');
  assert.deepEqual(telegram.calls.at(-1), {
    method: 'setChatMenuButton',
    payload: { menu_button: { type: 'web_app', text: 'Открыть Афишу', web_app: { url: 'https://afisha.example/' } } },
  });
  await telegram.message('/start');
  const launch = telegram.latest().buttons.find(button => button.text === 'Открыть Афишу');
  assert.deepEqual(launch, { text: 'Открыть Афишу', web_app: { url: 'https://afisha.example/' } });
  const calls = telegram.calls.length;
  await telegram.message('/start', 1, true);
  assert.equal(telegram.calls.length, calls);
});

test('does not offer a Mini App without a valid public HTTPS URL', async () => {
  for (const siteUrl of [undefined, 'http://localhost:3000', 'not-a-url', 'https://user:password@example.com']) {
    const telegram = harness(api(), siteUrl);
    await configureMiniApp(telegram.bot, siteUrl);
    assert.equal(telegram.calls.length, 0);
    await telegram.message('/start');
    assert.ok(!telegram.latest().buttons.some(button => 'web_app' in button));
  }
});

test('browses results with shared filters, pagination and source links', async () => {
  const concerts = Array.from({ length: 6 }, (_, index) => event(
    `Квартет ${index + 1}`, `2026-11-14T1${index}:00:00+05:00`,
    index === 5 ? { endsAt: '2026-11-14T16:30:00+05:00', ticketUrl: 'https://example.com/tickets' } : {},
  ));
  const backend = api([
    ...concerts,
    event('Квартет в Стерлитамаке', '2026-11-14T15:00:00+05:00', { city: 'Стерлитамак', priceMin: 300 }),
    event('Спектакль Квартет', '2026-11-14T15:00:00+05:00', { category: 'theatre', priceMin: 300 }),
  ]);
  const telegram = harness(backend, 'https://afisha.example/');
  await telegram.message('/start');
  await telegram.click('Город');
  await telegram.click('Уфа');
  await telegram.click('Категория');
  await telegram.click('Концерты');
  assert.match(telegram.latest().text, /Событий: 6. Страница 1 из 2/);
  await telegram.click('Далее →');
  assert.match(telegram.latest().text, /Страница 2 из 2/);
  await telegram.click(/Квартет 6/);
  assert.match(telegram.latest().text, /Цена: неизвестна\nВозраст: неизвестен/);
  assert.match(telegram.latest().text, /До: .*16:30/);
  const eventId = encodeURIComponent(concerts[5].id);
  assert.deepEqual(telegram.latest().buttons.filter(button => 'url' in button).map(button => button.url), [
    'https://example.com/tickets', 'https://example.com/venue', `https://afisha.example/events/${eventId}`,
  ]);
  await telegram.click('К результатам');
  assert.match(telegram.latest().text, /Страница 2 из 2/);
  await telegram.click('← Назад');
  assert.match(telegram.latest().text, /Страница 1 из 2/);
  await telegram.click('Цена');
  await telegram.click('Бесплатно');
  assert.match(telegram.latest().text, /Событий не найдено.*изменить цену/);
  assert.equal(backend.requests.at(-1)?.url.searchParams.get('maxPrice'), '0');
});

test('shows a cancellation published after the results and hides its ticket link', async () => {
  const quartet = event('Квартет', '2026-11-14T19:00:00+05:00', { ticketUrl: 'https://example.com/tickets' });
  const telegram = harness(api([quartet]));
  await telegram.message('/start');
  await telegram.click('Найти события');
  quartet.status = 'cancelled';
  await telegram.click(/Квартет/);
  assert.match(telegram.latest().text, /Событие отменено/);
  assert.ok(telegram.latest().buttons.some(button => button.text === 'Источник'));
  assert.ok(!telegram.latest().buttons.some(button => button.text === 'К билетам'));
  await telegram.click('К результатам');
  assert.match(telegram.latest().text, /Событий пока нет/);
});

test('handles each relative period and exact dates in Bashkortostan time', async () => {
  const backend = api([
    event('Пятница', '2026-11-13T20:00:00+05:00'),
    event('Суббота', '2026-11-14T00:01:00+05:00'),
    event('Воскресенье', '2026-11-15T23:59:00+05:00'),
    event('Понедельник', '2026-11-16T00:00:00+05:00'),
    event('Край следующей недели', '2026-11-22T23:59:00+05:00'),
    event('Через неделю', '2026-11-23T00:00:00+05:00'),
  ]);
  const telegram = harness(backend, 'http://unsafe.example');
  await telegram.message('/start');
  assert.ok(!telegram.latest().buttons.some(button => 'url' in button));
  await telegram.click('Даты');
  await telegram.click('Сегодня');
  assert.match(telegram.latest().text, /Событий: 1.*\n.*\n.*Пятница/);
  await telegram.click('Даты');
  await telegram.click('Завтра');
  assert.match(telegram.latest().text, /Событий: 1.*\n.*\n.*Суббота/);
  await telegram.click('Даты');
  await telegram.click('Ближайшие выходные');
  assert.match(telegram.latest().text, /Событий: 2.*\n.*\n.*Суббота.*\n.*Воскресенье/);
  await telegram.click('Даты');
  await telegram.click('Следующая неделя');
  assert.equal(backend.requests.at(-1)?.url.searchParams.get('from'), '2026-11-16');
  assert.equal(backend.requests.at(-1)?.url.searchParams.get('until'), '2026-11-22');
  assert.match(telegram.latest().text, /Событий: 2.*\n.*\n.*Понедельник.*\n.*Край следующей недели/);
  await telegram.click('Даты');
  await telegram.click('Точная дата');
  await telegram.message('2026-11-31');
  assert.match(telegram.latest().text, /Проверьте дату/);
  telegram.advance(10_000);
  await telegram.message('/cancel');
  assert.match(telegram.latest().text, /Следующая неделя/);
  await telegram.click('Даты');
  await telegram.click('Точная дата');
  await telegram.message('2026-11-23');
  assert.match(telegram.latest().text, /Событий: 1.*\n.*\n.*Через неделю/);
});

test('plain dates and arbitrary conversational replies always reach AI discovery outside the explicit date form', async () => {
  const backend = api();
  backend.discover(() => ({ status: 'clarify', message: 'С кем планируете пойти?',
    context: { memory: 'Пользователь выбирает отдых', conversation: [{ role: 'assistant', content: 'С кем планируете пойти?' }] },
    events: [], constraints: [], suggestions: [] }));
  const telegram = harness(backend);
  await telegram.message('/start');
  await telegram.message('2026-11-23');
  assert.equal((backend.requests.at(-1)?.body as { message: string }).message, '2026-11-23');
  await telegram.message('Я, моя половинка и наш маленький любитель динозавров');
  const body = backend.requests.at(-1)?.body as { message: string; context: DiscoveryContext };
  assert.equal(body.message, 'Я, моя половинка и наш маленький любитель динозавров');
  assert.equal(body.context.conversation?.at(-1)?.content, 'С кем планируете пойти?');
});

test('uses the authenticated backend to store subscriptions and scopes removal to the private chat', async () => {
  const backend = api([event('Квартет', '2026-11-14T19:00:00+05:00')]);
  const telegram = harness(backend);
  await telegram.message('/start');
  await telegram.click('Найти события');
  await telegram.click('Подписаться');
  assert.match(telegram.latest().text, /выберите город и категорию/);
  assert.ok(!backend.requests.some(request => request.method === 'PUT'));
  await telegram.click('Город');
  await telegram.click('Уфа');
  await telegram.click('Категория');
  await telegram.click('Концерты');
  await telegram.click('Подписаться');
  assert.match(telegram.latest().text, /Подписка сохранена/);
  await telegram.click('К результатам');
  await telegram.click('Подписаться');
  assert.deepEqual(backend.requests.at(-1)?.body, { subscriber: '1', city: 'Уфа', category: 'concert' });
  assert.equal(backend.subscriptions.get('1')?.size, 1);

  backend.subscriptions.set('2', new Set(['other']));
  const restartedBot = harness(backend);
  await restartedBot.message('/unsubscribe', 1, true);
  assert.equal(restartedBot.calls.length, 0);
  await restartedBot.message('/unsubscribe');
  assert.equal(restartedBot.latest().text, 'Подписки удалены.');
  assert.deepEqual(backend.requests.at(-1)?.body, { subscriber: '1' });
  assert.equal(backend.subscriptions.has('1'), false);
  assert.equal(backend.subscriptions.has('2'), true);
  await restartedBot.message('/unsubscribe');
  assert.equal(restartedBot.latest().text, 'Активных подписок нет.');
});

test('rejects unknown, cross-chat, replayed and expired callbacks and bounds rapid input', async () => {
  const telegram = harness(api());
  await telegram.message('/start');
  const city = telegram.data('Город');
  await telegram.callback(city, 2, 1);
  assert.equal(telegram.calls.length, 1);
  await telegram.callback(city, 2);
  assert.match(telegram.calls.at(-1)?.payload.text ?? '', /Кнопка устарела/);
  await telegram.callback('malformed');
  assert.match(telegram.calls.at(-1)?.payload.text ?? '', /Кнопка устарела/);
  await telegram.callback(city);
  assert.match(telegram.latest().text, /Города появятся/);
  const count = telegram.calls.length;
  await telegram.callback(city, 1, 1, true);
  assert.equal(telegram.calls.length, count);
  await telegram.callback(city);
  assert.match(telegram.calls.at(-1)?.payload.text ?? '', /Кнопка устарела/);
  const allCities = telegram.data('Все города');
  telegram.advance(30 * 60_000);
  await telegram.callback(allCities);
  assert.match(telegram.calls.at(-1)?.payload.text ?? '', /Кнопка устарела/);
  for (let index = 0; index < 15; index++) await telegram.message('/help', 3);
  assert.equal(telegram.calls.filter(call => call.payload.text?.includes('Слишком много запросов')).length, 1);
  telegram.advance(10_000);
  await telegram.message('/help', 3);
  assert.match(telegram.latest().text, /Напишите, какое событие ищете/);
});

test('sends free text and follow-ups to discovery and opens a matched card', async () => {
  const quartet = event('Квартет', '2026-11-14T19:00:00+05:00');
  const backend = api([quartet]);
  const response: DiscoveryResponse = {
    status: 'matches', message: 'Нашли концерт в Уфе.', constraints: [{ label: 'Бюджет', value: '2000 ₽' }],
    events: [{ event: quartet, reasons: ['Подходит по бюджету'] }], suggestions: ['Подешевле'],
    context: { city: 'Уфа', partySize: 3, budget: 2000 },
  };
  backend.discover(() => response);
  const telegram = harness(backend);
  await telegram.message('Концерт на троих в Уфе до 2000 рублей');
  assert.deepEqual(backend.requests.at(-1)?.body, { message: 'Концерт на троих в Уфе до 2000 рублей', planExperience: true, guidedPlan: true });
  assert.equal(backend.requests.at(-1)?.authorization, null);
  assert.match(telegram.latest().text, /Бюджет: 2000 ₽/);
  assert.match(telegram.latest().text, /Подходит по бюджету/);
  await telegram.click(/Квартет/);
  assert.equal(backend.requests.at(-1)?.url.pathname, '/api/v1/events/%D0%9A%D0%B2%D0%B0%D1%80%D1%82%D0%B5%D1%82');
  assert.match(telegram.latest().text, /Концерты/);
  await telegram.click('К результатам');
  assert.match(telegram.latest().text, /Нашли концерт в Уфе/);

  backend.discover(() => ({ ...response, status: 'no_results', message: 'Дешевле событий нет.', events: [], suggestions: [] }));
  await telegram.click('Подешевле');
  assert.deepEqual(backend.requests.at(-1)?.body, { message: 'Подешевле', context: response.context, planExperience: true, guidedPlan: true });
  assert.match(telegram.latest().text, /Дешевле событий нет/);
  await telegram.message('2026-11-23');
  assert.deepEqual(backend.requests.at(-1)?.body, { message: '2026-11-23', context: response.context, planExperience: true, guidedPlan: true });
  await telegram.message('Что сегодня?', 2);
  assert.deepEqual(backend.requests.at(-1)?.body, { message: 'Что сегодня?', planExperience: true, guidedPlan: true });
});

test('accepts the active day-plan offer, advances the shared conversation, and rejects stale offer buttons', async () => {
  const concert = event('Утренний концерт', '2026-11-14T10:00:00+05:00', {
    id: '00000000-0000-4000-8000-000000000001', endsAt: '2026-11-14T11:00:00+05:00',
  });
  const backend = api([concert]);
  const context: DiscoveryResponse['context'] = { city: 'Уфа', date: '2026-11-14', planMode: 'day' };
  const offer: DiscoveryResponse = {
    status: 'matches', message: 'Утренний концерт в 10:00. Добавим в план?', constraints: [],
    events: [{ event: concert, reasons: [] }], suggestions: [], context: { ...context, planStep: { phase: 'offer', eventId: concert.id } },
  };
  const nextQuestion: DiscoveryResponse = {
    status: 'clarify', message: 'Концерт закончится в 11:00. Что хотите после него?', constraints: [],
    events: [], suggestions: [], context: { ...context, planStep: { phase: 'question', anchor: concert.id } },
  };
  backend.discover(() => offer);
  const telegram = harness(backend);
  await telegram.message('Хочу начать день с концерта');
  const expiredSave = telegram.data('Добавить в план');
  await telegram.click('Утренний концерт');
  await telegram.click('К результатам');
  await telegram.callback(expiredSave);
  assert.equal(backend.requests.length, 2);

  const activeSave = telegram.data('Добавить в план');
  backend.discover(() => new Response(null, { status: 503 }));
  await telegram.callback(activeSave);
  assert.match(telegram.latest().text, /временно недоступна/);
  const retriableSave = backend.requests.at(-1)?.body;
  assert.deepEqual(retriableSave, {
    message: 'Что дальше по плану?', context: offer.context, planExperience: true, guidedPlan: true, selectedEventIds: [concert.id],
  });
  backend.discover(() => nextQuestion);
  await telegram.callback(activeSave);
  assert.deepEqual(backend.requests.at(-1)?.body, retriableSave);
  assert.match(telegram.latest().text, /в 11:00/);
  const requests = backend.requests.length;
  await telegram.callback(activeSave);
  assert.equal(backend.requests.length, requests);

  backend.discover(() => offer);
  await telegram.click('Убрать последнее событие');
  assert.deepEqual(backend.requests.at(-1)?.body, {
    message: 'Что дальше по плану?', context: nextQuestion.context, planExperience: true, guidedPlan: true, selectedEventIds: [],
  });
  await telegram.click('Добавить в план');
  await telegram.message('/start');
  await telegram.message('Что есть завтра?');
  assert.deepEqual(backend.requests.at(-1)?.body, { message: 'Что есть завтра?', planExperience: true, guidedPlan: true });
});

test('Telegram presents several plan choices and saves only the option the user chooses', async () => {
  const choices = Array.from({ length: 3 }, (_, index) => event(`Вариант ${index + 1}`, '2026-11-14T12:00:00+05:00'));
  const backend = api(choices);
  let calls = 0;
  backend.discover(() => ++calls === 1 ? {
    status: 'matches', message: 'Вот три спектакля. Выберите один.', suggestions: [], constraints: [],
    context: { city: 'Уфа', date: '2026-11-14', planMode: 'day', planCount: 2,
      planStep: { phase: 'offer', eventId: choices[0].id, eventIds: choices.map(item => item.id) } },
    events: choices.map(item => ({ event: item, reasons: [] })),
  } : { status: 'clarify', message: 'Что хочется после выбранного спектакля?', suggestions: [], constraints: [],
    context: { city: 'Уфа', date: '2026-11-14', planMode: 'day' }, events: [] });
  const telegram = harness(backend);
  await telegram.message('Посоветуй спектакли для плана дня');
  assert.deepEqual(telegram.latest().buttons.filter(button => /^Выбрать /u.test(button.text)).map(button => button.text),
    ['Выбрать 1', 'Выбрать 2', 'Выбрать 3']);
  await telegram.click('Выбрать 2');
  assert.deepEqual((backend.requests.at(-1)?.body as { selectedEventIds: string[] }).selectedEventIds, [choices[1].id]);
  assert.equal(calls, 2);
});

test('Telegram guides a day plan with the actual discovery API and skips overlapping events', async () => {
  const clock = () => fixedDate;
  const catalog = openCatalog(':memory:', clock);
  const source = { sourceType: 'import', sourceUrl: 'https://example.com/events', sourceName: 'Тест', raw: null, city: 'Уфа',
    status: 'published' } as const;
  catalog.importEvents([
    { ...source, title: 'Утренний спектакль', category: 'theatre', venue: 'Театр', sourceKey: 'theatre',
      startsAt: '2026-11-14T10:00:00+05:00', endsAt: '2026-11-14T12:00:00+05:00' },
    { ...source, title: 'Ранняя выставка', category: 'exhibition', venue: 'Музей', sourceKey: 'early',
      startsAt: '2026-11-14T11:00:00+05:00' },
    { ...source, title: 'Выставка после обеда', category: 'exhibition', venue: 'Музей', sourceKey: 'later',
      startsAt: '2026-11-14T13:00:00+05:00' },
  ]);
  const server = await buildServer(catalog, { clock, disableModel: true });
  const service = createBotService('http://api.test', 'test-token', async (input, options) => {
    const request = new Request(input, options);
    const response = await server.inject({ method: 'POST', url: new URL(request.url).pathname,
      headers: { 'content-type': 'application/json' }, payload: await request.text() });
    return new Response(response.body, { status: response.statusCode });
  });

  try {
    const telegram = harness({ service });
    await telegram.message('Подбери два события в Уфе завтра, поедем на машине');
    assert.match(telegram.latest().text, /С чего хотите начать/u);
    assert.doesNotMatch(telegram.latest().text, /Утренний спектакль/u);
    await telegram.click('Спектакли');
    assert.match(telegram.latest().text, /Утренний спектакль.*10:00.*12:00/u);
    await telegram.click('Добавить в план');
    assert.match(telegram.latest().text, /освободитесь в 12:00/u);
    assert.doesNotMatch(telegram.latest().text, /Выставка после обеда/u);
    await telegram.click('Выставки');
    assert.match(telegram.latest().text, /Выставка после обеда.*13:00/u);
    assert.doesNotMatch(telegram.latest().text, /Ранняя выставка/u);
  } finally {
    await server.close();
    catalog.close();
  }
});

test('Telegram keeps the detailed nearby-miss explanation and a selectable exhibition alternative', async () => {
  const exhibition = event('Фотовыставка', '2026-11-14T12:00:00+05:00', { category: 'exhibition' });
  const backend = api([exhibition]);
  const explanation = 'Рядом с выбранным кинотеатром выставку подтвердить не удалось. '
    + 'Я проверил остальные условия выбранного дня и доступные сведения о площадках. '.repeat(10)
    + 'Есть фотовыставка в другом месте, но расстояние до кинотеатра не проверено.';
  backend.discover(() => ({ status: 'clarify', message: explanation, constraints: [], suggestions: [], events: [],
    alternatives: [{ event: exhibition, reasons: ['Расстояние до кинотеатра не удалось проверить.'] }], alternativeReason: 'proximity',
    context: { city: 'Уфа', date: '2026-11-14', planMode: 'day', planStep: { phase: 'offer', eventId: exhibition.id } } }));
  const telegram = harness(backend);
  await telegram.message('Выставку рядом с кинотеатром');
  assert.match(telegram.latest().text, /другом месте, но расстояние до кинотеатра не проверено/);
  assert.match(telegram.latest().text, /Фотовыставка/);
  assert.ok(telegram.latest().buttons.some(button => button.text === 'Добавить в план'));
  assert.ok(telegram.latest().text.length <= 4000);
});

test('reports backend failures and keeps context for a retry', async () => {
  const backend = api();
  backend.discover(() => ({
    status: 'clarify', message: 'На какой день?', context: { city: 'Уфа' }, constraints: [], events: [], suggestions: [],
  }));
  const telegram = harness(backend);
  await telegram.message('Концерт в Уфе');
  assert.equal(telegram.latest().text, 'На какой день?');
  backend.discover(() => new Response('private backend diagnostic', { status: 503 }));
  await telegram.message('Завтра');
  assert.match(telegram.latest().text, /временно недоступна/);
  assert.equal(telegram.errors(), 1);
  await telegram.message('В выходные');
  assert.deepEqual(backend.requests.at(-1)?.body, { message: 'В выходные', context: { city: 'Уфа' }, planExperience: true, guidedPlan: true });
});
