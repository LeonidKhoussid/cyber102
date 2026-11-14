import assert from 'node:assert/strict';
import test from 'node:test';
import { openCatalog } from '../src/catalog.ts';
import { buildServer } from '../src/server.ts';
import { importAnalyticsFixture } from '../../../test/fixtures/analytics/import.ts';

const clock = () => new Date('2026-11-13T00:00:00+05:00');

test('synthetic fixture imports through the catalog and is searchable over HTTP', async () => {
  const catalog = openCatalog(':memory:', clock);
  const { report, ids } = importAnalyticsFixture(catalog);
  const server = await buildServer(catalog, { clock, disableModel: true });
  try {
    assert.equal(report.added + report.updated + report.unchanged, 126);
    assert.deepEqual(report.rejected, []);
    assert.equal(Object.keys(ids).length, 126);
    assert.equal(importAnalyticsFixture(catalog).report.unchanged, 126);
    const eventId = ids['3b1e5981-f6b1-51d9-9b74-96c5dd64232c'];
    const detail = await server.inject(`/api/v1/events/${eventId}`);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().title, 'Ярмарка выходного дня');
    assert.equal(detail.json().priceMin, 0);
    assert.equal(detail.json().ageLimit, 0);
    assert.match(detail.json().sources[0].url, /^https:\/\/demo\.example\//);
    const search = await server.inject('/api/v1/events?maxPrice=0&age=0');
    assert.ok(search.json().events.some((event: { id: string }) => event.id === eventId));
    const tomorrow = (await server.inject('/api/v1/events?period=tomorrow')).json();
    const fixedDate = (await server.inject('/api/v1/events?date=2026-11-14')).json();
    assert.ok(tomorrow.total > 0);
    assert.deepEqual(tomorrow, fixedDate);
    const opera = await server.inject(`/api/v1/events/${ids['f231ff77-d224-5bc4-becd-ac5072d9bc33']}`);
    assert.equal(opera.statusCode, 200);
    assert.equal(opera.json().address, 'ул. Ленина, 5/1');
    assert.equal((await server.inject('/api/v1/events?maxPrice=-1')).statusCode, 400);
  } finally { await server.close(); catalog.close(); }
});

test('v3 clean subset loads and reimports in an isolated catalog', () => {
  const catalog = openCatalog(':memory:', clock);
  try {
    const { report, ids } = importAnalyticsFixture(catalog, 'clean');
    assert.equal(report.added + report.updated, 104);
    assert.deepEqual(report.rejected, []);
    assert.equal(Object.keys(ids).length, 104);
    assert.equal(importAnalyticsFixture(catalog, 'clean').report.unchanged, 104);
  } finally { catalog.close(); }
});

test('fixture server never uses configured AI credentials', async () => {
  const priorKey = process.env.TIMEWEB_API_KEY;
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  process.env.TIMEWEB_API_KEY = 'test-key';
  globalThis.fetch = async () => { externalRequests++; throw new Error('Unexpected external network request'); };
  const catalog = openCatalog(':memory:', clock);
  const server = await buildServer(catalog, { clock, disableModel: true });
  try {
    importAnalyticsFixture(catalog);
    const result = await server.inject({ method: 'POST', url: '/api/v1/discover', payload: { message: 'Куда пойти в Уфе?' } });
    assert.equal(result.statusCode, 200);
    assert.equal(externalRequests, 0);
  } finally {
    await server.close(); catalog.close(); globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.TIMEWEB_API_KEY; else process.env.TIMEWEB_API_KEY = priorKey;
  }
});
