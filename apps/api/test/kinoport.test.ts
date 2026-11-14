import assert from 'node:assert/strict';
import test from 'node:test';
import { collectKinoport } from '../src/kinoport.ts';

const today = '14.11.2026';
const tomorrow = '15.11.2026';
const film = 'cm9qvxeiwg2k90829fewwuhuf';
const city = 'cjtd73pnveqz707660usjs5u8';
const theatre = '3644eef5-bcc2-4e07-8a15-32dcd2e07834';
const origin = 'https://kino-str.ru';

function session(id: number, date: string, time: string, passed = false) {
  return `<div class="schedule__session-time${passed ? ' session-picker__item_passed' : ''}" data-film-date="${date}"
    data-theatre-id="${theatre}" data-film-id="${film}" data-session-id="${id}"><div class="session-picker__item-time">
    <div class="value">${time}</div></div><div class="session-picker__item-price">от 350 Р</div></div>`;
}

function schedule(date: string, sessions: string) {
  return `<div class="page__title">Расписание сеансов</div><form id="filter-form">
      <input name="date" value="${date}"></form><div class="schedule__list"><div class="schedule__item">
      <a href="/schedule/${film}?date=${date}&amp;cityId=${city}" class="film-mini__title">Приключения пингвиненка</a>
      <div class="film-mini__genre">Семейный</div><div class="film__label">6+</div>
      <div class="schedule__theatre"><div class="schedule__theatre-info">
        <a href="/theatre/kinoport/schedule">Кинопорт</a>
        <div class="schedule__theatre-city">г. Стерлитамак, ул. Худайбердина 120, ТЦ Фабри, 4 этаж</div>
      </div>${sessions}</div></div></div><script>$('#w3').datetimepicker({"enabledDates":["2026-11-14","2026-11-15"]});</script>`;
}

test('reads official schedules using only the publisher locale cookies and preserves unknown finish', async () => {
  const requests: string[] = [];
  const result = await collectKinoport(async (address, options) => {
    const url = new URL(String(address));
    const cookies = new Headers(options?.headers).get('Cookie');
    assert.equal(url.origin, origin);
    requests.push(url.pathname + url.search);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /order/');
    if (url.search === '?date=' + today && !cookies) {
      const headers = new Headers({ location: url.href });
      headers.append('Set-Cookie', 'installed_city=city-value; Path=/');
      headers.append('Set-Cookie', 'stop_geo=stop-value; Path=/');
      headers.append('Set-Cookie', '_csrf=csrf-value; Path=/');
      return new Response(null, { status: 302, headers });
    }
    assert.equal(cookies, 'installed_city=city-value; stop_geo=stop-value');
    const data = url.search === '?date=' + today
      ? schedule(today, session(1, today, '17:00') + session(2, today, '19:00', true))
      : schedule(tomorrow, session(3, tomorrow, '12:30') + session(4, today, '14:00'));
    return new Response(data);
  }, new Date('2026-11-14T18:35:00+05:00'));
  assert.equal(result.error, undefined);
  assert.equal(result.events.length, 1);
  const [screening] = result.events;
  assert.equal(screening.sourceKey, 'kinoport:3');
  assert.equal(screening.startsAt, '2026-11-15T12:30:00+05:00');
  assert.deepEqual([screening.ageLimit, screening.priceMin, screening.priceMax], [6, 350, undefined]);
  assert.equal(screening.endsAt, undefined);
  assert.equal(screening.sourceUrl, origin + '/schedule?date=' + tomorrow);
  assert.equal(screening.ticketUrl, origin + '/schedule/' + film + '?date=' + tomorrow + '&cityId=' + city);
  assert.equal(requests.length, 4);
});
