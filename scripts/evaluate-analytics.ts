import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { registerApi } from '../apps/api/src/api.ts';
import { openCatalog } from '../apps/api/src/catalog.ts';
import { createDiscovery } from '../apps/api/src/discover.ts';
import { modelInterpreter } from '../apps/api/src/model.ts';
import { importAnalyticsFixture } from '../test/fixtures/analytics/import.ts';

type Expectation = {
  query: string;
  expected_tool?: string;
  must_include_ids?: string[];
  must_exclude_ids?: string[];
};
type Case = Expectation & { id: string; turns?: Expectation[] };
type Suite = { suite: string; queries: Case[] };
type Result = {
  suite: string; case: string; turn: number; expectedTool?: string; status: number; discoveryStatus: string;
  expectedIncluded: number; missingIncluded: string[]; excludedReturned: string[];
  ambiguousExcluded: string[]; missingMappings: string[];
  elapsedMs: number; usedFallback: boolean;
};

// The live sample covers first searches, multi-turn behavior and both supplied suites.
const liveSample = new Set([
  'q-02', 'q-03', 'q-04', 'q-08', 'q-14', 'q-16', 'q-22', 'q-24', 'q-26',
  'q-29', 'q-32', 'q-48', 'q-56', 'ext-01', 'ext-02', 'ext-03', 'ext-04', 'ext-07',
]);

async function run() {
  const live = process.argv.includes('--live-model');
  const interpret = live ? modelInterpreter(process.env) : undefined;
  if (live && !interpret) throw new Error('Configure the discovery model before running the live sample.');
  const clock = () => new Date('2026-11-13T12:00:00+05:00');
  const catalog = openCatalog(':memory:', clock);
  const server = Fastify({ logger: false });
  try {
    const { report, ids } = await importAnalyticsFixture(catalog);
    if (report.rejected.length) throw new Error(`Fixture import rejected ${report.rejected.length} rows`);
    registerApi(server, catalog, { discover: createDiscovery(catalog, { clock, interpret }) });
    const suites = await Promise.all(['control_queries_65_uuid', 'control_queries_external10_uuid'].map(async name =>
      JSON.parse(await readFile(new URL(`../test/evaluation/${name}.json`, import.meta.url), 'utf8')) as Suite));
    const sourceIdsByCanonical = new Map<string, string[]>();
    for (const [sourceId, canonicalId] of Object.entries(ids)) {
      const existing = sourceIdsByCanonical.get(canonicalId) ?? [];
      existing.push(sourceId);
      sourceIdsByCanonical.set(canonicalId, existing);
    }
    const results: Result[] = [];
    for (const suite of suites) {
      for (const testCase of suite.queries) {
        if (live && !liveSample.has(testCase.id)) continue;
        let context: unknown;
        for (const [turnIndex, turn] of (testCase.turns ?? [testCase]).entries()) {
          const started = performance.now();
          const response = await server.inject({ method: 'POST', url: '/api/v1/discover', payload: { message: turn.query, context } });
          const elapsedMs = Math.round(performance.now() - started);
          const body = response.json();
          context = body.context;
          const observed = new Set<string>((body.events ?? []).map((item: { event: { id: string } }) => item.event.id));
          const included = turn.must_include_ids ?? [];
          const excluded = turn.must_exclude_ids ?? [];
          // A canonical card does not identify which merged source was shown.
          // An exclusion is decidable only if every source for that card is excluded.
          const excludedSet = new Set(excluded);
          const ambiguous = excluded.filter(id => ids[id] &&
            (sourceIdsByCanonical.get(ids[id]) ?? []).some(sourceId => !excludedSet.has(sourceId)));
          const ambiguousSet = new Set(ambiguous);
          const missingMappings = [...included, ...excluded].filter(id => !ids[id]);
          results.push({ suite: suite.suite, case: testCase.id, turn: turnIndex + 1, expectedTool: turn.expected_tool,
            status: response.statusCode, discoveryStatus: body.status, elapsedMs,
            usedFallback: body.message?.startsWith('ИИ временно недоступен.') ?? false,
            expectedIncluded: included.length,
            missingIncluded: included.filter(id => !ids[id] || !observed.has(ids[id])),
            excludedReturned: excluded.filter(id => ids[id] && !ambiguousSet.has(id) && observed.has(ids[id])),
            ambiguousExcluded: ambiguous, missingMappings,
          });
        }
      }
    }
    const summary = suites.map(suite => {
      const rows = results.filter(result => result.suite === suite.suite);
      return { suite: suite.suite, turns: rows.length, httpErrors: rows.filter(row => row.status !== 200).length,
        turnsWithExpectedIds: rows.filter(row => row.expectedIncluded).length,
        turnsFindingExpectedIds: rows.filter(row => row.expectedIncluded > row.missingIncluded.length).length,
        fallbackTurns: rows.filter(row => row.usedFallback).length,
        turnsMissingExpectedIds: rows.filter(row => row.missingIncluded.length).length,
        turnsReturningExcludedIds: rows.filter(row => row.excludedReturned.length).length,
        turnsWithAmbiguousExclusions: rows.filter(row => row.ambiguousExcluded.length).length,
        turnsWithMissingMappings: rows.filter(row => row.missingMappings.length).length };
    });
    console.log(JSON.stringify({
      mode: live ? 'live_model_subset' : 'isolated_offline_discovery_id_checks_only',
      note: 'Synthetic fixture and fixed clock. ID observations are limited to five cards and merged source IDs.',
      unmeasured: ['factual claims', 'expected tool calls and arguments', 'security', 'clarifications', 'planning', 'constraints', 'cost'],
      importReport: report, summary, results,
    }, null, 2));
  } finally {
    await server.close();
    catalog.close();
  }
}

await run();
