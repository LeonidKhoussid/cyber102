import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { InlineKeyboardButton, Update } from 'grammy/types';
import { createTelegramBot } from '../src/bot.ts';
import { openCatalog } from '../src/catalog.ts';
import type { Catalog, SourceEvent } from '../src/catalog.ts';

const fixedDate = new Date('2026-11-13T10:00:00+05:00');
const botUser = { id: 99, is_bot: true, first_name: 'Афиша', username: 'afisha_test_bot', can_join_groups: false,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false,
  supports_guest_queries: false, supports_join_request_queries: false } as const;

function event(title: string, startsAt: string, extra: Partial<SourceEvent> = {}): SourceEvent {
  return {
    title, startsAt, city: 'Уфа', venue: 'Филармония', category: 'concert',
    status: 'published', sourceName: 'Филармония', sourceUrl: 'https://example.com/venue',
    sourceKey: title, sourceType: 'manual', raw: {}, ...extra,
  };
}

function harness(catalog: Catalog, siteUrl?: string) {
  let time = fixedDate.valueOf();
  const bot = createTelegramBot({ token: 'offline', catalog, siteUrl, clock: () => new Date(time) });
  type RecordedPayload = { text?: string; reply_markup?: { inline_keyboard: InlineKeyboardButton[][] } };
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
  return { calls, message, latest, data, callback, click: (label: string | RegExp) => callback(data(label)),
    advance: (milliseconds: number) => { time += milliseconds; } };
}

test('browses results with shared filters, pagination and source links', async context => {
  const catalog = openCatalog(':memory:', () => fixedDate);
  context.after(catalog.close);
  const concerts = Array.from({ length: 6 }, (_, index) => event(
    `Квартет ${index + 1}`, `2026-11-14T1${index}:00:00+05:00`,
    index === 5 ? { endsAt: '2026-11-14T16:30:00+05:00', ticketUrl: 'https://example.com/tickets' } : {},
  ));
  catalog.importEvents([
    ...concerts,
    event('Квартет в Стерлитамаке', '2026-11-14T15:00:00+05:00', { city: 'Стерлитамак', priceMin: 300 }),
    event('Спектакль Квартет', '2026-11-14T15:00:00+05:00', { category: 'theatre', priceMin: 300 }),
  ]);
  const telegram = harness(catalog, 'https://afisha.example/');
  await telegram.message('/start');
  await telegram.click('Город');
  await telegram.click('Уфа');
  await telegram.click('Категория');
  await telegram.click('Концерты');
  await telegram.message('Квартет');
  assert.match(telegram.latest().text, /Событий: 6. Страница 1 из 2/);
  await telegram.click('Далее →');
  assert.match(telegram.latest().text, /Страница 2 из 2/);
  await telegram.click(/Квартет 6/);
  assert.match(telegram.latest().text, /Цена: неизвестна\nВозраст: неизвестен/);
  assert.match(telegram.latest().text, /До: .*16:30/);
  const eventId = catalog.search({ query: 'Квартет 6' }).events[0].id;
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
  telegram.advance(10_000);
  await telegram.message('другой квартет');
  assert.match(telegram.latest().text, /другой квартет.*Уфа.*Концерты.*бесплатно/);
});

test('shows a cancellation published after the results and hides its ticket link', async context => {
  const catalog = openCatalog(':memory:', () => fixedDate);
  context.after(catalog.close);
  catalog.importEvents([event('Квартет', '2026-11-14T19:00:00+05:00', { ticketUrl: 'https://example.com/tickets' })]);
  const telegram = harness(catalog);
  await telegram.message('Квартет');
  const eventId = catalog.search().events[0].id;
  catalog.setStatus(eventId, 'cancelled');
  await telegram.click(/Квартет/);
  assert.match(telegram.latest().text, /Событие отменено/);
  assert.ok(telegram.latest().buttons.some(button => button.text === 'Источник'));
  assert.ok(!telegram.latest().buttons.some(button => button.text === 'К билетам'));
  await telegram.click('К результатам');
  assert.match(telegram.latest().text, /Событий не найдено/);
});

test('handles each relative period and exact dates in Bashkortostan time', async context => {
  const catalog = openCatalog(':memory:', () => fixedDate);
  context.after(catalog.close);
  catalog.importEvents([
    event('Пятница', '2026-11-13T20:00:00+05:00'),
    event('Суббота', '2026-11-14T00:01:00+05:00'),
    event('Воскресенье', '2026-11-15T23:59:00+05:00'),
    event('Понедельник', '2026-11-16T00:00:00+05:00'),
    event('Край следующей недели', '2026-11-22T23:59:00+05:00'),
    event('Через неделю', '2026-11-23T00:00:00+05:00'),
  ]);
  const telegram = harness(catalog, 'http://unsafe.example');
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
  assert.match(telegram.latest().text, /Событий: 2.*\n.*\n.*Понедельник.*\n.*Край следующей недели/);
  await telegram.click('Даты');
  await telegram.click('Точная дата');
  await telegram.message('2026-11-31');
  assert.match(telegram.latest().text, /Проверьте дату/);
  telegram.advance(10_000);
  await telegram.message('/cancel');
  assert.match(telegram.latest().text, /Следующая неделя/);
  await telegram.message('2026-11-23');
  assert.match(telegram.latest().text, /Событий: 1.*\n.*\n.*Через неделю/);
});

test('persists idempotent subscriptions and scopes unsubscribe to the private chat', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'afisha-telegram-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'catalog.sqlite');
  const catalog = openCatalog(filename, () => fixedDate);
  try {
    catalog.importEvents([event('Квартет', '2026-11-14T19:00:00+05:00', { priceMin: 0 })]);
    const telegram = harness(catalog);
    await telegram.message('Квартет');
    await telegram.click('Подписаться');
    assert.match(telegram.latest().text, /выберите город и категорию/);
    await telegram.click('Город');
    await telegram.click('Уфа');
    await telegram.click('Категория');
    await telegram.click('Концерты');
    await telegram.click('Подписаться');
    assert.match(telegram.latest().text, /Подписка сохранена/);
    await telegram.click('К результатам');
    await telegram.click('Подписаться');
    catalog.subscribe('2', { city: 'Уфа', category: 'concert' });
  } finally {
    catalog.close();
  }
  const reopened = openCatalog(filename, () => fixedDate);
  try {
    assert.deepEqual(reopened.subscriptions('1'), [{ city: 'Уфа', category: 'concert' }]);
    const telegram = harness(reopened);
    await telegram.message('/unsubscribe', 1, true);
    assert.equal(telegram.calls.length, 0);
    await telegram.message('/unsubscribe');
    assert.equal(telegram.latest().text, 'Подписки удалены.');
    assert.deepEqual(reopened.subscriptions('1'), []);
    assert.deepEqual(reopened.subscriptions('2'), [{ city: 'Уфа', category: 'concert' }]);
    await telegram.message('/unsubscribe');
    assert.equal(telegram.latest().text, 'Активных подписок нет.');
  } finally {
    reopened.close();
  }
});

test('rejects unknown, cross-chat, replayed and expired callbacks and bounds rapid input', async context => {
  const catalog = openCatalog(':memory:', () => fixedDate);
  context.after(catalog.close);
  const telegram = harness(catalog);
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
  assert.match(telegram.latest().text, /Напишите название/);
});
