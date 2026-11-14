import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLibrary } from '../src/local-feeds.ts';

test('Sterlitamak library expands published visiting days using the correct branch hours', async () => {
  const schedule = `<table><tr><th>Дата и время проведения</th></tr>
    <tr><td>1.</td><td>Выставка «Крылатые легенды народов мира» 6+</td>
    <td>09-12.11 и 15.11.2026 г. в часы работы библиотеки</td>
    <td>Центральная городская библиотека (ул. Сакко и Ванцетти, 55)</td><td>Бесплатно</td></tr>
    <tr><td>2.</td><td>Экскурсия «ДАРВИН-ЛАБ» 6+ По предварительной записи (Тел.: 30-21-61)</td>
    <td>13-15.11.2026 г. в часы работы библиотеки</td>
    <td>Центральная детская библиотека (пр. Октября, 43)</td><td>Детский – 70 руб. Взрослый – 100 руб.</td></tr>
    <tr><td>3.</td><td>Выставка с точным временем 6+</td><td>14 и 15.11.2026 г. 11.00-16.00 ч.</td>
    <td>Библиотека-филиал №1 (ул. Гоголя, 94)</td><td>Бесплатно</td></tr>
    <tr><td>4.</td><td>Выставка неизвестного филиала 6+</td><td>15.11.2026 г. в часы работы библиотеки</td>
    <td>Библиотека-филиал №999 (ул. Гоголя, 94)</td><td>Бесплатно</td></tr></table>`;
  const hours = `<table><tr><td>ЦЕНТРАЛЬНАЯ ГОРОДСКАЯ БИБЛИОТЕКА</td></tr>
    <tr><td>Отдел работы с читателями</td><td><p>ул. Сакко и Ванцетти, 55</p></td><td></td>
    <td><p>Понедельник-четверг с 10.00 до 19.00 ч.</p><p>воскресенье с 9.00 до 17.00 ч.;</p></td></tr>
    <tr><td>Методико-библиографический отдел</td><td><p>ул. Сакко и Ванцетти, 55</p></td><td></td>
    <td><p>Понедельник-пятница с 09.00 до 18.00 ч.</p></td></tr>
    <tr><td>Центральная детская модельная библиотека</td><td><p>пр. Октября, 43</p></td><td></td>
    <td><p>Вторник-суббота с 09.00 до 18.00 ч. перерыв с 13.00 до 14.00 ч.,</p>
    <p>суббота с 9.00 ч. до 17.00 ч.;</p><p>Выходные - воскресенье, понедельник.</p></td></tr></table>`;
  const requests: string[] = [];
  const result = await collectLibrary(async address => {
    const path = new URL(address).pathname;
    requests.push(path);
    if (path === '/robots.txt') return 'User-agent: *\nAllow: /';
    if (path === '/events/') return schedule;
    assert.equal(path, '/grafik-raboty/');
    return hours;
  }, new Date('2026-11-14T08:00:00+05:00'));
  assert.deepEqual(requests, ['/robots.txt', '/events/', '/grafik-raboty/']);
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.events.map(event => [event.title, event.startsAt, event.endsAt, event.ageLimit, event.priceMin]), [
    ['Выставка «Крылатые легенды народов мира»', '2026-11-15T09:00:00+05:00', '2026-11-15T17:00:00+05:00', 6, 0],
    ['Экскурсия «ДАРВИН-ЛАБ»', '2026-11-14T09:00:00+05:00', undefined, 6, 70],
    ['Выставка с точным временем', '2026-11-14T11:00:00+05:00', '2026-11-14T16:00:00+05:00', 6, 0],
    ['Выставка с точным временем', '2026-11-15T11:00:00+05:00', '2026-11-15T16:00:00+05:00', 6, 0],
  ]);
  assert.match(result.events[1].description ?? '', /По предварительной записи.*30-21-61/u);
});
