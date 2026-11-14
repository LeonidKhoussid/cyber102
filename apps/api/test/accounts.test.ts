import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { initializeAccounts, registerAccounts, upsertTelegramUser } from '../src/accounts.ts';
import { initializeChats, registerChats } from '../src/chats.ts';
import type { DiscoveryResponse } from '@afisha/contracts';

const databaseUrl = process.env.AFISHA_ACCOUNT_TEST_DATABASE_URL;
const origin = 'https://afisha.example';

test('PostgreSQL account sessions isolate saved chats and preserve discovery turns', {
  skip: databaseUrl ? false : 'Set AFISHA_ACCOUNT_TEST_DATABASE_URL to run with PostgreSQL.',
}, async () => {
  const schema = 'afisha_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, application_name: schema, options: '-c search_path=' + schema });
  const server = Fastify();
  let calls = 0;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstIsRunning = new Promise<void>(resolve => { firstStarted = resolve; });
  const firstCanFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
  const discover = async (message: string, prior?: unknown): Promise<DiscoveryResponse> => {
    calls++;
    if (message === 'Театры в Уфе') {
      firstStarted();
      await firstCanFinish;
    }
    if (message === 'Ошибка поиска') throw Error('Controlled discovery failure');
    return {
      status: 'no_results', message: 'Город: ' + (message === 'Театры в Уфе' ? 'Уфа' : (prior as { city?: string } | undefined)?.city),
      context: { city: 'Уфа' }, suggestions: [], constraints: [], events: [],
    };
  };
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object, cookie?: string, requestOrigin = origin) =>
    server.inject({ method, url: '/api/v1' + path, payload, headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}) } });
  try {
    await initializeAccounts(pool);
    await initializeChats(pool);
    registerAccounts(server, pool, { origin, telegramEnabled: true });
    registerChats(server, pool, { origin, discover });

    assert.deepEqual((await request('GET', '/auth/session')).json(), { user: null, telegramEnabled: true });
    assert.equal((await request('GET', '/chats')).statusCode, 401);
    const credentials = { name: ' Анна ', email: ' ANNA@EXAMPLE.COM ', password: 'correct horse battery staple' };
    assert.equal((await request('POST', '/auth/register', credentials, undefined, 'https://other.example')).statusCode, 403);
    assert.equal((await request('POST', '/auth/register', { ...credentials, password: 'short' })).statusCode, 400);
    const registration = await request('POST', '/auth/register', credentials);
    assert.equal(registration.statusCode, 201, registration.body);
    assert.equal(registration.json().user.email, 'anna@example.com');
    assert.equal(registration.json().user.name, 'Анна');
    const cookie = String(registration.headers['set-cookie']).split(';')[0]!;
    assert.match(String(registration.headers['set-cookie']), /HttpOnly; SameSite=Lax; Secure/);
    const stored = (await pool.query('SELECT * FROM account_users')).rows[0];
    assert.ok(stored.password_hash);
    assert.ok(!String(stored.password_hash).includes(credentials.password));
    assert.ok(!(await pool.query('SELECT token_hash FROM account_sessions')).rows[0].token_hash.includes(cookie.split('=')[1]));
    assert.equal((await request('POST', '/auth/register', credentials)).statusCode, 409);
    assert.equal((await request('POST', '/auth/login', { email: credentials.email, password: 'wrong password' })).statusCode, 401);
    assert.deepEqual((await request('GET', '/auth/session', undefined, cookie)).json().user, registration.json().user);

    const creation = await request('POST', '/chats', {}, cookie);
    assert.equal(creation.statusCode, 201, creation.body);
    const { id } = creation.json().chat as { id: string };
    const url = '/chats/' + id;
    const bob = await request('POST', '/auth/register', { ...credentials, email: 'bob@example.com' });
    const bobCookie = String(bob.headers['set-cookie']).split(';')[0]!;
    assert.deepEqual((await request('GET', '/chats', undefined, bobCookie)).json().chats, []);
    assert.equal((await request('GET', url, undefined, bobCookie)).statusCode, 404);
    assert.equal((await request('PATCH', url, { title: 'Чужой' }, bobCookie)).statusCode, 404);
    assert.equal((await request('DELETE', url, undefined, bobCookie)).statusCode, 404);
    assert.equal((await request('POST', url + '/turns', { message: 'Чужое сообщение', requestId: 'blocked' }, bobCookie)).statusCode, 404);

    const first = { message: 'Театры в Уфе', requestId: 'one' };
    const second = { message: 'А завтра?', requestId: 'two', context: { city: 'Москва' } };
    const firstResponse = request('POST', url + '/turns', first, cookie);
    await Promise.race([firstIsRunning, firstResponse.then(response => {
      throw Error('First turn completed before discovery: ' + response.body);
    })]);
    const secondResponse = request('POST', url + '/turns', second, cookie);
    const secondIsWaiting = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rowCount } = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
          [schema],
        );
        if (rowCount) return;
        await delay(20);
      }
      throw Error('Concurrent turn did not wait for the chat lock');
    };
    await Promise.race([secondIsWaiting(), secondResponse.then(response => {
      throw Error('Second turn completed before the first response: ' + response.body);
    })]);
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([firstResponse, secondResponse]);
    assert.equal(firstResult.statusCode, 200, firstResult.body);
    assert.equal(secondResult.statusCode, 200, secondResult.body);
    assert.equal(secondResult.json().turn.response.message, 'Город: Уфа');
    assert.deepEqual((await request('POST', url + '/turns', first, cookie)).json().turn, firstResult.json().turn);
    assert.equal(calls, 2);
    assert.equal((await request('POST', url + '/turns', { ...first, message: 'Иное сообщение' }, cookie)).statusCode, 409);
    assert.equal((await request('POST', url + '/turns', { message: 'Ошибка поиска', requestId: 'three' }, cookie)).statusCode, 500);
    const history = await request('GET', url, undefined, cookie);
    assert.equal(history.headers['cache-control'], 'no-store');
    assert.equal(history.json().chat.title, 'Театры в Уфе');
    assert.deepEqual(history.json().turns.map((turn: { requestId: string }) => turn.requestId), ['one', 'two']);
    assert.equal((await request('PATCH', url, { title: 'Спектакли' }, cookie)).json().chat.title, 'Спектакли');

    const login = await request('POST', '/auth/login', credentials, cookie);
    assert.equal(login.statusCode, 200, login.body);
    assert.equal((await request('GET', '/auth/session', undefined, cookie)).json().user, null);
    const newCookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.equal((await request('GET', '/chats', undefined, newCookie)).json().chats[0].id, id);
    assert.equal((await request('DELETE', url, undefined, newCookie)).statusCode, 204);
    assert.equal((await request('GET', url, undefined, newCookie)).statusCode, 404);
    assert.equal((await pool.query('SELECT count(*) AS count FROM account_chat_turns')).rows[0].count, '0');
    assert.equal((await request('POST', '/auth/logout', undefined, newCookie)).statusCode, 204);
    assert.equal((await request('GET', '/auth/session', undefined, newCookie)).json().user, null);

    const telegramUser = await upsertTelegramUser(pool, '12345', 'Имя Telegram');
    assert.equal(telegramUser.email, undefined);
    assert.equal((await upsertTelegramUser(pool, '12345', 'Новое имя')).id, telegramUser.id);
    assert.notEqual(telegramUser.id, registration.json().user.id);
  } finally {
    releaseFirst();
    await server.close();
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
