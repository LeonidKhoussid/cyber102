import assert from 'node:assert/strict';
import test from 'node:test';
import { openCatalog } from '../src/catalog.ts';
import type { SourceEvent } from '../src/catalog.ts';
import { parseFilters } from '../src/filters.ts';
import { parseImport } from '../src/import.ts';

const now = new Date('2026-11-13T10:00:00+05:00');
const record: SourceEvent = {
  title: 'Контрольный спектакль', city: 'Уфа', venue: 'Контрольный театр', category: 'theatre',
  startsAt: '2026-11-14T19:00:00+05:00', endsAt: '2026-11-14T21:00:00+05:00',
  ageLimit: 6, priceMin: 600, priceMax: 1000, status: 'published', sourceType: 'import',
  sourceUrl: 'https://example.org/test-event', sourceName: 'Контрольный источник', sourceKey: 'test-event',
  raw: { row: 'control' },
};

test('deduplicates across sources, rejects invalid dates and keeps cancellations out of search after reimport', () => {
  const catalog = openCatalog(':memory:', () => now);
  try {
    assert.deepEqual(catalog.importEvents([record]), { added: 1, updated: 0, unchanged: 0, rejected: [] });
    assert.equal(catalog.importEvents([record]).unchanged, 1);
    const alternate = {
      ...record, sourceType: 'api', sourceKey: 'second', sourceUrl: 'https://example.org/second',
      startsAt: '2026-11-14T14:00:00Z',
    } satisfies SourceEvent;
    assert.equal(catalog.importEvents([alternate]).updated, 1);
    const results = catalog.search(parseFilters({ q: 'СПЕКТАКЛЬ', city: 'Уфа', period: 'weekend', maxPrice: '600', age: '8' }, now));
    assert.equal(results.total, 1);
    assert.equal(results.events[0].sources.length, 2);
    assert.equal(catalog.search({ maxPrice: 599 }).total, 0);
    assert.equal(catalog.search({ age: 5 }).total, 0);
    assert.equal(catalog.importEvents([{ ...record, startsAt: '2026-02-30T18:00:00+05:00' }]).rejected.length, 1);
    const { id } = results.events[0];
    assert.equal(catalog.setStatus(id, 'cancelled'), true);
    catalog.importEvents([{ ...alternate, address: 'Контрольная улица, 1' }]);
    assert.equal(catalog.search().total, 0);
    assert.equal(catalog.getEvent(id)?.status, 'cancelled');
  } finally {
    catalog.close();
  }
});

test('treats unknown prices as unknown and reads CSV with valid zero price', () => {
  const catalog = openCatalog(':memory:', () => now);
  try {
    catalog.importEvents([{ ...record, priceMin: undefined, priceMax: undefined }]);
    const csv = 'title,city,venue,category,startsAt,priceMin,ageLimit,status,sourceUrl,sourceName\nКонтрольная выставка,Уфа,Музей,exhibition,2026-11-14T19:00:00+05:00,0,0,published,https://example.org/exhibit,Контроль';
    assert.equal(catalog.importEvents(parseImport(csv)).added, 1);
    assert.deepEqual(catalog.search({ maxPrice: 0 }).events.map(event => event.title), ['Контрольная выставка']);
    assert.throws(() => parseFilters({ date: '2026-11-31' }, now), /Введите дату/);
    assert.throws(() => parseFilters({ maxPrice: '-1' }, now), /допустимом диапазоне/);
    assert.throws(() => parseFilters({ from: '2026-11-16', until: '2026-11-15' }, now), /окончания/);
  } finally {
    catalog.close();
  }
});

test('keeps subscriptions durable and unsubscribe idempotent', () => {
  const catalog = openCatalog(':memory:', () => now);
  try {
    const subscription = { city: 'Уфа', category: 'theatre' } as const;
    catalog.subscribe('control-1', subscription);
    catalog.subscribe('control-1', subscription);
    assert.deepEqual(catalog.subscriptions('control-1'), [subscription]);
    assert.deepEqual(catalog.subscriptions('control-2'), []);
    assert.equal(catalog.unsubscribe('control-1'), 1);
    assert.equal(catalog.unsubscribe('control-1'), 0);
  } finally {
    catalog.close();
  }
});
