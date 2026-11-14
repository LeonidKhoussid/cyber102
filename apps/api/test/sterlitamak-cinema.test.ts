import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSterlitamakCinema } from '../src/sterlitamak-cinema.ts';

const origin = 'https://www.mirage.ru';
const today = '14.11.2026';
const tomorrow = '15.11.2026';
const past = 'b19464ba-3432-47c1-95ea-82cb5a1c3413';
const upcoming = '3b681fa7-dadb-4366-8dfd-cb919ade9db9';
const unconfirmed = 'f58535a6-c709-426b-896e-6066995f7727';
const cinema = '<div class="md-title"><a href="/str/cinema/9/">АРБАТ</a></div><div class="adds">ул. Артема, 96</div>';
const dayLink = (day: string, active = false) =>
  `<a class="bt-dark${active ? ' active' : ''}" href="/str/schedule/${day}/">${day}</a>`;

function session(key: string, time: string, price: string) {
  return `<div class="session"><a href="/ticket_new/${key}/">
    <div class="title">Сказка о потерянном времени</div>
    <div class="genre">семейный, фэнтези</div>
    <div class="photo"><img src="https://cdn.mirage.ru/images/film/7000/small/p7622.jpg"></div>
    <div class="labels"><span>Зал 5</span></div>
    <div class="info-line"><div class="time">${time}</div></div><div class="age">6+</div>
    <div class="place-price"><div class="item"><img src="/i/armchair/svg.svg">${price}</div>
      <div class="item"><img src="/i/stroller.svg">100₽</div></div>
  </a></div>`;
}

function schedule(day: string, sessions: string) {
  return `<div class="page-content"><h1>Расписание в Стерлитамаке</h1>
    <div class="calendar-list">${dayLink(today, day === today)}${dayLink(tomorrow, day === tomorrow)}</div>
    <div class="session-box">${cinema}<div class="session-slider">${sessions}</div></div>
  </div>`;
}

test('collects official future screenings with confirmed end and keeps starting prices distinct', async () => {
  const pages = new Map([
    ['/robots.txt', 'User-agent: *\nDisallow: /ticket/'],
    ['/str/schedule/', schedule(today, session(past, '17:00', '200₽'))],
    [`/str/schedule/${tomorrow}/`, schedule(tomorrow,
      session(upcoming, '11:00', 'От 125₽') + session(unconfirmed, '12:00', ''))],
    [`/str/film/7622/${tomorrow}/`, `<div class="calendar-list"><a class="bt-dark active" href="/film/7622/${tomorrow}/"></a></div>
      <div class="session-box">${cinema}<div class="session-slider"><div class="session-item">
        <a href="/ticket/${upcoming}/"><div class="title">Сказка о потерянном времени</div>
          <div class="period"><div class="start">11:00</div><div class="end">12:30</div></div></a>
      </div></div></div>`],
  ]);
  const requests: string[] = [];
  const result = await collectSterlitamakCinema(async href => {
    const url = new URL(href);
    assert.equal(url.origin, origin);
    requests.push(url.pathname);
    assert.ok(pages.has(url.pathname), `Unexpected request: ${href}`);
    return pages.get(url.pathname)!;
  }, new Date('2026-11-14T18:35:00+05:00'));

  assert.equal(result.error, undefined);
  assert.equal(result.events.length, 2);
  const [first, second] = result.events;
  assert.equal(first.sourceKey, 'mirage:str:' + upcoming);
  assert.equal(first.sourceUrl, origin + `/str/film/7622/${tomorrow}/`);
  assert.equal(first.ticketUrl, origin + `/ticket_new/${upcoming}/`);
  assert.equal(first.startsAt, '2026-11-15T11:00:00+05:00');
  assert.equal(first.endsAt, '2026-11-15T12:30:00+05:00');
  assert.equal(first.venue, 'Кинотеатр «Арбат»');
  assert.deepEqual([first.ageLimit, first.priceMin, first.priceMax], [6, 125, undefined]);
  assert.ok(first.latitude && first.longitude);
  assert.deepEqual([second.endsAt, second.priceMin], [undefined, undefined]);
  assert.equal(requests.length, 4);
});
