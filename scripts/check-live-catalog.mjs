import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { openDatabase } from '../apps/api/src/database.ts';
import { openPostgresCatalog } from '../apps/api/src/postgres-catalog.ts';
import { createDiscovery } from '../apps/api/src/discover.ts';
import { registerApi } from '../apps/api/src/api.ts';
import { modelInterpreter, modelRecommender } from '../apps/api/src/model.ts';
import { datePeriod, localDate, localDay } from '../apps/api/src/filters.ts';

const suites = JSON.parse(await readFile(new URL('../test/evaluation/live-catalog-november-2026.json', import.meta.url), 'utf8'));
const cases = suites.flatMap(suite => suite.cases.map(scenario => ({ ...scenario, suite: suite.name })));
const interpret = modelInterpreter(process.env);
const recommend = modelRecommender(process.env);
assert.ok(interpret && recommend, 'Configure the discovery model.');
const catalog = openPostgresCatalog(openDatabase());
const server = Fastify();
const succeeded = { interpretation: 0, recommendation: 0 };
let modelFailures = 0;
registerApi(server, catalog, { discover: createDiscovery(catalog, {
  interpret: async (...args) => {
    const result = await interpret(...args);
    succeeded.interpretation++;
    return result;
  },
  recommend: async (...args) => {
    const result = await recommend(...args);
    succeeded.recommendation++;
    return result;
  },
  onInterpretFailure: () => { modelFailures++; },
}) });

const time = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function identifies(event, { title, start, source }) {
  return event.title === title && (!start || Date.parse(event.startsAt) === Date.parse(start)) &&
    (!source || event.sources.some(item => item.url === source));
}

function check({ expect, context, recommendation }, body) {
  const { includes = [], excludes = [], status, messageIncludes, ...fields } = expect;
  if (status) assert.equal(body.status, status, 'status');
  else if (includes.length) assert.equal(body.status, 'matches', 'status');
  if (messageIncludes) assert.ok(body.message.includes(messageIncludes), 'missing explanation: ' + messageIncludes);
  for (const [field, value] of Object.entries(fields)) assert.equal(body.context[field], value, field);
  for (const field of Object.keys(context ?? {})) {
    if (!Object.hasOwn(fields, field)) assert.equal(body.context[field], context[field], 'follow-up changed ' + field);
  }

  const events = body.events.map(({ event }) => event);
  if (recommendation) {
    assert.match(body.message, /Я бы начал с/u);
    assert.ok(body.context.preference, 'preference missing');
  }
  for (const target of includes) assert.ok(events.some(event => identifies(event, target)), 'missing ' + target.title + ' at ' + target.start);
  for (const target of excludes) assert.ok(!events.some(event => identifies(event, target)), 'returned excluded ' + target.title);
  const from = fields.date || fields.fromDate;
  const until = fields.date || fields.untilDate;
  const lower = from && datePeriod(from).from;
  const upper = until && datePeriod(localDay(until, 1)).from;
  for (const event of events) {
    assert.equal(event.status, 'published');
    assert.ok(event.sources.length && event.sources.every(source => new URL(source.url).hostname !== 'demo.example'));
    for (const field of ['city', 'category', 'venue', 'language']) {
      if (fields[field]) assert.equal(event[field], fields[field], field + ' leaked');
    }
    if (lower) assert.ok((event.endsAt ?? event.startsAt) >= lower, 'date lower bound leaked');
    if (upper) assert.ok(event.startsAt < upper, 'date upper bound leaked');
    if (fields.childAge !== undefined) assert.ok(event.ageLimit <= fields.childAge, 'age leaked');
    if (fields.budget !== undefined) assert.ok(event.priceMin * (body.context.partySize ?? 1) <= fields.budget, 'budget leaked');
    if (fields.free) assert.equal(event.priceMin, 0, 'non-free event');
    if (fields.earliestStart) assert.ok(time.format(new Date(event.startsAt)) >= fields.earliestStart, 'start time leaked');
    if (fields.latestEnd) assert.ok(event.endsAt && localDate(new Date(event.startsAt)) === localDate(new Date(event.endsAt)) &&
      time.format(new Date(event.endsAt)) <= fields.latestEnd, 'end time leaked');
  }
}

const results = [];
let cursor = 0;
try {
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < cases.length) {
      const index = cursor++;
      const scenario = cases[index];
      try {
        const response = await server.inject({
          method: 'POST', url: '/api/v1/discover', payload: { message: scenario.message, context: scenario.context },
        });
        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.ok(!body.message.startsWith('ИИ временно недоступен.'), 'model fallback');
        check(scenario, body);
        results[index] = { pass: true };
      } catch (error) {
        results[index] = { pass: false, reason: error.message };
      }
    }
  }));
  for (const [index, result] of results.entries()) {
    const scenario = cases[index];
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${index + 1} ${scenario.suite} ${scenario.message}${result.reason ? ' — ' + result.reason : ''}`);
  }
  const passed = results.filter(result => result.pass).length;
  console.log(JSON.stringify({ distinct: new Set(cases.map(scenario => scenario.message)).size,
    passed, failed: results.length - passed, modelCallsSucceeded: succeeded, modelFailures }));
  if (passed !== results.length || modelFailures) process.exitCode = 1;
} finally {
  await server.close();
  await catalog.close();
}
