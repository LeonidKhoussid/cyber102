import type {
  CatalogEvent, Directories, DiscoveryContext, DiscoveryResponse, EventPage, QueryValues, Subscription,
} from '@afisha/contracts';

export type BotService = {
  search: (filters: QueryValues) => Promise<EventPage>;
  event: (id: string) => Promise<CatalogEvent | undefined>;
  directories: () => Promise<Directories>;
  discover: (message: string, context?: DiscoveryContext) => Promise<DiscoveryResponse>;
  subscribe: (subscriber: string, subscription: Subscription) => Promise<void>;
  unsubscribe: (subscriber: string) => Promise<number>;
};

export class BotServiceError extends Error {
  constructor() {
    super('Backend request failed');
  }
}

export function createBotService(origin: string, token: string, fetcher: typeof fetch = fetch): BotService {
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('API_ORIGIN must be an HTTP(S) origin.');
  }

  async function request(path: string, init?: RequestInit, allowMissing = false): Promise<Response> {
    try {
      const response = await fetcher(new URL(path, base), {
        ...init, redirect: 'error', signal: AbortSignal.timeout(path === '/api/v1/discover' ? 25_000 : 8_000),
      });
      if (response.ok || (allowMissing && response.status === 404)) return response;
      await response.body?.cancel();
    } catch {
      throw new BotServiceError();
    }
    throw new BotServiceError();
  }

  async function json<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new BotServiceError();
    }
  }

  function send(method: string, body: object, authenticated = false): RequestInit {
    return {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    };
  }

  const subscriptions = '/api/v1/bot/subscriptions';
  return {
    async search(filters) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) query.set(key, value);
      }
      return json(await request(`/api/v1/events?${query}`));
    },
    async event(id) {
      const response = await request(`/api/v1/events/${encodeURIComponent(id)}`, undefined, true);
      if (response.status !== 404) return json(response);
      await response.body?.cancel();
    },
    async directories() {
      return json(await request('/api/v1/directories'));
    },
    async discover(message, context) {
      return json(await request('/api/v1/discover', send('POST', { message, context })));
    },
    async subscribe(subscriber, subscription) {
      const response = await request(subscriptions, send('PUT', { subscriber, ...subscription }, true));
      await response.body?.cancel();
    },
    async unsubscribe(subscriber) {
      const response = await request(subscriptions, send('DELETE', { subscriber }, true));
      return (await json<{ removed: number }>(response)).removed;
    },
  };
}
