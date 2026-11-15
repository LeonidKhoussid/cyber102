import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { openCatalog } from '../src/catalog.ts';
import { createConversationalDiscovery } from '../src/conversation.ts';
import { buildServer } from '../src/server.ts';
import type { DiscoveryContext } from '@afisha/contracts';

const clock = () => new Date('2026-11-14T12:00:00+05:00');
const fixture = {
  title: 'Дневная сказка', city: 'Уфа', venue: 'Театр', category: 'theatre' as const,
  startsAt: '2026-11-21T11:00:00+05:00', endsAt: '2026-11-21T12:00:00+05:00',
  status: 'published' as const, priceMin: 400, ageLimit: 6,
  sourceName: 'Театр', sourceUrl: 'https://example.org/show', sourceKey: 'daytime', sourceType: 'import' as const, raw: {},
};
const answer = (message: string, context = {}, event_ids: string[] = [], status = 'clarify') =>
  ({ action: 'respond', arguments: { message, context, event_ids, status, suggestions: [] } });

test('a broad city request must learn interests before offering events, then offers several selectable alternatives', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents(Array.from({ length: 3 }, (_, index) => ({ ...fixture, title: `Комедия ${index + 1}`, sourceKey: `choice-${index}` })));
  const choices = catalog.search().events;
  let round = 0;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    round++;
    if (round === 1) return { action: 'search_events', arguments: { context: { city: 'Уфа' } } };
    if (round === 2) return answer('Вот варианты, выбирайте.', {}, choices.map(event => event.id), 'matches');
    if (round === 3) {
      assert.match(input.steps.at(-1).error, /has not said what kind/);
      return { action: 'respond', arguments: { ...answer('Что вам ближе: спектакль, концерт или выставка?').arguments,
        context: { interestsKnown: false }, suggestions: ['Спектакль', 'Концерт', 'Выставка'] } };
    }
    if (round === 4) return { action: 'search_events', arguments: { context: {
      interestsKnown: true, category: 'theatre', preference: 'Лёгкие комедии', planMode: 'day', date: '2026-11-21',
    } } };
    if (round === 5) return answer('Вот три комедии. Какую выбираете?', {}, choices.map(event => event.id), 'matches');
    assert.deepEqual(input.selectedEvents.map((event: any) => event.id), [choices[1].id]);
    return answer('Хороший выбор. Что хочется посетить после него?');
  } });
  try {
    const question = await discover('Хочу что-нибудь в Уфе', undefined, { guidedPlan: true });
    assert.equal(question.status, 'clarify');
    assert.equal(question.events.length, 0);
    assert.equal(question.suggestions.length, 3);
    const offer = await discover('Люблю лёгкие комедии', question.context, { guidedPlan: true });
    assert.equal(offer.events.length, 3);
    assert.deepEqual(offer.context.planStep?.eventIds, choices.map(event => event.id));
    assert.equal(offer.context.interestsKnown, true);
    const next = await discover('Что дальше по плану?', offer.context, { guidedPlan: true, selectedEventIds: [choices[1].id] });
    assert.equal(next.context.planStep?.anchor, choices[1].id);
    assert.equal(next.events.length, 0);
  } finally { catalog.close(); }
});

test('the AI sees free-form answers and its last question, chooses searches and writes the reply', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([fixture]);
  const event = catalog.search().events[0];
  const inputs: any[] = [];
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    inputs.push(input);
    if (inputs.length === 1) return answer('Какой город и сколько лет дочке?', { memory: 'С семьёй, не хотят кино.' });
    if (!input.steps.length) return { action: 'search_events', arguments: { context: {
      city: 'Уфа', childAge: 7.5, child: true, partySize: 3, budget: 1500, date: '2026-11-21',
      preference: 'Сказки, без громкой музыки', memory: 'Уфимцы, дочка семи с половиной лет. Не хотят кино.',
    } } };
    assert.equal(input.steps[0].result.events[0].id, event.id);
    return answer('Есть дневная сказка в театре. Хотите посмотреть этот вариант?', {}, [event.id], 'matches');
  } });
  try {
    const first = await discover('Мы хотим выбраться с дочкой, только не в кино.', undefined, { guidedPlan: true });
    assert.equal(first.message, 'Какой город и сколько лет дочке?');
    const reply = 'Мы уфимцы, ей семь с половиной, нас трое. В следующую субботу полторы тысячи на всех, хочется сказки без громкой музыки.';
    const second = await discover(reply, first.context, { guidedPlan: true });
    assert.equal(inputs[1].message, reply);
    assert.equal(inputs[1].conversation.at(-1).content, first.message);
    assert.equal(second.context.childAge, 7);
    assert.equal(second.context.partySize, 3);
    assert.equal(second.context.budget, 1500);
    assert.equal(second.events[0].event.id, event.id);
    assert.equal(second.message, 'Есть дневная сказка в театре. Хотите посмотреть этот вариант?');
    assert.match(second.context.memory!, /Не хотят кино/);
    assert.equal(second.context.conversation!.length, 4);
  } finally { catalog.close(); }
});

test('the AI can inspect another day without silently changing the requested date', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([fixture]);
  let calls = 0;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    calls++;
    if (calls === 1) return { action: 'search_events', arguments: { context: { city: 'Уфа', date: '2026-11-16' } } };
    if (calls === 2) {
      assert.equal(input.steps[0].result.total, 0);
      return { action: 'search_events', arguments: { filters: { date: null, from: '2026-11-17' } } };
    }
    assert.equal(input.steps[1].result.events[0].title, fixture.title);
    return answer('В понедельник ничего не нашлось, но есть сказка 21 ноября. Подойдёт другая дата?', {}, [], 'no_results');
  } });
  try {
    const result = await discover('Мне нужен именно понедельник');
    assert.equal(result.status, 'no_results');
    assert.equal(result.context.date, '2026-11-16');
    assert.equal(result.events.length, 0);
    assert.match(result.message, /21 ноября/);
  } finally { catalog.close(); }
});

test('fabricated IDs and offers outside the budget are sent back to the AI for repair', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([fixture]);
  const event = catalog.search().events[0];
  let calls = 0;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    calls++;
    if (calls === 1) return answer('Выдуманный концерт', {}, ['00000000-0000-4000-8000-000000000000'], 'matches');
    if (calls === 2) return { action: 'get_event', arguments: { id: event.id } };
    if (calls === 3) return answer('Дешёвая сказка', { budget: 100 }, [event.id], 'matches');
    assert.ok(input.steps.some((step: any) => step.rejected?.[0].issues.includes('budget')));
    return answer('У этого варианта цена выше вашего бюджета. Рассмотреть бюджет до четырёхсот рублей?');
  } });
  try {
    const result = await discover('Не больше ста рублей');
    assert.equal(result.events.length, 0);
    assert.equal(result.context.budget, 100);
    assert.match(result.message, /выше вашего бюджета/);
  } finally { catalog.close(); }
});

test('saved evening events can receive an earlier non-overlapping AI offer with the existing plan buttons', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([fixture, { ...fixture, title: 'Вечерняя сказка', startsAt: '2026-11-21T18:00:00+05:00',
    endsAt: '2026-11-21T20:00:00+05:00', sourceKey: 'evening' }]);
  const [day, evening] = catalog.search().events;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    if (!input.steps.length) return { action: 'search_events', arguments: { position: 'before', context: {
      city: 'Уфа', date: '2026-11-21', planMode: 'day', planCount: 2, transport: 'car',
    } } };
    return { ...answer('Можно сначала сходить на дневную сказку.', {}, [day.id], 'matches'),
      arguments: { ...answer('Можно сначала сходить на дневную сказку.', {}, [day.id], 'matches').arguments, position: 'before' } };
  } });
  try {
    const result = await discover('А до вечернего спектакля что-то подберёшь?', undefined,
      { guidedPlan: true, selectedEventIds: [evening.id] });
    assert.equal(result.events[0].event.id, day.id);
    assert.deepEqual(result.context.planStep, { phase: 'offer', eventId: day.id, anchor: evening.id, position: 'before' });
  } finally { catalog.close(); }
});

test('AI failures preserve bounded conversation memory and never fall back to a scripted questionnaire', async () => {
  const catalog = openCatalog(':memory:', clock);
  const discover = createConversationalDiscovery(catalog, { clock, model: async () => { throw Error('provider down'); } });
  try {
    const context: DiscoveryContext = { city: 'Салават', memory: 'Любят выставки',
      conversation: Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'Предыдущий вопрос' })) };
    const result = await discover('На машине, а ребёнку восемь', context);
    assert.match(result.message, /Не удалось получить ответ ИИ/);
    assert.equal(result.context.city, 'Салават');
    assert.equal(result.context.childAge, undefined);
    assert.equal(result.context.transport, undefined);
    assert.equal(result.context.memory, 'Любят выставки');
    assert.equal(result.context.conversation!.length, 12);
    assert.equal(result.context.conversation!.at(-2)!.content, 'На машине, а ребёнку восемь');
  } finally { catalog.close(); }
});

test('a natural availability answer can continue a plan whose saved event has no published end', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([{ ...fixture, endsAt: undefined }, { ...fixture, title: 'После обеда', sourceKey: 'afternoon',
    startsAt: '2026-11-21T15:00:00+05:00', endsAt: '2026-11-21T16:00:00+05:00' }]);
  const [saved, afternoon] = catalog.search().events;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    if (!input.steps.length) return { action: 'search_events', arguments: { position: 'after', context: {
      city: 'Уфа', date: '2026-11-21', planMode: 'day', earliestStart: '14:00',
    } } };
    return answer('Тогда можно продолжить после обеда.', {}, [afternoon.id], 'matches');
  } });
  try {
    const result = await discover('К двум мы уже точно освободимся, давай что-нибудь после обеда', undefined,
      { guidedPlan: true, selectedEventIds: [saved.id] });
    assert.equal(result.events[0].event.id, afternoon.id);
    assert.equal(result.context.earliestStart, '14:00');
    assert.equal(result.context.planStep?.phase, 'offer');
  } finally { catalog.close(); }
});

test('the HTTP discovery route uses AI conversation mode when the provider is configured', async () => {
  const oldKey = process.env.TIMEWEB_API_KEY;
  const oldOverride = process.env.DISCOVERY_MODEL_KEY;
  process.env.TIMEWEB_API_KEY = 'test-key';
  delete process.env.DISCOVERY_MODEL_KEY;
  let called = false;
  const mocked = mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.message, 'Вечерком бы куда-то, ты же помнишь, что мне нравится?');
    assert.equal(input.conversation[0].content, 'Мне нравятся тихие выставки');
    called = true;
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer('Подберу спокойную выставку. В каком городе ищем?')) } }] });
  });
  const catalog = openCatalog(':memory:', clock);
  const server = await buildServer(catalog);
  try {
    const result = await server.inject({ method: 'POST', url: '/api/v1/discover', payload: {
      message: 'Вечерком бы куда-то, ты же помнишь, что мне нравится?', guidedPlan: true,
      context: { conversation: [{ role: 'user', content: 'Мне нравятся тихие выставки' }] },
    } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().message, 'Подберу спокойную выставку. В каком городе ищем?');
    assert.ok(called);
  } finally {
    await server.close(); catalog.close(); mocked.mock.restore();
    if (oldKey === undefined) delete process.env.TIMEWEB_API_KEY; else process.env.TIMEWEB_API_KEY = oldKey;
    if (oldOverride === undefined) delete process.env.DISCOVERY_MODEL_KEY; else process.env.DISCOVERY_MODEL_KEY = oldOverride;
  }
});

test('nearby misses name the cinema and expose a farther exhibition as a labelled alternative without dropping other constraints', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([
    { ...fixture, title: 'Фильм', category: 'cinema', venue: 'Кинотеатр у парка', address: 'Кино, 1',
      startsAt: '2026-11-21T18:00:00+05:00', endsAt: '2026-11-21T20:00:00+05:00', latitude: 54.7, longitude: 55.9, sourceKey: 'cinema' },
    { ...fixture, title: 'Выставка картин', category: 'exhibition', venue: 'Галерея', address: 'Галерея, 10',
      latitude: 54.8, longitude: 55.9, sourceKey: 'exhibition' },
  ]);
  const events = catalog.search().events;
  const cinema = events.find(event => event.category === 'cinema')!;
  const exhibition = events.find(event => event.category === 'exhibition')!;
  let calls = 0;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    calls++;
    if (calls === 1) return { action: 'search_events', arguments: { position: 'any', context: {
      category: 'exhibition', nearEventId: cinema.id, nearbyKm: 1,
    }, filters: { venue: cinema.venue, q: cinema.title } } };
    if (calls === 2) {
      const result = input.steps.at(-1).result;
      assert.equal(result.appliedFilters.venue, undefined);
      assert.equal(result.appliedFilters.q, undefined);
      assert.equal(result.events[0].proximity.status, 'farther');
      assert.ok(result.events[0].proximity.distanceKm > 10);
      assert.equal(result.proximity.referenceEvent.venue, cinema.venue);
      return answer('Рядом ничего не найдено.', {}, [], 'no_results');
    }
    assert.match(input.steps.at(-1).error, /Do not end with a generic miss/);
    return answer('Рядом с «Кинотеатр у парка», где вы выбрали фильм, выставку в пределах километра не нашёл. Есть «Выставка картин» в Галерее, но она примерно в одиннадцати километрах по прямой. Подойдёт такой вариант?',
      { nearEventId: cinema.id, nearbyKm: null }, [exhibition.id], 'matches');
  } });
  try {
    const result = await discover('А выставку рядом с этим кинотеатром найдёшь?', {
      city: 'Уфа', date: '2026-11-21', planMode: 'day', venue: cinema.venue, query: cinema.title,
      budget: 1500, partySize: 2, childAge: 7, planStep: { phase: 'question', position: 'after' },
    }, { guidedPlan: true, selectedEventIds: [cinema.id] });
    assert.equal(result.events.length, 0);
    assert.equal(result.alternatives?.[0].event.id, exhibition.id);
    assert.equal(result.alternativeReason, 'proximity');
    assert.equal(result.context.nearEventId, cinema.id);
    assert.equal(result.context.nearbyKm, 1);
    assert.equal(result.context.budget, 1500);
    assert.equal(result.context.childAge, 7);
    assert.equal(result.context.date, '2026-11-21');
    assert.match(result.message, /Кинотеатр у парка/);
    assert.ok(result.alternatives![0].reasons.some(reason => reason.includes('по прямой') && reason.includes('радиуса')));
    assert.equal(result.context.planStep?.eventId, exhibition.id);
  } finally { catalog.close(); }
});

test('missing coordinates produce unverified-distance alternatives, not a false claim that the venue is far away', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([
    { ...fixture, title: 'Фильм', category: 'cinema', venue: 'Кинотеатр', sourceKey: 'cinema',
      startsAt: '2026-11-21T19:00:00+05:00', endsAt: '2026-11-21T21:00:00+05:00', latitude: 54.7, longitude: 55.9 },
    { ...fixture, title: 'Фотовыставка', category: 'exhibition', venue: 'Библиотека', sourceKey: 'exhibition' },
  ]);
  const cinema = catalog.search().events.find(event => event.category === 'cinema')!;
  const exhibition = catalog.search().events.find(event => event.category === 'exhibition')!;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    if (!input.steps.length) return { action: 'search_events', arguments: { position: 'any', context: {
      city: 'Уфа', category: 'exhibition', date: '2026-11-21', nearEventId: cinema.id, planMode: 'day',
    } } };
    assert.equal(input.steps[0].result.events[0].proximity.status, 'unverified');
    assert.equal(input.steps[0].result.events[0].proximity.distanceKm, undefined);
    return answer('Выставка в 1,5–2 км от кинотеатра, можно посетить после кино в 21:00.', {}, [exhibition.id], 'matches');
  } });
  try {
    const result = await discover('Выставку недалеко от выбранного кино', undefined, { guidedPlan: true, selectedEventIds: [cinema.id] });
    assert.equal(result.status, 'clarify');
    assert.equal(result.events.length, 0);
    assert.equal(result.alternativeReason, 'proximity');
    assert.ok(result.alternatives![0].reasons.some(reason => reason.includes('Расстояние') && reason.includes('не удалось проверить')));
    assert.ok(result.alternatives![0].reasons.every(reason => !reason.includes('радиуса')));
    assert.ok(!result.message.includes('1,5–2 км'));
    assert.ok(!result.message.includes('после кино'));
    assert.match(result.message, /11:00–12:00/);
    assert.equal(result.context.conversation!.at(-1)!.content, result.message);
  } finally { catalog.close(); }
});

test('verified nearby candidates remain normal matches with a measured straight-line distance', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([
    { ...fixture, title: 'Фильм', category: 'cinema', venue: 'Кинотеатр', sourceKey: 'cinema',
      startsAt: '2026-11-21T19:00:00+05:00', endsAt: '2026-11-21T21:00:00+05:00', latitude: 54.7, longitude: 55.9 },
    { ...fixture, title: 'Выставка рядом', category: 'exhibition', venue: 'Галерея', sourceKey: 'exhibition', latitude: 54.701, longitude: 55.9 },
  ]);
  const cinema = catalog.search().events.find(event => event.category === 'cinema')!;
  const exhibition = catalog.search().events.find(event => event.category === 'exhibition')!;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    if (!input.steps.length) return { action: 'search_events', arguments: { context: { category: 'exhibition', nearEventId: cinema.id, nearbyKm: 0.2 } } };
    assert.equal(input.steps[0].result.events[0].proximity.status, 'nearby');
    return answer('Выставка примерно в ста метрах по прямой от кинотеатра.', {}, [exhibition.id], 'matches');
  } });
  try {
    const result = await discover('Хочу выставку поблизости', { city: 'Уфа' }, { selectedEventIds: [cinema.id] });
    assert.equal(result.events[0].event.id, exhibition.id);
    assert.equal(result.alternatives, undefined);
    assert.ok(result.events[0].reasons.some(reason => reason.includes('0,11 км по прямой')));
  } finally { catalog.close(); }
});

test('nearby alternatives still cannot violate the user budget or the saved schedule', async () => {
  const catalog = openCatalog(':memory:', clock);
  catalog.importEvents([
    { ...fixture, title: 'Фильм', category: 'cinema', venue: 'Кинотеатр', sourceKey: 'cinema',
      startsAt: '2026-11-21T18:00:00+05:00', endsAt: '2026-11-21T20:00:00+05:00' },
    { ...fixture, title: 'Дорогая выставка', category: 'exhibition', venue: 'Галерея', priceMin: 1000, sourceKey: 'exhibition' },
  ]);
  const cinema = catalog.search().events.find(event => event.category === 'cinema')!;
  const exhibition = catalog.search().events.find(event => event.category === 'exhibition')!;
  let calls = 0;
  const discover = createConversationalDiscovery(catalog, { clock, model: async raw => {
    const input = raw as any;
    if (++calls === 1) return { action: 'search_events', arguments: { context: {
      city: 'Уфа', category: 'exhibition', budget: 100, nearEventId: cinema.id, date: '2026-11-21',
    } } };
    if (calls === 2) return { action: 'get_event', arguments: { id: exhibition.id } };
    if (calls === 3) return answer('Можно в эту галерею.', {}, [exhibition.id], 'matches');
    assert.ok(input.steps.at(-1).rejected[0].issues.includes('budget'));
    return answer('Рядом с кинотеатром подходящей выставки по вашему бюджету не нашлось. Найденная галерея стоит дороже установленного лимита.', {}, [], 'no_results');
  } });
  try {
    const result = await discover('Выставку рядом, но не дороже ста рублей', undefined, { selectedEventIds: [cinema.id] });
    assert.equal(result.context.budget, 100);
    assert.equal(result.events.length, 0);
    assert.equal(result.alternatives, undefined);
  } finally { catalog.close(); }
});
