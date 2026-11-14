import type { CatalogStore, ImportReport } from './catalog.ts';
import { bashoperaName, collectBashopera } from './bashopera.ts';
import { collectBashgf } from './bashgf.ts';
import { collectNationalLibrary, nationalLibraryName } from './bashnl.ts';
import { sourceReader } from './crawl.ts';
import { collectGasorb, gasorbName } from './gasorb.ts';
import { collectKinoport, kinoportName } from './kinoport.ts';
import { collectLibrary, collectYouthTheater } from './local-feeds.ts';
import { collectRegionalEvents } from './regional-feed.ts';
import { collectSources } from './sources.ts';
import type { SourceResult } from './source-data.ts';
import { collectSterlitamakCinema, sterlitamakCinemaName } from './sterlitamak-cinema.ts';
import { collectSterlitamakVenues } from './sterlitamak-venues.ts';
import { collectSterlitamak } from './sterlitamak.ts';
import { collectTimepad } from './timepad.ts';
import { collectUfaCinema, ufaCinemaName } from './ufa-cinema.ts';

type RefreshReport = ImportReport & {
  source: string;
  collected: number;
  sourceRejected: number;
  durationMs: number;
  error?: string;
};

export async function refreshCatalog(catalog: CatalogStore, options: {
  fetcher?: typeof fetch;
  now?: Date;
  timepadToken?: string;
  onReport?: (report: RefreshReport) => void;
} = {}) {
  const { fetcher = fetch, now = new Date(), timepadToken = process.env.TIMEPAD_TOKEN?.trim(), onReport } = options;
  const read = sourceReader(fetcher);
  const reports: RefreshReport[] = [];
  async function importSource(result: SourceResult, durationMs: number) {
    const report = {
      source: result.name, collected: result.events.length, sourceRejected: result.rejected, durationMs, error: result.error,
      ...await catalog.importEvents(result.events, result.name),
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
    await importSource(result, Math.round(performance.now() - started));
  }
  await Promise.all([
    collectSources({ fetcher, now, onSource: importSource }),
    collect(bashoperaName, () => collectBashopera(read, now)),
    collect('Башкирская государственная филармония имени Хусаина Ахметова', () => collectBashgf(read, now)),
    collect(nationalLibraryName, () => collectNationalLibrary(read, now)),
    collect(gasorbName, () => collectGasorb(read, now)),
    collect('Русский драматический театр Стерлитамака', () => collectSterlitamak(fetcher, now)),
    collect('Национальный молодёжный театр имени Мустая Карима', () => collectYouthTheater(read, now)),
    collect('Централизованная библиотечная система Стерлитамака', () => collectLibrary(read, now)),
    collect('Стерлитамакское государственное театрально-концертное объединение', () => collectSterlitamakVenues(read, now)),
    collect(sterlitamakCinemaName, () => collectSterlitamakCinema(read, now)),
    collect(kinoportName, () => collectKinoport(fetcher, now)),
    collect(ufaCinemaName, () => collectUfaCinema(read, now)),
    collect('Афиша городов', () => collectRegionalEvents(read, now)),
    ...(timepadToken ? [collect('Timepad', () => collectTimepad(read, now, timepadToken))] : []),
  ]);
  return reports;
}
