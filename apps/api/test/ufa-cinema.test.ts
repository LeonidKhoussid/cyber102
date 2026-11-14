import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectUfaCinema } from '../src/ufa-cinema.ts';

const today = '2026-11-14';
const tomorrow = '2026-11-15';
const now = new Date(today + 'T12:00:00+05:00');

test('imports official Ufa showtimes for the confirmed venue and date without inferring end times', async () => {
  const result = await collectUfaCinema(async address => {
    const url = new URL(address);
    if (url.pathname === '/robots.txt') return 'User-agent: *\nDisallow: /buy/';
    const day = url.searchParams.get('date');
    assert.equal(url.searchParams.size, 1);
    assert.ok(day === today || day === tomorrow);
    const name = url.pathname.endsWith('/semya/') ? 'Синема Парк Семья' : 'Синема Парк Галерея Арт';
    const id = name.endsWith('Семья') ? '1858' : '1859';
    const link = (session: string, date: string, venue: string, time: string) => `
      <a class="buy_seance shedule_session" data-r-id="${venue}" data-r-seance-id="${session}" data-movie-id="196"
         data-id="${session}" href="${url.pathname}?date=${date}&amp;openWidget=${session}">
        <span class="shedule_session_time">${time}</span><span class="shedule_session_price">от 320 р.</span>
      </a>`;
    return `<div class="cinema_card_single">
      <h1>Кинотеатр <span itemprop="name">${name}</span></h1><span itemprop="address">Уфа, ул. Ленина, 2</span>
      <meta itemprop="latitude" content="54.72"><meta itemprop="longitude" content="55.95">
    </div><input id="js_single_cinema_date" value="${day}" data-dates="${today},${tomorrow}">
    <div class="shedule_content">
      <div class="shedule_movie" data-gtm-list-item-filmid="196" data-gtm-list-item-genre="мультфильм">
        <span class="movie_card_header">Кот в шляпе</span><i class="raiting_sub">6+</i><span class="title">1 ч. 45 мин.</span>
        ${link(day === today ? '2' : '3', day, id, '14:30')}
        ${link('4', day, id, '10:00')}
        ${link('5', '2026-11-16', id, '14:30')}
        ${link('6', day, '999', '14:30')}
      </div>
    </div>`;
  }, now);

  assert.equal(result.error, undefined);
  assert.equal(result.events.length, 6);
  const event = result.events.find(item => item.venue === 'Синема Парк Галерея Арт' && item.startsAt === tomorrow + 'T14:30:00+05:00');
  assert.ok(event);
  assert.equal(event.city, 'Уфа');
  assert.equal(event.ageLimit, 6);
  assert.equal(event.priceMin, 320);
  assert.equal(event.priceMax, undefined);
  assert.equal(event.endsAt, undefined);
  assert.equal(event.ticketUrl, 'https://kinoteatr.ru/raspisanie-kinoteatrov/ufa/galereya-art/?date=2026-11-15&openWidget=3');
});

test('does not import fallback dates or crawl pages forbidden by the publisher', async () => {
  await assert.rejects(collectUfaCinema(async address => {
    const url = new URL(address);
    if (url.pathname === '/robots.txt') return 'User-agent: *\nDisallow: /raspisanie-kinoteatrov/ufa/semya/';
    assert.ok(url.pathname.endsWith('/galereya-art/'));
    return '<input id="js_single_cinema_date" value="2026-11-16">';
  }, now), /No Ufa cinema schedules/);
});
