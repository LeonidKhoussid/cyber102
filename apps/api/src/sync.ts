import type { Catalog } from './catalog.ts';
import { collectSources } from './sources.ts';

export async function refreshCatalog(catalog: Catalog) {
  const results = await collectSources();
  return results.map(result => ({
    source: result.name,
    collected: result.events.length,
    sourceRejected: result.rejected,
    error: result.error,
    ...catalog.importEvents(result.events, result.name),
  }));
}
