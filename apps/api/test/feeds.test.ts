import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../src/catalog.ts';
import { mapConcurrent, openCrawler, sourceReader } from '../src/crawl.ts';
import { collectLibrary, collectYouthTheater } from '../src/local-feeds.ts';
import { collectRegionalEvents } from '../src/regional-feed.ts';
import { collectSterlitamakVenues } from '../src/sterlitamak-venues.ts';
import { refreshCatalog } from '../src/sync.ts';
import { collectTimepad } from '../src/timepad.ts';

const now = new Date('2026-11-13T12:00:00+05:00');
const library = 'https://lib-str.ru';
const theater = 'https://teatrnmt.ru';
const title = 'Библиотечная экскурсия';
const librarySchedule = `<table><tr><th>Дата и время проведения</th></tr>
  <tr><td>1.</td><td>${title} 6+</td><td>14.11.2026 г. 13.30–14.30 ч.</td><td>Библиотека (ул. Ленина, 1)</td><td>Бесплатно</td></tr>
  <tr><td>2.</td><td>Без точного времени</td><td>14.11.2026 г. в часы работы</td><td>Библиотека</td><td>Бесплатно</td></tr>
  <tr><td>3.</td><td>Второй сеанс 12+</td><td>14.11.2026 г. 15.00 ч. 15.11.2026 г. 16.00 ч.</td><td>Библиотека</td><td>Детский – 100 руб. Взрослый – 150 руб.</td></tr>
</table>`;

test('library imports only dated sessions and keeps exact age, price, end time and source', async () => {
  const result = await collectLibrary(async url => url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : librarySchedule, now);
  assert.equal(result.events.length, 3);
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.events[0], {
    ...result.events[0], title, category: 'tour', city: 'Стерлитамак', venue: 'Библиотека', address: 'ул. Ленина, 1',
    ageLimit: 6, priceMin: 0, priceMax: 0, startsAt: '2026-11-14T13:30:00+05:00',
    endsAt: '2026-11-14T14:30:00+05:00', sourceUrl: library + '/events/',
  });
  assert.equal(result.events[1].priceMin, 100);
  assert.equal(result.events[1].priceMax, 150);
  assert.equal(result.events[1].endsAt, undefined);
  assert.notEqual(result.events[1].sourceKey, result.events[2].sourceKey);
});

test('theater batches public JSON and matches schedule IDs, weekday, source links and age', async () => {
  const show = theater + '/new-spectacle/sample/';
  const card = (id: number, weekday: string) => `<div class="jet-listing-grid__item" data-post-id="${id}">
    <a href="${show}"><h3>Спектакль</h3></a>
    <div class="jet-listing-dynamic-field__content">15 ноября</div>
    <div class="jet-listing-dynamic-field__content">${weekday}</div>
    <div class="jet-listing-dynamic-field__content">12:00</div>
    <div class="jet-listing-dynamic-field__content">Продолжительность: 35 минут</div></div>`;
  const result = await collectYouthTheater(async address => {
    const url = new URL(address);
    if (url.pathname === '/robots.txt') return 'User-agent: *\nAllow: /';
    if (url.origin === 'https://ufa.kassy.ru') {
      assert.equal(url.pathname, '/venue/nacionalnyjj-molodezhnyjj-teatr-im-m-karima-16/');
      return '<ul class="dl-data"><li>Адрес: 450008, Уфа, ул. Ленина, 62</li></ul><ul class="events">' +
        ['16 ноября 2026 12:00', '15 ноября 2026 12:00'].map((date, index) => `<li>
          <h2><a class="event_link" href="/events/teatr/40-${index + 1}/">Спектакль</a></h2>
          <p class="venue"><a href="${url.pathname}">Национальный молодежный театр им. М.Карима +</a>, Камерный зал, ${date}</p>
          <div class="price_line"><p>Билеты в наличии: ${index === 1 ? '450 — 1 000' : '900'} <i aria-hidden="true">&#xf158;</i></p></div>
        </li>`).join('') + '</ul>';
    }
    if (url.pathname === '/afisha/') return card(42, 'Воскресенье') + card(43, 'Суббота');
    assert.equal(url.pathname, '/wp-json/wp/v2/new-spectacle');
    assert.equal(url.searchParams.get('include'), '42');
    return JSON.stringify([{ id: 42, link: show, title: { rendered: 'Спектакль' },
      content: { rendered: '<p>Возрастное ограничение: 3+</p>' } }]);
  }, now);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].sourceType, 'api');
  assert.equal(result.events[0].ageLimit, 3);
  assert.equal(result.events[0].endsAt, '2026-11-15T07:35:00.000Z');
  assert.equal(result.events[0].priceMin, 450);
  assert.equal(result.events[0].priceMax, 1000);
  assert.equal(result.events[0].ticketUrl, 'https://ufa.kassy.ru/events/teatr/40-2/');
});

test('regional listings keep verified local detail, respect robots and isolate a failed city', async () => {
  const origin = 'https://afishagorodov.ru';
  const slug = '0123456789abcdef01234567';
  const link = origin + '/salavat/events/show-' + slug + '/';
  const denied = origin + '/salavat/events/denied-' + slug + '/';
  const script = (value: unknown) => '<script type="application/ld+json">' + JSON.stringify(value) + '</script>';
  const requested: string[] = [];
  const result = await collectRegionalEvents(async url => {
    requested.push(url);
    if (url === origin + '/robots.txt') return 'User-agent: *\nDisallow: ' + new URL(denied).pathname;
    if (url === origin + '/salavat/') return script({ '@type': 'ItemList', itemListElement: [{ url: link }, { url: denied }] });
    if (url === origin + '/neftekamsk/') throw new Error('Controlled outage');
    if (url === origin + '/sterlitamak/') return script({ '@type': 'ItemList', itemListElement: [{ url: link }] });
    assert.equal(url, link);
    return script({ '@type': 'TheaterEvent', url, name: 'Спектакль', startDate: '2026-11-15T12:00:00+05:00',
      eventStatus: 'https://schema.org/EventScheduled', location: { name: 'Театр', address: { addressLocality: 'Салават' } },
      typicalAgeRange: '6-', offers: { priceCurrency: 'RUB', price: '500' } });
  }, now);
  assert.match(result.error ?? '', /1 of 3/);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].city, 'Салават');
  assert.equal(result.events[0].ageLimit, 6);
  assert.equal(result.events[0].priceMin, 500);
  assert.ok(!requested.includes(denied));
});

test('Timepad uses credential only on its API and rejects out-of-region and malformed events', async () => {
  const result = await collectTimepad(async (address, headers) => {
    assert.equal(new URL(address).origin, 'https://api.timepad.ru');
    assert.equal(new Headers(headers).get('Authorization'), 'Bearer fixture-token');
    const record = { id: 42, name: 'Выставка', starts_at: '2026-11-15T12:00:00+05:00', access_status: 'public',
      url: 'https://museum.timepad.ru/event/42/', categories: [{ name: 'Выставки' }],
      location: { city: 'Уфа', address: 'ул. Ленина, 1' }, registration_data: { price_min: 0 }, age_limit: '6+' };
    return JSON.stringify({ values: [record, { ...record, url: 'invalid' }, { ...record, location: { city: 'Москва' } }] });
  }, now, 'fixture-token');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].priceMin, 0);
  assert.equal(result.events[0].ageLimit, 6);
  assert.equal(result.rejected, 2);
});

test('transport bounds content and concurrent work, and stops scheduling after a publisher rate limits', async () => {
  const read = sourceReader(async () => new Response('a'.repeat(3_000_001)));
  await assert.rejects(read('https://example.org/data'), /3 MB/);
  const requested: string[] = [];
  const publisher = sourceReader(async input => {
    requested.push(String(input));
    return String(input).endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /') : new Response(null, { status: 429 });
  });
  const crawler = await openCrawler('https://example.org', publisher);
  await assert.rejects(crawler.page(new URL('https://example.org/first')), /429/);
  await assert.rejects(crawler.page(new URL('https://example.org/second')), /rate limited/);
  assert.equal(requested.length, 2);
  let running = 0;
  let maximum = 0;
  const outcomes = await mapConcurrent([1, 2, 3, 4, 5], 2, async value => {
    maximum = Math.max(maximum, ++running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
    return value;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(outcomes.map(outcome => outcome.status === 'fulfilled' ? outcome.value : null), [1, 2, 3, 4, 5]);
});

test('the refresh imports a completed source during another source failure and preserves IDs on rerun', async () => {
  const catalog = openCatalog(':memory:', () => now);
  let confirmVisible: () => void = () => undefined;
  const committed = new Promise<void>(resolve => { confirmVisible = resolve; });
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.origin === library) return new Response(url.pathname === '/robots.txt' ? '' : librarySchedule);
    if (url.hostname === 'afisha-ufa.ru') {
      await committed;
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 503 });
  };
  try {
    const first = await refreshCatalog(catalog, { now, fetcher, timepadToken: '', onReport(report) {
      if (report.source.startsWith('Централизованная')) {
        assert.equal(catalog.search().total, 3);
        confirmVisible();
      }
    } });
    assert.equal(first.filter(report => report.error).length, first.length - 1);
    const ids = catalog.search().events.map(event => event.id);
    const second = await refreshCatalog(catalog, { now, fetcher, timepadToken: '' });
    assert.equal(second.find(report => report.source.startsWith('Централизованная'))?.unchanged, 3);
    assert.deepEqual(catalog.search().events.map(event => event.id), ids);
  } finally {
    catalog.close();
  }
});

test('crawler respects rules behind a same-site robots redirect and refuses other redirects', async () => {
  const origin = 'https://example.org';
  const requests: string[] = [];
  const read = sourceReader(async (input, options) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === '/robots.txt') {
      assert.equal(options?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: '/crawler-policy.txt' } });
    }
    if (path === '/crawler-policy.txt') return new Response('User-agent: *\nDisallow: /blocked');
    assert.equal(options?.redirect, 'error');
    return new Response('listing');
  });
  const crawler = await openCrawler(origin, read);
  await assert.rejects(crawler.page(new URL(origin + '/blocked')), /disallows/);
  assert.equal(await crawler.page(new URL(origin + '/listing')), 'listing');
  assert.deepEqual(requests, ['/robots.txt', '/crawler-policy.txt', '/listing']);
  const external = sourceReader(async input => {
    assert.equal(String(input), origin + '/robots.txt');
    return new Response(null, { status: 302, headers: { location: 'https://other.example/robots.txt' } });
  });
  await assert.rejects(openCrawler(origin, external), /leaves source origin/);
});

test('transport retries a timeout once and does not retry forbidden responses', async () => {
  let attempts = 0;
  const flaky = sourceReader(async () => {
    if (++attempts === 1) throw new DOMException('Controlled timeout', 'TimeoutError');
    return new Response('recovered');
  });
  assert.equal(await flaky('https://example.org/feed'), 'recovered');
  assert.equal(attempts, 2);
  attempts = 0;
  const forbidden = sourceReader(async () => {
    attempts++;
    return new Response(null, { status: 403 });
  });
  await assert.rejects(forbidden('https://example.org/feed'), /403/);
  assert.equal(attempts, 1);
});


test('official venue details preserve two prices and do not invent end time or require a ticket for cancellations', async () => {
  const origin = 'https://sgtko.ru';
  const concert = origin + '/afisha/event/concert/';
  const cancelled = origin + '/afisha/event/cancelled/';
  const result = await collectSterlitamakVenues(async url => {
    if (url === origin + '/robots.txt') return 'User-agent: *\nAllow: /';
    if (url === origin + '/afisha/') return `<a href="${concert}">Концерт</a><a href="${cancelled}">Отмена</a>`;
    return `<h2 class="my-title-opacity">Концерт</h2><ul><li class="event-category"><a rel="tag">Филармония</a></li>
      <li class="my-single-poster-price"><abbr class="dtstart" title="2026-11-15 12:00"></abbr>
      <abbr class="dtend" title="2026-11-15 12:00"></abbr>
      <div class="event-ticket"><span class="ticket-name">400 - </span><span class="ticket-price">700 ₽</span></div></li></ul>
      <div class="tab-pane">Возрастная категория: 0+. ${url === cancelled ? 'Концерт отменён.' :
        '<a class="a_quicktickets" href="https://quicktickets.ru/sterlitamak-gtko/s515?min=1">Билеты</a>'}</div>`;
  }, now);
  assert.deepEqual(result.events.map(event => [event.status, event.venue, event.priceMin, event.priceMax, event.ageLimit, event.endsAt]),
    [['published', 'Филармония', 400, 700, 0, undefined], ['cancelled', 'Филармония', 400, 700, 0, undefined]]);
  assert.equal(result.events[1].ticketUrl, undefined);
});
