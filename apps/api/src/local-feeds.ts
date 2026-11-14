import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { SourceEvent } from './catalog.ts';
import { isLocalDate, normalizeText } from './catalog.ts';
import { openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { localDay } from './filters.ts';
import { category, clean, eventNotice, publicPage, record } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const theater = 'https://teatrnmt.ru';
export const theaterName = 'Национальный молодёжный театр имени Мустая Карима';
const theaterTicketOrigin = 'https://ufa.kassy.ru';
const theaterTicketVenue = '/venue/nacionalnyjj-molodezhnyjj-teatr-im-m-karima-16/';
const library = 'https://lib-str.ru';
const libraryName = 'Централизованная библиотечная система Стерлитамака';
const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const weekdays = 'воскресенье понедельник вторник среда четверг пятница суббота'.split(' ');

function timestamp(date: string, hour: string, minute: string) {
  if (!isLocalDate(date) || Number(hour) > 23 || Number(minute) > 59) return;
  return `${date}T${hour.padStart(2, '0')}:${minute}:00+05:00`;
}

function theaterStart(day: string, weekday: string, time: string, now: Date) {
  const dayMatch = /^(\d{1,2}) ([а-я]+)(?: (\d{4}))?$/iu.exec(day);
  const hour = /^(\d{1,2}):([0-5]\d)$/.exec(time);
  const month = dayMatch && months.indexOf(dayMatch[2].toLowerCase()) + 1;
  if (!dayMatch || !hour || !month) return;
  const current = new Date(now.getTime() + 5 * 3_600_000);
  // The schedule lists future sessions with a weekday. Require both to agree.
  for (const year of dayMatch[3] ? [Number(dayMatch[3])] : [current.getUTCFullYear(), current.getUTCFullYear() + 1]) {
    const date = `${year}-${String(month).padStart(2, '0')}-${dayMatch[1].padStart(2, '0')}`;
    const starts = timestamp(date, hour[1], hour[2]);
    if (!starts || Date.parse(starts) <= now.getTime() || Date.parse(starts) - now.getTime() > 120 * 86_400_000) continue;
    if (weekdays[new Date(date + 'T12:00:00Z').getUTCDay()] === weekday.toLowerCase()) return starts;
  }
}

function ageOf(text: string): number | undefined {
  const match = /(?:^|[^\d])(\d{1,2})\s*\+/u.exec(text);
  if (match && Number(match[1]) <= 21) return Number(match[1]);
}

function durationOf(text: string): number | undefined {
  const match = /продолжительность\s*:\s*(?:(\d{1,2})\s*(?:час(?:а|ов)?|ч\.?)\s*)?(?:(\d{1,3})\s*мин(?:ут[аы]?)?\.?)/iu.exec(text)
    ?? /продолжительность\s*:\s*(\d{1,2})\s*(?:час(?:а|ов)?|ч\.)(?!\p{L})/iu.exec(text);
  const minutes = Number(match?.[1] ?? 0) * 60 + Number(match?.[2] ?? 0);
  return minutes > 0 && minutes <= 600 ? minutes : undefined;
}

type TheaterOffer = { priceMin: number; priceMax: number; ticketUrl: string };

function theaterSessionKey(title: string, startsAt: string) {
  return `${startsAt}:${normalizeText(title)}`;
}

async function youthTheaterOffers(read: Read) {
  const crawler = await openCrawler(theaterTicketOrigin, read);
  const page = load(await crawler.page(new URL(theaterTicketVenue, theaterTicketOrigin)));
  const offers = new Map<string, TheaterOffer | undefined>();
  if (!/\b450008\b.*уфа.*ленина\s+62(?= |$)/u.test(normalizeText(page('.dl-data').first().text()))) return offers;
  for (const node of page('ul.events > li').toArray()) {
    const item = page(node);
    const titleLink = item.find('h2 a.event_link');
    const title = clean(titleLink.text());
    const ticketUrl = titleLink.length === 1 && publicPage(titleLink.attr('href'), theaterTicketOrigin, /^\/events\/teatr\/\d+-\d+\/$/);
    const venue = item.find('p.venue');
    if (!title || !ticketUrl || !crawler.allowed(ticketUrl) || venue.length !== 1 ||
        venue.find('a').first().attr('href') !== theaterTicketVenue) continue;
    const date = /(\d{1,2})\s+([а-я]+)\s+(\d{4})\s+(\d{1,2}):([0-5]\d)(?:\s|$)/iu.exec(clean(venue.text()) ?? '');
    if (!date) continue;
    const monthsIndex = months.indexOf(date[2].toLowerCase());
    if (monthsIndex < 0) continue;
    const startsAt = timestamp(`${date[3]}-${String(monthsIndex + 1).padStart(2, '0')}-${date[1].padStart(2, '0')}`, date[4], date[5]);
    // The seller may include restrictions and discounts elsewhere in the card. Read only the published range.
    const priceLine = item.find('.price_line > p').clone();
    priceLine.find('i[aria-hidden="true"]').remove();
    const price = /^Билеты в наличии:\s*(\d+(?: \d{3})*)(?:\s*[-–—]\s*(\d+(?: \d{3})*))?$/iu
      .exec(clean(priceLine.text()) ?? '');
    if (!startsAt || !price) continue;
    const priceMin = Number(price[1].replaceAll(' ', ''));
    const priceMax = Number((price[2] ?? price[1]).replaceAll(' ', ''));
    if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax) || priceMin <= 0 || priceMax < priceMin) continue;
    const key = theaterSessionKey(title, startsAt);
    offers.set(key, offers.has(key) ? undefined : { priceMin, priceMax, ticketUrl: ticketUrl.href });
  }
  return offers;
}

export async function collectYouthTheater(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name: theaterName, events: [], rejected: 0 };
  const crawler = await openCrawler(theater, read);
  const page = load(await crawler.page(new URL('/afisha/', theater)));
  const cards = page('.jet-listing-grid__item[data-post-id]').toArray();
  if (!cards.length) throw new Error('Expected dated theater schedule cards');
  const sessions = cards.flatMap(card => {
    const element = page(card);
    const id = element.attr('data-post-id');
    const link = publicPage(element.find('a[href*="/new-spectacle/"]').first().attr('href'), theater, /^\/new-spectacle\/[a-z0-9%-]+\/$/i);
    const fields = element.find('.jet-listing-dynamic-field__content').toArray().map(field => clean(page(field).text()) ?? '');
    const [day, weekday, time] = fields;
    const startsAt = day && weekday && time ? theaterStart(day, weekday, time, now) : undefined;
    if (!id || !/^\d+$/.test(id) || !link || !crawler.allowed(link) || !startsAt) return [];
    return [{ id, link, startsAt, fields, title: clean(element.find('h1,h2,h3,h4').first().text()) }];
  });
  const byId = new Map<string, Record<string, unknown>>();
  const ids = [...new Set(sessions.map(session => session.id))];
  const offersRequest = ids.length ? youthTheaterOffers(read).catch(() => undefined) : undefined;
  for (let index = 0; index < ids.length; index += 60) {
    const batch = ids.slice(index, index + 60);
    const api = new URL('/wp-json/wp/v2/new-spectacle', theater);
    api.searchParams.set('include', batch.join(','));
    api.searchParams.set('per_page', String(batch.length));
    api.searchParams.set('_fields', 'id,link,title,content');
    try {
      const posts: unknown = JSON.parse(await crawler.page(api));
      if (!Array.isArray(posts)) throw new Error('Expected theater API array');
      for (const post of posts) byId.set(String(record(post).id), record(post));
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Theater API unavailable';
      break;
    }
  }
  const datesById = new Map<string, Set<string>>();
  for (const session of sessions) {
    const dates = datesById.get(session.id) ?? new Set<string>();
    dates.add(session.startsAt);
    datesById.set(session.id, dates);
  }
  const offers = await offersRequest;
  const emitted = new Set<string>();
  for (const session of sessions) {
    const post = byId.get(session.id);
    const title = clean(load(String(record(post?.title).rendered ?? '')).text());
    if (!post || !title || datesById.get(session.id)?.size !== 1 || post.link !== session.link.href ||
        (session.title && normalizeText(session.title) !== normalizeText(title))) {
      result.rejected++;
      continue;
    }
    const content = load(String(record(post.content).rendered ?? ''));
    const lines = content('p').map((_index, paragraph) => clean(content(paragraph).text()) ?? '').get();
    const ageLine = lines.find(line => /возрастное ограничение/i.test(line));
    const synopsis = lines.find(line => line.length >= 70 && !/возрастное ограничение|продолжительность|стоимость|купить билет/iu.test(line));
    const status = eventNotice(title, ...session.fields, ...lines);
    const duration = durationOf(session.fields.join(' ')) ?? durationOf(lines.join(' '));
    const offer = status === 'published' ? offers?.get(theaterSessionKey(title, session.startsAt)) : undefined;
    const key = session.id + ':' + session.startsAt;
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.events.push({
      title, category: 'theatre', city: 'Уфа', venue: theaterName, address: 'ул. Ленина, 62',
      description: synopsis?.slice(0, 500),
      startsAt: session.startsAt, endsAt: duration ? new Date(Date.parse(session.startsAt) + duration * 60_000).toISOString() : undefined,
      ageLimit: ageLine ? ageOf(ageLine) : undefined,
      ...offer,
      sourceUrl: session.link.href, sourceName: theaterName, sourceType: 'api', sourceKey: 'youth-theater:' + session.id,
      status, verifiedAt: now.toISOString(), raw: { post, schedule: session.fields, offer },
    });
  }
  return result;
}

// One announced time can apply to a day, a list of days, or a range of days.
function* libraryDays(days: string, month: string, year: string): Generator<string> {
  for (const segment of days.split(/\s*(?:и|,)\s*/u)) {
    const [first, last] = segment.split(/\s*[-–—]\s*/u);
    const toDate = (value: string) => {
      const [day, specifiedMonth = month] = value.split('.');
      return `${year}-${specifiedMonth}-${day}`;
    };
    const end = toDate(last ?? first);
    const start = toDate(first);
    if (!isLocalDate(start) || !isLocalDate(end) || start > end || localDay(start, 31) < end) continue;
    for (let date = start; date <= end; date = localDay(date, 1)) yield date;
  }
}

type Opening = { day: number; untilDay: number; start: string; end: string; breakStart?: string; breakEnd?: string };

function libraryHours(html: string) {
  const page = load(html);
  return page('table tr').toArray().flatMap(row => {
    const cells = page(row).children('td');
    if (cells.length !== 4) return [];
    const branch = /библиотека[\s-]*филиал\s*№\s*(\d+)/iu.exec(cells.eq(0).text())?.[1];
    const label = clean(cells.eq(0).text()) ?? '';
    const venue = branch ? '№' + branch : /^отдел работы с читателями$/iu.test(label) ? 'городская'
      : /^центральная детская/u.test(normalizeText(label)) ? 'детская' : undefined;
    const address = clean(cells.eq(1).find('p').first().text() || cells.eq(1).text());
    if (!venue || !address) return [];
    const text = (clean(cells.eq(3).text()) ?? '').toLowerCase();
    const dayNames = weekdays.join('|');
    const clock = '(\\d{1,2}[:.][0-5]\\d)';
    const hours = new RegExp(`(${dayNames})(?:\\s*[-–—]\\s*(${dayNames}))?\\s+с\\s+${clock}(?:\\s*ч\\.)?\\s+до\\s+${clock}(?:\\s*ч\\.)?(?:\\s+перерыв\\s+с\\s+${clock}\\s+до\\s+${clock})?`, 'gu');
    const openings: Opening[] = [...text.matchAll(hours)].map(([, first, last, start, end, breakStart, breakEnd]) => ({
      day: weekdays.indexOf(first), untilDay: weekdays.indexOf(last ?? first), start, end, breakStart, breakEnd,
    }));
    return [{ venue, address: normalizeText(address), openings }];
  });
}

export async function collectLibrary(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name: libraryName, events: [], rejected: 0 };
  const url = new URL('/events/', library);
  const crawler = await openCrawler(library, read);
  const page = load(await crawler.page(url));
  const tables = page('table').filter((_index, table) => /Дата и время проведения/i.test(page(table).find('tr').first().text()));
  if (!tables.length) throw new Error('Expected a dated library schedule');
  const hoursPage = new URL('/grafik-raboty/', library);
  let hours: ReturnType<typeof libraryHours> | undefined;
  const announced = /(\d{2}(?:\.\d{2})?(?:\s*(?:[-–—]|и|,)\s*\d{2}(?:\.\d{2})?)*?)\.(\d{2})\.(\d{4})\s*г\.?\s+(?:(\d{1,2}[.:][0-5]\d)(?:\s*[-–—]\s*(\d{1,2}[.:][0-5]\d))?|(?=(в часы работы библиотеки)))/giu;
  for (const row of tables.find('tr').toArray()) {
    const fields = page(row).children('td').map((_index, cell) => clean(page(cell).text()) ?? '').get();
    if (fields.length !== 5 || !/^\d+\.$/.test(fields[0])) continue;
    const [, label, schedule, place, cost] = fields;
    if (/трансляция|онлайн/i.test(label) || /https?:/i.test(place)) continue;
    const ageLimit = ageOf(label);
    const title = clean(label.replace(/(?:\s+Участвует в программе|\s+По предварительной записи|\s+\d{1,2}\s*\+).*$/iu, ''));
    const location = /^(.+?)(?:\s+\(([^()]+)\))?$/.exec(place);
    if (!title || !location) { result.rejected++; continue; }
    const [, venue, address] = location;
    const type = category(title);
    const appointment = /по предварительной записи(?:\s*\([^)]*\))?/iu.exec(label)?.[0];
    const prices = [...cost.matchAll(/(\d[\d ]*)\s*руб/giu)].map(match => Number(match[1].replaceAll(' ', '')));
    const free = /^бесплатно\.?$/iu.test(cost);
    const times = [...schedule.matchAll(announced)];
    if (!times.length) { result.rejected++; continue; }
    for (const [, days, month, year, start, end, duringHours] of times) {
      let branch: ReturnType<typeof libraryHours>[number] | undefined;
      if (duringHours) {
        if (!address || (!appointment && type !== 'exhibition')) { result.rejected++; continue; }
        if (!hours) {
          try {
            hours = libraryHours(await crawler.page(hoursPage));
            if (!hours.length) throw new Error('Expected official library opening hours');
          } catch (error) {
            hours = [];
            result.error = error instanceof Error ? error.message : 'Library opening hours unavailable';
          }
        }
        const branchId = /№\s*(\d+)/u.exec(venue)?.[1];
        const name = normalizeText(venue);
        const libraryId = branchId ? '№' + branchId : name === 'центральная городская библиотека' ? 'городская'
          : name === 'центральная детская библиотека' ? 'детская' : undefined;
        branch = hours.find(item => item.venue === libraryId && item.address === normalizeText(address));
        if (!branch) { result.rejected++; continue; }
      }
      for (const date of new Set(libraryDays(days, month, year))) {
        const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
        const opening = branch?.openings.find(item => item.day === weekday && item.untilDay === weekday)
          ?? branch?.openings.find(item => weekday >= item.day && weekday <= item.untilDay);
        if (duringHours && !opening) continue;
        const windows = opening?.breakStart && opening.breakEnd && !appointment
          ? [[opening.start, opening.breakStart], [opening.breakEnd, opening.end]]
          : [[opening?.start ?? start, appointment && duringHours ? undefined : opening?.end ?? end]];
        for (const [windowStart, windowEnd] of windows) {
          const at = (clock: string | undefined) => {
            if (!clock) return;
            const [hour, minute] = clock.split(/[.:]/u);
            return timestamp(date, hour, minute);
          };
          const startsAt = at(windowStart);
          const endsAt = at(windowEnd);
          if (!startsAt || Date.parse(endsAt ?? startsAt) <= now.getTime() || (endsAt && endsAt <= startsAt)) continue;
          const key = createHash('sha256').update(JSON.stringify([normalizeText(title), normalizeText(venue), startsAt])).digest('hex');
          const description = opening && appointment
            ? `${appointment}. Время визита уточняйте у библиотеки. Часы работы: ${opening.start}–${opening.end}.`
            : appointment || (opening ? 'Вход в часы работы библиотеки.' : undefined);
          result.events.push({
            title, category: type, city: 'Стерлитамак', venue, address, description,
            startsAt, endsAt, ageLimit,
            priceMin: free ? 0 : prices.length ? Math.min(...prices) : undefined,
            priceMax: free ? 0 : prices.length ? Math.max(...prices) : undefined,
            sourceUrl: url.href, sourceName: libraryName, sourceType: 'scrape', sourceKey: 'sterlitamak-library:' + key,
            status: eventNotice(title, label, schedule), verifiedAt: now.toISOString(), raw: fields,
          });
        }
      }
    }
  }
  return result;
}
