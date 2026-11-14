import { readFileSync } from 'node:fs';
import type { Catalog, Category, SourceEvent } from '../../../apps/api/src/catalog.ts';

type FixtureEvent = {
  id: string; title: string; category: string; date_start: string; date_end: string | null;
  city: string; venue: string; address: string | null; lat: number | null; lon: number | null;
  description: string | null; price_min: number | null; price_max: number | null;
  age_limit: number | null; language: string | null; status: string; source_url: string;
};
type Fixture = { meta: { synthetic_test_data?: boolean }; events: FixtureEvent[] };

const categories: Record<string, Category> = {
  концерт: 'concert', спектакль: 'theatre', выставка: 'exhibition', фестиваль: 'festival',
  кино: 'cinema', экскурсия: 'tour', другое: 'other',
};
const statuses: Record<string, SourceEvent['status']> = {
  опубликовано: 'published', черновик: 'draft', отменено: 'cancelled',
};

/** Load the supplied synthetic data only into a catalog provided by the caller. */
export function importAnalyticsFixture(catalog: Catalog, variant: 'full' | 'clean' = 'full') {
  const filename = variant === 'clean' ? 'events_import_clean_104.json' : 'events_import_126.json';
  const fixture = JSON.parse(readFileSync(new URL(filename, import.meta.url), 'utf8')) as Fixture;
  if (fixture.meta.synthetic_test_data !== true || !Array.isArray(fixture.events)) throw new Error('Invalid synthetic fixture');
  const keys = new Set<string>();
  const events: SourceEvent[] = fixture.events.map(row => {
    if (!row.id || keys.has(row.id) || !categories[row.category] || !statuses[row.status]) {
      throw new Error(`Invalid fixture event: ${row.id}`);
    }
    keys.add(row.id);
    return {
      sourceKey: `analytics:${row.id}`, sourceName: 'Synthetic analytics fixture', sourceType: 'import',
      sourceUrl: row.source_url, title: row.title, category: categories[row.category], startsAt: row.date_start,
      endsAt: row.date_end ?? undefined, city: row.city, venue: row.venue, address: row.address ?? undefined,
      latitude: row.lat ?? undefined, longitude: row.lon ?? undefined, description: row.description ?? undefined,
      priceMin: row.price_min ?? undefined, priceMax: row.price_max ?? undefined,
      ageLimit: row.age_limit ?? undefined, language: row.language ?? undefined, status: statuses[row.status], raw: row,
    };
  });
  const report = catalog.importEvents(events, 'synthetic fixture');
  if (report.rejected.length) throw new Error(`Fixture rows rejected: ${JSON.stringify(report.rejected)}`);
  const ids: Record<string, string> = {};
  for (const event of events) {
    const id = catalog.eventIdForSource(event.sourceType, event.sourceKey);
    if (!id) throw new Error(`Fixture source missing: ${event.sourceKey}`);
    ids[event.sourceKey.slice('analytics:'.length)] = id;
  }
  return { report, ids };
}
