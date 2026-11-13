import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Catalog, EventStatus } from './catalog.ts';
import { categories } from './catalog.ts';
import { FilterError, parseFilters } from './filters.ts';
import type { QueryValues } from './filters.ts';
import { parseImport } from './import.ts';

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

function adminAllowed(request: FastifyRequest, reply: FastifyReply, token: string | undefined) {
  if (!token) {
    failure(reply, 503, 'admin_unavailable', 'Доступ администратора не настроен.');
    return false;
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(request.headers.authorization ?? '');
  if (expected.length === provided.length && timingSafeEqual(expected, provided)) return true;
  failure(reply, 401, 'unauthorized', 'Требуется токен администратора.');
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

export function registerApi(server: FastifyInstance, catalog: Catalog, token?: string) {
  server.addContentTypeParser('text/csv', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  server.get('/health', () => {
    catalog.search({ limit: 1 });
    return { status: 'ok' };
  });
  server.get('/openapi.json', () => spec);
  server.get('/api/v1/events', (request, reply) => {
    try {
      return catalog.search(parseFilters(request.query as QueryValues));
    } catch (error) {
      if (error instanceof FilterError) return failure(reply, 400, 'invalid_filter', error.message);
      throw error;
    }
  });
  server.get<{ Params: { id: string } }>('/api/v1/events/:id', (request, reply) => {
    const event = catalog.getEvent(request.params.id);
    return event ? cached(request, reply, event) : failure(reply, 404, 'event_not_found', 'Событие не найдено.');
  });
  server.get('/api/v1/directories', (request, reply) => cached(request, reply, catalog.directories()));
  server.post('/api/v1/admin/import', (request, reply) => {
    if (!adminAllowed(request, reply, token)) return;
    let events: ReturnType<typeof parseImport>;
    try {
      events = parseImport(request.body);
    } catch {
      return failure(reply, 400, 'invalid_import', 'Нужен массив JSON или CSV с заголовками и 1–1000 записями.');
    }
    return catalog.importEvents(events, 'admin');
  });
  server.post('/api/v1/admin/events', (request, reply) => {
    if (!adminAllowed(request, reply, token)) return;
    const report = catalog.importEvents(parseImport(request.body, 'manual'), 'admin');
    return report.rejected.length ? failure(reply, 400, 'invalid_event', report.rejected[0].reason) : report;
  });
  server.patch<{ Params: { id: string }; Body: { status?: EventStatus } }>('/api/v1/admin/events/:id', (request, reply) => {
    if (!adminAllowed(request, reply, token)) return;
    const status = request.body?.status;
    if (!status || !['published', 'draft', 'cancelled'].includes(status)) {
      return failure(reply, 400, 'invalid_status', 'Допустимые статусы: published, draft, cancelled.');
    }
    if (!catalog.setStatus(request.params.id, status)) return failure(reply, 404, 'event_not_found', 'Событие не найдено.');
    return { status };
  });
}
