import { load } from 'cheerio';
import { isLocalDate } from './catalog.ts';
import type { SourceEvent } from './catalog.ts';
import { mapConcurrent, openCrawler } from './crawl.ts';
import type { Read } from './crawl.ts';
import { localDate, localDay } from './filters.ts';
import { clean, inUfa, numberBetween, safeUrl } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

export const ufaCinemaName = 'Синема Парк · Уфа';
const origin = 'https://kinoteatr.ru';
const venues = [
  { slug: 'galereya-art', name: 'Синема Парк Галерея Арт', id: '1859' },
  { slug: 'semya', name: 'Синема Парк Семья', id: '1858' },
];

function scheduleUrl(venue: typeof venues[number], day: string): URL {
  const url = new URL('/raspisanie-kinoteatrov/ufa/' + venue.slug + '/', origin);
  url.searchParams.set('date', day);
  return url;
}

function screenings(html: ReturnType<typeof load>, venue: typeof venues[number], url: URL, day: string, now: Date): SourceEvent[] {
  const theatre = html('.cinema_card_single');
  const address = clean(theatre.find('[itemprop="address"]').text());
  if (clean(theatre.find('h1 [itemprop="name"]').text()) !== venue.name || !address?.startsWith('Уфа,') ||
      html('#js_single_cinema_date').attr('value') !== day) throw new Error('Expected selected Ufa cinema venue and date');

  const latitude = numberBetween(theatre.find('[itemprop="latitude"]').attr('content'), -90, 90);
  const longitude = numberBetween(theatre.find('[itemprop="longitude"]').attr('content'), -180, 180);
  const events: SourceEvent[] = [];
  const seen = new Set<string>();
  html('.shedule_content .shedule_movie').each((_index, item) => {
    const film = html(item);
    const title = clean(film.find('.movie_card_header').text());
    const movieId = film.attr('data-gtm-list-item-filmid');
    if (!title || !movieId || !/^\d+$/.test(movieId)) return;
    const genre = clean(film.attr('data-gtm-list-item-genre'));
    const age = clean(film.find('.raiting_sub').text())?.match(/^(0|6|12|16|18)\s*\+$/)?.[1];
    const image = safeUrl(film.find('.shedule_movie_img').attr('data-src'));
    film.find('a.buy_seance.shedule_session').each((_position, element) => {
      const session = html(element);
      const id = session.attr('data-r-seance-id');
      const widget = session.attr('data-id');
      const ticket = safeUrl(session.attr('href'), origin);
      const time = clean(session.find('.shedule_session_time').text());
      if (!id || !/^\d+$/.test(id) || seen.has(id) || !widget || !/^\d+$/.test(widget) ||
          session.attr('data-r-id') !== venue.id || session.attr('data-movie-id') !== movieId ||
          !ticket || ticket.pathname !== url.pathname || ticket.hash || ticket.searchParams.size !== 2 ||
          ticket.searchParams.get('date') !== day || ticket.searchParams.get('openWidget') !== widget || !time) return;
      const startsAt = inUfa(day + 'T' + time + ':00+05:00');
      if (!startsAt || Date.parse(startsAt) <= now.getTime()) return;
      const listedPrice = clean(session.find('.shedule_session_price').text());
      const price = listedPrice?.match(/^(от )?(\d+(?: \d{3})*)\s*(?:₽|р\.?)$/i);
      const priceMin = price ? Number(price[2].replaceAll(' ', '')) : undefined;
      seen.add(id);

      events.push({
        title, city: 'Уфа', venue: venue.name, category: 'cinema', address, latitude, longitude, description: genre,
        startsAt, ageLimit: age === undefined ? undefined : Number(age),
        // Film runtime does not establish when this particular screening ends.
        priceMin, priceMax: price && !price[1] ? priceMin : undefined,
        imageUrl: image?.hostname.endsWith('.kinoteatr.ru') ? image.href : undefined, ticketUrl: ticket.href,
        sourceType: 'scrape', sourceName: ufaCinemaName, sourceUrl: url.href, sourceKey: 'cinema-park:ufa:' + venue.id + ':' + id,
        status: 'published', verifiedAt: now.toISOString(),
        raw: { id, widget, movieId, title, genre, startsAt, age, listedPrice, venue: venue.name },
      });
    });
  });
  return events;
}

export async function collectUfaCinema(read: Read, now: Date): Promise<SourceResult> {
  const crawler = await openCrawler(origin, read);
  const today = localDate(now);
  const result: SourceResult = { name: ufaCinemaName, events: [], rejected: 0 };
  const schedules = await mapConcurrent(venues, 2, async venue => {
    const url = scheduleUrl(venue, today);
    const page = load(await crawler.page(url));
    const events = screenings(page, venue, url, today, now);
    const publishedDates = page('#js_single_cinema_date').attr('data-dates')?.split(',') ?? [];
    const days = [...new Set(publishedDates)]
      .filter(day => isLocalDate(day) && day > today && day <= localDay(today, 21)).sort().slice(0, 7);
    const upcoming = await mapConcurrent(days, 1, async day => {
      const datedUrl = scheduleUrl(venue, day);
      return screenings(load(await crawler.page(datedUrl)), venue, datedUrl, day, now);
    });
    for (const day of upcoming) {
      if (day.status === 'fulfilled') events.push(...day.value);
    }
    return { events, partial: upcoming.some(day => day.status === 'rejected') };
  });

  if (schedules.every(schedule => schedule.status === 'rejected')) throw new Error('No Ufa cinema schedules could be read');
  for (const schedule of schedules) {
    if (schedule.status === 'fulfilled') result.events.push(...schedule.value.events);
    if (schedule.status === 'rejected' || schedule.value.partial) result.error = 'Some Ufa cinema schedules could not be read';
  }
  return result;
}
