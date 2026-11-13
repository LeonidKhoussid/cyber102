import { clean, inUfa, numberBetween, record } from './source-data.ts';
import type { SourceResult } from './source-data.ts';
import type { Read } from './crawl.ts';
import type { SourceEvent } from './catalog.ts';

const name = 'Timepad';
const cities = ['Уфа', 'Стерлитамак', 'Салават', 'Нефтекамск', 'Октябрьский', 'Сибай'];
const culturalCategories: [RegExp, SourceEvent['category']][] = [
  [/театр|спектакл/iu, 'theatre'], [/концерт|музык/iu, 'concert'], [/выставк|искусств/iu, 'exhibition'],
  [/фестивал/iu, 'festival'], [/кино/iu, 'cinema'], [/экскурси/iu, 'tour'],
];

function normalizeEvent(value: unknown, now: Date): SourceEvent | undefined {
  const raw = record(value);
  const id = numberBetween(raw.id, 1, Number.MAX_SAFE_INTEGER);
  const title = clean(raw.name);
  const startsAt = inUfa(raw.starts_at);
  const endsAt = inUfa(raw.ends_at);
  const place = record(raw.location);
  const city = clean(place.city);
  const address = clean(place.address);
  if (!id || !Number.isSafeInteger(id) || !title || !startsAt || !city || !cities.includes(city) || !address) return;
  if (raw.access_status !== 'public' || Date.parse(startsAt) <= now.getTime()) return;
  const kinds = Array.isArray(raw.categories) ? raw.categories.map(entry => clean(record(entry).name) ?? '').join(' ') : '';
  const category = culturalCategories.find(([pattern]) => pattern.test(kinds))?.[1];
  if (!category || typeof raw.url !== 'string') return;
  const url = new URL(raw.url);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !/^[a-z0-9-]+\.timepad\.ru$/i.test(url.hostname) || url.pathname !== '/event/' + id + '/') return;
  const tickets = record(raw.registration_data);
  const age = /^(\d{1,2})(?:\+)?$/.exec(String(raw.age_limit ?? ''));
  const priceMin = numberBetween(tickets.price_min, 0, Infinity);
  const priceMax = numberBetween(tickets.price_max, priceMin ?? 0, Infinity);
  return {
    title, category, city, venue: clean(place.name) ?? address, address, startsAt,
    endsAt: endsAt && Date.parse(endsAt) > Date.parse(startsAt) ? endsAt : undefined,
    ageLimit: age ? numberBetween(age[1], 0, 21) : undefined, priceMin, priceMax,
    status: 'published', sourceUrl: url.href, sourceName: name, sourceType: 'api', sourceKey: 'timepad:' + id,
    raw, verifiedAt: now.toISOString(),
  };
}

export async function collectTimepad(read: Read, now: Date, token: string): Promise<SourceResult> {
  const result: SourceResult = { name, events: [], rejected: 0 };
  for (let offset = 0; offset < 150; offset += 50) {
    const url = new URL('https://api.timepad.ru/v1/events.json');
    url.search = new URLSearchParams({
      cities: cities.join(','), limit: '50', skip: String(offset), starts_at_min: now.toISOString(),
      sort: '+starts_at', fields: 'location,categories,registration_data,age_limit,access_status',
    }).toString();
    try {
      const body = record(JSON.parse(await read(url.href, { Authorization: 'Bearer ' + token })));
      if (!Array.isArray(body.values)) throw new Error('Expected Timepad events array');
      for (const value of body.values) {
        let event: SourceEvent | undefined;
        try { event = normalizeEvent(value, now); } catch { /* An invalid event URL affects only its row. */ }
        if (event) result.events.push(event);
        else result.rejected++;
      }
      if (body.values.length < 50) break;
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Timepad unavailable';
      break;
    }
  }
  return result;
}
