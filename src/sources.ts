import { load } from 'cheerio';
import { setTimeout as delay } from 'node:timers/promises';
import type { SourceEvent } from './catalog.ts';

export type SourceResult = { name: string; events: SourceEvent[]; rejected: number; error?: string };

const culture = 'https://kulturaufa.ru';
const afisha = 'https://afisha-ufa.ru';
const cultureFeed = culture + '/wp-json/wp/v2/posts?categories=34&per_page=20&_fields=id,link,date,modified,title,content';
const cultureName = 'Управление культуры Уфы';
const afishaName = 'Афиша Уфа';
const articlePath = /^\/(?:novosti|afishi|muzei|po-pushkinskoj-karte)\/[a-z0-9-]+\/$/;
const eventPath = /^\/events\/[a-z0-9-]+\/([0-9]+)-[a-z0-9-]+\/$/;
const userAgent = 'UfaCultureCatalog';
const detailLimit = 12;
const ufaOffset = '+05:00';

type RecordValue = Record<string, unknown>;
type Read = (url: string) => Promise<Response>;

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || undefined : undefined;
}

function plainHtml(value: unknown): string {
  if (typeof value !== 'string') return '';
  const html = load(value);
  html('script, style').remove();
  html('br, p, li, h2, h3').append(' ');
  return clean(html.root().text()) ?? '';
}

function safeUrl(value: unknown, origin?: string): URL | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, origin);
    if (url.protocol === 'https:' && !url.username && !url.password && (!origin || url.origin === origin)) return url;
  } catch {
    return;
  }
}

function publicPage(value: unknown, origin: string, path: RegExp): URL | undefined {
  const url = safeUrl(value, origin);
  if (url && !url.search && !url.hash && path.test(url.pathname)) return url;
}

function inUfa(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const date = value.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!date || !Number.isFinite(Date.parse(value))) return;
  if (new Date(date[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== date[1]) return;
  return new Date(Date.parse(value) + 5 * 60 * 60 * 1000).toISOString().replace(/(?:\.000)?Z$/, ufaOffset);
}

function numberBetween(value: unknown, lower: number, upper: number): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return;
  const result = Number(value);
  return result >= lower && result <= upper && Number.isFinite(result) ? result : undefined;
}

function category(value: string): SourceEvent['category'] {
  if (/фестивал|Festival/i.test(value)) return 'festival';
  if (/кино|ScreeningEvent/i.test(value)) return 'cinema';
  if (/экскурси|Tour/i.test(value)) return 'tour';
  if (/театр|спектакл|TheaterEvent/i.test(value)) return 'theatre';
  if (/выставк|музеи|ExhibitionEvent/i.test(value)) return 'exhibition';
  if (/концерт|MusicEvent/i.test(value)) return 'concert';
  return 'other';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reader(fetcher: typeof fetch): Read {
  return async (url) => {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': userAgent },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('HTTP ' + response.status + ' for ' + url);
    }
    return response;
  };
}

const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const municipalDate = new RegExp(String.raw`(?<!\d)(\d{1,2}) (${months.join('|')})(?: (\d{4})(?: года)?)?`, 'gi');
const announcement = new RegExp(municipalDate.source + String.raw`,? в ((?:[01]\d|2[0-3]):[0-5]\d) в ([^.!?;:]+?) (?:состоится|пройд[её]т|отмен[её]н[ао]?)(?= |$|[.!?])`, 'i');

function municipalEvent(value: unknown, now: Date): SourceEvent | undefined {
  const post = record(value);
  const sourceUrl = publicPage(post.link, culture, articlePath);
  const title = plainHtml(record(post.title).rendered);
  const content = plainHtml(record(post.content).rendered);
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
  const startsAt = inUfa(year + '-' + String(month).padStart(2, '0') + '-' + day.padStart(2, '0') + 'T' + time + ':00' + ufaOffset);
  const venue = clean(venueWithAddress.split('(')[0]);
  if (!startsAt || !venue || /\b(?:https?|www)\b|\b\d{2}:\d{2}\b/.test(venue)) return;

  const status = /(?:мероприятие|концерт|спектакль|фестиваль|показ) отмен[её]н[ао]?(?=[.!? ]|$)|отмен[её]н[ао]?$/i.test(title + '. ' + headline[0])
    ? 'cancelled' : 'published';
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
  const posts: unknown = await (await read(cultureFeed)).json();
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
      await (await read(event.sourceUrl)).body?.cancel();
      result.events.push({ ...event, verifiedAt: now.toISOString() });
    } catch {
      result.rejected++;
    }
  }
}

function robotsPolicy(body: string) {
  const groups: { agents: string[]; rules: { expression: RegExp; weight: number; allow: boolean }[]; delay: number }[] = [];
  let group = { agents: [] as string[], rules: [] as (typeof groups)[number]['rules'], delay: 0 };
  let readingRules = false;
  for (const line of body.split(/\r?\n/)) {
    const field = line.split('#', 1)[0].match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!field) continue;
    const [, key, value] = field;
    if (key.toLowerCase() === 'user-agent') {
      if (readingRules || groups.length === 0) {
        group = { agents: [], rules: [], delay: 0 };
        groups.push(group);
        readingRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length > 0) {
      readingRules = true;
      if (key.toLowerCase() === 'crawl-delay') group.delay = Number(value) || 0;
      if (value && /^(?:allow|disallow)$/i.test(key)) {
        const anchored = value.endsWith('$');
        const pattern = (anchored ? value.slice(0, -1) : value).split('*')
          .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        group.rules.push({ expression: new RegExp('^' + pattern + (anchored ? '$' : '')), weight: value.length, allow: /^allow$/i.test(key) });
      }
    }
  }
  const matching = groups.filter((entry) => entry.agents.includes(userAgent.toLowerCase()));
  const applicable = matching.length > 0 ? matching : groups.filter((entry) => entry.agents.includes('*'));
  const rules = applicable.flatMap((entry) => entry.rules).sort((left, right) =>
    right.weight - left.weight || Number(right.allow) - Number(left.allow));
  return {
    delayMs: Math.max(0, ...applicable.map((entry) => entry.delay * 1000)),
    allowed: (url: URL) => rules.find((rule) => rule.expression.test(url.pathname + url.search))?.allow ?? true,
  };
}

function jsonEvents(html: ReturnType<typeof load>): RecordValue[] {
  const events: RecordValue[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = record(value);
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((type) => typeof type === 'string' && /^(?:https?:\/\/schema\.org\/)?[A-Za-z]*Event$/.test(type))) {
      events.push(node);
      return;
    }
    visit(node['@graph']);
    visit(node.itemListElement);
    visit(node.item);
  }
  html('script[type="application/ld+json"]').each((_index, element) => {
    try { visit(JSON.parse(html(element).html() ?? '')); } catch { /* Ignore unrelated malformed JSON-LD scripts. */ }
  });
  return events;
}

function afishaEvent(html: ReturnType<typeof load>, url: URL, now: Date): SourceEvent | undefined {
  const raw = jsonEvents(html).find((event) => publicPage(event.url, afisha, eventPath)?.href === url.href);
  if (!raw) return;
  const title = clean(raw.name);
  const startsAt = inUfa(raw.startDate);
  const location = record(raw.location);
  const address = record(location.address);
  const city = clean(address.addressLocality);
  const venue = clean(location.name);
  const statusName = clean(raw.eventStatus)?.split('/').at(-1);
  if (!title || !startsAt || !city || !/^Уфа$/i.test(city) || !venue) return;
  if (statusName && !['EventCancelled', 'EventScheduled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline'].includes(statusName)) return;
  const status = statusName === 'EventCancelled' ? 'cancelled' :
    statusName === 'EventPostponed' || statusName === 'EventMovedOnline' ? 'draft' : 'published';
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
  const robots = robotsPolicy(await (await read(afisha + '/robots.txt')).text());
  const home = new URL(afisha + '/');
  const schedule = new URL(afisha + '/list/all/');
  if (!robots.allowed(home) && !robots.allowed(schedule)) throw new Error('robots.txt disallows the listing paths');

  let nextRequest = Date.now() + robots.delayMs;
  const page = async (url: URL) => {
    const start = Math.max(Date.now(), nextRequest);
    nextRequest = start + robots.delayMs;
    if (robots.delayMs > 0) await delay(start - Date.now());
    return load(await (await read(url.href)).text());
  };
  const candidates = new Set<string>();
  const invalid = new Set<unknown>();
  function add(value: unknown) {
    const url = publicPage(value, afisha, eventPath);
    if (!url || !robots.allowed(url)) invalid.add(value);
    else candidates.add(url.href);
  }
  const listingErrors: string[] = [];
  for (const listing of [home, schedule]) {
    if (!robots.allowed(listing)) continue;
    try {
      const html = await page(listing);
      jsonEvents(html).forEach((event) => add(event.url));
      html('.uf-event-card .uf-event-title a[href]').each((_index, link) => { add(html(link).attr('href')); });
    } catch (error) {
      listingErrors.push(errorMessage(error));
    }
  }
  result.rejected += invalid.size;
  if (listingErrors.length > 0) result.error = listingErrors.join(' | ');
  const urls = [...candidates].slice(0, detailLimit);
  for (let index = 0; index < urls.length; index += 3) {
    const checked = await Promise.allSettled(urls.slice(index, index + 3).map(async (href) => {
      const url = new URL(href);
      return afishaEvent(await page(url), url, now);
    }));
    for (const outcome of checked) {
      if (outcome.status === 'fulfilled' && outcome.value) result.events.push(outcome.value);
      else result.rejected++;
    }
  }
}

export async function collectSources({ fetcher = fetch, now = new Date() }: {
  fetcher?: typeof fetch; now?: Date;
} = {}): Promise<SourceResult[]> {
  const read = reader(fetcher);
  const sources = [[cultureName, municipal], [afishaName, scrape]] as const;
  return Promise.all(sources.map(async ([name, collect]) => {
    const result: SourceResult = { name, events: [], rejected: 0 };
    try { await collect(read, now, result); } catch (error) { result.error = errorMessage(error); }
    return result;
  }));
}
