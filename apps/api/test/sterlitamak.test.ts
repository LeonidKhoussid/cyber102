import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSterlitamak } from '../src/sterlitamak.ts';

const origin = 'https://rusdramteatr.ru';
const ticketOrigin = 'https://sterlitamak.kassy.ru';
const ticketPath = '/events/teatr/2-25366/';
const now = new Date('2026-11-14T12:00:00+05:00');
const shows = new Map([
  ['/afisha/tsarevna', 'Царевна — Лягушка'],
  ['/afisha/unknown', 'Царевна'],
]);

async function collect(tariffs: string, robots = 'User-agent: *\nAllow: /', ticket?: Record<string, unknown>) {
  return collectSterlitamak(async input => {
    const { origin: host, pathname } = new URL(String(input));
    if (host === ticketOrigin) {
      if (pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nDisallow: /*/buy/');
      assert.equal(pathname, ticketPath);
      return new Response(`<script type="application/ld+json">${JSON.stringify(ticket)}</script>`);
    }
    if (pathname === '/robots.txt') return new Response(robots);
    if (pathname === '/afisha') return new Response([...shows.keys()].map(path =>
      `<div class="nspArt"><a class="nspImageWrapper" href="${path}"></a><span class="nspInfo">15 ноября, 12:00</span></div>`).join(''));
    if (pathname === '/bilety') {
      assert.ok(!robots.includes('Disallow: /bilety'));
      return new Response(tariffs);
    }
    assert.ok(shows.has(pathname));
    return new Response(`<main><article class="com-content-article"><h2>${shows.get(pathname)}</h2>
      <dl><dd class="create"><time datetime="2026-11-15T12:00:00+05:00">15 ноября, 12:00</time></dd></dl>
      <h5>0+</h5><p>сказка</p><p>1 ч.</p>${ticket && pathname === '/afisha/tsarevna'
        ? '<button data-kassy-agent_id="rusdramteatr.ru" data-kassy-db="sterlitamak" data-kassy-event_id="25366">Билеты</button>' : ''}
      </article><div id="mod-custom121"><p>Русский драматический театр Стерлитамака</p><p>г. Стерлитамак, пр. Ленина, 30</p></div></main>`);
  }, now);
}

const tariffs = `<div class="stoimost"><h3>Цены на билеты</h3>
  <div data-rlta-element="button" aria-controls="children"><h3>Детские спектакли: «Кошкин дом»; «Царевна - Лягушка»</h3></div>
  <div id="children" data-rlta-element="panel"><div data-rlta-element="panel-content">
    <ul><li>1 - 4 ряды - 600 руб.</li><li>19 - 20 ряды (12 - 20 мест) - 350 руб.</li></ul>
  </div></div></div><p>Скидка — 100 руб.</p>`;

test('official theater tariffs match a verified exact production and retain the pricing source', async () => {
  const result = await collect(tariffs);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events.map(event => [event.title, event.priceMin, event.priceMax]), [
    ['Царевна — Лягушка', 350, 600], ['Царевна', undefined, undefined],
  ]);
  assert.equal(result.events[0].sourceUrl, origin + '/afisha/tsarevna');
  assert.deepEqual((result.events[0].raw as { tariff: unknown }).tariff,
    { url: origin + '/bilety', priceMin: 350, priceMax: 600 });
});

test('unavailable theater tariffs preserve verified sessions without adding prices', async () => {
  const result = await collect(tariffs, 'User-agent: *\nDisallow: /bilety');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events.map(event => event.priceMin), [undefined, undefined]);
});

const ticket = {
  '@type': 'TheaterEvent', name: 'Царевна-Лягушка', startDate: '2026-11-15T12:00:00+05:00',
  url: ticketOrigin + ticketPath, eventStatus: 'https://schema.org/EventScheduled',
  offers: { url: ticketOrigin + ticketPath, priceCurrency: 'RUB', lowPrice: 400, highPrice: 550 },
};

test('official ticket link enriches only the matching session and takes priority over general tariffs', async () => {
  const linked = await collect(tariffs, undefined, ticket);
  assert.deepEqual(linked.events.map(event => [event.priceMin, event.priceMax, event.ticketUrl]), [
    [400, 550, ticketOrigin + ticketPath], [undefined, undefined, undefined],
  ]);
  const differentSession = await collect(tariffs, undefined, { ...ticket, startDate: '2026-11-16T12:00:00+05:00' });
  assert.deepEqual(differentSession.events.map(event => [event.priceMin, event.priceMax, event.ticketUrl]), [
    [350, 600, undefined], [undefined, undefined, undefined],
  ]);
});
