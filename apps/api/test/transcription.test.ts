import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { openCatalog } from '../src/catalog.ts';
import { registerApi } from '../src/api.ts';
import { createDiscovery } from '../src/discover.ts';
import { transcriber } from '../src/transcription.ts';

test('transcribes a browser recording and rejects invalid uploads before calling the provider', async t => {
  const catalog = openCatalog(':memory:');
  const server = Fastify();
  let calls = 0;
  const recording = Buffer.from('browser audio');
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    calls++;
    assert.equal(String(input), 'https://api.timeweb.ai/v1/audio/transcriptions');
    const form = init.body as FormData;
    assert.equal(form.get('model'), 'openai/gpt-4o-mini-transcribe');
    assert.equal(form.get('language'), 'ru');
    const file = form.get('file') as File;
    assert.equal(file.name, 'question.webm');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), recording);
    return Response.json({ text: '  Куда сходить в Уфе?  ' });
  });
  registerApi(server, catalog, { discover: createDiscovery(catalog), transcribe: transcriber({ TIMEWEB_API_KEY: 'test' }) });
  const upload = (contentType: string, payload: Buffer) => server.inject({
    method: 'POST', url: '/api/v1/transcribe', headers: { 'content-type': contentType }, payload,
  });
  try {
    assert.equal((await upload('text/plain', recording)).statusCode, 415);
    assert.equal((await upload('audio/webm', Buffer.alloc(0))).statusCode, 400);
    assert.equal((await upload('audio/webm', Buffer.alloc(1_048_577))).statusCode, 413);
    assert.equal(calls, 0);
    const response = await upload('audio/webm;codecs=opus', recording);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { text: 'Куда сходить в Уфе?' });
    assert.equal(calls, 1);
  } finally {
    await server.close();
    catalog.close();
  }
});
