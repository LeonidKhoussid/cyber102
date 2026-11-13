import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSources } from '../src/sources.ts';

const afisha = 'https://afisha-ufa.ru';
const culture = 'https://kulturaufa.ru';
const now = new Date('2026-11-13T12:00:00+05:00');
const articlePath = '/novosti/koncert/';
const eventPath = '/events/filarmoniya/1234-koncert/';
const cancelledPath = '/events/filarmoniya/1235-otmena/';
const gonePath = '/events/filarmoniya/1236-gone/';
const blockedPath = '/events/filarmoniya/1237-blocked/';
const foreignUrl = 'https://example.com/events/filarmoniya/1234-koncert/';
const event = {
  '@type': 'Event',
  name: 'Концерт',
  url: afisha + eventPath,
  startDate: '2026-11-20T19:00:00+05:00',
  eventStatus: 'https://schema.org/EventScheduled',
  location: { name: 'Филармония', address: { addressLocality: 'Уфа', streetAddress: 'ул. Ленина, 1' } },
};
const cancelled = {
  ...event,
  name: 'Отмена',
  url: afisha + cancelledPath,
  eventStatus: 'https://schema.org/EventCancelled',
  startDate: '2026-11-12T19:00:00+05:00',
};

function structured(value: unknown): string {
  return '<script type="application/ld+json">' + JSON.stringify(value) + '</script>';
}

function article(id: number, content: string, path = articlePath) {
  return {
    id,
    date: '2026-11-10T09:16:16',
    title: { rendered: 'Концерт &laquo;Осень&raquo;' },
    link: culture + path,
    content: { rendered: '<p>' + content + '</p>' },
  };
}

const single = '20 ноября в 19:00 в Уфимской детской филармонии состоится концерт. Вход свободный.';

test('collects only verified events, preserves cancellations and missing values, and deduplicates links', async () => {
  const requested: string[] = [];
  const post = article(5, single);
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    requested.push(url);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    if (url.startsWith(culture + '/wp-json/')) {
      return Response.json([
        post,
        post,
        article(6, 'С 20 по 21 ноября в 19:00 в Доме культуры состоится фестиваль.'),
        article(7, single + ' 21 ноября в 18:00 состоится концерт.'),
        article(8, '31 ноября в 19:00 в Доме культуры состоится фестиваль.'),
        article(9, '20 ноября в 19:00 в Уфимской детской филармонии состоится концерт.'),
        article(10, '20 ноября в Уфимской детской филармонии состоится концерт.'),
        article(11, '13 ноября в 12:00 в Уфимской детской филармонии состоится концерт.'),
      ]);
    }
    if (url === culture + articlePath) return new Response('article');
    if (url === afisha + '/robots.txt') return new Response('User-agent: *\nDisallow: ' + blockedPath);
    if (url === afisha + '/') {
      return new Response(structured({
        '@type': 'ItemList',
        itemListElement: [event, event, cancelled, { ...event, url: foreignUrl },
          { ...event, url: afisha + gonePath }, { ...event, url: afisha + blockedPath }].map((item) => ({ item })),
      }));
    }
    if (url === afisha + '/list/all/') {
      return new Response('<div class="uf-event-card"><div class="uf-event-title"><a href="' + eventPath + '">Концерт</a></div></div>');
    }
    if (url === afisha + eventPath) {
      return new Response(structured(event) + '<div class="uf-event-category-badge">Концерты · Для детей</div><div class="uf-event-detail-age">0+</div>');
    }
    if (url === afisha + cancelledPath) return new Response(structured(cancelled));
    if (url === afisha + gonePath) return new Response(null, { status: 404 });
    assert.fail('Unexpected URL ' + url);
  };

  const [municipal, afishaResult] = await collectSources({ fetcher, now });
  assert.equal(municipal.error, undefined);
  assert.equal(municipal.rejected, 5);
  assert.equal(municipal.events.length, 1);
  assert.equal(municipal.events[0].startsAt, '2026-11-20T19:00:00+05:00');
  assert.equal(municipal.events[0].title, 'Концерт «Осень»');
  assert.equal(municipal.events[0].venue, 'Уфимской детской филармонии');
  assert.equal(municipal.events[0].priceMin, 0);
  assert.equal(municipal.events[0].ageLimit, undefined);
  assert.deepEqual(municipal.events[0].raw, post);

  assert.equal(afishaResult.error, undefined);
  assert.equal(afishaResult.rejected, 3);
  assert.deepEqual(afishaResult.events.map(({ status, ageLimit, category, priceMin, imageUrl }) =>
    ({ status, ageLimit, category, priceMin, imageUrl })), [
    { status: 'published', ageLimit: 0, category: 'concert', priceMin: undefined, imageUrl: undefined },
    { status: 'cancelled', ageLimit: undefined, category: 'other', priceMin: undefined, imageUrl: undefined },
  ]);
  assert.equal(requested.filter((url) => url === afisha + eventPath).length, 1);
  assert.ok(!requested.includes(foreignUrl));
  assert.ok(!requested.includes(afisha + blockedPath));
});

test('returns independent source errors and makes no page requests after robots denies crawling', async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === afisha + '/robots.txt') return new Response('User-agent: *\nDisallow: /');
    return new Response(null, { status: 503 });
  };
  const [municipal, afishaResult] = await collectSources({ fetcher, now });
  assert.match(municipal.error ?? '', /503/);
  assert.match(afishaResult.error ?? '', /robots\.txt/);
  assert.equal(requested.length, 2);
});
