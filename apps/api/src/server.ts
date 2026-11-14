import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Catalog } from './catalog.ts';
import { registerApi } from './api.ts';
import { createDiscovery } from './discover.ts';
import { osrmEstimator } from './routing.ts';
import { modelInterpreter } from './model.ts';

export async function buildServer(catalog: Catalog, options: { adminToken?: string; botToken?: string; logger?: boolean; routingOrigin?: string; clock?: () => Date } = {}) {
  const server = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
  });
  await server.register(rateLimit, {
    max: 180,
    timeWindow: '1 minute',
  });

  let requestCount = 0;
  let serverErrors = 0;
  let elapsedMilliseconds = 0;
  server.addHook('onSend', async (request, reply, body) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-request-id', request.id);
    reply.header('content-security-policy', [
      "default-src 'none'", "style-src 'self'", "font-src 'self'", "img-src 'self' https:",
      "base-uri 'none'", "frame-ancestors 'none'",
    ].join('; '));
    return body;
  });
  server.addHook('onResponse', async (request, reply) => {
    requestCount++;
    if (reply.statusCode >= 500) serverErrors++;
    elapsedMilliseconds += reply.elapsedTime;
    request.log.info({
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      status: reply.statusCode,
      elapsedMs: Math.round(reply.elapsedTime),
    }, 'request completed');
  });
  server.setErrorHandler((error, request, reply) => {
    const failure = error && typeof error === 'object' ? error as { statusCode?: number; code?: string } : {};
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500 ? failure.statusCode : 500;
    if (status === 429) {
      return reply.code(429).send({ code: 'rate_limit', message: 'Слишком много запросов. Попробуйте через минуту.', details: null });
    }
    if (status >= 500) request.log.error({ requestId: request.id, errorCode: failure.code }, 'request failed');
    return reply.code(status).send({
      code: status === 500 ? 'internal_error' : 'invalid_request',
      message: status === 500 ? 'Сервис временно недоступен.' : 'Проверьте данные запроса.',
      details: null,
    });
  });

  server.get('/metrics', () => ({
    requests: requestCount,
    serverErrors,
    averageResponseMs: requestCount ? Number((elapsedMilliseconds / requestCount).toFixed(2)) : 0,
  }));

  registerApi(server, catalog, {
    adminToken: options.adminToken, botToken: options.botToken,
    discover: createDiscovery(catalog, {
      clock: options.clock,
      travel: options.routingOrigin ? osrmEstimator(options.routingOrigin) : undefined,
      interpret: modelInterpreter(process.env),
      onInterpretFailure: () => server.log.warn("Model unavailable, using local search"),
    }),
  });
  return server;
}
