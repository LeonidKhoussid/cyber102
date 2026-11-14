import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { registerTelegramLogin, telegramLoginConfigured } from '../src/telegram-login.ts';

const startPath = '/api/v1/auth/telegram/start';
const callbackPath = '/api/v1/auth/telegram/callback';
const issuer = 'https://oauth.telegram.org';
const env = {
  TELEGRAM_CLIENT_ID: '123456',
  TELEGRAM_CLIENT_SECRET: 'local-test-secret',
  PUBLIC_SITE_URL: 'https://afisha.example',
};

function app(t: TestContext, configuration: NodeJS.ProcessEnv = env) {
  const server = Fastify();
  const identities: Array<{ subject: string; name: string; secure: boolean }> = [];
  registerTelegramLogin(server, {
    env: configuration,
    async onIdentity(_request, reply, identity, secure) {
      identities.push({ ...identity, secure });
      reply.header('set-cookie', 'afisha_session=test-session');
    },
  });
  t.after(() => server.close());
  return { server, identities };
}

async function start(server: ReturnType<typeof Fastify>) {
  const response = await server.inject(startPath);
  assert.equal(response.statusCode, 302, response.body);
  assert.ok(response.headers.location);
  assert.ok(response.headers['set-cookie']);
  const authorization = new URL(response.headers.location);
  const state = authorization.searchParams.get('state');
  assert.ok(state);
  const cookie = String(response.headers['set-cookie']);
  return { authorization, state, cookie, cookiePair: cookie.split(';')[0] };
}

function callback(state: string, params: Record<string, string> = { code: 'telegram-code' }) {
  return callbackPath + '?' + new URLSearchParams({ state, ...params });
}

test('Telegram Login requires distinct OIDC credentials and a safe public origin', async t => {
  const configuration = { ...env, TELEGRAM_CLIENT_SECRET: '', BOT_TOKEN: 'bot-api-token' };
  const { server } = app(t, configuration);
  assert.equal(telegramLoginConfigured(configuration), false);
  assert.equal(telegramLoginConfigured({ ...env, PUBLIC_SITE_URL: 'http://afisha.example' }), false);
  const response = await server.inject(startPath);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'telegram_unavailable');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal((await server.inject(callbackPath)).statusCode, 503);
});

test('Telegram Login uses the website origin and a short-lived browser cookie', async t => {
  const { server } = app(t, { ...env, PUBLIC_SITE_URL: '', WEB_PORT: '3555' });
  const { authorization, cookie } = await start(server);
  assert.equal(authorization.searchParams.get('redirect_uri'), 'http://localhost:3555' + callbackPath);
  assert.match(cookie, /; Max-Age=600\b/);
  assert.match(cookie, /; HttpOnly\b/);
  assert.match(cookie, /; SameSite=Lax\b/);
  assert.doesNotMatch(cookie, /; Secure\b/);
});

test('Telegram Login validates callback state before contacting Telegram', async t => {
  const { server, identities } = app(t);
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  const first = await start(server);
  const second = await start(server);
  const [name, state, verifier, expiresAt, mac] = first.cookiePair.split(/[=.]/);
  const changedVerifier = (verifier.startsWith('a') ? 'b' : 'a') + verifier.slice(1);
  const forgedCookie = name + '=' + [state, changedVerifier, expiresAt, mac].join('.');
  assert.notEqual(first.state, second.state);
  const rejected = [
    { url: callback(first.state) },
    { url: callback(first.state), headers: { cookie: second.cookiePair } },
    { url: callback(first.state), headers: { cookie: first.cookiePair + 'x' } },
    { url: callback(first.state), headers: { cookie: forgedCookie } },
    { url: callback(first.state) + '&state=' + first.state, headers: { cookie: first.cookiePair } },
  ];
  for (const request of rejected) {
    const response = await server.inject(request);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'invalid_telegram_state');
  }
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(identities, []);
});

test('Telegram Login rejects an expired login even if the browser sends the cookie', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { server, identities } = app(t);
  const attempt = await start(server);
  t.mock.timers.tick(10 * 60 * 1000);
  const response = await server.inject({
    url: callback(attempt.state),
    headers: { cookie: attempt.cookiePair },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'invalid_telegram_state');
  assert.deepEqual(identities, []);
});

test('Telegram denial clears the browser cookie and returns the user to the website', async t => {
  const { server, identities } = app(t);
  const attempt = await start(server);
  const response = await server.inject({
    url: callback(attempt.state, { error: 'access_denied' }),
    headers: { cookie: attempt.cookiePair },
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/?telegram=denied');
  assert.match(String(response.headers['set-cookie']), /; Max-Age=0\b/);
  assert.deepEqual(identities, []);
});

test('Telegram Login exchanges the code using PKCE and creates a session only for a verified identity', async t => {
  const { server, identities } = app(t);
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'telegram-key', alg: 'RS256' };
  const claims: JWTPayload = {
    sub: '5261287051118831155',
    name: '  Анна Иванова  ',
    id: 987654321,
    iss: issuer,
    aud: env.TELEGRAM_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };
  const sign = (payload: JWTPayload, key = privateKey) =>
    new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(key);
  let exchange = Response.json({ token_type: 'Bearer', access_token: 'unused', expires_in: 3600, id_token: await sign(claims) });
  const network = t.mock.method(globalThis, 'fetch', async (input: URL | string, options?: RequestInit) => {
    const url = String(input);
    if (url === issuer + '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
    if (url === issuer + '/token') return exchange;
    assert.fail('Unexpected network URL ' + url);
  });
  const attempt = await start(server);
  assert.equal(attempt.authorization.origin + attempt.authorization.pathname, issuer + '/auth');
  assert.equal(attempt.authorization.searchParams.get('scope'), 'openid profile');
  assert.equal(attempt.authorization.searchParams.get('response_type'), 'code');
  assert.equal(attempt.authorization.searchParams.get('client_id'), env.TELEGRAM_CLIENT_ID);
  assert.equal(attempt.authorization.searchParams.get('redirect_uri'), env.PUBLIC_SITE_URL + callbackPath);
  assert.equal(attempt.authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.match(attempt.cookie, /^__Host-/);
  assert.match(attempt.cookie, /; Secure\b/);
  const response = await server.inject({
    url: callback(attempt.state),
    headers: { cookie: attempt.cookiePair },
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/');
  assert.match(String(response.headers['set-cookie']), /; Max-Age=0\b/);
  assert.match(String(response.headers['set-cookie']), /afisha_session=test-session/);
  assert.deepEqual(identities, [{ subject: '5261287051118831155', name: 'Анна Иванова', secure: true }]);

  const tokenRequest = network.mock.calls[0].arguments[1];
  assert.equal(tokenRequest?.method, 'POST');
  assert.equal(tokenRequest?.redirect, 'error');
  const headers = new Headers(tokenRequest?.headers);
  assert.equal(headers.get('authorization'), 'Basic ' + Buffer.from('123456:local-test-secret').toString('base64'));
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(String(tokenRequest?.body));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), env.TELEGRAM_CLIENT_ID);
  assert.equal(body.get('code'), 'telegram-code');
  assert.equal(body.get('redirect_uri'), env.PUBLIC_SITE_URL + callbackPath);
  const verifier = body.get('code_verifier');
  assert.ok(verifier);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'),
    attempt.authorization.searchParams.get('code_challenge'));

  const unrelated = await generateKeyPair('RS256');
  const rejected = [
    Response.json({ error: 'invalid_grant' }, { status: 400 }),
    Response.json({ access_token: 'unused' }),
    Response.json({ id_token: await sign(claims, unrelated.privateKey) }),
    Response.json({ id_token: await sign({ ...claims, iss: 'https://other.example' }) }),
    Response.json({ id_token: await sign({ ...claims, aud: 'other-client' }) }),
    Response.json({ id_token: await sign({ ...claims, aud: [env.TELEGRAM_CLIENT_ID, 'other-client'] }) }),
    Response.json({ id_token: await sign({ ...claims, exp: undefined }) }),
    Response.json({ id_token: await sign({ ...claims, exp: claims.iat }) }),
    Response.json({ id_token: await sign({ ...claims, sub: undefined }) }),
    Response.json({ id_token: await sign({ ...claims, iat: claims.iat! + 300 }) }),
  ];
  for (const reply of rejected) {
    exchange = reply;
    const attempt = await start(server);
    const response = await server.inject({
      url: callback(attempt.state),
      headers: { cookie: attempt.cookiePair },
    });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/?telegram=error');
    assert.match(String(response.headers['set-cookie']), /; Max-Age=0\b/);
  }
  assert.equal(identities.length, 1);
});
