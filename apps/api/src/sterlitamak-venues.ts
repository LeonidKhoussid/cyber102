import { load } from 'cheerio';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { category, clean, eventNotice, inUfa, publicPage } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const origin = 'https://sgtko.ru';
const name = 'Стерлитамакское государственное театрально-концертное объединение';
const path = /^\/afisha\/event\/[a-z0-9-]+\/$/;
const ticketPath = /^https:\/\/quicktickets\.ru\/sterlitamak-gtko\/s\d+(?:\?min=1)?$/;

export async function collectSterlitamakVenues(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name, events: [], rejected: 0 };
  const crawler = await openCrawler(origin, read);
  const listing = load(await crawler.page(new URL('/afisha/', origin)));
  const pages = [...new Set(listing('a[href*="/afisha/event/"]').toArray().flatMap(element => {
    const url = publicPage(listing(element).attr('href'), origin, path);
    return url && crawler.allowed(url) ? [url.href] : [];
  }))].slice(0, 24);
  if (!pages.length) throw new Error('Expected venue event links');
  const outcomes = await mapConcurrent(pages, 3, async href => {
    const page = load(await crawler.page(new URL(href)));
    const title = clean(page('.my-title-opacity').first().text());
    const text = clean(page('.my-page-content, .tab-pane').text()) ?? '';
    const ticketUrl = page('a.a_quicktickets').attr('href');
    const schedule = page('.my-single-poster-price').last();
    const dates = [...new Set(schedule.find('.dtstart').toArray().map(item => page(item).attr('title')))];
    // Price and venue are attached to the performance page; skip ambiguous schedules.
    const date = dates.length === 1 ? dates[0] : undefined;
    const startsAt = date && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date) ? inUfa(date.replace(' ', 'T') + ':00+05:00') : undefined;
    if (!title || !startsAt) return;
    const status = eventNotice(title, title, text);
    const validTicket = ticketUrl && ticketPath.test(ticketUrl) ? ticketUrl : undefined;
    if (!validTicket && status === 'published') return;
    if (status === 'published' && Date.parse(startsAt) <= now.getTime()) return;
    const age = /возрастная категория\s*:\s*(\d{1,2})\+/iu.exec(text)?.[1];
    const end = schedule.find('.dtend').first().attr('title');
    const endsAt = end && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(end) ? inUfa(end.replace(' ', 'T') + ':00+05:00') : undefined;
    const prices = schedule.find('.event-ticket').text().match(/\d+(?:[  ]\d{3})*/g)?.map(value => Number(value.replace(/[  ]/g, ''))) ?? [];
    const venueLabels = [...new Set(schedule.parent().find('.event-category a[rel="tag"]').toArray()
      .flatMap(item => clean(page(item).text()) ?? []))];
    const venueLabel = venueLabels.length === 1 ? venueLabels[0] : undefined;
    const details = {
      title, category: /музыкальная программа|концерт/iu.test(title) ? 'concert' : category(title),
      city: 'Стерлитамак', venue: venueLabel ?? name,
      startsAt, endsAt: endsAt && Date.parse(endsAt) > Date.parse(startsAt) ? endsAt : undefined,
      ageLimit: age && Number(age) <= 21 ? Number(age) : undefined,
      priceMin: prices.length ? Math.min(...prices) : undefined,
      priceMax: prices.length > 1 ? Math.max(...prices) : undefined,
      ticketUrl: validTicket, sourceUrl: href, sourceName: name, sourceKey: 'sgtko:' + new URL(href).pathname,
      sourceType: 'scrape', status, verifiedAt: now.toISOString(),
      raw: { title, date, end, age, ticketUrl, prices, venueLabel },
    } as const;
    return details;
  });
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled' && outcome.value) result.events.push(outcome.value);
    else result.rejected++;
  }
  if (outcomes.every(outcome => outcome.status === 'rejected')) result.error = 'All venue detail requests failed';
  return result;
}
