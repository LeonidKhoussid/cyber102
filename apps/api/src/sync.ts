import type { Catalog } from './catalog.ts';
import { collectSources } from './sources.ts';
import { collectSterlitamak } from './sterlitamak.ts';

export async function refreshCatalog(catalog: Catalog) {
  const [sources, theatre] = await Promise.all([collectSources(), collectSterlitamak(fetch, new Date())]);
  const results = [...sources, theatre];
  return results.map(result => ({
    source: result.name,
    collected: result.events.length,
    sourceRejected: result.rejected,
    error: result.error,
    ...catalog.importEvents(result.events, result.name),
  }));
}
