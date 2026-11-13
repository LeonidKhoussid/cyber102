import { load } from 'cheerio';
import type { SourceEvent } from './catalog.ts';
import { normalizeText } from './catalog.ts';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { category, clean, eventNotice, inUfa, numberBetween, publicPage, record, structuredData } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const origin = 'https://afishagorodov.ru';
const regions = [['salavat', 'Салават'], ['neftekamsk', 'Нефтекамск'], ['sterlitamak', 'Стерлитамак']] as const;
const sourceName = 'Афиша городов';
const eventPath = /^\/(salavat|neftekamsk|sterlitamak)\/events\/[a-z0-9-]+-([0-9a-f]{24})\/$/;

function parseEvent(body: string, url: URL, city: string, now: Date): SourceEvent | undefined {
  const page = load(body);
  const entries = structuredData(page).filter(entry => publicPage(entry.url, origin, eventPath)?.href === url.href);
  if (entries.length !== 1) return;
  const [raw] = entries;
  const title = clean(raw.name);
  const startsAt = inUfa(raw.startDate);
  const place = record(raw.location);
  const address = record(place.address);
  const venue = clean(place.name);
  if (!title || !startsAt || !venue || normalizeText(clean(address.addressLocality) ?? '') !== normalizeText(city)) return;

  const sourceStatus = clean(raw.eventStatus)?.split('/').at(-1);
  const notice = eventNotice(title, page('h1').first().text(), clean(raw.description) ?? '');
  const status = notice === 'cancelled' || sourceStatus === 'EventCancelled' ? 'cancelled' :
    notice === 'draft' || (sourceStatus !== 'EventScheduled' && sourceStatus !== 'EventRescheduled') ? 'draft' : 'published';
  if (status === 'published' && Date.parse(startsAt) <= now.getTime()) return;
  if (clean(raw.eventAttendanceMode)?.endsWith('/OnlineEventAttendanceMode')) return;

  const endsAt = inUfa(raw.endDate);
  const age = /^(\d{1,2})(?:-|\+)$/u.exec(clean(raw.typicalAgeRange) ?? '');
  const offer = record(raw.offers);
  const priceMin = offer.priceCurrency === 'RUB' ? numberBetween(offer.lowPrice ?? offer.price, 0, Infinity) : undefined;
  const priceMax = offer.priceCurrency === 'RUB' ? numberBetween(offer.highPrice ?? offer.price, 0, Infinity) : undefined;
  const breadcrumbs = structuredData(page, node => node['@type'] === 'BreadcrumbList').flatMap(node =>
    Array.isArray(node.itemListElement) ? node.itemListElement.map(item => clean(record(item).name)) : []);
  const geo = record(place.geo);
  return {
    title, city, venue, category: category([...breadcrumbs.slice(0, -1), raw['@type']].join(' ')), startsAt,
    endsAt: endsAt && Date.parse(endsAt) > Date.parse(startsAt) ? endsAt : undefined,
    address: clean(address.streetAddress),
    latitude: numberBetween(geo.latitude, -90, 90), longitude: numberBetween(geo.longitude, -180, 180),
    ageLimit: age ? numberBetween(age[1], 0, 21) : undefined,
    priceMin, priceMax: priceMax !== undefined && (priceMin === undefined || priceMax >= priceMin) ? priceMax : undefined,
    status, sourceUrl: url.href, sourceName, sourceType: 'scrape', sourceKey: 'afisha-gorodov:' + eventPath.exec(url.pathname)![2],
    raw, verifiedAt: now.toISOString(),
  };
}

export async function collectRegionalEvents(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name: sourceName, events: [], rejected: 0 };
  const crawler = await openCrawler(origin, read);
  const lists = await mapConcurrent(regions, 2, async ([slug, city]) => {
    const page = load(await crawler.page(new URL('/' + slug + '/', origin)));
    const items = structuredData(page, node => node['@type'] === 'ItemList')
      .flatMap(node => Array.isArray(node.itemListElement) ? node.itemListElement : []);
    const candidates = new Set<string>();
    for (const item of items) {
      const url = publicPage(record(item).url, origin, eventPath);
      if (url && url.pathname.startsWith('/' + slug + '/') && crawler.allowed(url)) candidates.add(url.href);
    }
    return [...candidates].slice(0, 10).map(url => ({ url: new URL(url), city }));
  });
  const candidates = lists.flatMap(outcome => outcome.status === 'fulfilled' ? outcome.value : []);
  const failures = lists.filter(outcome => outcome.status === 'rejected').length;
  if (failures) result.error = `${failures} of ${regions.length} city listings unavailable`;
  if (!candidates.length) throw new Error(result.error ?? 'No structured city event links found');

  const pages = await mapConcurrent(candidates, 4, async ({ url, city }) => parseEvent(await crawler.page(url), url, city, now));
  for (const page of pages) {
    if (page.status === 'fulfilled' && page.value) result.events.push(page.value);
    else result.rejected++;
  }
  if (pages.every(page => page.status === 'rejected')) result.error = 'All regional event detail requests failed';
  return result;
}
