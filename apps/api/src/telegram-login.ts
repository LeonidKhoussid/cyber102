import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = 'https://oauth.telegram.org';
const callbackPath = '/api/v1/auth/telegram/callback';
const attemptSeconds = 600;
const cookieName = 'afisha_telegram_login';
const randomValue = /^[A-Za-z0-9_-]{43}$/;

type TelegramIdentity = { subject: string; name: string };
type Options = {
  env?: NodeJS.ProcessEnv;
  onIdentity(request: FastifyRequest, reply: FastifyReply, identity: TelegramIdentity, secure: boolean): Promise<void>;
};

function loginConfig(env: NodeJS.ProcessEnv) {
  const clientId = env.TELEGRAM_CLIENT_ID?.trim();
  const clientSecret = env.TELEGRAM_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return;
  const localPort = env.WEB_PORT?.trim() || '3000';
  const site = URL.parse(env.PUBLIC_SITE_URL?.trim() || 'http://localhost:' + localPort);
  if (!site || site.username || site.password) return;
  const secure = site.protocol === 'https:';
  if (!secure && (site.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(site.hostname))) return;

  return {
    clientId, clientSecret, secure,
    redirectUri: site.origin + callbackPath,
    cookie: secure ? '__Host-' + cookieName : cookieName,
  };
}

export function telegramLoginConfigured(env = process.env): boolean {
  return loginConfig(env) !== undefined;
}

function signature(attempt: string, secret: string): Buffer {
  return createHmac('sha256', secret).update('afisha-telegram-login-v1.').update(attempt).digest();
}

function verifiedVerifier(cookie: string, state: string, secret: string) {
  const parts = cookie.split('.');
  if (parts.length !== 4) return;
  const [savedState, verifier, expiresAt, mac] = parts;
  if (savedState !== state || !randomValue.test(verifier) || !randomValue.test(mac) || !/^\d{10}$/.test(expiresAt)) return;
  if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return;

  const expected = signature([savedState, verifier, expiresAt].join('.'), secret);
  const given = Buffer.from(mac, 'base64url');
  if (timingSafeEqual(expected, given)) return verifier;
}

export function registerTelegramLogin(server: FastifyInstance, options: Options) {
  const config = loginConfig(options.env ?? process.env);
  const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'));

  function unavailable(reply: FastifyReply) {
    return reply.code(503).send({
      code: 'telegram_unavailable', message: 'Вход через Telegram недоступен.', details: null,
    });
  }

  function setAttemptCookie(reply: FastifyReply, value: string, maxAge: number) {
    if (!config) return;
    reply.header('set-cookie', config.cookie + '=' + value
      + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; SameSite=Lax' + (config.secure ? '; Secure' : ''));
  }

  server.get('/api/v1/auth/telegram/start', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!config) return unavailable(reply);

    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const expiry = Math.floor(Date.now() / 1000) + attemptSeconds;
    const attempt = [state, verifier, expiry].join('.');
    const mac = signature(attempt, config.clientSecret).toString('base64url');
    setAttemptCookie(reply, attempt + '.' + mac, attemptSeconds);

    const authorization = new URL(issuer + '/auth');
    authorization.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return reply.redirect(authorization.href);
  });

  server.get<{ Querystring: { state?: unknown; error?: unknown; code?: unknown } }>(
    callbackPath,
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!config) return unavailable(reply);

      const { state, error, code } = request.query;
      const cookie = request.headers.cookie?.split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(config.cookie + '='))?.slice(config.cookie.length + 1);
      const verifier = typeof state === 'string' && randomValue.test(state) && cookie
        ? verifiedVerifier(cookie, state, config.clientSecret) : undefined;
      if (!verifier) {
        return reply.code(400).send({
          code: 'invalid_telegram_state', message: 'Начните вход через Telegram заново.', details: null,
        });
      }

      setAttemptCookie(reply, '', 0);
      if (error === 'access_denied') return reply.redirect('/?telegram=denied');
      if (error !== undefined || typeof code !== 'string' || !code || code.length > 4096) {
        return reply.redirect('/?telegram=error');
      }

      let identity: TelegramIdentity;
      try {
        const tokenResponse = await fetch(issuer + '/token', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64'),
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: config.redirectUri,
            client_id: config.clientId,
            code_verifier: verifier,
          }),
        });
        if (!tokenResponse.ok) return reply.redirect('/?telegram=error');
        const tokens = await tokenResponse.json() as { id_token?: unknown } | null;
        if (typeof tokens?.id_token !== 'string') return reply.redirect('/?telegram=error');

        const { payload } = await jwtVerify(tokens.id_token, keys, {
          algorithms: ['RS256', 'ES256'],
          issuer,
          audience: config.clientId,
          requiredClaims: ['sub', 'iat', 'exp'],
        });
        const { sub, aud, azp, iat, exp, name, preferred_username: username } = payload;
        if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255 || sub.includes('\0')
          || (Array.isArray(aud) && aud.length !== 1) || (azp !== undefined && azp !== config.clientId)
          || typeof iat !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp)
          || iat > Math.floor(Date.now() / 1000) + 60) {
          return reply.redirect('/?telegram=error');
        }
        const displayName = [name, username].find(value => typeof value === 'string' && value.trim() && !value.includes('\0'));
        identity = {
          subject: sub,
          name: typeof displayName === 'string' ? displayName.trim().slice(0, 80).toWellFormed() : 'Пользователь Telegram',
        };
      } catch {
        return reply.redirect('/?telegram=error');
      }

      await options.onIdentity(request, reply, identity, config.secure);
      return reply.redirect('/');
    },
  );
}
