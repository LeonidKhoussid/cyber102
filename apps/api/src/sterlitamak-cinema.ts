import { load } from 'cheerio';
import { isLocalDate } from './catalog.ts';
import type { SourceEvent } from './catalog.ts';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { localDate, localDay } from './filters.ts';
import { clean, inUfa, publicPage, safeUrl } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

export const sterlitamakCinemaName = 'Мираж Синема · Стерлитамак';
const origin = 'https://www.mirage.ru';
const venuePath = '/str/cinema/9/';
const schedulePath = /^\/str\/schedule\/(\d{2})\.(\d{2})\.(\d{4})\/$/;
const guid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const showtimePath = new RegExp('^/ticket_new/(' + guid + ')/$');
const filmShowtimePath = new RegExp('^/ticket/(' + guid + ')/$');
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const concurrency = 3;
const filmPageLimit = 32;

type CinemaDay = { iso: string; publisher: string; url: URL };
type Screening = { day: CinemaDay; event: SourceEvent; filmId?: string; showtime: string; time: string };

function dayFromLink(value: unknown): CinemaDay | undefined {
  const url = publicPage(value, origin, schedulePath);
  const date = url?.pathname.match(schedulePath);
  if (!url || !date) return;
  const [, day, month, year] = date;
  const iso = `${year}-${month}-${day}`;
  if (isLocalDate(iso)) return { iso, publisher: `${day}.${month}.${year}`, url };
}

function screenings(html: ReturnType<typeof load>, day: CinemaDay, now: Date): Screening[] {
  const active = dayFromLink(html('.calendar-list a.active').attr('href'));
  // Dates beyond the five visible tabs have no active tab. The date-specific form marks them.
  const selected = active ?? dayFromLink(html('form[name="myform_fil_sch"]').attr('action'));
  if (!/^Расписание\s+в Стерлитамаке$/i.test(html('.page-content h1').first().text().trim()) || selected?.iso !== day.iso) {
    throw new Error('Expected selected Sterlitamak cinema schedule');
  }
  const found: Screening[] = [];
  const seen = new Set<string>();
  html('.session-box').each((_index, node) => {
    const cinema = html(node);
    const label = cinema.find('.md-title a[href="' + venuePath + '"]');
    const address = clean(cinema.find('.adds').first().text());
    if (label.length !== 1 || clean(label.text())?.toLowerCase() !== 'арбат' || !address) return;

    cinema.find('.session-slider > .session > a').each((_position, item) => {
      const card = html(item);
      const title = clean(card.find('.title').text());
      const time = clean(card.find('.info-line .time').text());
      const ticket = publicPage(card.attr('href'), origin, showtimePath);
      const showtime = ticket?.pathname.match(showtimePath)?.[1];
      if (!title || !time || !clock.test(time) || !ticket || !showtime || seen.has(showtime)) return;
      const startsAt = inUfa(`${day.iso}T${time}:00+05:00`);
      if (!startsAt || Date.parse(startsAt) <= now.getTime()) return;
      seen.add(showtime);

      const genre = clean(card.find('.genre').text());
      const age = clean(card.find('.age').text())?.match(/^(0|6|12|16|18)\s*\+$/)?.[1];
      const standard = card.find('.place-price .item').filter((_index, price) =>
        html(price).find('img[src="/i/armchair/svg.svg"]').length === 1);
      const listedPrice = standard.length === 1 ? clean(standard.text()) : undefined;
      const price = listedPrice?.match(/^(От )?(\d+(?: \d{3})*)\s*₽$/i);
      const priceMin = price ? Number(price[2].replaceAll(' ', '')) : undefined;
      const image = safeUrl(card.find('.photo img').attr('src'), 'https://cdn.mirage.ru');
      const filmId = image?.pathname.match(/^\/images\/film\/\d+\/small\/p(\d+)\.jpg$/)?.[1];

      found.push({
        day, time, filmId, showtime,
        event: {
          title, category: 'cinema', city: 'Стерлитамак', venue: 'Кинотеатр «Арбат»', address,
          // The official cinema page publishes these coordinates in its map embed.
          latitude: 53.62258, longitude: 55.902281,
          description: genre, startsAt, ageLimit: age === undefined ? undefined : Number(age),
          priceMin, priceMax: price && !price[1] ? priceMin : undefined,
          imageUrl: image?.href, ticketUrl: ticket.href, sourceUrl: day.url.href,
          sourceName: sterlitamakCinemaName, sourceType: 'scrape', sourceKey: 'mirage:str:' + showtime,
          status: 'published', verifiedAt: now.toISOString(),
          raw: { showtime, title, genre, startsAt, age, listedPrice, scheduleUrl: day.url.href },
        },
      });
    });
  });
  return found;
}

function confirmEnds(html: ReturnType<typeof load>, screenings: Screening[], filmUrl: URL) {
  const [{ day, filmId }] = screenings;
  const selected = html('.calendar-list a.active').attr('href');
  if (selected !== `/film/${filmId}/${day.publisher}/` && selected !== filmUrl.pathname) {
    throw new Error('Expected selected cinema film date');
  }
  const byShowtime = new Map(screenings.map(screening => [screening.showtime, screening]));
  html('.session-box').each((_index, node) => {
    const cinema = html(node);
    if (cinema.find('.md-title a[href="' + venuePath + '"]').length !== 1) return;
    cinema.find('.session-slider .session-item > a').each((_position, item) => {
      const card = html(item);
      // Read only the UUID from the publisher's link; robots.txt disallows requesting this route.
      const href = publicPage(card.attr('href'), origin, filmShowtimePath);
      const showtime = href?.pathname.match(filmShowtimePath)?.[1];
      const screening = showtime && byShowtime.get(showtime);
      const start = clean(card.find('.period .start').text());
      const end = clean(card.find('.period .end').text());
      if (!screening || start !== screening.time || !end || !clock.test(end) || end === start ||
          clean(card.find('.title').text()) !== screening.event.title) return;
      const endDate = end < start ? localDay(day.iso, 1) : day.iso;
      const endsAt = inUfa(`${endDate}T${end}:00+05:00`);
      if (!endsAt) return;
      screening.event.endsAt = endsAt;
      screening.event.sourceUrl = filmUrl.href;
      screening.event.raw = { ...screening.event.raw as object, endsAt, filmUrl: filmUrl.href };
    });
  });
}

export async function collectSterlitamakCinema(read: Read, now: Date): Promise<SourceResult> {
  const result: SourceResult = { name: sterlitamakCinemaName, events: [], rejected: 0 };
  const crawler = await openCrawler(origin, read);
  const main = load(await crawler.page(new URL('/str/schedule/', origin)));
  const selected = dayFromLink(main('.calendar-list a.active').attr('href'));
  if (!selected) throw new Error('Expected dated Sterlitamak cinema links');
  const today = localDate(now);
  const days = new Map<string, CinemaDay>();
  main('.calendar-list a.bt-dark, #modal-filter_date a').each((_index, item) => {
    const day = dayFromLink(main(item).attr('href'));
    if (day && day.iso >= today && day.iso <= localDay(today, 21)) days.set(day.iso, day);
  });

  const upcoming = [...days.values()].sort((first, second) => first.iso.localeCompare(second.iso)).slice(0, 9);
  const schedules = await mapConcurrent(upcoming, concurrency, async day => {
    const html = day.iso === selected.iso ? main : load(await crawler.page(day.url));
    return screenings(html, day, now);
  });
  const all = schedules.flatMap(outcome => outcome.status === 'fulfilled' ? outcome.value : []);
  if (schedules.length && schedules.every(outcome => outcome.status === 'rejected')) {
    throw new Error('No Sterlitamak cinema schedules could be read');
  }

  const films = new Map<string, Screening[]>();
  // Each film page confirms all showtimes for that date. Enrich age-rated family films first.
  const priority = [...all].sort((first, second) =>
    Number((second.event.ageLimit ?? 99) <= 6) - Number((first.event.ageLimit ?? 99) <= 6));
  for (const screening of priority) {
    if (!screening.filmId) continue;
    const path = `/str/film/${screening.filmId}/${screening.day.publisher}/`;
    const group = films.get(path) ?? [];
    group.push(screening);
    films.set(path, group);
  }
  const details = await mapConcurrent([...films].slice(0, filmPageLimit), concurrency, async ([path, group]) => {
    const url = new URL(path, origin);
    confirmEnds(load(await crawler.page(url)), group, url);
  });
  result.events = all.map(screening => screening.event);
  if (schedules.some(outcome => outcome.status === 'rejected') || details.some(outcome => outcome.status === 'rejected')) {
    result.error = 'Some cinema schedule or film pages could not be read';
  }
  return result;
}
