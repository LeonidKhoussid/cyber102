import { dayPlanLimit } from '@afisha/contracts';
import type { CatalogEvent } from '@afisha/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { accountError, withAccountTransaction } from './accounts.ts';
import { isLocalDate, normalizeText } from './catalog.ts';
import type { CatalogStore } from './catalog.ts';
import { localDate } from './filters.ts';

type ChatParams = { id: string };
type EventParams = ChatParams & { eventId: string };
type Selection = { day: string; city_key: string; event: CatalogEvent };

export async function initializeEventPlans(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_chat_plan_events (
      chat_id uuid NOT NULL REFERENCES account_chats(id) ON DELETE CASCADE,
      event_id text NOT NULL,
      day date NOT NULL,
      city_key text NOT NULL,
      event jsonb NOT NULL,
      PRIMARY KEY (chat_id, event_id)
    )
  `);
}

async function selections(client: Pool | PoolClient, chatId: string) {
  const { rows } = await client.query<Selection>(`
    SELECT day::text AS day, city_key, event FROM account_chat_plan_events WHERE chat_id = $1
  `, [chatId]);
  return rows;
}

function isInPlanCityAndDay(event: CatalogEvent, day: string, cityKey: string) {
  return localDate(new Date(event.startsAt)) === day && normalizeText(event.city) === cityKey;
}

export function registerEventPlans(chats: FastifyInstance, pool: Pool, catalog: Pick<CatalogStore, 'getEvent'>, access: {
  userId: (request: FastifyRequest) => string;
  validUuid: (value: string) => boolean;
  chatNotFound: (reply: FastifyReply) => FastifyReply;
}) {
  async function owned(client: Pool | PoolClient, chatId: string, userId: string, lock = false) {
    const result = await client.query(`SELECT id FROM account_chats WHERE id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [chatId, userId]);
    return Boolean(result.rowCount);
  }

  async function currentPlan(rows: Selection[]) {
    const events = await Promise.all(rows.map(async selection => {
      const current = await catalog.getEvent(selection.event.id);
      return current?.status === 'published' && isInPlanCityAndDay(current, selection.day, selection.city_key)
        ? current : { ...selection.event, status: 'cancelled' as const };
    }));
    events.sort((first, second) => Date.parse(first.startsAt) - Date.parse(second.startsAt) || first.id.localeCompare(second.id));
    return { events };
  }

  chats.get<{ Params: ChatParams }>('/:id/event-plan', async (request, reply) => {
    const { id } = request.params;
    if (!access.validUuid(id) || !await owned(pool, id, access.userId(request))) return access.chatNotFound(reply);
    return currentPlan(await selections(pool, id));
  });

  chats.put<{ Params: EventParams; Body: { date?: unknown } }>('/:id/event-plan/:eventId', { bodyLimit: 1024 }, async (request, reply) => {
    const { id, eventId } = request.params;
    if (!access.validUuid(id)) return access.chatNotFound(reply);
    const date = request.body?.date;
    if (typeof date !== 'string' || date.startsWith('0000-') || !isLocalDate(date)) {
      return accountError(reply, 400, 'invalid_plan_date', 'Выберите день для плана.');
    }
    if (!access.validUuid(eventId)) return accountError(reply, 404, 'event_not_found', 'Событие не найдено.');

    const result = await withAccountTransaction(pool, async client => {
      if (!await owned(client, id, access.userId(request), true)) return 'missing_chat';
      const saved = await selections(client, id);
      if (saved.some(selection => selection.event.id === eventId && selection.day === date)) return saved;
      const event = await catalog.getEvent(eventId);
      if (event?.status !== 'published') return 'missing_event';
      const cityKey = normalizeText(event.city);
      if (!isInPlanCityAndDay(event, date, cityKey)
        || saved.some(selection => selection.day !== date || selection.city_key !== cityKey)) return 'different_plan';
      if (saved.length >= dayPlanLimit) return 'full';

      const offered = await client.query(`
        SELECT 1 FROM account_chat_turns
        WHERE chat_id = $1 AND response->'context'->>'planMode' = 'day'
          AND response->'context'->>'date' = $2
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              COALESCE(response->'events', '[]'::jsonb) || COALESCE(response->'alternatives', '[]'::jsonb)
            ) AS card WHERE card->'event'->>'id' = $3
          )
        LIMIT 1
      `, [id, date, eventId]);
      if (!offered.rowCount) return 'not_offered';

      await client.query(`
        INSERT INTO account_chat_plan_events (chat_id, event_id, day, city_key, event) VALUES ($1, $2, $3, $4, $5)
      `, [id, eventId, date, cityKey, event]);
      return [...saved, { day: date, city_key: cityKey, event }];
    });
    if (result === 'missing_chat') return access.chatNotFound(reply);
    if (result === 'missing_event') return accountError(reply, 404, 'event_not_found', 'Событие больше недоступно.');
    if (result === 'different_plan') return accountError(reply, 409, 'different_event_plan', 'В одном плане могут быть только события одного города и одного дня.');
    if (result === 'full') return accountError(reply, 409, 'event_plan_full', `В план можно добавить до ${dayPlanLimit} событий.`);
    if (result === 'not_offered') return accountError(reply, 409, 'event_not_offered', 'Выберите событие из подборки для этого дня.');
    return currentPlan(result);
  });

  chats.delete<{ Params: EventParams }>('/:id/event-plan/:eventId', async (request, reply) => {
    const { id, eventId } = request.params;
    if (!access.validUuid(id)) return access.chatNotFound(reply);
    if (!access.validUuid(eventId)) return accountError(reply, 404, 'event_not_found', 'Событие не найдено.');
    const saved = await withAccountTransaction(pool, async client => {
      if (!await owned(client, id, access.userId(request), true)) return null;
      await client.query('DELETE FROM account_chat_plan_events WHERE chat_id = $1 AND event_id = $2', [id, eventId]);
      return selections(client, id);
    });
    if (!saved) return access.chatNotFound(reply);
    return currentPlan(saved);
  });
}
