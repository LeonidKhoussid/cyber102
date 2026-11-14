import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscoveryContext } from '@afisha/contracts';
import { constraintIssue, mergeIntent, readIntent } from '../src/intent.ts';

const now = new Date('2026-11-13T12:00:00+05:00');
const cities = ['Салават', 'Стерлитамак', 'Уфа'];
const venues = [{ name: 'Парк Якутова', city: 'Уфа' }, { name: 'Киноцентр «Кинопорт»', city: 'Стерлитамак' }];
const parse = (message: string, previous: DiscoveryContext = {}) => readIntent(message, previous, cities, now, venues);

test('preserves explicit dates, languages, proper names and group size', () => {
  assert.deepEqual(parse('События в Стирлитамаке на выходных'), { city: 'Стерлитамак', period: 'weekend' });
  assert.deepEqual(parse('Что проходит в парке Якутова 15 ноября?'), { city: 'Уфа', venue: 'Парк Якутова', date: '2026-11-15' });
  assert.deepEqual(parse('Концерты в парке Якутова'), { city: 'Уфа', venue: 'Парк Якутова', category: 'concert' });
  assert.deepEqual(parse('Покажи «Чудо-Юдо» в Кинопорте 15 ноября'), {
    city: 'Стерлитамак', venue: 'Киноцентр «Кинопорт»', date: '2026-11-15', query: 'Чудо-Юдо',
  });
  assert.deepEqual(parse('Найди «Тайны старой Уфы»'), { query: 'Тайны старой Уфы' });
  assert.deepEqual(parse('Найди спектакль Письма памяти в Уфе'), { city: 'Уфа', category: 'theatre', query: 'Письма памяти' });
  assert.deepEqual(parse('Поближе к Парку Якутова'), { origin: 'Парк Якутова', sortByDistance: true });
  assert.deepEqual(parse('События на башкирском в конце ноября'), {
    language: 'ba', fromDate: '2026-11-21', untilDate: '2026-11-30',
  });
  assert.deepEqual(parse('На 20 ноября в Уфе с 11 до 18 часов, дешевле 500 рублей на 3 человека.'), {
    city: 'Уфа', date: '2026-11-20', earliestStart: '11:00', latestEnd: '18:00',
    partySize: 3, budget: 500, cheaperThan: 500, free: false,
  });
});

test('distinguishes full search changes from follow-ups and rejects unusable restrictions', () => {
  const previous = parse('Бесплатный концерт в Салавате с 20 по 23 декабря');
  assert.deepEqual(parse('А в Уфе?', previous), { ...previous, city: 'Уфа' });
  assert.deepEqual(parse('Покажи выставки в Уфе завтра', previous), {
    city: 'Уфа', category: 'exhibition', date: '2026-11-14', period: 'tomorrow',
  });
  assert.match(constraintIssue('А что в Уфе 31 февраля?') ?? '', /даты нет/);
  assert.match(constraintIssue('Мероприятия дешевле -100 рублей') ?? '', /отрицательным/);
  assert.match(constraintIssue('Что в Уфе с 20:00 до 02:00?') ?? '', /следующего утра/);
  assert.match(constraintIssue('Составь маршрут с событиями до 18:00') ?? '', /маршрута/);
});

test('model cannot override repeated explicit filters or make up extra ones', () => {
  const message = 'Концерт в Салавате завтра до 500 рублей';
  const previous = parse(message);
  const merged = mergeIntent(message, previous, parse(message, previous), {
    city: 'Уфа', category: 'cinema', date: '2026-11-15', budget: 900, childAge: 10,
    partySize: 20, query: 'завтра', sortByDistance: true, origin: 'Парк Якутова',
  }, cities, venues, now);
  assert.deepEqual(merged, previous);
});

test('cinema, film and cartoon requests use the cinema category and keep titles optional', () => {
  for (const message of [
    'хочу сходить с ребёнком в кинотеатр но не знаю на какой фильм',
    'Хочу посмотреть мультфильм с ребёнком',
    'Какие фильмы подходят детям?',
  ]) {
    const result = parse(message);
    assert.equal(result.category, 'cinema');
    assert.equal(result.query, undefined);
    assert.equal(mergeIntent(message, {}, result, { category: 'theatre', query: 'фильм' }, cities, venues, now).category, 'cinema');
  }
  assert.equal(parse('Спектакль в театре').category, 'theatre');
  assert.equal(parse('Нет, не спектакль, а кино').category, 'cinema');
  assert.equal(parse('Нет, не кино, а спектакль').category, 'theatre');
  assert.equal(parse('А лучше в кино', { category: 'theatre', query: 'Письма памяти' }).query, undefined);
  assert.equal(parse('Покажи фильм «Большое путешествие»').query, 'Большое путешествие');
});

test('reads a shared month for adjacent dates and colloquial child age', () => {
  assert.deepEqual(parse('В Уфе 15 и 16 декабря 2026 для подростка 16 лет.'), {
    city: 'Уфа', fromDate: '2026-12-15', untilDate: '2026-12-16', child: true, childAge: 16,
  });
  const child = parse('Куда сходить для шестилетки?');
  assert.equal(child.childAge, 6);
  assert.equal(child.child, true);
});

test('a genre reply refines a recommendation without becoming a title filter', () => {
  const context = { city: 'Уфа', category: 'theatre', seenEventIds: ['546c9eaf-eea9-4baf-a000-19162786584b'] } as const;
  const base = { ...context, seenEventIds: [...context.seenEventIds] };
  const refined = parse('Музыкальная сказка', base);
  assert.equal(refined.preference, 'Музыкальная сказка');
  assert.equal(refined.query, undefined);
  assert.equal(refined.category, 'theatre');
  assert.equal(parse('«Музыкальная сказка»', base).query, 'Музыкальная сказка');
  const request = 'Поищи классический концерт в Уфе завтра';
  const result = mergeIntent(request, {}, parse(request), { query: 'классический концерт' }, cities, venues, now);
  assert.equal(result.query, undefined);
  assert.equal(result.preference, 'классический концерт');
});
