import { load } from 'cheerio';
import { normalizeText } from './catalog.ts';
import type { SourceEvent } from './catalog.ts';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { category, clean, eventNotice, inUfa, publicPage, safeUrl } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const origin = 'https://bashgf.ru';
const name = 'Башкирская государственная филармония имени Хусаина Ахметова';
const eventPath = /^\/afisha\/event\/[a-z0-9-]+\/$/i;
const monthPath = /^\/afisha\/\d{4}\/(?:0[1-9]|1[0-2])\/?$/;
const hallNames = new Map([
  ['/afisha/category/bolshoj-zal/', 'Большой зал'],
  ['/afisha/category/malyj-zal/', 'Малый (органный) зал'],
]);

function timestamp(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return;
  return inUfa(value.replace(' ', 'T') + ':00+05:00');
}

function price(value: string | undefined): { priceMin?: number; priceMax?: number } {
  const match = /^Цена:\s*(\d[\d ]*?)(?:\s*[-–—]\s*(\d[\d ]*?)?)?\s*₽$/u.exec(value ?? '');
  if (!match) return {};
  const priceMin = Number(match[1].replaceAll(' ', ''));
  const priceMax = match[2] ? Number(match[2].replaceAll(' ', '')) : /[-–—]/u.test(value ?? '') ? undefined : priceMin;
  if (!Number.isSafeInteger(priceMin) || priceMin < 1 ||
      (priceMax !== undefined && (!Number.isSafeInteger(priceMax) || priceMax < priceMin))) return {};
  return { priceMin, priceMax };
}

function parsePage(page: ReturnType<typeof load>) {
  return page('article.hcalendar.event.status-publish').toArray().map(element => {
    const item = page(element);
    const id = /^post-(\d+)$/u.exec(item.attr('id') ?? '')?.[1];
    const heading = item.find('h3.entry-title a.url');
    const title = clean(heading.text());
    const url = publicPage(heading.attr('href'), origin, eventPath);
    const dateTitles = (selector: string) => [...new Set(item.find(selector)
      .map((_index, field) => page(field).attr('title') ?? '').get())];
    const starts = dateTitles('abbr.dtstart');
    const ends = dateTitles('abbr.dtend');
    const startsAt = starts.length === 1 ? timestamp(starts[0]) : undefined;
    const endsAt = ends.length === 1 ? timestamp(ends[0]) : undefined;
    const hallLink = safeUrl(item.find('.event-category a').first().attr('href'), origin);
    const hall = hallLink && hallNames.get(hallLink.pathname);
    const teaser = clean(item.find('.my-posters-content').clone().find('.entry-title').remove().end().text()) ?? '';
    const paragraphs = item.find('.my-poster-content p, .my-poster-content h3, .my-poster-content h4')
      .map((_index, paragraph) => clean(page(paragraph).text()) ?? '').get();
    const listedPrice = clean(item.find('.event-tickets').first().text());
    const tickets = item.find('.my-kassy-btn a[href], .my-mobile-buttons a[href], .my-poster-content a[href]')
      .map((_index, link) => page(link).attr('href') ?? '').get()
      .map(link => safeUrl(link))
      .find(link => link && /(?:^|\.)(?:kassir|kassy|intickets)\.ru$/iu.test(link.hostname));
    if (!id || !title || heading.length !== 1 || !url || !startsAt || !hall) return undefined;
    return { id, title, url, startsAt, endsAt: endsAt && endsAt > startsAt ? endsAt : undefined, hall,
      teaser, paragraphs, price: listedPrice, ticketUrl: tickets?.href };
  });
}

export async function collectBashgf(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name, events: [], rejected: 0 };
  const crawler = await openCrawler(origin, read);
  const listing = load(await crawler.page(new URL('/afisha/', origin)));
  const cards = parsePage(listing);
  if (!cards.length) throw new Error('Expected dated philharmonic schedule cards');
  const thisMonth = new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 7).replace('-', '/');
  const months = [...new Set(listing('.my-archive-months-poster a[href]').map((_index, link) => {
    const url = publicPage(listing(link).attr('href'), origin, monthPath);
    if (url && url.pathname.slice(8, 15) > thisMonth) {
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.href;
    }
  }).get())].filter(url => crawler.allowed(new URL(url))).sort().slice(0, 2);
  for (const month of months) {
    try {
      cards.push(...parsePage(load(await crawler.page(new URL(month)))));
    } catch (error) {
      result.error ??= error instanceof Error ? error.message : 'Monthly schedule unavailable';
    }
  }
  const sessions = new Map<string, NonNullable<(typeof cards)[number]>>();
  const conflictingIds = new Set<string>();
  for (const card of cards) {
    if (!card || !crawler.allowed(card.url)) { result.rejected++; continue; }
    const previous = sessions.get(card.id);
    if (previous && (previous.startsAt !== card.startsAt || previous.url.href !== card.url.href)) conflictingIds.add(card.id);
    sessions.set(card.id, card);
  }
  result.rejected += conflictingIds.size;
  const upcoming = [...sessions.values()].filter(card => !conflictingIds.has(card.id) &&
    Date.parse(card.endsAt ?? card.startsAt) > now.getTime()).slice(0, 36);
  const checked = await mapConcurrent(upcoming, 3, async (card): Promise<SourceEvent | undefined> => {
    const details = parsePage(load(await crawler.page(card.url))).filter(item => item?.id === card.id);
    const detail = details[0];
    if (details.length !== 1 || !detail || detail.startsAt !== card.startsAt || detail.hall !== card.hall ||
        detail.url.href !== card.url.href || normalizeText(detail.title) !== normalizeText(card.title)) return;
    const status = eventNotice(card.title, card.title, card.teaser, ...detail.paragraphs);
    const synopsis = [card.title, card.teaser, detail.paragraphs[0]].filter(Boolean).join(' ');
    const kind = [card.title, card.teaser, detail.paragraphs[0] ?? ''].map(category)
      .find(candidate => candidate !== 'other') ?? 'other';
    const age = (card.title + ' ' + card.teaser + ' ' + detail.paragraphs.slice(0, 2).join(' '))
      .match(/(?:^|[\s(])([0-9]|1[0-9]|2[01])\s*\+(?=$|[\s),.!])/u)?.[1];
    const priceFields = detail.price === card.price ? price(detail.price) : {};
    // The theme can show a default "Бесплатно" for an event whose description sells tickets.
    const free = detail.price === 'Бесплатно' && !detail.ticketUrl && !card.ticketUrl &&
      detail.paragraphs.some(line => /^(?:🎟️?\s*)?(?:вход\s+(?:свободный|бесплатный)|свободный\s+вход|бесплатный\s+вход)(?=$|[\s).,!])/iu.test(line));
    return {
      title: card.title, city: 'Уфа', venue: name, address: 'ул. Гоголя, 58',
      category: kind === 'other' && /ансамбл|оркестр|джаз|музык|хор|песн|эстрад|фортепиан|органн|авторский вечер/iu.test(synopsis)
        ? 'concert' : kind,
      startsAt: card.startsAt, endsAt: detail.endsAt, ageLimit: age === undefined ? undefined : Number(age),
      ...(free ? { priceMin: 0, priceMax: 0 } : priceFields),
      sourceKey: 'bashgf:' + card.id, sourceType: 'scrape', sourceName: name, sourceUrl: card.url.href,
      ticketUrl: detail.ticketUrl, status, verifiedAt: now.toISOString(),
      raw: { id: card.id, hall: card.hall, startsAt: card.startsAt, endsAt: detail.endsAt, advertisedPrice: detail.price },
    };
  });
  for (const outcome of checked) {
    if (outcome.status === 'fulfilled' && outcome.value) result.events.push(outcome.value);
    else {
      result.rejected++;
      if (outcome.status === 'rejected') result.error ??= outcome.reason instanceof Error ? outcome.reason.message : 'Event card unavailable';
    }
  }
  return result;
}
