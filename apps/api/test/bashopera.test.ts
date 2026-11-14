import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBashopera } from '../src/bashopera.ts';

const origin = 'https://bashopera.ru';
const day = new Date('2026-11-14T12:00:00+05:00');

function card(id: number, repertoire: string, title: string, date: string, weekday: string, prices = '', tags = '12+') {
  return `<div class="item content" id="bx_123_${id}">
    <div class="dates"><div class="date">${date}</div><div class="weekday">${weekday}</div></div>
    <div class="names"><div class="name"><a href="${repertoire}">${title}</a></div>
      <ul class="b-tags"><li>${tags}</li></ul></div>
    <div class="actions"><div class="hall"><a href="/tickets/halls/234/?template=blank">Большой зал</a>, 18:00</div>
      <div class="price">${prices}</div><div class="buy"><a class="b-byu-btn" href="${repertoire}${id}/">Билеты</a></div></div>
  </div>`;
}

test('BashOpera checks weekdays and session links, keeps separate showtimes, and extracts documented fields', async () => {
  const opera = '/repertoire/opera/20/';
  const concert = '/repertoire/concert/30/';
  const html = `<div class="b-affiche"><div class="items">
    ${card(1, opera, 'Тестовая опера', '14 ноября', 'суббота', '1 000 – 1 500 ₽')}
    ${card(2, opera, 'Тестовая опера', '3 января', 'воскресенье')}
    ${card(3, opera, 'Неверная дата', '15 ноября', 'суббота')}
    ${card(4, concert, 'Концерт', '15 ноября', 'воскресенье', 'от 300 руб.', 'Отменён')}
  </div></div>`;
  const detail = `<div id="article-content"><h1>Тестовая опера</h1><div class="b-event">
    <div class="info"><div class="description">Исполняется на башкирском языке<br>Продолжительность: 2 часа 10 минут</div></div>
    <div class="affiche"><a href="1/">Билеты</a><a href="2/">Билеты</a></div>
    <div class="text">Сопровождается титрами на русском языке.</div>
  </div></div>`;
  const pages = new Map([
    [origin + '/robots.txt', 'User-agent: *\nDisallow: /repertoire/concert/30/$'],
    [origin + '/affiche/', html], [origin + opera, detail],
  ]);
  const result = await collectBashopera(async url => {
    assert.ok(pages.has(url), `Unverified or disallowed request: ${url}`);
    return pages.get(url)!;
  }, day);
  assert.equal(result.rejected, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.events.length, 3);
  const [first, second, cancelled] = result.events;
  assert.equal(first.sourceKey, 'bashopera:1');
  assert.equal(first.startsAt, '2026-11-14T18:00:00+05:00');
  assert.equal(first.endsAt, '2026-11-14T15:10:00.000Z');
  assert.equal(first.sourceUrl, origin + opera);
  assert.equal(first.ticketUrl, origin + opera + '1/');
  assert.equal(first.ageLimit, 12);
  assert.equal(first.language, 'ba');
  assert.equal(first.priceMin, 1000);
  assert.equal(first.priceMax, 1500);
  assert.equal(second.startsAt, '2027-01-03T18:00:00+05:00');
  assert.equal(second.sourceKey, 'bashopera:2');
  assert.equal(second.priceMin, undefined);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.category, 'concert');
  assert.equal(cancelled.priceMin, 300);
  assert.equal(cancelled.priceMax, undefined);
  assert.equal(cancelled.endsAt, undefined);
  assert.equal(cancelled.language, undefined);
});
