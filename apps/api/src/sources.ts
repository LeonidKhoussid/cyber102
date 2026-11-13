import { load } from 'cheerio';
import { mapConcurrent, openCrawler, sourceReader } from './crawl.ts';
import type { Read } from './crawl.ts';
import type { SourceEvent } from './catalog.ts';

import {
  category, clean, eventNotice, inUfa, numberBetween, plainHtml, publicPage, record, safeUrl, structuredData,
} from './source-data.ts';
import type { RecordValue, SourceResult } from './source-data.ts';

const culture = 'https://kulturaufa.ru';
const afisha = 'https://afisha-ufa.ru';
const cultureFeed = culture + '/wp-json/wp/v2/posts?categories=34&per_page=20&_fields=id,link,date,modified,title,content';
const cultureName = 'Управление культуры Уфы';
const afishaName = 'Афиша Уфа';
const articlePath = /^\/(?:novosti|afishi|muzei|po-pushkinskoj-karte)\/[a-z0-9-]+\/$/;
const eventPath = /^\/events\/[a-z0-9-]+\/([0-9]+)-[a-z0-9-]+\/$/;
const detailLimit = 12;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const municipalDate = new RegExp(String.raw`(?<!\d)(\d{1,2}) (${months.join('|')})(?: (\d{4})(?: года)?)?`, 'gi');
const announcement = new RegExp(municipalDate.source + String.raw`,? в ((?:[01]\d|2[0-3]):[0-5]\d) в ([^.!?;:]+?) (?:состоится|пройд[её]т|отмен[её]н[ао]?)(?= |$|[.!?])`, 'i');

function municipalEvent(value: unknown, now: Date): SourceEvent | undefined {
  const post = record(value);
  return municipalArticle(post, plainHtml(record(post.title).rendered), plainHtml(record(post.content).rendered), now);
}

function municipalArticle(post: RecordValue, title: string, content: string, now: Date): SourceEvent | undefined {
  const sourceUrl = publicPage(post.link, culture, articlePath);
  const headline = content.match(announcement);
  if (!sourceUrl || !Number.isSafeInteger(post.id) || !title || !headline ||
      [...content.matchAll(municipalDate)].length !== 1 || (content.match(/\d{1,2}:\d{2}/g)?.length ?? 0) !== 1 ||
      /расписание|афиша мероприятий|программа мероприятий|гастрольный тур/i.test(title) ||
      !/(?:^|[.!?] )$/.test(content.slice(0, headline.index))) return;

  const [, day, monthName, explicitYear, time, venueWithAddress] = headline;
  const month = months.indexOf(monthName.toLowerCase()) + 1;
  const publication = clean(post.date)?.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  const year = explicitYear ?? (publication && Number(publication[2]) === month &&
    Number(day) >= Number(publication[3]) ? publication[1] : undefined);
  if (!year) return;
  const startsAt = inUfa(year + '-' + String(month).padStart(2, '0') + '-' + day.padStart(2, '0') + 'T' + time + ':00+05:00');
  const venue = clean(venueWithAddress.split('(')[0]);
  if (!startsAt || !venue || /\b(?:https?|www)\b|\b\d{2}:\d{2}\b/.test(venue)) return;

  const status = strongestStatus(eventNotice(title, title, content),
    /отмен[её]н[ао]?$/i.test(headline[0]) ? 'cancelled' : 'published');
  if (status === 'published' && Date.parse(startsAt) <= now.getTime()) return;
  const free = /вход (?:для всех желающих )?(?:свободный|бесплатный)(?=[.!? ]|$)/i.test(content);
  return {
    title, category: category(title), startsAt, city: 'Уфа', venue,
    priceMin: free ? 0 : undefined, priceMax: free ? 0 : undefined,
    sourceUrl: sourceUrl.href, sourceName: cultureName, sourceType: 'api',
    sourceKey: String(post.id), status, raw: post,
  };
}

async function municipal(read: Read, now: Date, result: SourceResult) {
  const posts: unknown = JSON.parse(await read(cultureFeed));
  if (!Array.isArray(posts)) throw new Error('Expected a WordPress posts array');
  const seen = new Set<string>();
  for (const post of posts.slice(0, 20)) {
    const event = municipalEvent(post, now);
    if (!event) {
      result.rejected++;
      continue;
    }
    if (seen.has(event.sourceUrl)) continue;
    seen.add(event.sourceUrl);
    try {
      const html = load(await read(event.sourceUrl));
      const article = html('.my-single .my-page-content');
      const title = clean(article.children('h1').text());
      const body = article.children('.mt-2').html();
      const apiUrl = html('link[rel="alternate"][type="application/json"]').attr('href');
      if (article.length !== 1 || title !== event.title || !body ||
          (apiUrl && apiUrl !== culture + '/wp-json/wp/v2/posts/' + event.sourceKey)) {
        result.rejected++;
        continue;
      }
      const current = municipalArticle(record(post), title, plainHtml(body), now);
      if (!current || current.startsAt !== event.startsAt || current.venue !== event.venue) {
        result.rejected++;
        continue;
      }
      result.events.push({
        ...current,
        status: strongestStatus(event.status, current.status),
        verifiedAt: now.toISOString(),
      });
    } catch {
      result.rejected++;
    }
  }
}

function strongestStatus(...statuses: SourceEvent['status'][]): SourceEvent['status'] {
  if (statuses.includes('cancelled')) return 'cancelled';
  return statuses.includes('draft') ? 'draft' : 'published';
}

function afishaEvent(html: ReturnType<typeof load>, url: URL, now: Date): SourceEvent | undefined {
  const entries = structuredData(html)
    .filter((event) => publicPage(event.url, afisha, eventPath)?.href === url.href)
    .map((raw) => ({
      raw,
      startsAt: inUfa(raw.startDate),
      statusName: clean(raw.eventStatus)?.split('/').at(-1),
    }));
  if (entries.length === 0) return;
  const cancelled = entries.filter((entry) => entry.statusName === 'EventCancelled');
  const deferred = entries.filter((entry) => ['EventPostponed', 'EventMovedOnline'].includes(entry.statusName ?? ''));
  const rescheduled = entries.filter((entry) => entry.statusName === 'EventRescheduled' && entry.startsAt);
  const uniqueReschedule = rescheduled.length > 0 && new Set(rescheduled.map((entry) => entry.startsAt)).size === 1;
  const conflictingDates = new Set(entries.map((entry) => entry.startsAt)).size > 1;
  const selected = (cancelled.length > 0 ? cancelled : deferred.length > 0 ? deferred : uniqueReschedule ? rescheduled : entries)
    .find((entry) => entry.startsAt) ?? entries.find((entry) => entry.startsAt);
  if (!selected) return;
  const { raw, startsAt } = selected;
  const title = clean(raw.name);
  const location = record(raw.location);
  const address = record(location.address);
  const city = clean(address.addressLocality);
  const venue = clean(location.name);
  if (!title || !startsAt || !city || !/^Уфа$/i.test(city) || !venue) return;

  const notice = eventNotice(title, html('.uf-event-detail-title').text(),
    plainHtml(html('.uf-event-description').html()), clean(raw.description) ?? '');
  const unknownStatus = entries.some(({ statusName }) => statusName &&
    !['EventCancelled', 'EventScheduled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline'].includes(statusName));
  const status = strongestStatus(notice, cancelled.length > 0 ? 'cancelled' :
    deferred.length > 0 || unknownStatus || (conflictingDates && !uniqueReschedule) ? 'draft' : 'published');
  if (status === 'published' && Date.parse(startsAt) <= now.getTime()) return;

  const endsAt = inUfa(raw.endDate);
  const offer = record(raw.offers);
  const pricesInRubles = offer.priceCurrency === 'RUB';
  const explicitlyFree = raw.isAccessibleForFree === true;
  const age = clean(html('.uf-event-detail-age').first().text())?.match(/^(\d{1,2})\+$/);
  return {
    title, startsAt, endsAt: endsAt && Date.parse(endsAt) >= Date.parse(startsAt) ? endsAt : undefined,
    category: category(html('.uf-event-category-badge').first().text() + ' ' + String(raw['@type'])),
    city: 'Уфа', venue, address: clean(address.streetAddress),
    ageLimit: age ? numberBetween(age[1], 0, 21) : undefined,
    priceMin: explicitlyFree ? 0 : pricesInRubles ? numberBetween(offer.lowPrice ?? offer.price, 0, Infinity) : undefined,
    priceMax: explicitlyFree ? 0 : pricesInRubles ? numberBetween(offer.highPrice ?? offer.price, 0, Infinity) : undefined,
    latitude: numberBetween(record(location.geo).latitude, -90, 90),
    longitude: numberBetween(record(location.geo).longitude, -180, 180),
    language: clean(raw.inLanguage),
    ticketUrl: safeUrl(offer.url)?.href,
    sourceUrl: url.href, sourceName: afishaName, sourceType: 'scrape',
    sourceKey: eventPath.exec(url.pathname)![1], status, raw, verifiedAt: now.toISOString(),
  };
}

async function scrape(read: Read, now: Date, result: SourceResult) {
  const crawler = await openCrawler(afisha, read);
  const home = new URL(afisha + '/');
  const schedule = new URL(afisha + '/list/all/');
  if (!crawler.allowed(home) && !crawler.allowed(schedule)) throw new Error('robots.txt disallows the listing paths');
  const candidates = new Set<string>();
  const invalid = new Set<unknown>();
  function add(value: unknown) {
    const url = publicPage(value, afisha, eventPath);
    if (!url || !crawler.allowed(url)) invalid.add(value);
    else candidates.add(url.href);
  }

  const listingErrors: string[] = [];
  async function discover(listing: URL) {
    if (!crawler.allowed(listing)) return;
    try {
      const html = load(await crawler.page(listing));
      const local = new Date(now.getTime() + 5 * 3_600_000);
      for (const item of structuredData(html)) {
        const startsAt = inUfa(item.startDate);
        if (startsAt && Date.parse(startsAt) <= now.getTime() &&
            clean(item.eventStatus)?.endsWith('/EventScheduled')) continue;
        add(item.url);
      }
      html('.uf-event-card .uf-event-title a[href]').each((_index, link) => {
        const date = html(link).closest('.uf-event-card').find('.uf-event-date').first().text().trim();
        const shown = /^(\d{1,2}) ([а-я]+), [а-я]+, (\d{2}):(\d{2})/iu.exec(date);
        if (shown && Number(shown[1]) === local.getUTCDate() && months.indexOf(shown[2]) === local.getUTCMonth() &&
            Number(shown[3]) * 60 + Number(shown[4]) <= local.getUTCHours() * 60 + local.getUTCMinutes()) return;
        add(html(link).attr('href'));
      });
    } catch (error) {
      listingErrors.push(errorMessage(error));
    }
  }
  await discover(home);
  if (candidates.size < detailLimit) await discover(schedule);
  result.rejected += invalid.size;
  if (listingErrors.length) result.error = listingErrors.join(' | ');
  const urls = [...candidates].slice(0, detailLimit);
  const checked = await mapConcurrent(urls, 3, async href => {
    const url = new URL(href);
    return afishaEvent(load(await crawler.page(url)), url, now);
  });
  for (const outcome of checked) {
    if (outcome.status === 'fulfilled' && outcome.value) result.events.push(outcome.value);
    else result.rejected++;
  }
  if (urls.length && checked.every(outcome => outcome.status === 'rejected')) {
    result.error ??= 'All event detail requests failed';
  }

}

export async function collectSources({ fetcher = fetch, now = new Date(), onSource }: {
  fetcher?: typeof fetch; now?: Date; onSource?: (result: SourceResult, durationMs: number) => void;
} = {}): Promise<SourceResult[]> {
  const read = sourceReader(fetcher);
  const sources = [[cultureName, municipal], [afishaName, scrape]] as const;
  return Promise.all(sources.map(async ([name, collect]) => {
    const started = performance.now();
    const result: SourceResult = { name, events: [], rejected: 0 };
    try { await collect(read, now, result); } catch (error) { result.error = errorMessage(error); }
    onSource?.(result, Math.round(performance.now() - started));
    return result;
  }));
}
