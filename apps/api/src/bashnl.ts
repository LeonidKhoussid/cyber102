import { load } from 'cheerio';
import type { SourceEvent } from './catalog.ts';
import { normalizeText } from './catalog.ts';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { category, clean, eventNotice, inUfa, numberBetween, plainHtml, safeUrl } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const origin = 'https://bashnl.ru';
const schedule = '/uslugi/pushkinskaya-karta/';
const hoursPath = '/o-biblioteke/struktura-biblioteki/otdel-obsluzhivaniya-polzovateley/';
const exhibitionPath = '/novosti/50935/';
export const nationalLibraryName = 'Национальная библиотека имени Ахмет-Заки Валиди';
const chizhovVenue = 'Дом купца Чижова — корпус № 2 Национальной библиотеки';
const chizhovAddress = 'ул. Октябрьской революции, 10';
const locations: [RegExp, string, string][] = [
  [/^(?:г уфа )?ул октябрьской революции (?:д )?10$/u, chizhovVenue, chizhovAddress],
  [/^(?:г уфа )?(?:пр кт|проспект) октября (?:д )?62 2(?: центр юношеского чтения)?$/u, 'Центр юношеского чтения Национальной библиотеки', 'пр. Октября, 62/2'],
  [/^(?:г уфа )?ул менделеева (?:д )?203$/u, 'Центр детского чтения Национальной библиотеки', 'ул. Менделеева, 203'],
  [/^(?:г уфа )?(?:ул )?ленина (?:д )?4$/u, nationalLibraryName, 'ул. Ленина, 4'],
];

function startTime(label: string) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$/u.exec(label);
  if (match) return inUfa(`${match[3]}-${match[2]}-${match[1]}T${match[4]}+05:00`);
}

function publishedPrice(label: string): number | undefined {
  if (/^(?:бесплатно|вход свободный)$/iu.test(label)) return 0;
  return numberBetween(/^(\d+)\s*(?:руб\.?|₽)$/iu.exec(label)?.[1], 0, 100_000);
}

function ticketLink(value: unknown) {
  const url = safeUrl(value);
  if (url?.origin === 'https://iframeab-pre5630.intickets.ru' && /^\/(?:event|seance)\/\d+\/$/u.test(url.pathname) &&
      !url.search && !url.hash) return url.href;
}

function exhibitionWindows(announcementPage: string, venuePage: string, now: Date): SourceEvent[] {
  const announcement = load(announcementPage);
  const title = clean(announcement('h2.title-section').first().text());
  const body = plainHtml(announcement('#textgraphId').first().html());
  const publication = startTime(announcement('.news-date-time').first().text().trim() + ' 00:00:00');
  const hoursPage = load(venuePage);
  const hoursBody = plainHtml(hoursPage('#textgraphId').first().html());
  if (!title || !publication || !/корпус 2 национальной библиотеки/iu.test(body) ||
      !normalizeText(body).includes(normalizeText(chizhovAddress)) ||
      !normalizeText(hoursBody).includes(normalizeText(chizhovAddress))) return [];
  const dates = /выставку можно посетить с (\d{1,2}) ([а-я]+) по (\d{1,2}) ([а-я]+)\./iu.exec(body);
  const hours = /график работы:\s*вт (\d{2}:\d{2})[–—-](\d{2}:\d{2}),\s*сб (\d{2}:\d{2})[–—-](\d{2}:\d{2}),\s*последняя пятница месяца\s*[–—-]\s*санитарный день/iu.exec(hoursBody);
  if (!dates || !hours) return [];
  const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
  const firstMonth = months.indexOf(dates[2].toLowerCase()) + 1;
  const lastMonth = months.indexOf(dates[4].toLowerCase()) + 1;
  const timestamp = (year: number, month: number, day: string) =>
    inUfa(`${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00+05:00`);
  const publishedYear = Number(publication.slice(0, 4));
  const first = timestamp(publishedYear, firstMonth, dates[1]);
  const last = timestamp(publishedYear + Number(lastMonth < firstMonth), lastMonth, dates[3]);
  const dayMs = 86_400_000;
  if (!first || !last || Date.parse(last) < Date.parse(first) || Date.parse(last) - Date.parse(first) > 90 * dayMs ||
      Math.abs(Date.parse(first) - Date.parse(publication)) > 31 * dayMs) return [];
  const status = eventNotice(title, title, body);
  const free = /(?:^|[.!?]\s+)вход свободный[.!?]/iu.test(body);
  const sessions: SourceEvent[] = [];
  for (let day = Date.parse(first); day <= Date.parse(last); day += dayMs) {
    const local = new Date(day + 5 * 3_600_000);
    const weekday = local.getUTCDay();
    if (weekday !== 2 && weekday !== 6) continue;
    const [opening, closing] = weekday === 2 ? hours.slice(1, 3) : hours.slice(3, 5);
    const date = local.toISOString().slice(0, 10);
    const startsAt = inUfa(`${date}T${opening}:00+05:00`);
    const endsAt = inUfa(`${date}T${closing}:00+05:00`);
    if (!startsAt || !endsAt || endsAt <= startsAt || Date.parse(endsAt) <= now.getTime()) continue;
    sessions.push({
      title, category: 'exhibition', startsAt, endsAt, city: 'Уфа', venue: chizhovVenue, address: chizhovAddress,
      description: 'Интервал посещения соответствует опубликованным часам работы корпуса № 2. В это время можно прийти на выставку. Режим работы: ' + origin + hoursPath,
      priceMin: free ? 0 : undefined, priceMax: free ? 0 : undefined,
      sourceUrl: origin + exhibitionPath, sourceName: nationalLibraryName, sourceType: 'scrape',
      sourceKey: `bashnl:exhibition:50935:${date}`, verifiedAt: now.toISOString(), status,
      raw: { announcement: dates[0], venueHours: hours[0], venueHoursUrl: origin + hoursPath },
    });
  }
  return sessions;
}

export async function collectNationalLibrary(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name: nationalLibraryName, events: [], rejected: 0 };
  const crawler = await openCrawler(origin, read);
  const details = await Promise.allSettled([schedule, exhibitionPath, hoursPath].map(path => crawler.page(new URL(path, origin))));
  const [listing, exhibition, hours] = details;
  if (listing.status === 'fulfilled') {
    const page = load(listing.value);
    const seen = new Set<string>();
    const cards = page('.list-news__item').toArray();
    const candidates = cards.slice(0, 40).flatMap(card => {
      const element = page(card);
      const heading = element.find('h3 a').first();
      const title = clean(heading.text());
      const sourceUrl = safeUrl(heading.attr('href'), origin);
      const id = sourceUrl && /^\?ELEMENT_ID=(\d+)$/u.exec(sourceUrl.search)?.[1];
      const fields = element.find('h3 > b').toArray().map(field => clean(page(field).text()) ?? '');
      const [priceLabel, dateLabel, addressLabel] = fields;
      const startsAt = dateLabel && startTime(dateLabel);
      if (startsAt && Date.parse(startsAt) <= now.getTime()) return [];
      const location = addressLabel && locations.find(([pattern]) => pattern.test(normalizeText(addressLabel)));
      if (!title || !sourceUrl || !id || sourceUrl.pathname !== schedule || sourceUrl.hash || !crawler.allowed(sourceUrl) ||
          !startsAt || !location || seen.has(id)) {
        result.rejected++;
        return [];
      }
      seen.add(id);
      return [{ id, title, sourceUrl, startsAt, location, priceLabel, dateLabel, addressLabel }];
    });
    const sessions = await mapConcurrent(candidates, 2, async candidate => {
      const { id, title, sourceUrl, startsAt, location: [, venue, address], priceLabel, dateLabel, addressLabel } = candidate;
      const detail = load(await crawler.page(sourceUrl));
      const article = detail('#textgraphId').first();
      const body = plainHtml(article.html());
      if (!article.find('h3').toArray().some(heading => normalizeText(detail(heading).text()) === normalizeText(title)) ||
          !body.includes(dateLabel) || !normalizeText(body).includes(normalizeText(addressLabel))) return;
      const price = body.includes(priceLabel) ? publishedPrice(priceLabel) : undefined;
      const age = /(?:возрастное ограничение|возраст)\s*:\s*(\d{1,2})\s*\+/iu.exec(body)?.[1];
      const ticket = article.find('a.news-preview-button[href]').toArray().map(link => ticketLink(detail(link).attr('href'))).find(Boolean);
      const event: SourceEvent = {
        title, category: category(title), startsAt, city: 'Уфа', venue, address,
        priceMin: price, priceMax: price, ageLimit: numberBetween(age, 0, 21), ticketUrl: ticket,
        sourceUrl: sourceUrl.href, sourceName: nationalLibraryName, sourceType: 'scrape', sourceKey: `bashnl:show:${id}`,
        status: eventNotice(title, title, body), verifiedAt: now.toISOString(), raw: { dateLabel, priceLabel, addressLabel },
      };
      return event;
    });
    for (const outcome of sessions) {
      if (outcome.status === 'fulfilled' && outcome.value) result.events.push(outcome.value);
      else result.rejected++;
    }
    if (!cards.length) result.error = 'Expected National Library schedule cards';
  } else result.error = 'National Library schedule unavailable';
  if (exhibition.status === 'fulfilled' && hours.status === 'fulfilled') {
    result.events.push(...exhibitionWindows(exhibition.value, hours.value, now));
  } else result.error = [result.error, 'National Library exhibition or venue hours unavailable'].filter(Boolean).join('; ');
  return result;
}
