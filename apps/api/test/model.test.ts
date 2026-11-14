import assert from 'node:assert/strict';
import test from 'node:test';
import { modelInterpreter } from '../src/model.ts';

test('uses the Timeweb key, model and endpoint with structured output', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.timeweb.ai/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: '{"city":"Уфа","category":"theatre"}' } }] });
  };
  try {
    const interpret = modelInterpreter({ TIMEWEB_API_KEY: 'test-key', BASE_URL: 'https://api.timeweb.ai/v1' });
    assert.ok(interpret);
    assert.deepEqual(await interpret('Театр в Уфе', {}, [], '2026-11-14'), { city: 'Уфа', category: 'theatre' });
    assert.equal(requestBody?.model, 'openai/gpt-6-luna');
    assert.deepEqual(requestBody?.response_format, { type: 'json_object' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to the local parser when the provider cannot answer', async () => {
  const { createDiscovery } = await import('../src/discover.ts');
  const { openCatalog } = await import('../src/catalog.ts');
  const catalog = openCatalog(':memory:');
  let failures = 0;
  try {
    const discover = createDiscovery(catalog, {
      interpret: async () => { throw new Error('provider unavailable'); },
      onInterpretFailure: () => { failures++; },
    });
    const answer = await discover('События в Уфе');
    assert.equal(failures, 1);
    assert.equal(answer.context.city, 'Уфа');
    assert.match(answer.message, /ИИ временно недоступен/);
  } finally {
    catalog.close();
  }
});
