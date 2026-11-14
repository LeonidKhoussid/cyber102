import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CatalogStore, EventStatus } from './catalog.ts';
import type { Category } from '@afisha/contracts';
import type { createDiscovery } from './discover.ts';
import { categories } from './catalog.ts';
import { FilterError, parseFilters } from './filters.ts';
import type { QueryValues } from './filters.ts';
import { parseImport } from './import.ts';
import { audioTypes, UnreadableAudio } from './transcription.ts';
import type { AudioType, Transcribe } from './transcription.ts';

function failure(reply: FastifyReply, status: number, code: string, message: string, details: unknown = null) {
  return reply.code(status).send({ code, message, details });
}

function cached(request: FastifyRequest, reply: FastifyReply, body: unknown) {
  const etag = '"' + createHash('sha256').update(JSON.stringify(body)).digest('base64url') + '"';
  reply.header('etag', etag).header('cache-control', 'public, max-age=0, must-revalidate');
  const tags = request.headers['if-none-match']?.split(',').map(tag => tag.trim().replace(/^W\//, ''));
  if (tags?.some(tag => tag === etag || tag === '*')) return reply.code(304).send();
  return reply.send(body);
}

function authorized(request: FastifyRequest, reply: FastifyReply, token: string | undefined) {
  if (!token) {
    failure(reply, 503, 'authorization_unavailable', 'Доступ к операции не настроен.');
    return false;
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(request.headers.authorization ?? '');
  if (expected.length === provided.length && timingSafeEqual(expected, provided)) return true;
  failure(reply, 401, 'unauthorized', 'Требуется токен доступа.');
  return false;
}

const queryParameters = [
  ['q', 'string', 'Название или ключевые слова'],
  ['city', 'string', 'Город'],
  ['venue', 'string', 'Площадка'],
  ['category', 'string', 'Код категории'],
  ['period', 'string', 'today, tomorrow, weekend или week'],
  ['date', 'string', 'Конкретный день, ГГГГ-ММ-ДД'],
  ['from', 'string', 'Начальный день, ГГГГ-ММ-ДД'],
  ['until', 'string', 'Последний день включительно, ГГГГ-ММ-ДД'],
  ['maxPrice', 'integer', 'Максимальная начальная цена, ₽'],
  ['age', 'integer', 'Возраст зрителя'],
  ['page', 'integer', 'Номер страницы от 1'],
  ['limit', 'integer', 'Размер страницы от 1 до 50'],
  ['sort', 'string', 'date или price'],
].map(([name, type, description]) => ({ name, in: 'query', schema: { type }, description }));

const spec = {
  openapi: '3.1.0',
  info: { title: 'Афиша Башкортостана', version: '0.1.0' },
  paths: {
    '/api/v1/transcribe': { post: {
      summary: 'Распознавание голосового запроса',
      requestBody: { required: true, content: Object.fromEntries(Object.keys(audioTypes).map(type =>
        [type, { schema: { type: 'string', format: 'binary' } }])) },
      responses: {
        '200': { description: 'Распознанный текст', content: { 'application/json': { schema: {
          type: 'object', required: ['text'], properties: { text: { type: 'string' } },
        } } } },
        '400': { description: 'Пустая запись' },
        '413': { description: 'Размер записи превышает 1 МиБ' },
        '415': { description: 'Формат аудио не поддерживается' },
        '422': { description: 'Речь не удалось распознать' },
        '503': { description: 'Распознавание временно недоступно' },
      },
    } },
    '/api/v1/discover': { post: {
      summary: 'Подбор событий по запросу на русском языке',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['message'], properties: {
          message: { type: 'string', minLength: 1, maxLength: 1200 }, context: { type: 'object' },
          planExperience: { type: 'boolean', description: 'Уточнять город и предлагать план дня' },
          guidedPlan: { type: 'boolean' }, selectedEventIds: { type: 'array', maxItems: 4, items: { type: 'string', format: 'uuid' } },
        },
      } } } },
      responses: {
        '200': { description: 'Подходящие события, уточнение или объяснение отсутствия данных', content: { 'application/json': { schema: {
          type: 'object', required: ['status', 'message', 'constraints', 'events', 'suggestions', 'context'], properties: {
            status: { enum: ['matches', 'clarify', 'no_results'] }, message: { type: 'string' },
            context: { type: 'object' }, constraints: { type: 'array', items: { type: 'object', properties: {
              label: { type: 'string' }, value: { type: 'string' },
            } } }, events: { type: 'array', items: { type: 'object', properties: {
              event: { $ref: '#/components/schemas/Event' }, reasons: { type: 'array', items: { type: 'string' } },
            } } }, suggestions: { type: 'array', items: { type: 'string' } },
            alternatives: { description: 'Варианты с неподтверждённым временем в пути', type: 'array', items: { type: 'object', properties: {
              event: { $ref: '#/components/schemas/Event' }, reasons: { type: 'array', items: { type: 'string' } },
            } } },
          },
        } } } },
        '400': { $ref: '#/components/responses/Invalid' },
      },
    } },
    '/api/v1/events': { get: {
      summary: 'Поиск по опубликованным событиям', parameters: queryParameters,
      responses: {
        '200': { description: 'Страница выдачи', content: { 'application/json': {
          schema: { type: 'object', required: ['events', 'page', 'limit', 'total'], properties: {
            events: { type: 'array', items: { $ref: '#/components/schemas/Event' } },
            page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' },
          } },
          example: { events: [], page: 1, limit: 12, total: 0 },
        } } },
        '400': { $ref: '#/components/responses/Invalid' },
      },
    } },
    '/api/v1/events/{id}': { get: {
      summary: 'Карточка события', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        '200': { description: 'Карточка', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } },
        '304': { description: 'Карточка не изменилась' }, '404': { description: 'Событие не найдено' },
      },
    } },
    '/api/v1/directories': { get: {
      summary: 'Города, площадки и категории', responses: {
        '200': { description: 'Справочники', content: { 'application/json': { schema: {
          type: 'object', required: ['cities', 'venues', 'categories'], properties: {
            cities: { type: 'array', items: { type: 'string' } },
            venues: { type: 'array', items: { type: 'object', properties: { city: { type: 'string' }, name: { type: 'string' } } } },
            categories: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },
          },
        } } } }, '304': { description: 'Справочники не изменились' },
      },
    } },
    '/health': { get: { summary: 'Проверка доступности', responses: {
      '200': { description: 'Сервис и база доступны', content: { 'application/json': { example: { status: 'ok' } } } },
    } } },
  },
  components: {
    responses: { Invalid: { description: 'Некорректный запрос', content: { 'application/json': {
      example: { code: 'invalid_filter', message: 'Неизвестная категория.', details: null },
    } } } },
    schemas: {
      Event: {
        type: 'object',
        required: ['id', 'title', 'category', 'city', 'venue', 'startsAt', 'status', 'sources'],
        properties: {
          id: { type: 'string', format: 'uuid' }, title: { type: 'string' }, category: { type: 'string', enum: Object.keys(categories) },
          city: { type: 'string' }, venue: { type: 'string' }, startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' }, address: { type: 'string' }, description: { type: 'string' },
          ageLimit: { type: 'integer' }, priceMin: { type: 'number' }, priceMax: { type: 'number' }, language: { type: 'string' },
          latitude: { type: 'number' }, longitude: { type: 'number' }, imageUrl: { type: 'string', format: 'uri' },
          ticketUrl: { type: 'string', format: 'uri' }, status: { type: 'string', enum: ['published', 'cancelled'] },
          sources: { type: 'array', items: { type: 'object', required: ['name', 'url'], properties: {
            name: { type: 'string' }, url: { type: 'string', format: 'uri' }, verifiedAt: { type: 'string', format: 'date-time' },
          } } },
        },
      },
    },
  },
};

export function registerApi(server: FastifyInstance, catalog: CatalogStore, options: {
  adminToken?: string; botToken?: string; clock?: () => Date; discover: ReturnType<typeof createDiscovery>;
  transcribe?: Transcribe;
}) {
  const token = options.adminToken;
  const yandexApiKey = process.env.YANDEX_MAPS_JS_API_KEY?.trim();
  server.get('/api/v1/maps/config', (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return yandexApiKey && /^[a-z0-9_-]{1,150}$/i.test(yandexApiKey) ? { yandexApiKey } : {};
  });

  server.post<{ Body: { message?: unknown; context?: unknown; planExperience?: unknown; guidedPlan?: unknown; selectedEventIds?: unknown } }>('/api/v1/discover', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const message = request.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 1200) {
      return failure(reply, 400, 'invalid_message', 'Напишите запрос длиной до 1200 символов.');
    }
    return options.discover(message.trim(), request.body.context, { planExperience: request.body.planExperience === true,
      guidedPlan: request.body.guidedPlan === true, selectedEventIds: request.body.selectedEventIds });
  });

  // Scope binary parsing to voice requests. Other endpoints keep their existing parsers.
  server.register(async voice => {
    voice.addContentTypeParser(Object.keys(audioTypes), { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    voice.post<{ Body: Buffer }>('/api/v1/transcribe', {
      bodyLimit: 1_048_576,
      config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const type = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      if (!type || !Object.hasOwn(audioTypes, type)) {
        return failure(reply, 415, 'unsupported_audio', 'Этот формат записи не поддерживается.');
      }
      if (!Buffer.isBuffer(request.body) || !request.body.length) {
        return failure(reply, 400, 'missing_audio', 'Запись пустая. Попробуйте ещё раз.');
      }
      if (!options.transcribe) return failure(reply, 503, 'voice_unavailable', 'Голосовой поиск недоступен. Можно написать вопрос.');
      try {
        return { text: await options.transcribe(request.body, type as AudioType) };
      } catch (error) {
        if (error instanceof UnreadableAudio) {
          return failure(reply, 422, 'unreadable_audio', 'Не удалось разобрать речь. Попробуйте записать ещё раз.');
        }
        return failure(reply, 503, 'voice_unavailable', 'Не удалось распознать запись. Попробуйте ещё раз или напишите вопрос.');
      }
    });
  });

  type SubscriberInput = { subscriber?: unknown; city?: unknown; category?: unknown };
  server.put<{ Body: SubscriberInput }>('/api/v1/bot/subscriptions', async (request, reply) => {
    if (!authorized(request, reply, options.botToken)) return;
    const { subscriber, city, category } = request.body ?? {};
    if (typeof subscriber !== 'string' || !/^\d{1,20}$/.test(subscriber) ||
        typeof city !== 'string' || !city.trim() || city.length > 100 ||
        typeof category !== 'string' || !Object.hasOwn(categories, category)) {
      return failure(reply, 400, 'invalid_subscription', 'Укажите пользователя, город и категорию.');
    }
    await catalog.subscribe(subscriber, { city: city.trim(), category: category as Category });
    return { saved: true };
  });

  server.delete<{ Body: SubscriberInput }>('/api/v1/bot/subscriptions', async (request, reply) => {
    if (!authorized(request, reply, options.botToken)) return;
    const subscriber = request.body?.subscriber;
    if (typeof subscriber !== 'string' || !/^\d{1,20}$/.test(subscriber)) {
      return failure(reply, 400, 'invalid_subscription', 'Укажите пользователя.');
    }
    return { removed: await catalog.unsubscribe(subscriber) };
  });

  server.addContentTypeParser('text/csv', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  server.get('/health', async () => {
    await catalog.search({ limit: 1 });
    return { status: 'ok' };
  });
  server.get('/openapi.json', () => spec);
  server.get('/api/v1/events', async (request, reply) => {
    try {
      return catalog.search(parseFilters(request.query as QueryValues, options.clock?.()));
    } catch (error) {
      if (error instanceof FilterError) return failure(reply, 400, 'invalid_filter', error.message);
      throw error;
    }
  });
  server.get<{ Params: { id: string } }>('/api/v1/events/:id', async (request, reply) => {
    const event = await catalog.getEvent(request.params.id);
    return event ? cached(request, reply, event) : failure(reply, 404, 'event_not_found', 'Событие не найдено.');
  });
  server.get('/api/v1/directories', async (request, reply) => cached(request, reply, await catalog.directories()));
  server.get<{ Querystring: QueryValues }>('/api/v1/admin/events', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!authorized(request, reply, token)) return;
    const status = request.query.status;
    if (status !== undefined && status !== 'draft' && status !== 'published' && status !== 'cancelled') {
      return failure(reply, 400, 'invalid_status', 'Допустимые статусы: published, draft, cancelled.');
    }
    try {
      return await catalog.search(parseFilters(request.query, options.clock?.()), { status });
    } catch (error) {
      if (error instanceof FilterError) return failure(reply, 400, 'invalid_filter', error.message);
      throw error;
    }
  });
  server.post('/api/v1/admin/import', (request, reply) => {
    if (!authorized(request, reply, token)) return;
    let events: ReturnType<typeof parseImport>;
    try {
      events = parseImport(request.body);
    } catch {
      return failure(reply, 400, 'invalid_import', 'Нужен массив JSON или CSV с заголовками и 1–1000 записями.');
    }
    return catalog.importEvents(events, 'admin');
  });
  server.post('/api/v1/admin/events', async (request, reply) => {
    if (!authorized(request, reply, token)) return;
    const report = await catalog.importEvents(parseImport(request.body, 'manual'), 'admin');
    return report.rejected.length ? failure(reply, 400, 'invalid_event', report.rejected[0].reason) : report;
  });
  server.patch<{ Params: { id: string }; Body: { status?: EventStatus } }>('/api/v1/admin/events/:id', async (request, reply) => {
    if (!authorized(request, reply, token)) return;
    const status = request.body?.status;
    if (!status || !['published', 'draft', 'cancelled'].includes(status)) {
      return failure(reply, 400, 'invalid_status', 'Допустимые статусы: published, draft, cancelled.');
    }
    if (!await catalog.setStatus(request.params.id, status)) return failure(reply, 404, 'event_not_found', 'Событие не найдено.');
    return { status };
  });
}
