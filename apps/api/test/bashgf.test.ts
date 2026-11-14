import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBashgf } from '../src/bashgf.ts';
import type { Read } from '../src/crawl.ts';

const origin = 'https://bashgf.ru';
const now = new Date('2026-11-14T12:00:00+05:00');
const concertPath = '/afisha/event/with-price/';
const unclearPath = '/afisha/event/unclear/';
const freePath = '/afisha/event/free/';

function card({ id, path, title, start, end = start, ticket, description, price }: {
  id: string; path: string; title: string; start: string; end?: string;
  ticket?: string; description?: string; price: string;
}) {
  return `<article class="hcalendar event status-publish" id="post-${id}">
    <h3 class="entry-title"><a class="url" href="${path}">${title}</a></h3>
    <abbr class="dtstart" title="${start}"></abbr><abbr class="dtend" title="${end}"></abbr>
    <abbr class="dtstart" title="${start}"></abbr><abbr class="dtend" title="${end}"></abbr>
    <div class="event-category"><a href="/afisha/category/bolshoj-zal/">Большой зал</a></div>
    <div class="event-tickets">${price}</div>
    <div class="my-posters-content"><em>Вечер камерной музыки</em></div>
    <div class="my-poster-content"><p>${description ?? ''}</p>${ticket ? `<a href="${ticket}">Билеты</a>` : ''}</div>
  </article>`;
}

test('philharmonic collector verifies source cards and never equates an unconfirmed free badge with zero price', async () => {
  const priced = { id: '1', path: concertPath, title: 'Концерт «Вечер»', start: '2026-11-21 18:00',
    end: '2026-11-21 20:00', price: 'Цена: 600 - 1 200 ₽' };
  const unclear = { id: '2', path: unclearPath, title: 'Ансамбль «Музыка»', start: '2026-11-22 19:00', price: 'Бесплатно' };
  const free = { id: '3', path: freePath, title: 'Концерт «Для всех»', start: '2026-12-05 11:00', price: 'Бесплатно' };
  const pages = new Map([
    ['/robots.txt', 'User-agent: *\nDisallow: */page/\nDisallow: /afisha/event/hidden/'],
    ['/afisha/', card(priced) + card(unclear) + card({ ...priced, id: '4', path: '/afisha/event/hidden/' }) +
      card({ ...priced, id: '5', path: '/afisha/event/conflict/' }) +
      '<div class="my-archive-months-poster"><a href="/afisha/2026/12">December</a><a href="/afisha/2026/12/page/2/">2</a></div>'],
    ['/afisha/2026/12/', card(free)],
    [concertPath, card({ ...priced, description: 'Камерная программа для слушателей 12+.' })],
    [unclearPath, card({ ...unclear, description: 'Действует скидка на билеты.', ticket: 'https://iframe.intickets.ru/seance/123' })],
    [freePath, card({ ...free, description: 'Вход свободный.' })],
    ['/afisha/event/conflict/', card({ ...priced, id: '5', path: '/afisha/event/conflict/', start: '2026-11-21 20:00' })],
  ]);
  const read: Read = async address => {
    const url = new URL(address);
    assert.equal(url.origin, origin);
    const html = pages.get(url.pathname);
    assert.notEqual(html, undefined, url.pathname);
    return html!;
  };
  const report = await collectBashgf(read, now);
  assert.equal(report.error, undefined);
  assert.equal(report.rejected, 2);
  assert.deepEqual(report.events.map(({ sourceKey, startsAt, endsAt, category, priceMin, priceMax, ageLimit, ticketUrl }) =>
    ({ sourceKey, startsAt, endsAt, category, priceMin, priceMax, ageLimit, ticketUrl })), [
    { sourceKey: 'bashgf:1', startsAt: '2026-11-21T18:00:00+05:00', endsAt: '2026-11-21T20:00:00+05:00',
      category: 'concert', priceMin: 600, priceMax: 1200, ageLimit: 12, ticketUrl: undefined },
    { sourceKey: 'bashgf:2', startsAt: '2026-11-22T19:00:00+05:00', endsAt: undefined,
      category: 'concert', priceMin: undefined, priceMax: undefined, ageLimit: undefined, ticketUrl: 'https://iframe.intickets.ru/seance/123' },
    { sourceKey: 'bashgf:3', startsAt: '2026-12-05T11:00:00+05:00', endsAt: undefined,
      category: 'concert', priceMin: 0, priceMax: 0, ageLimit: undefined, ticketUrl: undefined },
  ]);
});
