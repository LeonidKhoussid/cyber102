import { load } from 'cheerio';
import { isLocalDate } from './catalog.ts';
import type { SourceEvent } from './catalog.ts';
import { mapConcurrent, openCrawler, sourceReader } from './crawl.ts';
import { localDate, localDay } from './filters.ts';
import { clean, inUfa, safeUrl } from './source-data.ts';
import type { SourceResult } from './source-data.ts';

export const kinoportName = 'Киноцентр «Кинопорт»';
const origin = 'https://kino-str.ru';
const venuePath = '/theatre/kinoport/schedule';
const theatreId = '3644eef5-bcc2-4e07-8a15-32dcd2e07834';
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function cinemaFetcher(fetcher: typeof fetch): typeof fetch {
  let publisherCookies = '';
  return async (address, options) => {
    const url = new URL(String(address));
    if (url.origin !== origin || url.pathname !== '/schedule') return fetcher(address, options);
    const headers = new Headers(options?.headers);
    if (publisherCookies) headers.set('Cookie', publisherCookies);
    const response = await fetcher(address, { ...options, headers, redirect: 'manual' });
    // The publisher initializes public schedule locale via one same-URL redirect.
    if (response.status !== 302 || response.headers.get('location') !== url.href) return response;
    const cookies = response.headers.getSetCookie()
      .filter(cookie => /^(?:installed_city|stop_geo)=/.test(cookie))
      .map(cookie => cookie.split(';', 1)[0]);
    if (cookies.length !== 2) return response;
    publisherCookies = cookies.join('; ');
    headers.set('Cookie', publisherCookies);
    await response.body?.cancel();
    return fetcher(address, { ...options, headers, redirect: 'error' });
  };
}

function scheduleUrl(day: string) {
  const url = new URL('/schedule', origin);
  url.searchParams.set('date', day.split('-').reverse().join('.'));
  return url;
}

function dateLinks(html: ReturnType<typeof load>, today: string): string[] {
  const dates = html('script:not([src])').toArray().flatMap(item => {
    const configured = html(item).text().match(/"enabledDates":\s*\[([^\]]*)\]/)?.[1];
    return configured?.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  });
  return [...new Set(dates)]
    .filter(day => isLocalDate(day) && day > today && day <= localDay(today, 21))
    .sort().slice(0, 7);
}

function sessions(html: ReturnType<typeof load>, url: URL, day: string, now: Date): SourceEvent[] {
  const publisherDate = url.searchParams.get('date');
  if (clean(html('.page__title').first().text()) !== 'Расписание сеансов' ||
      html('#filter-form input[name="date"]').attr('value') !== publisherDate) {
    throw new Error('Expected selected Kinoport date');
  }
  const found: SourceEvent[] = [];
  const seen = new Set<string>();
  html('.schedule__list .schedule__item').each((_position, element) => {
    const card = html(element);
    const link = card.find('a.film-mini__title');
    const title = clean(link.text());
    const film = safeUrl(link.attr('href'), origin);
    const movieId = film?.pathname.match(/^\/schedule\/([a-z0-9]{16,32})$/)?.[1];
    if (!title || !film || !movieId || film.hash || film.searchParams.size !== 2 ||
        film.searchParams.get('date') !== publisherDate || !/^[a-z0-9]{16,32}$/.test(film.searchParams.get('cityId') ?? '')) return;
    const genre = clean(card.find('.film-mini__genre').text());
    const age = clean(card.find('.film__label').first().text())?.match(/^(0|6|12|16|18)\s*\+$/)?.[1];
    const image = safeUrl(card.find('img.film-mini__poster').attr('src'), 'https://cdn.premierzal.ru');
    card.find('.schedule__theatre').each((_index, theatre) => {
      const detail = html(theatre);
      const address = clean(detail.find('.schedule__theatre-city').text());
      if (detail.find('.schedule__theatre-info a[href="' + venuePath + '"]').length !== 1 ||
          !address || !/^г\. Стерлитамак, ул\. Худайбердина 120\b/i.test(address)) return;
      detail.find('.schedule__session-time:not(.session-picker__item_passed)').each((_index, item) => {
        const session = html(item);
        const id = session.attr('data-session-id');
        const time = clean(session.find('.session-picker__item-time .value').text());
        if (!id || !/^\d+$/.test(id) || seen.has(id) || !time || !clock.test(time) ||
            session.attr('data-film-date') !== publisherDate || session.attr('data-film-id') !== movieId ||
            session.attr('data-theatre-id') !== theatreId) return;
        const startsAt = inUfa(`${day}T${time}:00+05:00`);
        if (!startsAt || Date.parse(startsAt) <= now.getTime()) return;
        const listedPrice = clean(session.find('.session-picker__item-price').text());
        const price = listedPrice?.match(/^(от )?(\d+(?: \d{3})*)\s*(?:₽|Р)$/i);
        const priceMin = price ? Number(price[2].replaceAll(' ', '')) : undefined;
        seen.add(id);
        found.push({
          title, category: 'cinema', city: 'Стерлитамак', venue: kinoportName, address,
          description: genre, startsAt, ageLimit: age === undefined ? undefined : Number(age),
          priceMin, priceMax: price && !price[1] ? priceMin : undefined,
          imageUrl: image?.href, ticketUrl: film.href, sourceUrl: url.href,
          sourceName: kinoportName, sourceType: 'scrape', sourceKey: 'kinoport:' + id,
          status: 'published', verifiedAt: now.toISOString(),
          raw: { id, movieId, title, genre, startsAt, age, listedPrice, theatreId },
        });
      });
    });
  });
  return found;
}

export async function collectKinoport(fetcher: typeof fetch, now: Date): Promise<SourceResult> {
  const crawler = await openCrawler(origin, sourceReader(cinemaFetcher(fetcher), 22_000));
  const today = localDate(now);
  const currentUrl = scheduleUrl(today);
  const current = await crawler.page(currentUrl).then(load).catch(() => undefined);
  const tomorrow = localDay(today, 1);
  const seedUrl = current ? currentUrl : scheduleUrl(tomorrow);
  const seed = current ?? load(await crawler.page(seedUrl));
  const result: SourceResult = {
    name: kinoportName, events: sessions(seed, seedUrl, current ? today : tomorrow, now), rejected: 0,
    error: current ? undefined : 'Current Kinoport schedule page could not be read',
  };
  const upcoming = await mapConcurrent(dateLinks(seed, current ? today : tomorrow), 2, async day => {
    const url = scheduleUrl(day);
    return sessions(load(await crawler.page(url)), url, day, now);
  });
  for (const day of upcoming) {
    if (day.status === 'fulfilled') result.events.push(...day.value);
    else result.error = 'Some Kinoport schedule pages could not be read';
  }
  return result;
}
