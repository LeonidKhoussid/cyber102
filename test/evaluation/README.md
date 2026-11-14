# Analytics control queries

The main and external suites use the supplied `afisha_hackathon_bundle_v3` synthetic events as of 13 November 2026. The YAML files are copied from v3 and the JSON files contain the same suite data for the Node runner. The full evaluation covers 79 main turns and 10 external turns.

From the app directory, run:

```sh
node scripts/evaluate-analytics.ts > /tmp/afisha-analytics-evaluation.json
```

The default runner imports the fixture into an in-memory catalog, fixes the clock to 13 November 2026, and exercises the actual discovery HTTP handler with the local interpreter. Multi-turn cases carry the previous response context forward. To repeat the live model comparison, run the fixed 23-turn subset with the configured provider. This mode makes billable model calls.

```sh
node --env-file=.env scripts/evaluate-analytics.ts --live-model > /tmp/afisha-live-model.json
```

The report compares returned canonical event IDs with the suites' `must_include_ids` and `must_exclude_ids`. A source event excluded by a case may share a canonical ID with another fixture row; exclusion is reported as ambiguous unless the case excludes every row merged into that card. Missing mappings are reported separately. The endpoint returns at most five cards, while some expectations name more than five. An absent ID therefore is an observation, not proof of an incorrect answer.

The reports measure event ID matches and exclusions, HTTP status, elapsed time, and fallback use. The original expected-tool labels and other criteria remain unchanged. The ID comparison alone cannot grade clarification quality, route planning, cost, or the organizer's complete rubric. Keep the external suite separate when tuning against the main suite.

## Live catalog acceptance

The dated November 2026 cases use the configured SQLite catalog and fresh model calls through the discovery HTTP handler. They assert source URLs, session times, filter boundaries, exclusions and selected recommendation behavior across cities. Run while the specified sessions are still upcoming. The command makes billable requests.

```sh
node --env-file=.env scripts/check-live-catalog.mjs
```

## Browser acceptance tests

Install the pinned Playwright browser, then run the tests from the app directory.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

Set `CHROMIUM_EXECUTABLE` to an installed Chromium or Chrome executable to use it in an isolated headless process. The runner starts Fastify and Vite on temporary local ports and creates an in-memory catalog from the same synthetic fixture. Each scenario gets a fresh browser context. The clock is fixed to 13 November 2026 in Bashkortostan. The voice test uses synthetic audio and stubs the external transcription endpoint. Search always runs through the real API with the model disabled.

The runner checks returned facts, rendered cards, clarification and follow-up behavior, cancelled-event exclusion, and source links. It exits with a failure if any scenario fails. To compare a second source tree with installed dependencies, run `npm run test:e2e -- --app-dir /path/to/app` with the same fixture in both trees.
