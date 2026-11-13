import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { SourceEvent } from './catalog.ts';
import { isLocalDate, normalizeText } from './catalog.ts';
import { openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { category, clean, eventNotice, publicPage, record } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const theater = 'https://teatrnmt.ru';
const theaterName = 'Национальный молодёжный театр имени Мустая Карима';
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
    const status = eventNotice(title, ...session.fields, ...lines);
    const duration = durationOf(session.fields.join(' ')) ?? durationOf(lines.join(' '));
    const key = session.id + ':' + session.startsAt;
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.events.push({
      title, category: 'theatre', city: 'Уфа', venue: theaterName, address: 'ул. Ленина, 62',
      startsAt: session.startsAt, endsAt: duration ? new Date(Date.parse(session.startsAt) + duration * 60_000).toISOString() : undefined,
      ageLimit: ageLine ? ageOf(ageLine) : undefined,
      sourceUrl: session.link.href, sourceName: theaterName, sourceType: 'api', sourceKey: 'youth-theater:' + session.id,
      status, verifiedAt: now.toISOString(), raw: { post, schedule: session.fields },
    });
  }
  return result;
}

export async function collectLibrary(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name: libraryName, events: [], rejected: 0 };
  const url = new URL('/events/', library);
  const crawler = await openCrawler(library, read);
  const page = load(await crawler.page(url));
  const tables = page('table').filter((_index, table) => /Дата и время проведения/i.test(page(table).find('tr').first().text()));
  if (!tables.length) throw new Error('Expected a dated library schedule');
  for (const row of tables.find('tr').toArray()) {
    const fields = page(row).children('td').map((_index, cell) => clean(page(cell).text()) ?? '').get();
    if (fields.length !== 5 || !/^\d+\.$/.test(fields[0])) continue;
    const [, label, schedule, place, cost] = fields;
    if (/трансляция|онлайн/i.test(label) || /https?:/i.test(place)) continue;
    const ageLimit = ageOf(label);
    const title = clean(label.replace(/(?:\s+Участвует в программе|\s+По предварительной записи|\s+\d{1,2}\s*\+).*$/iu, ''));
    const location = /^(.+?)(?:\s+\(([^()]+)\))?$/.exec(place);
    if (!title || !location) { result.rejected++; continue; }
    const prices = [...cost.matchAll(/(\d[\d ]*)\s*руб/giu)].map(match => Number(match[1].replaceAll(' ', '')));
    const free = /^бесплатно\.?$/iu.test(cost);
    const times = [...schedule.matchAll(/(?<![\d–—-])(\d{2})\.(\d{2})\.(\d{4})\s*г\.?\s+(\d{1,2})[.:]([0-5]\d)(?:\s*[-–—]\s*(\d{1,2})[.:]([0-5]\d))?/giu)];
    if (!times.length) { result.rejected++; continue; }
    for (const [, day, month, year, hour, minute, endHour, endMinute] of times) {
      const date = `${year}-${month}-${day}`;
      const startsAt = timestamp(date, hour, minute);
      if (!startsAt || Date.parse(startsAt) <= now.getTime()) continue;
      const endsAt = endHour ? timestamp(date, endHour, endMinute) : undefined;
      const venue = location[1].trim();
      const key = createHash('sha256').update(JSON.stringify([normalizeText(title), normalizeText(venue), startsAt])).digest('hex');
      result.events.push({
        title, category: category(title), city: 'Стерлитамак', venue, address: location[2],
        startsAt, endsAt: endsAt && Date.parse(endsAt) > Date.parse(startsAt) ? endsAt : undefined, ageLimit,
        priceMin: free ? 0 : prices.length ? Math.min(...prices) : undefined,
        priceMax: free ? 0 : prices.length ? Math.max(...prices) : undefined,
        sourceUrl: url.href, sourceName: libraryName, sourceType: 'scrape', sourceKey: 'sterlitamak-library:' + key,
        status: eventNotice(title, label, schedule), verifiedAt: now.toISOString(), raw: fields,
      });
    }
  }
  return result;
}
