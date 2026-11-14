import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const appPosition = process.argv.indexOf('--app-dir');
const root = appPosition === -1
  ? fileURLToPath(new URL('..', import.meta.url))
  : resolve(process.argv[appPosition + 1]);
const source = path => import(pathToFileURL(resolve(root, path)).href);
const [{ openCatalog }, { buildServer }, { importAnalyticsFixture }] = await Promise.all([
  source('apps/api/src/catalog.ts'),
  source('apps/api/src/server.ts'),
  source('test/fixtures/analytics/import.ts'),
]);

// The analytics catalog is dated, synthetic, and never loaded into the user's database.
const clock = () => new Date('2026-11-13T12:00:00+05:00');
const catalog = openCatalog(':memory:', clock);
let api;
let web;
let browser;

async function submit(page, question, button = false) {
  const suggestion = page.getByRole('button', { name: question, exact: true });
  if (button) await suggestion.waitFor();
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/discover' && response.request().method() === 'POST');
  const trigger = button
    ? suggestion.click()
    : page.getByRole('textbox').fill(question).then(() => page.getByRole('textbox').press('Enter'));
  const [response] = await Promise.all([responsePromise, trigger]);
  assert.equal(response.status(), 200);
  const result = await response.json();
  const turn = page.locator('.turn').last();
  await turn.getByText(result.message, { exact: true }).waitFor();
  const visibleTitles = await turn.getByRole('heading', { level: 3 }).allTextContents();
  const cards = result.events.length ? result.events : result.alternatives ?? [];
  assert.deepEqual(visibleTitles.map(title => title.trim()), cards.map(({ event }) => event.title));
  const events = result.events.map(({ event }) => event);
  assert.ok(events.every(event => event.sources.length > 0 && event.status === 'published'));
  return { result, events, turn };
}

function hasTitle(events, expected) {
  assert.ok(events.some(({ title }) => expected.test(title)),
    `Expected ${expected}, got ${events.map(({ title }) => title).join(' | ') || '(no cards)'}`);
}

function only(events, predicate, condition) {
  assert.ok(events.length > 0, `Expected cards for ${condition}`);
  assert.ok(events.every(predicate), `Found a card outside ${condition}: ${events.map(({ title }) => title).join(' | ')}`);
}

const cases = [
  ['typo in a city keeps the weekend and excludes other cities', async page => {
    const { events } = await submit(page, 'Что есть в Стирлитамаке в эти выходные?');
    only(events, event => event.city === 'Стерлитамак', 'Стерлитамак');
    hasTitle(events, /Дядя Ваня/u);
    hasTitle(events, /Осенний вальс/u);
  }],
  ['named venue narrows a busy day', async page => {
    const { events } = await submit(page, 'Что проходит в парке Якутова 15 ноября?');
    only(events, event => event.venue === 'Парк Якутова', 'Парк Якутова');
    hasTitle(events, /Ярмарка выходного дня/u);
    hasTitle(events, /Фестиваль национальных кухонь/u);
  }],
  ['spoken-style language request excludes Russian-only events', async page => {
    const { events } = await submit(page, 'Куда сходить в Салавате в субботу на башкирском?');
    only(events, event => event.city === 'Салават' && event.language?.includes('ba'), 'Bashkir in Салават');
    hasTitle(events, /Ай тотолоуы/u);
  }],
  ['unquoted title outranks other events in the same category', async page => {
    const { events } = await submit(page, 'Найди спектакль Письма памяти в Уфе.');
    assert.match(events[0]?.title ?? '', /Письма памяти/u);
  }],
  ['month constraint excludes concerts from the previous month', async page => {
    const { events } = await submit(page, 'Есть концерты в Нефтекамске в декабре?');
    only(events, event => event.city === 'Нефтекамск' && event.category === 'concert' &&
      event.startsAt.startsWith('2026-12'), 'December concerts in Нефтекамск');
    hasTitle(events, /Праздничный концерт башкирской музыки/u);
  }],
  ['explicit day range includes later dates within the range and preserves viewer age', async page => {
    const { events } = await submit(page, 'Куда в Уфе с ребёнком 6 лет с 20 по 23 декабря?');
    only(events, event => event.city === 'Уфа' && event.ageLimit <= 6 &&
      event.startsAt < '2026-12-23T19:00:00.000Z' &&
      (event.endsAt ?? event.startsAt) >= '2026-12-19T19:00:00.000Z', '20–23 December in Уфа, age 6');
    hasTitle(events, /Парк в деталях/u);
    hasTitle(events, /Сказки старого города/u);
  }],
  ['group budget, end time and cancellation rules survive a cheaper follow-up', async page => {
    const result = await submit(page, 'Спектакли на двоих в Уфе 14 ноября до 1800 рублей, закончить не позже 21:00.');
    only(result.events, event => event.city === 'Уфа' && event.category === 'theatre' &&
      event.startsAt.startsWith('2026-11-14') && event.endsAt && event.endsAt <= '2026-11-14T16:00:00.000Z' &&
      event.priceMin * 2 <= 1800, 'Уфа theatre, two tickets, budget and cutoff');
    hasTitle(result.events, /Ревизор/u);
    const lowerBudget = await submit(page, 'Тогда до 1000 рублей на двоих');
    only(lowerBudget.events, event => event.city === 'Уфа' && event.category === 'theatre' &&
      event.startsAt.startsWith('2026-11-14') && event.endsAt && event.endsAt <= '2026-11-14T16:00:00.000Z' &&
      event.priceMin * 2 <= 1000, 'updated budget with previous city, category, date and cutoff');
    hasTitle(lowerBudget.events, /Ревизор/u);
  }],
  ['cheaper chip finds lower-priced concerts beyond the first page', async page => {
    const initial = await submit(page, 'Какие концерты будут в Уфе?');
    only(initial.events, event => event.city === 'Уфа' && event.category === 'concert', 'Уфа concerts');
    const lowestShown = Math.min(...initial.events.map(event => event.priceMin ?? Infinity));
    assert.ok(Number.isFinite(lowestShown));
    const lower = await submit(page, 'А подешевле?', true);
    only(lower.events, event => event.city === 'Уфа' && event.category === 'concert' &&
      event.priceMin < lowestShown, `Уфа concerts cheaper than ${lowestShown} RUB`);
    const prices = lower.events.map(event => event.priceMin);
    assert.deepEqual(prices, [...prices].sort((first, second) => first - second));
  }],
  ['free follow-up keeps venue and day through an age clarification', async page => {
    const first = await submit(page, 'Куда сходить с ребёнком 15 ноября в Уфе?');
    assert.equal(first.result.status, 'clarify');
    assert.match(first.result.message, /Сколько лет/u);
    const child = await submit(page, '5');
    only(child.events, event => event.city === 'Уфа' && event.ageLimit <= 5, 'age 5 in Уфа');
    const free = await submit(page, 'Только бесплатные в парке Якутова.');
    only(free.events, event => event.city === 'Уфа' && event.priceMin === 0 && event.ageLimit <= 5 &&
      event.venue === 'Парк Якутова' && event.startsAt.startsWith('2026-11-15'), 'free park events for age 5 on 15 November');
    hasTitle(free.events, /Ярмарка выходного дня/u);
  }],
  ['an unverified route shows usable cards and preserves the route limit', async page => {
    const { result, events, turn } = await submit(page, 'Куда сходить в Уфе 14 ноября, если ехать не больше 20 минут?');
    assert.equal(result.context.travelMinutes, 20);
    assert.deepEqual(events, []);
    assert.ok(result.alternatives.length > 0);
    await turn.getByText('Варианты без проверки дороги', { exact: true }).waitFor();
    assert.equal(await turn.getByText('Время в пути не проверено', { exact: true }).count(), result.alternatives.length);
    const confirmed = await submit(page, 'Без учёта дороги', true);
    assert.equal(confirmed.result.context.travelMinutes, undefined);
    assert.equal(confirmed.result.context.date, '2026-11-14');
    only(confirmed.events, event => event.city === 'Уфа', 'Уфа');
  }],
  ['a missing category offers a verified single-filter change', async page => {
    const empty = await submit(page, 'Какие киносеансы в Белорецке 28 декабря?');
    assert.equal(empty.result.status, 'no_results');
    assert.deepEqual(empty.events, []);
    const broader = await submit(page, 'Любая категория', true);
    only(broader.events, event => event.city === 'Белорецк' && event.startsAt <= '2026-12-28T19:00:00.000Z' &&
      (event.endsAt ?? event.startsAt) >= '2026-12-27T19:00:00.000Z', 'Белорецк on 28 December');
    hasTitle(broader.events, /Концерт этнической музыки/u);
  }],
  ['impossible dates prompt clarification instead of browsing random events', async page => {
    const { result, events } = await submit(page, 'Что посмотреть в Уфе 31 февраля 2027 года?');
    assert.equal(result.status, 'clarify');
    assert.deepEqual(events, []);
  }],
  ['a request for a cancelled show never returns unrelated active cards', async page => {
    const { events } = await submit(page, 'Есть билеты на «Ромео и Джульетту» в Уфе 14 ноября?');
    assert.deepEqual(events, []);
  }],
  ['an action request cannot silently turn into an event search', async page => {
    const { events } = await submit(page, 'Подпиши меня на уведомления о концертах в Уфе.');
    assert.equal(events.length, 0);
  }],
  ['a result opens its database-backed card with a source', async page => {
    const { events, turn } = await submit(page, 'Найди экскурсию «Тайны старой Уфы» в Уфе 14 ноября.');
    hasTitle(events, /Тайны старой Уфы/u);
    const event = events.find(({ title }) => /Тайны старой Уфы/u.test(title));
    await turn.getByRole('link', { name: event.title, exact: true }).click();
    await page.getByRole('heading', { level: 1, name: event.title, exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/events/${event.id}`);
    await page.getByRole('heading', { name: 'Источники', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: event.sources[0].name, exact: true }).getAttribute('href'),
      event.sources[0].url);
  }],
];

// Exercise recording and the real search UI. Only the paid speech service is replaced.
async function checkVoice(page) {
  const typed = 'Какие события';
  const preview = 'в Сала';
  const final = 'в Салавате 19 ноября?';
  let finishing = false;
  await page.route('**/api/v1/transcribe', async route => {
    assert.match(route.request().headers()['content-type'], /^audio\//u);
    assert.ok(route.request().postDataBuffer()?.length > 0);
    await route.fulfill({ json: { text: finishing ? final : preview } });
  });
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
  const composer = page.getByRole('textbox');
  const start = page.getByRole('button', { name: 'Записать голосом', exact: true });
  const stop = page.getByRole('button', { name: 'Остановить запись', exact: true });
  async function waitForDraft(value) {
    try {
      await page.waitForFunction(expected => document.querySelector('textarea')?.value === expected, value, { timeout: 15_000 });
    } catch {
      assert.equal(await composer.inputValue(), value, 'Unexpected composer text after voice input');
    }
  }
  await composer.fill(typed);
  await start.click();
  await waitForDraft(`${typed} ${preview}`);
  assert.ok(await stop.isEnabled());
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await waitForDraft(typed);

  await start.click();
  await waitForDraft(`${typed} ${preview}`);
  assert.ok(await stop.isEnabled());
  finishing = true;
  await stop.click();
  await waitForDraft(`${typed} ${final}`);
  const resultPromise = page.waitForResponse(response => response.url().endsWith('/api/v1/discover'));
  await composer.press('Enter');
  const response = await resultPromise;
  assert.equal(response.status(), 200);
  assert.equal(response.request().postDataJSON().message, `${typed} ${final}`);
  await page.getByRole('link', { name: /Концерт кураистов/u }).waitFor();
}

async function runCase(name, run, origin) {
  const context = await browser.newContext({ viewport: { width: 375, height: 850 } });
  const page = await context.newPage();
  const errors = [];
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await run(page);
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${name}\n  ${String(error.message).replace(/\n+/gu, '\n  ')}`);
    return false;
  } finally {
    await context.close();
  }
}

try {
  const { report } = importAnalyticsFixture(catalog);
  assert.equal(report.rejected.length, 0);
  api = await buildServer(catalog, { clock, disableModel: true });
  const previousOrigin = process.env.API_ORIGIN;
  try {
    process.env.API_ORIGIN = await api.listen({ host: '127.0.0.1', port: 0 });
    web = await createServer({
      configFile: resolve(root, 'apps/web/vite.config.ts'),
      server: {
        port: 0, open: false,
        fs: { allow: [root, realpathSync(resolve(root, 'node_modules'))] },
      },
    });
  } finally {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
  }
  await web.listen();
  const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  let passes = 0;
  for (const [name, run] of cases) {
    if (await runCase(name, run, origin)) passes++;
  }
  console.log(`Search scenarios: ${passes}/${cases.length} passed (local parser, fixed catalog)`);
  const voice = await runCase('live voice preview, cancellation, final transcript and search (speech service stub)', checkVoice, origin);
  process.exitCode = passes === cases.length && voice ? 0 : 1;
} finally {
  await browser?.close();
  await web?.close();
  await api?.close();
  catalog.close();
}
