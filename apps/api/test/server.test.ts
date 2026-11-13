import assert from 'node:assert/strict';
import test from 'node:test';
import { openCatalog } from '../src/catalog.ts';
import { buildServer } from '../src/server.ts';

const nextYear = new Date().getUTCFullYear() + 1;
const record = {
  title: 'Контроль <script>alert(1)</script>', city: 'Уфа', venue: 'Театр для проверки',
  category: 'theatre', status: 'published', startsAt: `${nextYear}-06-14T19:00:00+05:00`,
  sourceName: 'Контрольный источник', sourceUrl: 'https://example.org/catalog-control',
  priceMin: 700, ageLimit: 7,
};

test('HTTP routes share one catalog and keep admin changes private', async () => {
  const catalog = openCatalog(':memory:');
  const server = await buildServer(catalog, { adminToken: 'local-test-only' });
  try {
    const payload = [record];
    const headers = { authorization: 'Bearer local-test-only' };
    const anonymous = await server.inject({ method: 'POST', url: '/api/v1/admin/import', payload });
    assert.equal(anonymous.statusCode, 401);

    const authorized = await server.inject({ method: 'POST', url: '/api/v1/admin/import', headers, payload });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.equal(authorized.json().added, 1);
    const secondImport = await server.inject({ method: 'POST', url: '/api/v1/admin/import', headers, payload });
    assert.equal(secondImport.json().unchanged, 1);

    const search = await server.inject({ method: 'GET', url: '/api/v1/events?maxPrice=700&age=7' });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().total, 1);
    const eventId = search.json().events[0].id as string;
    const detailUrl = `/api/v1/events/${eventId}`;

    const draft = { ...record, sourceKey: 'private-control', status: 'draft', priceMin: 0,
      description: 'Черновик для проверки', sourceUrl: 'https://example.org/private-control' };
    const draftImport = await server.inject({ method: 'POST', url: '/api/v1/admin/events', headers, payload: draft });
    assert.equal(draftImport.statusCode, 200, draftImport.body);
    assert.equal((await server.inject('/api/v1/events?maxPrice=0')).json().total, 0);
    const event = await server.inject(detailUrl);
    assert.equal(event.json().sources.length, 1);
    assert.equal(event.json().sources[0].url, record.sourceUrl);
    assert.equal(event.json().description, undefined);
    assert.ok(event.headers.etag);
    assert.equal((await server.inject({ url: detailUrl, headers: { 'if-none-match': event.headers.etag } })).statusCode, 304);

    const web = await server.inject('/');
    assert.equal(web.statusCode, 200, web.body);
    assert.match(web.body, /Контроль/);
    assert.doesNotMatch(web.body, /<script>alert\(1\)<\/script>/);
    const widget = await server.inject('/widget');
    assert.equal(widget.statusCode, 200);
    assert.match(widget.body, /Контроль/);
    assert.match(String(widget.headers['content-security-policy']), /frame-ancestors \*/);
    assert.equal(widget.headers['set-cookie'], undefined);

    const cancel = await server.inject({ method: 'PATCH', url: `/api/v1/admin/events/${eventId}`, headers, payload: { status: 'cancelled' } });
    assert.equal(cancel.statusCode, 200);
    assert.equal((await server.inject('/api/v1/events')).json().total, 0);
    assert.equal((await server.inject(detailUrl)).json().status, 'cancelled');
    assert.match((await server.inject(`/events/${eventId}`)).body, /Отмен[её]но/i);
    assert.equal((await server.inject('/api/v1/events?maxPrice=-1')).statusCode, 400);
    assert.equal((await server.inject('/api/v1/events?city=Уфа&city=Салават')).statusCode, 400);
    assert.equal((await server.inject('/api/v1/events?age=6')).json().total, 0);
    assert.equal((await server.inject('/health')).json().status, 'ok');
    assert.equal((await server.inject('/openapi.json')).json().openapi, '3.1.0');
  } finally {
    await server.close();
    catalog.close();
  }
});


test('returns 429 instead of 500 when the HTTP request limit is exceeded', async () => {
  const catalog = openCatalog(':memory:');
  const server = await buildServer(catalog);
  try {
    for (let requestNumber = 1; requestNumber <= 180; requestNumber++) {
      assert.equal((await server.inject('/health')).statusCode, 200);
    }
    const rejected = await server.inject('/health');
    assert.equal(rejected.statusCode, 429);
    assert.equal(rejected.json().code, 'rate_limit');
    assert.ok(rejected.headers['retry-after']);
  } finally {
    await server.close();
    catalog.close();
  }
});
