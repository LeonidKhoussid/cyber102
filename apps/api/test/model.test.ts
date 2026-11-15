import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogEvent } from '@afisha/contracts';
import { modelConversation, modelInterpreter, modelRecommender } from '../src/model.ts';

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

test('Qwen 3.8 Flash uses its gateway model ID and non-thinking JSON mode for chat latency', async context => {
  context.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.timeweb.ai/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'dashscope/qwen3.8-flash');
    assert.equal(body.enable_thinking, false);
    assert.equal(body.reasoning_effort, undefined);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return Response.json({ choices: [{ message: { content: '{"action":"respond","arguments":{"message":"Что вам интересно?"}}' } }] });
  });
  const conversation = modelConversation({ TIMEWEB_API_KEY: 'test-key', DISCOVERY_MODEL: 'dashscope/qwen3.8-flash' });
  assert.ok(conversation);
  assert.equal((await conversation({ message: 'Хочу куда-нибудь сходить' }) as { action: string }).action, 'respond');
});

test('ranks candidate IDs and sends only relevant evidence to the configured provider', async (context) => {
  const candidates: CatalogEvent[] = [{
    id: 'first', title: 'Маскарад', category: 'theatre', description: 'Драма', city: 'Стерлитамак', venue: 'Русдрамтеатр',
    startsAt: '2026-11-21T18:00:00+05:00', status: 'published', priceMin: 600,
    ticketUrl: 'https://tickets.example/1', sources: [],
  }, {
    id: 'second', title: 'Ужин с дураком', category: 'theatre', description: 'Комедия', city: 'Стерлитамак',
    venue: 'Русдрамтеатр', startsAt: '2026-11-15T18:00:00+05:00', status: 'published', sources: [],
  }];
  let content: unknown = {
    picks: [
      { id: 'second', reason: 'Комедия подойдёт для лёгкого вечера.' },
      { id: 'first', reason: 'Ссылка https://tickets.example/1 и билет за 600 рублей.' },
    ],
    question: 'Вам ближе сатира или семейный юмор?',
  };
  context.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.timeweb.ai/v1/chat/completions');
    assert.ok(init?.signal);
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /\bJSON\b/iu);
    const request = JSON.parse(body.messages[1].content);
    assert.deepEqual(request.candidates, candidates.map(({ id, title, category, description, city, venue }) =>
      ({ id, title, category, description, city, venue })));
    assert.equal(request.preferences.origin, undefined);
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
  });
  const recommend = modelRecommender({ TIMEWEB_API_KEY: 'test-key' });
  assert.ok(recommend);
  const ask = () => recommend('Хочется чего-нибудь лёгкого', { origin: '54.7, 55.9' }, candidates);
  assert.deepEqual(await ask(), {
    picks: [{ id: 'second', reason: 'Комедия подойдёт для лёгкого вечера.' }, { id: 'first' }],
    question: 'Вам ближе сатира или семейный юмор?',
  });
  content = { picks: [{ id: 'second' }, { id: 'missing' }] };
  await assert.rejects(ask, /Invalid discovery recommendation ID/u);
  content = { picks: [{ id: 'second' }, { id: 'second' }] };
  await assert.rejects(ask, /Invalid discovery recommendation ID/u);
  content = { picks: [{ id: 'second' }], question: 'Хотите комедию? Или драму?' };
  assert.deepEqual(await ask(), { picks: [{ id: 'second' }] });
  content = { picks: 'second' };
  await assert.rejects(ask, /Invalid discovery recommendation/u);
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
