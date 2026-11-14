import { load } from 'cheerio';
import { isLocalDate, normalizeText } from './catalog.ts';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { clean, eventNotice, publicPage, safeUrl } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

const origin = 'https://bashopera.ru';
const schedule = new URL('/affiche/', origin);
const venue = 'Башкирский государственный академический театр оперы и балета';
const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const weekdays = 'воскресенье понедельник вторник среда четверг пятница суббота'.split(' ');
const detailPath = /^\/repertoire\/(opera|ballet|comedy|concert|children|operetta)\/\d+\/$/u;
const ticketPath = /^\/repertoire\/(?:opera|ballet|comedy|concert|children|operetta)\/\d+\/\d+\/$/u;
const languages = { башкирском: 'ba', русском: 'ru', итальянском: 'it', французском: 'fr', немецком: 'de' };
export const bashoperaName = venue;

function sessionStart(dateLabel: string, weekday: string, time: string, now: Date) {
  const fields = /^(\d{1,2}) ([а-я]+)(?: (\d{4}))?$/u.exec(dateLabel);
  const month = fields && months.indexOf(fields[2]) + 1;
  if (!fields || !month) return;
  const localYear = new Date(now.getTime() + 5 * 3_600_000).getUTCFullYear();
  // The upcoming schedule omits the year. Require the printed weekday and a near-term date.
  for (const year of fields[3] ? [Number(fields[3])] : [localYear, localYear + 1]) {
    const day = `${year}-${String(month).padStart(2, '0')}-${fields[1].padStart(2, '0')}`;
    if (!isLocalDate(day) || weekdays[new Date(day + 'T12:00:00Z').getUTCDay()] !== weekday) continue;
    const start = `${day}T${time}:00+05:00`;
    const offset = Date.parse(start) - now.getTime();
    if (offset > 0 && offset < 120 * 86_400_000) return start;
  }
}

function durationOf(info: string) {
  const fields = /Продолжительность\s*:\s*(?:(\d{1,2})\s*(?:час(?:а|ов)?|ч\.?)(?!\p{L})\s*)?(?:(\d{1,3})\s*мин(?:ут[аы]?)?(?!\p{L}))?/iu.exec(info);
  const minutes = Number(fields?.[1] ?? 0) * 60 + Number(fields?.[2] ?? 0);
  return minutes > 0 && minutes <= 600 ? minutes : undefined;
}

function priceOf(text: string) {
  if (/^(?:бесплатно|вход свободный)[.!]?$/iu.test(text)) return { priceMin: 0, priceMax: 0 };
  const prices = /^(от\s+)?([\d ]+)(?:\s*[-–—]\s*([\d ]+))?\s*(?:₽|руб(?:лей|ля|ль)?\.?|р\.)$/iu.exec(text);
  if (!prices) return {};
  const priceMin = Number(prices[2].replaceAll(' ', ''));
  const priceMax = prices[3] ? Number(prices[3].replaceAll(' ', '')) : prices[1] ? undefined : priceMin;
  return Number.isFinite(priceMin) && (priceMax === undefined || (Number.isFinite(priceMax) && priceMax >= priceMin))
    ? { priceMin, priceMax } : {};
}

export async function collectBashopera(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name: bashoperaName, events: [], rejected: 0 };
  const crawler = await openCrawler(origin, read);
  const page = load(await crawler.page(schedule));
  const cards = page('.b-affiche > .items > .item.content').toArray();
  if (!cards.length) throw new Error('Expected BashOpera schedule sessions');
  const sessions = cards.flatMap(card => {
    const row = page(card);
    const text = (selector: string) => clean(row.find(selector).first().text()) ?? '';
    const id = /^bx_\d+_(\d+)$/u.exec(row.attr('id') ?? '')?.[1];
    const title = text('.names .name a');
    const repertoire = publicPage(row.find('.names .name a').first().attr('href'), origin, detailPath);
    const dateLabel = text('.dates .date');
    const weekday = text('.dates .weekday').toLowerCase();
    const hall = text('.actions .hall');
    const time = /, ((?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(hall)?.[1];
    const hallPath = safeUrl(row.find('.actions .hall a').first().attr('href'), origin)?.pathname;
    const start = time && sessionStart(dateLabel.toLowerCase(), weekday, time, now);
    if (!id || !title || !repertoire || !start ||
        !['/tickets/halls/234/', '/tickets/halls/235/'].includes(hallPath ?? '')) {
      result.rejected++;
      return [];
    }
    const ticket = publicPage(row.find('.actions .buy a.b-byu-btn').first().attr('href'), origin, ticketPath);
    const tags = row.find('.names .b-tags li').map((_index, tag) => clean(page(tag).text()) ?? '').get();
    const age = tags.find(tag => /^(?:[0-9]|1\d|2[01])\s*\+$/u.test(tag));
    return [{
      id, title, repertoire, start, hall, dateLabel, weekday, tags,
      ageLimit: age === undefined ? undefined : Number.parseInt(age),
      ticket: ticket?.pathname === repertoire.pathname + id + '/' && crawler.allowed(ticket) ? ticket.href : undefined,
      prices: text('.actions .price'), notice: text('.names > .text'),
    }];
  });

  const repertoireUrls = [...new Set(sessions.map(session => session.repertoire.href))].slice(0, 24);
  const details = new Map<string, { title: string; info: string; performanceText: string; tickets: Set<string> }>();
  const requests = await mapConcurrent(repertoireUrls.filter(url => crawler.allowed(new URL(url))), 2, async url => {
    const detail = load(await crawler.page(new URL(url)));
    const title = clean(detail('#article-content > h1').first().text());
    if (!title || detail('.b-event').length !== 1) return;
    const info = clean(detail('.b-event .info .description').first().text()) ?? '';
    const performanceText = clean(detail('.b-event > .text').first().text()) ?? '';
    const tickets = new Set<string>();
    detail('.b-event .affiche a[href]').each((_index, anchor) => {
      const href = detail(anchor).attr('href');
      const candidate = href && safeUrl(new URL(href, url).href, origin);
      if (candidate && ticketPath.test(candidate.pathname) && !candidate.search && !candidate.hash) tickets.add(candidate.href);
    });
    details.set(url, { title, info, performanceText, tickets });
  });
  const failed = requests.filter(request => request.status === 'rejected').length;
  if (failed) result.error = `BashOpera repertoire details unavailable for ${failed} titles`;

  for (const session of sessions) {
    const { id, title, repertoire, start, hall, dateLabel, weekday, tags, ageLimit, ticket, prices, notice } = session;
    const candidate = details.get(repertoire.href);
    const detail = candidate && normalizeText(candidate.title) === normalizeText(title) ? candidate : undefined;
    const duration = detail && durationOf(detail.info);
    const languageStatement = /(?:исполняется|спектакль идет)\s+на\s+(башкирском|русском|итальянском|французском|немецком)\s+языке/iu
      .exec(normalizeText([detail?.info, detail?.performanceText].filter(Boolean).join(' ')));
    const language = languageStatement?.[1] as keyof typeof languages | undefined;
    result.events.push({
      title, category: repertoire.pathname.startsWith('/repertoire/concert/') ? 'concert' : 'theatre',
      description: detail?.performanceText.slice(0, 500) || undefined,
      city: 'Уфа', venue, address: 'ул. Ленина, 5/1', startsAt: start,
      endsAt: duration ? new Date(Date.parse(start) + duration * 60_000).toISOString() : undefined,
      ageLimit, ...priceOf(prices), language: language && languages[language],
      sourceUrl: ticket && detail?.tickets.has(ticket) ? repertoire.href : schedule.href, ticketUrl: ticket,
      sourceName: bashoperaName, sourceType: 'scrape', sourceKey: 'bashopera:' + id,
      status: eventNotice(title, title, notice, ...tags), verifiedAt: now.toISOString(),
      raw: { dateLabel, weekday, hall, tags, prices, notice, repertoire: repertoire.href, performanceInfo: detail?.info,
        languageStatement: languageStatement?.[0] },
    });
  }
  return result;
}
