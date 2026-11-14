import { randomUUID } from 'node:crypto';
import type { DiscoveryResponse } from '@afisha/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { accountError, allowAccountOrigin, getSession, withAccountTransaction } from './accounts.ts';
import type { AccountUser } from './accounts.ts';
import type { createDiscovery } from './discover.ts';
import type { CatalogStore } from './catalog.ts';
import { initializeEventPlans, registerEventPlans } from './event-plans.ts';

type ChatRow = { id: string; title: string | null; created_at: Date; updated_at: Date };
type TurnRow = { request_id: string; message: string; response: DiscoveryResponse; created_at: Date | string };
type ChatParams = { id: string };
type TitleBody = { title?: unknown };
type TurnBody = { message?: unknown; requestId?: unknown; planExperience?: unknown };

const chatColumns = 'id, title, created_at, updated_at';
const turnColumns = 'request_id, message, response, created_at';

export async function initializeChats(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_chats (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
      title text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS account_chats_user_updated ON account_chats (user_id, updated_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS account_chat_turns (
      chat_id uuid NOT NULL REFERENCES account_chats(id) ON DELETE CASCADE,
      request_id text NOT NULL,
      position bigint GENERATED ALWAYS AS IDENTITY,
      message text NOT NULL,
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (chat_id, request_id),
      UNIQUE (chat_id, position)
    );
  `);
  await initializeEventPlans(pool);
}

function publicChat(row: ChatRow) {
  return { id: row.id, title: row.title ?? 'Новый чат', createdAt: row.created_at, updatedAt: row.updated_at };
}

function publicTurn(row: TurnRow) {
  return { requestId: row.request_id, message: row.message, response: row.response, createdAt: new Date(row.created_at) };
}

function chatNotFound(reply: FastifyReply) {
  return accountError(reply, 404, 'chat_not_found', 'Сохранённый чат не найден.');
}

function readTitle(value: unknown) {
  const title = typeof value === 'string' ? value.trim().toWellFormed() : '';
  if (title && title.length <= 80 && !title.includes('\u0000')) return title;
}

function invalidTitle(reply: FastifyReply) {
  return accountError(reply, 400, 'invalid_title', 'Введите название длиной до 80 символов.');
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function userId(request: FastifyRequest) {
  return request.getDecorator<AccountUser>('chatAccount').id;
}

export function registerChats(server: FastifyInstance, pool: Pool, options: {
  origin: string;
  discover: ReturnType<typeof createDiscovery>;
  catalog: Pick<CatalogStore, 'getEvent'>;
}) {
  const origin = new URL(options.origin).origin;
  server.register(async chats => {
    chats.decorateRequest('chatAccount', null);
    chats.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (request.method !== 'GET' && request.method !== 'HEAD' && !allowAccountOrigin(request, reply, origin)) return reply;
      const account = await getSession(pool, request);
      if (!account) return accountError(reply, 401, 'authentication_required', 'Войдите, чтобы открыть сохранённые чаты.');
      request.setDecorator('chatAccount', account);
    });
    registerEventPlans(chats, pool, options.catalog, { userId, validUuid, chatNotFound });

    chats.get('/', async request => {
      const { rows } = await pool.query<ChatRow>(`
        SELECT ${chatColumns} FROM account_chats WHERE user_id = $1 ORDER BY updated_at DESC, id DESC
      `, [userId(request)]);
      return { chats: rows.map(publicChat) };
    });

    chats.post<{ Body: TitleBody }>('/', { bodyLimit: 4096 }, async (request, reply) => {
      const title = readTitle(request.body?.title);
      if (request.body?.title !== undefined && !title) return invalidTitle(reply);
      const { rows: [chat] } = await pool.query<ChatRow>(`
        INSERT INTO account_chats (id, user_id, title)
        VALUES ($1, $2, $3)
        RETURNING ${chatColumns}
      `, [randomUUID(), userId(request), title ?? null]);
      return reply.code(201).send({ chat: publicChat(chat!) });
    });

    chats.get<{ Params: ChatParams }>('/:id', async (request, reply) => {
      if (!validUuid(request.params.id)) return chatNotFound(reply);
      const { rows: [row] } = await pool.query<ChatRow & { turns: TurnRow[] }>(`
        SELECT ${chatColumns}, COALESCE((
          SELECT jsonb_agg(row_to_json(turn) ORDER BY turn.position)
          FROM (
            SELECT ${turnColumns}, position
            FROM account_chat_turns WHERE chat_id = account_chats.id
          ) turn
        ), '[]'::jsonb) AS turns
        FROM account_chats WHERE id = $1 AND user_id = $2
      `, [request.params.id, userId(request)]);
      if (!row) return chatNotFound(reply);
      return { chat: publicChat(row), turns: row.turns.map(publicTurn) };
    });

    chats.patch<{ Params: ChatParams; Body: TitleBody }>('/:id', { bodyLimit: 4096 }, async (request, reply) => {
      if (!validUuid(request.params.id)) return chatNotFound(reply);
      const title = readTitle(request.body?.title);
      if (!title) return invalidTitle(reply);
      const { rows: [chat] } = await pool.query<ChatRow>(`
        UPDATE account_chats SET title = $3, updated_at = clock_timestamp()
        WHERE id = $1 AND user_id = $2
        RETURNING ${chatColumns}
      `, [request.params.id, userId(request), title]);
      if (!chat) return chatNotFound(reply);
      return { chat: publicChat(chat) };
    });

    chats.delete<{ Params: ChatParams }>('/:id', async (request, reply) => {
      if (!validUuid(request.params.id)) return chatNotFound(reply);
      const result = await pool.query(
        'DELETE FROM account_chats WHERE id = $1 AND user_id = $2',
        [request.params.id, userId(request)],
      );
      if (!result.rowCount) return chatNotFound(reply);
      return reply.code(204).send();
    });

    chats.post<{ Params: ChatParams; Body: TurnBody }>('/:id/turns', {
      bodyLimit: 12_288,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const { id } = request.params;
      if (!validUuid(id)) return chatNotFound(reply);
      const { message: rawMessage, requestId } = request.body ?? {};
      if (typeof rawMessage !== 'string' || rawMessage.length > 1200 || !rawMessage.trim() || rawMessage.includes('\u0000')) {
        return accountError(reply, 400, 'invalid_message', 'Напишите запрос длиной до 1200 символов.');
      }
      const message = rawMessage.trim().toWellFormed();
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
        return accountError(reply, 400, 'invalid_request_id', 'Не удалось определить запрос. Отправьте сообщение ещё раз.');
      }

      const result = await withAccountTransaction(pool, async client => {
        // Hold the chat row while discovery uses its latest context so concurrent turns cannot fork the history.
        const { rows: [chat] } = await client.query<ChatRow>(`
          SELECT ${chatColumns} FROM account_chats
          WHERE id = $1 AND user_id = $2 FOR UPDATE
        `, [id, userId(request)]);
        if (!chat) return null;

        const { rows: [duplicate] } = await client.query<TurnRow>(`
          SELECT ${turnColumns} FROM account_chat_turns WHERE chat_id = $1 AND request_id = $2
        `, [id, requestId]);
        if (duplicate) return duplicate.message === message ? { chat: publicChat(chat), turn: publicTurn(duplicate) } : 'conflict';

        const { rows: [prior] } = await client.query<{ context: DiscoveryResponse['context'] }>(`
          SELECT response->'context' AS context FROM account_chat_turns
          WHERE chat_id = $1 ORDER BY position DESC LIMIT 1
        `, [id]);
        const response = await options.discover(message, prior?.context, { planExperience: request.body?.planExperience === true });
        const { rows: [turn] } = await client.query<TurnRow>(`
          INSERT INTO account_chat_turns (chat_id, request_id, message, response)
          VALUES ($1, $2, $3, $4)
          RETURNING ${turnColumns}
        `, [id, requestId, message, response]);
        const firstLine = message.replace(/\s+/gu, ' ');
        const title = firstLine.length > 80 ? firstLine.slice(0, 79).toWellFormed() + '…' : firstLine;
        const { rows: [updated] } = await client.query<ChatRow>(`
          UPDATE account_chats SET title = COALESCE(title, $2), updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING ${chatColumns}
        `, [id, title]);
        return { chat: publicChat(updated!), turn: publicTurn(turn!) };
      });
      if (!result) return chatNotFound(reply);
      if (result === 'conflict') {
        return accountError(reply, 409, 'request_id_conflict', 'Этот запрос уже использован для другого сообщения.');
      }
      return result;
    });
  }, { prefix: '/api/v1/chats' });
}
