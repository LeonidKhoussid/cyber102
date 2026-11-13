import type { Catalog } from './catalog.ts';
import { sourceReader } from './crawl.ts';
import { collectLibrary, collectYouthTheater } from './local-feeds.ts';
import { collectRegionalEvents } from './regional-feed.ts';
import { collectSources } from './sources.ts';
import type { SourceResult } from './source-data.ts';
import { collectSterlitamakVenues } from './sterlitamak-venues.ts';
import { collectSterlitamak } from './sterlitamak.ts';
import { collectTimepad } from './timepad.ts';

type RefreshReport = ReturnType<Catalog['importEvents']> & {
  source: string;
  collected: number;
  sourceRejected: number;
  durationMs: number;
  error?: string;
};

export async function refreshCatalog(catalog: Catalog, options: {
  fetcher?: typeof fetch;
  now?: Date;
  timepadToken?: string;
  onReport?: (report: RefreshReport) => void;
} = {}) {
  const { fetcher = fetch, now = new Date(), timepadToken = process.env.TIMEPAD_TOKEN?.trim(), onReport } = options;
  const read = sourceReader(fetcher);
  const reports: RefreshReport[] = [];
  function importSource(result: SourceResult, durationMs: number) {
    const report = {
      source: result.name, collected: result.events.length, sourceRejected: result.rejected, durationMs, error: result.error,
      ...catalog.importEvents(result.events, result.name),
    };
    reports.push(report);
    onReport?.(report);
  }
  async function collect(name: string, run: () => Promise<SourceResult>) {
    const started = performance.now();
    let result: SourceResult;
    try {
      result = await run();
    } catch (error) {
      result = { name, events: [], rejected: 0, error: error instanceof Error ? error.message : 'Source unavailable' };
    }
    importSource(result, Math.round(performance.now() - started));
  }
  await Promise.all([
    collectSources({ fetcher, now, onSource: importSource }),
    collect('Русский драматический театр Стерлитамака', () => collectSterlitamak(fetcher, now)),
    collect('Национальный молодёжный театр имени Мустая Карима', () => collectYouthTheater(read, now)),
    collect('Централизованная библиотечная система Стерлитамака', () => collectLibrary(read, now)),
    collect('Стерлитамакское государственное театрально-концертное объединение', () => collectSterlitamakVenues(read, now)),
    collect('Афиша городов', () => collectRegionalEvents(read, now)),
    ...(timepadToken ? [collect('Timepad', () => collectTimepad(read, now, timepadToken))] : []),
  ]);
  return reports;
}
