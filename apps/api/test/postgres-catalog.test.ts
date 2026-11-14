import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { openCatalog } from '../src/catalog.ts';
import type { SourceEvent } from '../src/catalog.ts';
import { initializeCatalog, migrateSqliteCatalog, openPostgresCatalog } from '../src/postgres-catalog.ts';
import { buildServer } from '../src/server.ts';

const connectionString = process.env.AFISHA_ACCOUNT_TEST_DATABASE_URL;
const clock = () => new Date('2026-11-14T12:00:00+05:00');
const event: SourceEvent = {
  title: 'Семейный концерт «Сказка»', city: 'Уфа', venue: 'Филармония', category: 'concert',
  startsAt: '2026-11-15T12:00:00+05:00', endsAt: '2026-11-15T13:00:00+05:00',
  ageLimit: 6, priceMin: 500, priceMax: 500, sourceKey: 'original', sourceType: 'scrape',
  sourceName: 'Контрольная площадка', sourceUrl: 'https://example.org/event', status: 'published', raw: { original: true },
};

test('migrates and searches a real catalog, keeps IDs, sources and subscriptions, and writes updates', {
  skip: !connectionString,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'afisha-catalog-'));
  const file = join(directory, 'old.sqlite');
  const old = openCatalog(file, clock);
  old.importEvents([event]);
  old.subscribe('123', { city: 'Уфа', category: 'concert' });
  const expected = old.search();
  old.close();

  const admin = new pg.Pool({ connectionString });
  const namespace = 'catalog_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({ connectionString, options: '-c search_path=' + namespace });
  const catalog = openPostgresCatalog(pool, clock);
  try {
    await admin.query('CREATE SCHEMA ' + namespace);
    await initializeCatalog(pool);
    await migrateSqliteCatalog(pool, file);
    await migrateSqliteCatalog(pool, file);
    assert.deepEqual(await catalog.search(), expected);
    assert.equal(await catalog.eventIdForSource('scrape', 'original'), expected.events[0].id);
    assert.deepEqual(await catalog.subscriptions('123'), [{ city: 'Уфа', category: 'concert' }]);

    const updated = await catalog.importEvents([{ ...event, priceMin: 400, priceMax: 400 }]);
    assert.equal(updated.updated, 1);
    assert.equal((await catalog.search({ query: 'сказку', matchWords: true, maxPrice: 399 })).total, 0);
    assert.equal((await catalog.search({ query: 'сказка', sort: 'relevance', maxPrice: 400 })).total, 1);
    assert.equal((await catalog.search({ city: 'Уфа', page: 50, sort: 'family' })).total, 1);

    const server = await buildServer(catalog, { clock, disableModel: true });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/v1/discover',
        payload: { message: 'Концерт в Уфе 15 ноября до 400 рублей' } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().events[0].event.id, expected.events[0].id);
    } finally {
      await server.close();
    }
    assert.equal(await catalog.setStatus(expected.events[0].id, 'cancelled'), true);
    assert.equal((await catalog.search()).total, 0);
    assert.equal((await catalog.getEvent(expected.events[0].id))?.status, 'cancelled');
    assert.equal(await catalog.unsubscribe('123'), 1);
  } finally {
    await catalog.close();
    await admin.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
    await admin.end();
    await rm(directory, { recursive: true });
  }
});
