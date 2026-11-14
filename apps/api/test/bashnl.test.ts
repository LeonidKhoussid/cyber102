import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectNationalLibrary } from '../src/bashnl.ts';

const now = new Date('2026-11-14T14:00:00+05:00');
const schedule = '/uslugi/pushkinskaya-karta/';
const hoursPath = '/o-biblioteke/struktura-biblioteki/otdel-obsluzhivaniya-polzovateley/';
const card = (id: number, date: string, address: string) => `
  <article class="list-news__item">
    <h3><a href="${schedule}?ELEMENT_ID=${id}">Литературный турнир</a></h3>
    <h3>Стоимость: <b>250 руб.</b><br>Дата/время: <b>${date}</b><br>Место проведения: <b>${address}</b></h3>
  </article>`;
const address = 'г Уфа, пр-кт Октября, д 62/2';
const future = '16.11.2026 12:00:00';
const listing = card(1, future, address) + card(2, future, 'Выездное (по запросу организации)') +
  card(3, '13.11.2026 12:00:00', address) + card(4, future, address) + card(5, future, address);
const detail = (date: string) => `<div id="textgraphId">
  <h3>АФИША МЕРОПРИЯТИЙ</h3><h3>Литературный турнир</h3><p>Возрастное ограничение: 12+</p><b>250 руб.<br>${date}<br>${address}</b>
  <a class="news-preview-button" href="https://iframeab-pre5630.intickets.ru/event/123/">Купить билет</a>
</div>`;
const exhibition = `<h2 class="title-section">«Три взгляда»: живопись, природа и метафизика на одной выставке</h2>
  <div id="textgraphId"><span class="news-date-time">27.10.2026</span><br>
  Выставку можно посетить с 3 ноября по 3 декабря. Презентация выставки состоится 3 ноября в 17:00 ч.<br>
  Вход свободный.<br>Выставка работает по адресу: Уфа, ул. Октябрьской революции, 10. Дом купца Ф. Чижова – корпус 2 Национальной библиотеки РБ.</div>`;
const hours = `<div id="textgraphId"><p>Адрес: г. Уфа, ул. Октябрьской революции, 10</p>
  <p>График работы:</p><p>вт 09:00–20:00, сб 09:00–18:00,</p>
  <p>последняя пятница месяца – санитарный день, обслуживания нет.</p></div>`;

async function loadFixture() {
  return collectNationalLibrary(async address => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://bashnl.ru');
    switch (url.pathname + url.search) {
      case '/robots.txt': return `User-agent: *\nDisallow: ${schedule}?ELEMENT_ID=5`;
      case schedule: return listing;
      case schedule + '?ELEMENT_ID=1': return detail(future);
      case schedule + '?ELEMENT_ID=4': return detail('17.11.2026 12:00:00');
      case '/novosti/50935/': return exhibition;
      case hoursPath: return hours;
      default: assert.fail(`Unexpected page: ${url.href}`);
    }
  }, now);
}

test('library schedule requires matching official dates and excludes past, offsite and disallowed sessions', async () => {
  const result = await loadFixture();
  const dated = result.events.filter(event => event.category !== 'exhibition');
  assert.equal(dated.length, 1);
  assert.equal(result.rejected, 3);
  assert.equal(dated[0].sourceUrl, `https://bashnl.ru${schedule}?ELEMENT_ID=1`);
  assert.equal(dated[0].startsAt, '2026-11-16T12:00:00+05:00');
  assert.equal(dated[0].priceMin, 250);
  assert.equal(dated[0].ageLimit, 12);
  assert.equal(dated[0].endsAt, undefined);
});

test('library exhibition uses its explicit venue hours and stable date keys', async () => {
  const result = await loadFixture();
  const windows = result.events.filter(event => event.category === 'exhibition');
  assert.equal(windows.length, 6);
  assert.equal(windows[0].startsAt, '2026-11-14T09:00:00+05:00');
  assert.equal(windows[0].endsAt, '2026-11-14T18:00:00+05:00');
  assert.equal(windows[1].endsAt, '2026-11-17T20:00:00+05:00');
  assert.equal(windows.at(-1)?.startsAt, '2026-12-01T09:00:00+05:00');
  assert.ok(windows.every(event => event.priceMin === 0 && event.ageLimit === undefined));
  assert.match(windows[0].description ?? '', /часам работы/);
  assert.deepEqual((await loadFixture()).events.map(event => event.sourceKey), result.events.map(event => event.sourceKey));
});
