import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectGasorb } from '../src/gasorb.ts';

test('state symphony confirms each city and session against the organizer’s date and venue', async () => {
  const origin = 'https://gasorb.ru';
  const show = (slug: string, title: string, hall: string) => `<div class="item"><a class="image" href="/affiche/${slug}/">
    <span class="date">26 ноября 19:00</span><span class="hall">${hall}</span></a>
    <div class="title"><a href="/affiche/${slug}/">${title}</a></div></div>`;
  const detail = (hall: string, notice = '', free = false) => `<div id="article-content"><h1>Концерт симфонической музыки</h1>
    <div class="b-affiche-detail"><div class="content"><div class="date">Четверг 26 ноября 2026г 19:00</div>
    <div class="tags"><span>6+</span><span>II отделения</span></div>
    <div class="hall"><a href="#map">${hall}</a><br>Салават, ул. Гагарина, 2А</div>
    <div class="buy">${free ? '<a class="button" href="javascript:;">Вход свободный</a>'
      : '<a class="button" href="#event/2884497">Купить билет</a>'}</div>
    <div class="text">${notice}</div></div></div></div>`;
  const requests: string[] = [];
  const result = await collectGasorb(async address => {
    const path = new URL(address).pathname;
    requests.push(path);
    if (path === '/robots.txt') return 'User-agent: *\nDisallow: /affiche/denied/';
    if (path === '/affiche/') return `<div class="b-posters">${show('salavat', 'Концерт симфонической музыки', 'Салават, ЦДТ «Нефтехимик»')}
      ${show('changed', 'Концерт симфонической музыки', 'Уфа, ГКЗ «Башкортостан»')}
      ${show('denied', 'Концерт симфонической музыки', 'Уфа, ГКЗ «Башкортостан»')}
      ${show('cancelled', 'Концерт симфонической музыки', 'Салават, ЦДТ «Нефтехимик»')}
      ${show('free', 'Концерт симфонической музыки', 'Салават, ЦДТ «Нефтехимик»')}
      ${show('paid', 'Концерт симфонической музыки', 'Салават, ЦДТ «Нефтехимик»')}</div>`;
    if (path.endsWith('/cancelled/')) return detail('Салават, ЦДТ «Нефтехимик»', 'Концерт отменён.');
    if (path.endsWith('/free/') || path.endsWith('/paid/')) {
      return detail('Салават, ЦДТ «Нефтехимик»', 'Начало в 19:00. Вход на концерт свободный.<br>', path.endsWith('/free/'));
    }
    return detail('Салават, ЦДТ «Нефтехимик»', 'О программе.');
  }, new Date('2026-11-14T18:00:00+05:00'));
  assert.ok(!requests.includes('/affiche/denied/'));
  assert.deepEqual(result.events.map(({ city, venue, address, startsAt, ageLimit, endsAt, priceMin, priceMax, ticketUrl, status }) =>
    [city, venue, address, startsAt, ageLimit, endsAt, priceMin, priceMax, ticketUrl, status]), [
    ['Салават', 'ЦДТ «Нефтехимик»', 'ул. Гагарина, 2А', '2026-11-26T19:00:00+05:00', 6, undefined, undefined, undefined,
      origin + '/affiche/salavat/#event/2884497', 'published'],
    ['Салават', 'ЦДТ «Нефтехимик»', 'ул. Гагарина, 2А', '2026-11-26T19:00:00+05:00', 6, undefined, undefined, undefined,
      undefined, 'cancelled'],
    ['Салават', 'ЦДТ «Нефтехимик»', 'ул. Гагарина, 2А', '2026-11-26T19:00:00+05:00', 6, undefined, 0, 0,
      undefined, 'published'],
    ['Салават', 'ЦДТ «Нефтехимик»', 'ул. Гагарина, 2А', '2026-11-26T19:00:00+05:00', 6, undefined, undefined, undefined,
      origin + '/affiche/paid/#event/2884497', 'published'],
  ]);
  assert.equal(result.rejected, 2);
});
