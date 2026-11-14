import { load } from 'cheerio';
import { normalizeText } from './catalog.ts';
import type { SourceEvent } from './catalog.ts';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { clean, eventNotice, inUfa, publicPage, safeUrl } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const origin = 'https://gasorb.ru';
export const gasorbName = 'Государственный академический симфонический оркестр Республики Башкортостан';
const eventPath = /^\/affiche\/[a-z0-9-]+\/$/u;
const cities = ['Уфа', 'Стерлитамак', 'Салават', 'Нефтекамск', 'Октябрьский', 'Туймазы', 'Ишимбай', 'Сибай',
  'Белорецк', 'Бирск', 'Мелеуз', 'Кумертау', 'Белебей', 'Дюртюли'];
const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const weekdays = 'воскресенье понедельник вторник среда четверг пятница суббота'.split(' ');

function readDate(detail: string, listing: string) {
  const match = /^(\p{L}+)\s+(\d{1,2})\s+(\p{L}+)\s+(20\d{2})\s*г\.?\s+([0-2]\d:[0-5]\d)$/iu.exec(detail);
  if (!match) return;
  const [, weekday, day, monthName, year, time] = match;
  const month = months.indexOf(monthName.toLowerCase()) + 1;
  const listingDate = /^(\d{1,2})\s+(\p{L}+)\s+([0-2]\d:[0-5]\d)$/iu.exec(listing);
  if (!month || !listingDate || Number(listingDate[1]) !== Number(day) || listingDate[2].toLowerCase() !== monthName.toLowerCase() || listingDate[3] !== time) return;
  const startsAt = inUfa(`${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}T${time}:00+05:00`);
  if (startsAt && weekdays[new Date(startsAt.slice(0, 10) + 'T00:00:00Z').getUTCDay()] === weekday.toLowerCase()) return startsAt;
}

export async function collectGasorb(read: Read, now: Date): Promise<SourceResult> {
  const crawler = await openCrawler(origin, read);
  const schedule = load(await crawler.page(new URL('/affiche/', origin)));
  const rows = schedule('.b-posters .item').toArray();
  if (!rows.length) throw new Error('Expected state symphony schedule cards');
  const result: SourceResult = { name: gasorbName, events: [], rejected: 0 };
  const cards = new Map<string, { url: URL; title: string; date: string; hall: string }>();
  for (const row of rows) {
    const card = schedule(row);
    const title = clean(card.find('.title a').text());
    const url = publicPage(card.find('.title a').attr('href'), origin, eventPath);
    const date = clean(card.find('.image .date').text());
    const hall = clean(card.find('.image .hall').text());
    if (!title || !url || !date || !hall || !crawler.allowed(url)) { result.rejected++; continue; }
    cards.set(url.href, { url, title, date, hall });
  }
  const settled = await mapConcurrent([...cards.values()].slice(0, 36), 3, async (card): Promise<SourceEvent | undefined> => {
    const page = load(await crawler.page(card.url));
    const title = clean(page('#article-content > h1').text());
    const detail = page('.b-affiche-detail > .content');
    const date = clean(detail.children('.date').text());
    const startsAt = date && readDate(date, card.date);
    const hallBlock = detail.children('.hall');
    const hall = clean(hallBlock.children('a[href="#map"]').text());
    const [city, venue] = hall?.split(/,\s*/, 2) ?? [];
    if (!title || normalizeText(title) !== normalizeText(card.title) || !startsAt || !hall || normalizeText(hall) !== normalizeText(card.hall) ||
        !venue || !cities.includes(city)) return;
    const addressText = clean(hallBlock.clone().children().remove().end().text());
    const address = addressText?.startsWith(city + ',') ? clean(addressText.slice(city.length + 1)) : undefined;
    const age = detail.find('.tags > span').map((_index, tag) => clean(page(tag).text()) ?? '').get()
      .map(tag => /^(0|6|12|16|18)\+$/u.exec(tag)?.[1]).find(value => value !== undefined);
    const notices = detail.children('.text').clone().find('br').replaceWith('\n').end().text();
    const status = eventNotice(title, title, notices);
    if (status === 'published' && Date.parse(startsAt) <= now.getTime()) return;
    const purchaseButton = detail.find('.buy > a.button');
    const ticketLink = purchaseButton.attr('href');
    const ticketUrl = ticketLink && (/^#event\/\d+$/u.test(ticketLink)
      ? new URL(ticketLink, card.url) : safeUrl(ticketLink));
    const freeAdmission = status === 'published' && !ticketUrl && purchaseButton.length === 1 &&
      normalizeText(purchaseButton.text()) === 'вход свободный' &&
      /(?:^|[.!?\n])\s*вход(?: на концерт)? свободный\s*(?=[.!?\n]|$)/iu.test(notices);
    const image = safeUrl(detail.find('.image img[src]').first().attr('src'), origin);
    return {
      title, category: 'concert', city, venue, address, startsAt, ageLimit: age === undefined ? undefined : Number(age),
      priceMin: freeAdmission ? 0 : undefined, priceMax: freeAdmission ? 0 : undefined,
      imageUrl: image?.href, ticketUrl: status === 'published' && ticketUrl ? ticketUrl.href : undefined,
      sourceUrl: card.url.href, sourceName: gasorbName, sourceKey: 'gasorb:' + card.url.pathname, sourceType: 'scrape',
      status, verifiedAt: now.toISOString(), raw: { listing: { title: card.title, date: card.date, hall: card.hall }, date, hall, age },
    };
  });
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled' && outcome.value) result.events.push(outcome.value);
    else {
      result.rejected++;
      if (outcome.status === 'rejected') result.error ??= outcome.reason instanceof Error ? outcome.reason.message : 'Symphony event unavailable';
    }
  }
  return result;
}
