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
  ['theme switch applies to the whole site and persists across navigation and reload', async page => {
    const theme = page.getByRole('switch', { name: 'Светлая тема' });
    const appearance = () => page.evaluate(() => ({
      scheme: getComputedStyle(document.documentElement).colorScheme,
      background: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
    }));
    const dark = await appearance();
    assert.equal(dark.scheme, 'dark');
    assert.match(dark.font, /^Manrope/);
    assert.equal(await theme.getAttribute('aria-checked'), 'false');
    await theme.focus();
    await theme.press('Space');
    assert.equal(await theme.getAttribute('aria-checked'), 'true');
    const light = await appearance();
    assert.equal(light.scheme, 'light');
    assert.notEqual(light.background, dark.background);
    await page.getByRole('link', { name: 'Все события', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Все события' }).waitFor();
    await page.reload();
    assert.equal(await theme.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await appearance(), light);
    await theme.click();
    await page.getByRole('link', { name: 'Поиск', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Куда пойдём?' }).waitFor();
    assert.deepEqual(await appearance(), dark);
  }],
  ['question markers preview and jump to earlier turns on desktop and mobile', async page => {
    const first = 'Какие концерты будут в Уфе?';
    const second = 'Что посмотреть в парке Якутова 15 ноября?';
    const third = 'Куда сходить в Белорецке 28 декабря?';
    const firstAnswer = await submit(page, first);
    const jump = page.getByRole('navigation', { name: 'Вопросы в этом диалоге' });
    assert.equal(await jump.count(), 0);
    await submit(page, second);
    await submit(page, third);
    assert.equal(await jump.getByRole('button').count(), 3);
    const firstMarker = jump.getByRole('button', { name: 'Вопрос 1. ' + first, exact: true });
    await firstMarker.hover();
    const preview = page.locator('.question-jump-preview');
    await preview.getByText(first, { exact: true }).waitFor();
    await preview.getByText(firstAnswer.result.message, { exact: true }).waitFor();
    await firstMarker.press('Enter');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.turn .question') &&
      document.querySelector('.question-jump-marker')?.getAttribute('aria-current') === 'location');
    await page.setViewportSize({ width: 390, height: 844 });
    await jump.getByRole('button', { name: 'Вопрос 2. ' + second, exact: true }).click();
    await page.waitForFunction(() => document.activeElement === document.querySelectorAll('.turn .question')[1]);
  }],
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

const planDay = '2027-02-03';
const planTitles = ['Дневная программа 1', 'Дневная программа 2', 'Дневная программа 3', 'Дневная программа 4', 'Дневная программа 5'];

function importPlanEvents() {
  const originals = planTitles.map((title, index) => ({
    title, startsAt: `${planDay}T${10 + index * 2}:00:00+05:00`, endsAt: `${planDay}T${10 + index * 2}:55:00+05:00`,
    venue: `Тестовая площадка ${index + 1}`, category: 'other', city: 'Уфа', latitude: 54.72 + index * .01, longitude: 55.94,
    status: 'published', sourceName: 'Controlled planner fixture', sourceKey: `planner-${index}`,
    sourceType: 'import', sourceUrl: 'https://example.org/planner', raw: null,
  }));
  originals[0].endsAt = `${planDay}T11:59:00+05:00`;
  const report = catalog.importEvents([...originals, { ...originals[0], title: 'Другая дата', sourceKey: 'planner-other-day',
    startsAt: '2027-02-04T10:00:00+05:00', endsAt: '2027-02-04T11:00:00+05:00' }]);
  assert.deepEqual(report.rejected, []);
}

async function checkSingleChoice(page) {
  const initial = await submit(page, `Куда сходить ${planDay}?`);
  assert.match(initial.result.message, /город/u);
  assert.match(initial.result.message, /одно событие или несколько/u);
  assert.equal(initial.result.context.city, undefined);
  assert.equal(initial.events.length, 0);
  const city = await submit(page, 'Уфа');
  assert.equal(city.result.context.city, 'Уфа');
  assert.equal(city.events.length, 0);
  const single = await submit(page, 'Одно событие', true);
  assert.equal(single.result.context.planMode, 'single');
  assert.equal(single.events.length, 1);
  assert.ok(planTitles.includes(single.events[0].title));
  assert.equal(await page.getByRole('button', { name: 'Добавить в план' }).count(), 0);
}

async function checkFamilyWeekday(page) {
  const initial = await submit(page, 'Я хочу провести весь день с семьёей');
  assert.equal(initial.result.context.preference, 'Семейный досуг');
  const city = await submit(page, 'Несколько событий и в городе Салават');
  assert.equal(city.result.context.city, 'Салават');
  const monday = await submit(page, 'на пн');
  assert.equal(monday.result.context.date, '2026-11-16');
  assert.equal(monday.result.context.query, undefined);
  assert.match(monday.result.message, /транспорт/u);
  const unavailable = await submit(page, 'На машине', true);
  assert.equal(unavailable.result.status, 'no_results');
  assert.match(unavailable.result.message, /понедельник, 16 ноября/u);
  const alternative = await submit(page, 'А 14 ноября?', true);
  assert.equal(alternative.result.context.transport, 'car');
  assert.equal(alternative.result.context.date, '2026-11-14');
  assert.ok(alternative.events.some(event => event.city === 'Салават' && event.title === 'Мастер-класс «Гончарное дело» для детей'));
}

const mapsFixture = `
  window.ymaps = {
    ready: success => success(),
    Map: class {
      constructor(node) {
        node.dataset.mapRendered = 'true';
        this.geoObjects = { add: route => queueMicrotask(() => route.listeners.get('requestsuccess')?.()),
          remove() {}, getBounds: () => [[54.7,55.9],[54.8,56]] };
      }
      setBounds() {}
      destroy() {}
    },
    multiRouter: { MultiRoute: class {
      constructor(model) {
        (window.testRouteRequests ??= []).push(model);
        this.points = model.referencePoints;
        this.listeners = new Map();
        this.model = { events: { add: (event, listener) => this.listeners.set(event, listener),
          remove: event => this.listeners.delete(event) }, destroy() {} };
      }
      getActiveRoute() {
        const count = this.points.length - 1;
        const metrics = count => ({ get: key => ({ duration: { value: count * 480 }, distance: { value: count * 1400 } })[key] });
        return { properties: metrics(count), getPaths: () => ({ each: callback => {
          for (let index = 0; index < count; index++) callback({ properties: metrics(1) });
        } }) };
      }
    } },
  };
`;

async function checkDayPlan(page, withMaps) {
  await page.route('**/api/v1/maps/config', route => route.fulfill({ json: withMaps ? { yandexApiKey: 'fixture-key' } : {} }));
  await page.route('https://api-maps.yandex.ru/2.1/**', route => {
    assert.ok(withMaps, 'The SDK should load only with a configured key');
    return route.fulfill({ contentType: 'application/javascript', body: mapsFixture });
  });
  await submit(page, `Куда сходить в Уфе ${planDay}?`);
  const plural = await submit(page, 'Несколько событий', true);
  assert.match(plural.result.message, /транспорт/u);
  const transport = await submit(page, 'На общественном транспорте', true);
  assert.equal(transport.result.context.transport, 'transit');
  assert.match(transport.result.message, /откуда/iu);
  const proposed = await submit(page, '54.701, 55.901');
  assert.deepEqual(proposed.events.map(event => event.title).sort(), [...planTitles].sort());
  const card = title => proposed.turn.locator('.event-card').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });
  const add = title => card(title).getByRole('button', { name: 'Добавить в план' });
  const plan = page.getByRole('region', { name: 'План дня', exact: true });
  const maps = plan.getByRole('region', { name: 'Маршрут в Яндекс Картах' });

  await add(planTitles[1]).click();
  assert.equal(await maps.count(), 0);
  await add(planTitles[0]).click();
  const ordered = plan.getByRole('list', { name: 'События по времени' });
  assert.deepEqual(await ordered.getByRole('link').allTextContents(), planTitles.slice(0, 2));
  const link = maps.getByRole('link', { name: 'Открыть в Яндекс Картах' });
  await link.waitFor();
  const route = new URL(await link.getAttribute('href'));
  assert.equal(route.hostname, 'yandex.ru');
  assert.equal(route.searchParams.get('rtt'), 'mt');
  assert.equal(route.searchParams.get('rtext').split('~').length, 3);
  if (withMaps) {
    await maps.getByText(/в пути около 16 мин/iu).waitFor();
    assert.equal(await plan.getByRole('list', { name: 'Отрезки маршрута' }).getByRole('listitem').count(), 2);
    await plan.getByText(/Не хватает времени на дорогу/u).waitFor();
    const request = await page.evaluate(() => window.testRouteRequests.at(-1));
    assert.equal(request.params.routingMode, 'masstransit');
    assert.deepEqual(request.referencePoints, [[54.701, 55.901], ...proposed.events.filter(event => planTitles.slice(0, 2).includes(event.title))
      .sort((first, second) => first.startsAt.localeCompare(second.startsAt)).map(event => [event.latitude, event.longitude])]);
  } else {
    await maps.getByText(/время в пути.*в яндекс картах/iu).waitFor();
    assert.equal(await plan.getByRole('list', { name: 'Отрезки маршрута' }).count(), 0);
  }
  await add(planTitles[2]).click();
  await add(planTitles[3]).click();
  assert.equal(await add(planTitles[4]).isDisabled(), true);
  await plan.getByText('4 из 4', { exact: true }).waitFor();
  await plan.getByRole('button', { name: `Убрать из плана: ${planTitles[1]}` }).click();
  assert.equal(await add(planTitles[4]).isEnabled(), true);
}

async function runCase(name, run, origin, planning = false) {
  const context = await browser.newContext({ viewport: { width: 375, height: 850 } });
  const page = await context.newPage();
  const errors = [];
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    // Exercise the established search rules independently of the new onboarding turns.
    if (!planning) await page.route('**/api/v1/discover', route => route.continue({
      postData: JSON.stringify({ ...route.request().postDataJSON(), planExperience: false }),
    }));
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

async function startFixture() {
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
  return `http://127.0.0.1:${web.httpServer.address().port}`;
}

try {
  const { report } = importAnalyticsFixture(catalog);
  assert.equal(report.rejected.length, 0);
  importPlanEvents();
  const origin = await startFixture();
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
  // Use a fresh API instance for another scenario group so its shared test IP has a fresh request budget.
  await web.close();
  await api.close();
  const plannerOrigin = await startFixture();
  const planner = await runCase('planner asks for city and returns one event when selected', checkSingleChoice, plannerOrigin, true);
  const familyWeekday = await runCase('family plan accepts an abbreviated weekday and follows the verified nearby date', checkFamilyWeekday, plannerOrigin, true);
  const mapped = await runCase('planner saves and orders stops, warns about transfers, and enforces four-event limit (Yandex SDK stub)',
    page => checkDayPlan(page, true), plannerOrigin, true);
  const noKey = await runCase('planner offers a maps link without estimating time when no key is configured',
    page => checkDayPlan(page, false), plannerOrigin, true);
  process.exitCode = passes === cases.length && voice && planner && familyWeekday && mapped && noKey ? 0 : 1;
} finally {
  await browser?.close();
  await web?.close();
  await api?.close();
  catalog.close();
}
