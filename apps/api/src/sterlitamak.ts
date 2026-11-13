import { load } from 'cheerio';
import type { SourceEvent } from './catalog.ts';
import { mapConcurrent, openCrawler, sourceReader } from './crawl.ts';

const origin = 'https://rusdramteatr.ru';
const name = 'Русский драматический театр Стерлитамака';
const detailLimit = 24;
const detailPath = /^\/afisha\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const durationPattern = /^(?:(\d{1,2})\s*ч\.*\s*)?(?:(\d{1,2})\s*мин\.*)?(?:\s+с обсуждением)?$/i;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function durationMinutes(text: string): number {
  const match = clean(text).match(durationPattern);
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : 0;
}

function eventStatus(text: string): SourceEvent['status'] {
  const notice = clean(text).replace(/^(?:внимание[!:.]?\s*)/i, '');
  if (/^(?:спектакль\s+|концерт\s+)?(?:отмен[её]н[ао]?|не состоится)(?:\s|[.!]|$)/i.test(notice)) return 'cancelled';
  if (/^(?:спектакль\s+|концерт\s+)?(?:перен[её]с[её]н[ао]?|отложен[ао]?)(?:\s|[.!]|$)/i.test(notice)) return 'draft';
  return 'published';
}

function theatreEvent(
  html: ReturnType<typeof load>, path: string, listingTime: string, listingStatus: SourceEvent['status'], now: Date,
): SourceEvent | undefined {
  const article = html('main .com-content-article');
  const time = article.find('dd.create time[datetime]');
  const sourceTime = time.attr('datetime');
  const sourceTimestamp = Date.parse(sourceTime ?? '');
  const title = clean(article.children('h2').first().text());
  const venueDetails = html('#mod-custom121 > p');
  const venue = clean(venueDetails.first().text());
  const address = clean(venueDetails.eq(1).text()).match(/Стерлитамак,\s*(.+)$/)?.[1];

  if (article.length !== 1 || time.length !== 1 || clean(time.text()) !== listingTime ||
      !sourceTime || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00$/.test(sourceTime) ||
      !Number.isFinite(sourceTimestamp) ||
      new Date(sourceTimestamp + 5 * 3_600_000).toISOString().slice(0, 19) !== sourceTime.slice(0, 19) ||
      !listingTime.endsWith(sourceTime.slice(11, 16)) ||
      !title || !venue.includes('Стерлитамак') || !address ||
      /гастроли\s+в\s+г[.\s]/i.test(article.find('h6').text())) return;

  const startsAt = sourceTime.slice(0, 16) + ':00+05:00';
  const timestamp = Date.parse(startsAt);
  const paragraphs = article.children('p').toArray().map((element) => clean(html(element).text()));
  const statuses = [listingStatus, ...paragraphs.map(eventStatus)];
  const status = statuses.includes('cancelled') ? 'cancelled' : statuses.includes('draft') ? 'draft' : 'published';
  if (status === 'published' && timestamp <= now.getTime()) return;

  const minutes = [...new Set(paragraphs.map(durationMinutes).filter((value) => value > 0))];
  const age = clean(article.children('h5').first().text()).match(/^(0|6|12|16|18)\+$/)?.[1];
  const image = article.find('figure.item-image > img').attr('src');
  const sourceUrl = origin + path;
  const genre = paragraphs[0] ?? '';
  const summary = /^(?:трагедия|комедия|драма|сказка|музыкальная сказка|концерт|мистический триллер)(?:$| )/i.test(genre)
    ? genre : undefined;
  return {
    title, category: /^концерт(?:$| )/i.test(genre) ? 'concert' : 'theatre', description: summary,
    startsAt, endsAt: minutes.length === 1 ? new Date(timestamp + minutes[0] * 60_000).toISOString() : undefined,
    city: 'Стерлитамак', venue, address, ageLimit: age === undefined ? undefined : Number(age),
    imageUrl: image && /^\/images\/[a-z0-9_/%.-]+$/i.test(image) ? origin + image : undefined,
    sourceUrl, sourceName: name, sourceKey: path, sourceType: 'scrape', status,
    verifiedAt: now.toISOString(), raw: { title, sourceTime, age, durations: minutes, venue, address },
  };
}

export async function collectSterlitamak(fetcher: typeof fetch, now: Date): Promise<{
  name: string; events: SourceEvent[]; rejected: number; error?: string;
}> {
  const result: { name: string; events: SourceEvent[]; rejected: number; error?: string } =
    { name, events: [], rejected: 0 };
  try {
    const crawler = await openCrawler(origin, sourceReader(fetcher));
    const read = async (path: string) => load(await crawler.page(new URL(path, origin)));
    const listing = await read('/afisha');
    const cards = listing('.nspArt:has(.nspInfo)');
    if (!cards.length) throw new Error('Expected theater schedule cards');
    const candidates = new Map<string, { time: string; status: SourceEvent['status'] }>();
    for (const card of cards.toArray()) {
      const element = listing(card);
      const path = element.children('a.nspImageWrapper').attr('href');
      const time = clean(element.children('.nspInfo').text());
      if (!path || !detailPath.test(path) || !time || /гастроли\s+в\s+г[.\s]/i.test(element.find('h6').text())) {
        result.rejected++;
        continue;
      }
      const notices = element.find('h4, h5, h6').toArray().map((heading) => eventStatus(listing(heading).text()));
      const status = notices.includes('cancelled') ? 'cancelled' : notices.includes('draft') ? 'draft' : 'published';
      candidates.set(path, { time, status });
    }
    const entries = [...candidates].slice(0, detailLimit);
    const checked = await mapConcurrent(entries, 3, async ([path, item]) =>
      theatreEvent(await read(path), path, item.time, item.status, now));
    for (const entry of checked) {
      if (entry.status === 'fulfilled' && entry.value) result.events.push(entry.value);
      else result.rejected++;
    }
    if (entries.length && checked.every(entry => entry.status === 'rejected')) result.error = 'All theater detail requests failed';

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
