import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const categories = {
  concert: 'Концерты',
  theatre: 'Спектакли',
  exhibition: 'Выставки',
  festival: 'Фестивали',
  cinema: 'Кино',
  tour: 'Экскурсии',
  other: 'Другие события',
} as const;

export type Category = keyof typeof categories;
export type EventStatus = 'published' | 'draft' | 'cancelled';

type EventDetails = {
  title: string;
  category: Category;
  startsAt: string;
  endsAt?: string;
  city: string;
  venue: string;
  address?: string;
  description?: string;
  priceMin?: number;
  priceMax?: number;
  ageLimit?: number;
  language?: string;
  latitude?: number;
  longitude?: number;
  imageUrl?: string;
  ticketUrl?: string;
  status: EventStatus;
};

export type SourceEvent = EventDetails & {
  sourceUrl: string;
  sourceName: string;
  sourceType: 'api' | 'scrape' | 'import' | 'manual';
  sourceKey: string;
  verifiedAt?: string;
  confidence?: number;
  raw: unknown;
};

export type CatalogEvent = EventDetails & {
  id: string;
  sources: { name: string; url: string; verifiedAt?: string }[];
};

export type EventFilters = {
  query?: string;
  city?: string;
  venue?: string;
  category?: Category;
  from?: string;
  until?: string;
  maxPrice?: number;
  age?: number;
  sort?: 'date' | 'price';
  page?: number;
  limit?: number;
};

export type EventPage = {
  events: CatalogEvent[];
  page: number;
  limit: number;
  total: number;
};

export type Subscription = { city: string; category: Category };
export type ImportReport = {
  added: number;
  updated: number;
  unchanged: number;
  rejected: { row: number; reason: string }[];
};

const categoriesSql = "('concert','theatre','exhibition','festival','cinema','tour','other')";
const schema = `
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  search_text TEXT NOT NULL,
  city TEXT NOT NULL,
  city_key TEXT NOT NULL,
  venue TEXT NOT NULL,
  venue_key TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ${categoriesSql}),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  price_min REAL,
  age_limit INTEGER,
  status TEXT NOT NULL CHECK (status IN ('published','draft','cancelled')),
  status_override TEXT CHECK (status_override IN ('published','draft','cancelled')),
  details TEXT NOT NULL
);
CREATE INDEX events_schedule ON events(status, starts_at, id);
CREATE TABLE sources (
  source_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('api','scrape','import','manual')),
  hash TEXT NOT NULL,
  verified_at TEXT,
  normalized TEXT NOT NULL,
  raw TEXT NOT NULL
);
CREATE INDEX sources_event ON sources(event_id);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE TABLE subscriptions (
  subscriber TEXT NOT NULL,
  city TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ${categoriesSql}),
  PRIMARY KEY (subscriber, city, category)
);
PRAGMA user_version = 1;
`;

export function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    return;
  }
}

function dateTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match || !isLocalDate(match[1])) return;
  const date = new Date(value);
  if (Number.isFinite(date.valueOf())) return date.toISOString();
}

export function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function eventIdentity(event: SourceEvent): string {
  return JSON.stringify([normalizeText(event.city), normalizeText(event.venue),
    normalizeText(event.title), event.startsAt]);
}

function validateEvent(event: SourceEvent): SourceEvent {
  const required = [event.title, event.city, event.venue, event.sourceName, event.sourceKey];
  if (required.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) {
    throw new Error('Заполните название, город, площадку и источник.');
  }
  if (!Object.hasOwn(categories, event.category)) throw new Error('Неизвестная категория.');
  if (!['published', 'draft', 'cancelled'].includes(event.status)) throw new Error('Неизвестный статус.');
  if (!['api', 'scrape', 'import', 'manual'].includes(event.sourceType)) throw new Error('Неизвестный тип источника.');
  const sourceUrl = publicUrl(event.sourceUrl);
  if (!sourceUrl) throw new Error('Укажите HTTPS-ссылку на источник.');
  const startsAt = dateTime(event.startsAt);
  if (!startsAt) throw new Error('Укажите дату и время начала с часовым поясом.');
  const endsAt = dateTime(event.endsAt);
  if (event.endsAt !== undefined && (!endsAt || endsAt <= startsAt)) throw new Error('Проверьте время окончания.');
  if ([event.priceMin, event.priceMax].some(price => price !== undefined && (!Number.isFinite(price) || price < 0))) {
    throw new Error('Цена должна быть неотрицательным числом.');
  }
  if (event.priceMin !== undefined && event.priceMax !== undefined && event.priceMax < event.priceMin) {
    throw new Error('Верхняя граница цены меньше нижней.');
  }
  if (event.ageLimit !== undefined && (!Number.isInteger(event.ageLimit) || event.ageLimit < 0 || event.ageLimit > 21)) {
    throw new Error('Укажите возрастное ограничение от 0 до 21 года.');
  }
  if (event.latitude !== undefined && (!Number.isFinite(event.latitude) || Math.abs(event.latitude) > 90)) {
    throw new Error('Некорректная широта.');
  }
  if (event.longitude !== undefined && (!Number.isFinite(event.longitude) || Math.abs(event.longitude) > 180)) {
    throw new Error('Некорректная долгота.');
  }
  if (event.confidence !== undefined && (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)) {
    throw new Error('Уверенность должна быть в диапазоне от 0 до 1.');
  }
  const verifiedAt = dateTime(event.verifiedAt);
  if (event.verifiedAt !== undefined && !verifiedAt) throw new Error('Некорректная дата проверки.');
  return {
    ...event, title: event.title.trim(), city: event.city.trim(), venue: event.venue.trim(),
    sourceName: event.sourceName.trim(), sourceKey: event.sourceKey.trim(), sourceUrl, startsAt, endsAt, verifiedAt,
    imageUrl: publicUrl(event.imageUrl), ticketUrl: publicUrl(event.ticketUrl),
  };
}

function detailsOf(event: SourceEvent): EventDetails {
  return {
    title: event.title, city: event.city, venue: event.venue, category: event.category,
    startsAt: event.startsAt, endsAt: event.endsAt, address: event.address,
    description: event.description, priceMin: event.priceMin, priceMax: event.priceMax,
    ageLimit: event.ageLimit, language: event.language, latitude: event.latitude, longitude: event.longitude,
    imageUrl: event.imageUrl, ticketUrl: event.ticketUrl, status: event.status,
  };
}

type EventRow = { id: string; details: string; status: EventStatus; sources: string };
type SourceRow = { event_id: string; hash: string };
type CanonicalRow = { id: string; identity: string; status_override: EventStatus | null };

const selectEvents = `SELECT events.id, events.details, events.status,
  COALESCE((SELECT json_group_array(json(source_item)) FROM
    (SELECT json_object('name', name, 'url', url, 'verifiedAt', verified_at) AS source_item
     FROM sources WHERE event_id = events.id GROUP BY url ORDER BY MAX(verified_at) DESC, url)), '[]') AS sources
  FROM events`;

function readEvent(row: EventRow): CatalogEvent {
  const sources = JSON.parse(row.sources) as { name: string; url: string; verifiedAt: string | null }[];
  return {
    ...(JSON.parse(row.details) as EventDetails), id: row.id, status: row.status,
    sources: sources.map(source => ({ ...source, verifiedAt: source.verifiedAt ?? undefined })),
  };
}

export function openCatalog(filename = 'data/catalog.sqlite', clock = () => new Date()) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  database.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    if (version === 0) database.exec(schema);
    else if (version !== 1) throw new Error(`Unsupported catalog schema version: ${version}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }

  function writeCanonical(id: string, identity: string, event: EventDetails, status: EventStatus) {
    database.prepare(`INSERT INTO events
      (id, identity, title, search_text, city, city_key, venue, venue_key, category, starts_at, ends_at, price_min, age_limit, status, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET identity=excluded.identity, title=excluded.title, search_text=excluded.search_text,
        city=excluded.city, city_key=excluded.city_key, venue=excluded.venue, venue_key=excluded.venue_key,
        category=excluded.category, starts_at=excluded.starts_at, ends_at=excluded.ends_at, price_min=excluded.price_min,
        age_limit=excluded.age_limit, status=excluded.status, details=excluded.details`)
      .run(id, identity, event.title, normalizeText([event.title, event.city, event.venue, event.description, event.language].filter(Boolean).join(' ')),
        event.city, normalizeText(event.city), event.venue, normalizeText(event.venue), event.category, event.startsAt,
        event.endsAt ?? null, event.priceMin ?? null, event.ageLimit ?? null, status, JSON.stringify(event));
  }

  function rebuildCanonical(id: string, identity: string, override: EventStatus | null) {
    const records = database.prepare(`SELECT normalized FROM sources WHERE event_id = ?
      ORDER BY CASE type WHEN 'manual' THEN 0 WHEN 'api' THEN 1 WHEN 'import' THEN 2 ELSE 3 END,
        verified_at DESC, source_key`).all(id);
    const sourceDetails = records.map(record => JSON.parse(String(record.normalized)) as EventDetails);
    const primary = sourceDetails.find(event => event.status === 'published') ?? sourceDetails[0];
    if (!primary) throw new Error('Cannot rebuild an event without a source.');
    const status = override ?? (sourceDetails.some(event => event.status === 'cancelled') ? 'cancelled' : primary.status);
    // Keep related fields together so that ranges and coordinate pairs always agree with a source.
    const price = sourceDetails.find(event => event.priceMin !== undefined || event.priceMax !== undefined);
    const coordinates = sourceDetails.find(event => event.latitude !== undefined && event.longitude !== undefined);
    const merged = {
      ...primary, priceMin: price?.priceMin, priceMax: price?.priceMax,
      latitude: coordinates?.latitude, longitude: coordinates?.longitude,
    };
    for (const field of ['endsAt', 'address', 'description', 'ageLimit', 'language', 'imageUrl', 'ticketUrl'] as const) {
      const source = sourceDetails.find(event => event[field] !== undefined);
      if (source) Object.assign(merged, { [field]: source[field] });
    }
    writeCanonical(id, identity, merged, status);
  }

  function recordChange(id: string, actor: string, action: string, details: unknown) {
    database.prepare('INSERT INTO audit_log (event_id, actor, action, recorded_at, details) VALUES (?, ?, ?, ?, ?)')
      .run(id, actor, action, clock().toISOString(), JSON.stringify(details));
  }

  function importEvents(events: readonly SourceEvent[], actor = 'import'): ImportReport {
    const report: ImportReport = { added: 0, updated: 0, unchanged: 0, rejected: [] };
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const [index, input] of events.entries()) {
        let event: SourceEvent;
        let raw: string;
        try {
          event = validateEvent(input);
          raw = JSON.stringify(event.raw ?? null);
        } catch (error) {
          report.rejected.push({ row: index + 1, reason: error instanceof Error ? error.message : 'Некорректная запись.' });
          continue;
        }
        const identity = eventIdentity(event);
        const sourceKey = `${event.sourceType}:${event.sourceKey}`;
        const source = database.prepare('SELECT event_id, hash FROM sources WHERE source_key = ?')
          .get(sourceKey) as SourceRow | undefined;
        const matching = database.prepare('SELECT id, identity, status_override FROM events WHERE identity = ?')
          .get(identity) as CanonicalRow | undefined;
        const sourceDetails = detailsOf(event);
        const normalized = JSON.stringify({ ...sourceDetails, confidence: event.confidence });
        const hash = createHash('sha256').update(JSON.stringify([event.sourceName, event.sourceUrl, normalized])).digest('hex');

        if (source?.hash === hash) {
          database.prepare('UPDATE sources SET verified_at = COALESCE(?, verified_at), raw = ? WHERE source_key = ?')
            .run(event.verifiedAt ?? null, raw, sourceKey);
          report.unchanged++;
          continue;
        }

        const previous = source && database.prepare('SELECT id, identity, status_override FROM events WHERE id = ?')
          .get(source.event_id) as CanonicalRow | undefined;
        const otherSources = previous && Number(database.prepare('SELECT count(*) AS total FROM sources WHERE event_id = ? AND source_key != ?')
          .get(previous.id, sourceKey)?.total);
        const existing = matching ?? (otherSources ? undefined : previous);
        const id = existing?.id ?? randomUUID();
        if (!existing) writeCanonical(id, identity, sourceDetails, sourceDetails.status);

        database.prepare(`INSERT INTO sources (source_key, event_id, name, url, type, hash, verified_at, normalized, raw)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET event_id=excluded.event_id,
          name=excluded.name, url=excluded.url, hash=excluded.hash, verified_at=COALESCE(excluded.verified_at, sources.verified_at),
          normalized=excluded.normalized, raw=excluded.raw`)
          .run(sourceKey, id, event.sourceName, event.sourceUrl, event.sourceType, hash, event.verifiedAt ?? null, normalized, raw);

        if (previous && previous.id !== id) {
          if (otherSources) rebuildCanonical(previous.id, previous.identity, previous.status_override);
          else {
            database.prepare("UPDATE events SET status = 'draft' WHERE id = ?").run(previous.id);
            recordChange(previous.id, actor, 'merged', { into: id });
          }
        }
        rebuildCanonical(id, identity, existing?.status_override ?? null);
        recordChange(id, actor, existing ? 'updated' : 'added', { sourceKey, fields: sourceDetails });
        if (existing) report.updated++;
        else report.added++;
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return report;
  }

  function search(filters: EventFilters = {}): EventPage {
    const page = Math.min(10_000, Math.max(1, Math.trunc(filters.page ?? 1)));
    const limit = Math.min(50, Math.max(1, Math.trunc(filters.limit ?? 12)));
    const conditions = ["status = 'published'", 'COALESCE(ends_at, starts_at) >= ?'];
    const parameters: (number | string)[] = [clock().toISOString()];
    function add(condition: string, value: number | string | undefined) {
      if (value === undefined || value === '') return;
      conditions.push(condition);
      parameters.push(value);
    }
    add('city_key = ?', filters.city && normalizeText(filters.city));
    add('venue_key = ?', filters.venue && normalizeText(filters.venue));
    add('category = ?', filters.category);
    add('COALESCE(ends_at, starts_at) >= ?', filters.from);
    add('starts_at < ?', filters.until);
    add('price_min <= ?', filters.maxPrice);
    add('age_limit <= ?', filters.age);
    for (const term of normalizeText(filters.query ?? '').split(' ').filter(Boolean).slice(0, 12)) {
      add('instr(search_text, ?) > 0', term);
    }
    const where = conditions.join(' AND ');
    const order = filters.sort === 'price' ? 'price_min IS NULL, price_min, starts_at, id' : 'starts_at, id';
    const total = Number(database.prepare(`SELECT count(*) AS total FROM events WHERE ${where}`).get(...parameters)?.total);
    const rows = database.prepare(`${selectEvents} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...parameters, limit, (page - 1) * limit) as EventRow[];
    return { events: rows.map(readEvent), page, limit, total };
  }

  function getEvent(id: string): CatalogEvent | undefined {
    const row = database.prepare(`${selectEvents} WHERE id = ? AND status != 'draft'`).get(id) as EventRow | undefined;
    return row && readEvent(row);
  }

  function directories() {
    const list = database.prepare(`SELECT city, venue FROM events WHERE status = 'published'
      AND COALESCE(ends_at, starts_at) >= ? GROUP BY city_key, venue_key ORDER BY city, venue`).all(clock().toISOString());
    return {
      cities: Array.from(new Set(list.map(record => String(record.city)))).sort((first, second) => first.localeCompare(second, 'ru')),
      venues: list.map(record => ({ city: String(record.city), name: String(record.venue) })),
      categories: Object.entries(categories).map(([id, label]) => ({ id: id as Category, label })),
    };
  }

  function setStatus(id: string, status: EventStatus) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database.prepare('SELECT status, status_override FROM events WHERE id = ?').get(id);
      if (existing && (existing.status !== status || existing.status_override !== status)) {
        database.prepare('UPDATE events SET status = ?, status_override = ? WHERE id = ?').run(status, status, id);
        recordChange(id, 'admin', 'status', { from: existing.status, to: status });
      }
      database.exec('COMMIT');
      return Boolean(existing);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    search, getEvent, directories, importEvents, setStatus,
    hasSources: () => Boolean(database.prepare('SELECT 1 FROM sources LIMIT 1').get()),
    close: () => database.close(),
    subscribe(subscriber: string, subscription: Subscription) {
      database.prepare('INSERT OR IGNORE INTO subscriptions (subscriber, city, category) VALUES (?, ?, ?)')
        .run(subscriber, subscription.city, subscription.category);
    },
    subscriptions(subscriber: string): Subscription[] {
      return database.prepare('SELECT city, category FROM subscriptions WHERE subscriber = ? ORDER BY city, category')
        .all(subscriber).map(record => ({ city: String(record.city), category: record.category as Category }));
    },
    unsubscribe(subscriber: string) {
      return Number(database.prepare('DELETE FROM subscriptions WHERE subscriber = ?').run(subscriber).changes);
    },
  };
}

export type Catalog = ReturnType<typeof openCatalog>;
