import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.API_ORIGIN || 'http://127.0.0.1:3001';
const rounds = Number(process.argv[2] ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 2 && rounds <= 5, 'Give the number of rounds from 2 to 5.');

// Expectations checked against the publishers' November 2026 schedules.
const opera = 'bashopera.ru';
const philharmonic = 'bashgf.ru';
const localTime = (date, time) => Date.parse(`2026-11-${date}T${time}:00+05:00`);
const target = (host, title, day, time) => event => event.title.includes(title) &&
  Date.parse(event.startsAt) === localTime(day, time) &&
  event.sources.some(source => new URL(source.url).hostname === host);

const swanLake = target(opera, 'Лебединое озеро', '15', '18:00');
const nutcracker = target(opera, 'Щелкунчик', '21', '18:00');
const plusFive = target(philharmonic, 'PlusFive', '20', '19:00');
const anniversary = target(philharmonic, 'Годы, дороги, песни', '21', '18:00');
const kodasa = target(opera, 'Кодаса', '20', '19:00');
const exhibition = target('bashnl.ru', 'Три взгляда', '21', '09:00');
const libraryTournament = target('bashnl.ru', 'Тайны книжных лабиринтов', '16', '12:00');
const frogPrincess = target('rusdramteatr.ru', 'Царевна - Лягушка', '15', '12:00');
const catInTheHat = target('www.mirage.ru', 'Кот в шляпе', '15', '11:10');
const cityExhibition = target('lib-str.ru', 'Крылатые легенды', '15', '09:00');
const symphony = target('gasorb.ru', 'Шедевры мировой классики в Салавате', '26', '19:00');
const forestCircus = event => target('teatrnmt.ru', 'Цирк на поляне', '15', '12:00')(event) &&
  event.ticketUrl === 'https://ufa.kassy.ru/events/teatr/40-29116868/';
const cases = [
  {
    message: 'Найди балет «Лебединое озеро» в Уфе 15 ноября для ребёнка 12 лет.',
    expected: swanLake,
    allowed: event => event.ageLimit <= 12 && Date.parse(event.startsAt) === localTime('15', '18:00'),
  },
  {
    message: 'Балет «Лебединое озеро» в Уфе 15 ноября для ребёнка 11 лет.',
    allowed: event => event.ageLimit <= 11,
    excluded: swanLake,
  },
  {
    message: 'Балет «Щелкунчик» в Уфе 21 ноября для ребёнка 6 лет.',
    expected: nutcracker,
    allowed: event => event.ageLimit <= 6 && Date.parse(event.startsAt) === localTime('21', '18:00'),
  },
  {
    message: 'Балет «Лебединое озеро» в Уфе 15 ноября, чтобы закончилось не позже 20:20.',
    expected: swanLake,
    allowed: event => Date.parse(event.endsAt) <= localTime('15', '20:20'),
  },
  {
    message: 'Балет «Лебединое озеро» в Уфе 15 ноября, чтобы закончилось не позже 20:19.',
    allowed: event => Date.parse(event.endsAt) <= localTime('15', '20:19'),
    excluded: swanLake,
  },
  {
    message: 'Найди концерт «PlusFive» в Уфе 20 ноября до 800 рублей.',
    expected: plusFive,
    allowed: event => event.priceMin <= 800 && event.category === 'concert',
    followup: {
      message: 'Тогда до 799 рублей.',
      allowed: event => event.priceMin <= 799 && event.category === 'concert',
      excluded: plusFive,
    },
  },
  {
    message: 'Концерт «Годы, дороги, песни» в Уфе 21 ноября до 1200 рублей на двоих.',
    expected: anniversary,
    allowed: event => event.priceMin * 2 <= 1200 && event.category === 'concert',
    followup: {
      message: 'Только бесплатные.',
      allowed: event => event.priceMin === 0 && event.category === 'concert',
      excluded: anniversary,
    },
  },
  {
    message: 'Найди концерт «PlusFive» в Уфе 20 ноября после 19:30.',
    allowed: event => Date.parse(event.startsAt) >= localTime('20', '19:30'),
    excluded: plusFive,
  },
  {
    message: 'Спектакль «Кодаса» на башкирском языке в Уфе 20 ноября.',
    expected: kodasa,
    allowed: event => event.language === 'ba' && event.category === 'theatre',
  },
  {
    message: 'Бесплатная выставка «Три взгляда» в Уфе 21 ноября.',
    expected: exhibition,
    allowed: event => event.priceMin === 0 && event.category === 'exhibition' &&
      Date.parse(event.endsAt) === localTime('21', '18:00'),
    followup: {
      message: 'А 22 ноября?',
      date: '2026-11-22',
      allowed: () => false,
      excluded: exhibition,
    },
  },
  {
    message: 'Найди «Тайны книжных лабиринтов» в Уфе 16 ноября до 250 рублей.',
    expected: libraryTournament,
    allowed: event => event.priceMin <= 250,
    followup: {
      message: 'Тогда до 249 рублей.',
      allowed: event => event.priceMin <= 249,
      excluded: libraryTournament,
    },
  },
  {
    city: 'Стерлитамак',
    message: 'Спектакль «Царевна-лягушка» 15 ноября в Стерлитамаке с ребёнком 8 лет, до 700 рублей на двоих, окончание до 13:00.',
    expected: frogPrincess,
    allowed: event => event.category === 'theatre' && event.priceMin * 2 <= 700 && event.ageLimit <= 8 &&
      Date.parse(event.endsAt) <= localTime('15', '13:00'),
    followup: {
      message: 'А если бюджет только 699 рублей?',
      allowed: event => event.priceMin * 2 <= 699 && event.ageLimit <= 8 && Date.parse(event.endsAt) <= localTime('15', '13:00'),
      excluded: frogPrincess,
    },
  },
  {
    city: 'Стерлитамак',
    message: 'Покажи «Кот в шляпе» в кино 15 ноября в Стерлитамаке, до 500 рублей на двоих с ребёнком 6 лет, закончить не позже 12:57.',
    expected: catInTheHat,
    allowed: event => event.category === 'cinema' && event.priceMin * 2 <= 500 && event.ageLimit <= 6 &&
      Date.parse(event.endsAt) <= localTime('15', '12:57'),
    followup: {
      message: 'Нужно закончить не позже 12:56.',
      allowed: event => event.priceMin * 2 <= 500 && event.ageLimit <= 6 && Date.parse(event.endsAt) <= localTime('15', '12:56'),
      excluded: catInTheHat,
    },
  },
  {
    city: 'Стерлитамак',
    message: 'Бесплатные выставки в Стерлитамаке 15 ноября для ребёнка 6 лет, чтобы закончились до 17:00.',
    expected: cityExhibition,
    allowed: event => event.category === 'exhibition' && event.priceMin === 0 && event.ageLimit <= 6 &&
      Date.parse(event.endsAt) <= localTime('15', '17:00'),
    followup: {
      message: 'А для ребёнка 5 лет?',
      allowed: event => event.priceMin === 0 && event.ageLimit <= 5 && Date.parse(event.endsAt) <= localTime('15', '17:00'),
      excluded: cityExhibition,
    },
  },
  {
    city: 'Салават',
    message: 'Есть концерты в Салавате 26 ноября после 18:00 для ребёнка 6 лет?',
    expected: symphony,
    allowed: event => event.category === 'concert' && event.ageLimit <= 6 && Date.parse(event.startsAt) >= localTime('26', '18:00'),
    followup: {
      message: 'А если ребёнку 5 лет?',
      allowed: event => event.category === 'concert' && event.ageLimit <= 5 && Date.parse(event.startsAt) >= localTime('26', '18:00'),
      excluded: symphony,
    },
  },
  {
    message: 'Спектакль «Цирк на поляне» в Уфе 15 ноября с ребёнком 5 лет, до 700 рублей на двоих, чтобы закончилось не позже 12:45.',
    expected: forestCircus,
    allowed: event => event.category === 'theatre' && event.priceMin * 2 <= 700 && event.ageLimit <= 5 &&
      Date.parse(event.endsAt) <= localTime('15', '12:45'),
  },
];

async function ask(test, expectedDate, city, context) {
  const response = await fetch(new URL('/api/v1/discover', origin), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: test.message, context }),
    signal: AbortSignal.timeout(25_000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.context.city, city);
  assert.equal(result.context.date, expectedDate);
  const events = result.events.map(({ event }) => event);
  const titles = events.map(event => event.title).join(', ') || '(none)';
  assert.ok(events.every(event => event.city === city && event.status === 'published' &&
    event.sources.length && event.sources.every(source => new URL(source.url).hostname !== 'demo.example')),
  `Wrong city, unpublished or synthetic event: ${titles}`);
  const beginning = Date.parse(`${expectedDate}T00:00:00+05:00`);
  assert.ok(events.every(event => Date.parse(event.startsAt) < beginning + 86_400_000 &&
    Date.parse(event.endsAt ?? event.startsAt) >= beginning && test.allowed(event)), `Filter leak: ${titles}`);
  if (test.expected) assert.ok(events.some(test.expected), `Expected publisher session missing: ${titles}`);
  if (test.excluded) {
    assert.ok(!events.some(test.excluded), `Excluded session returned: ${titles}`);
    assert.ok(events.length || result.status === 'no_results', `Expected an explicit no-results answer, got ${result.status}`);
  }
  return result;
}

let failed = 0;
let passed = 0;
let fallback = 0;
for (let round = 1; round <= rounds; round++) {
  const roundStarted = Date.now();
  for (const test of cases) {
    const day = /\b(\d{1,2}) ноября/u.exec(test.message)?.[1];
    assert.ok(day, 'Live fixture case needs a November day');
    let context;
    for (const turn of [test, test.followup].filter(Boolean)) {
      try {
        const result = await ask(turn, turn.date ?? `2026-11-${day.padStart(2, '0')}`, test.city ?? 'Уфа', context);
        if (context) {
          for (const field of ['city', 'category', 'date', 'query', 'partySize']) {
            if (field === 'date' && turn.date) continue;
            assert.equal(result.context[field], context[field], `Follow-up changed ${field}`);
          }
        }
        context = result.context;
        if (result.message.startsWith('ИИ временно недоступен.')) fallback++;
        passed++;
        console.log(`PASS ${round} ${turn.message}`);
      } catch (error) {
        failed++;
        console.error(`FAIL ${round} ${turn.message} ${error.message}`);
        break;
      }
    }
  }
  // The real discovery endpoint permits 30 requests per minute per client.
  if (round < rounds) await delay(Math.max(0, 60_500 - (Date.now() - roundStarted)));
}
console.log(JSON.stringify({ rounds, passed, failed, fallback }));
if (failed) process.exitCode = 1;
