import { setTimeout as delay } from 'node:timers/promises';

const agent = 'UfaCultureCatalog';
export type Read = (url: string, headers?: HeadersInit, retry?: boolean) => Promise<string>;

export class SourceHttpError extends Error {
  readonly status: number;

  constructor(status: number, url: URL) {
    super(`HTTP ${status} for ${url.origin}${url.pathname}`);
    this.status = status;
  }
}

export function sourceReader(fetcher: typeof fetch): Read {
  return async (address, headers, retry = true) => {
    const url = new URL(address);
    const requestHeaders = new Headers(headers);
    requestHeaders.set('User-Agent', agent);
    const request = (timeout: number) => fetcher(url.href, {
      headers: requestHeaders, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    // Retry a transient connection failure once without retrying HTTP rate limits or access errors.
    const response = await request(6000).catch((error: unknown) => {
      const code = error instanceof Error && error.cause && typeof error.cause === 'object'
        ? (error.cause as { code?: string }).code : undefined;
      if (retry && error instanceof Error && (error.name === 'TimeoutError' ||
        code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CONNECT_TIMEOUT')) return request(6000);
      throw error;
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceHttpError(response.status, url);
    }
    if (!response.body) return '';
    const stream = response.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await stream.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 3_000_000) {
          await stream.cancel();
          throw new Error(`Response exceeds 3 MB from ${url.origin}`);
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join('');
    } finally {
      stream.releaseLock();
    }
  };
}

function robotsPolicy(body: string) {
  type Rule = { pattern: RegExp; weight: number; allow: boolean };
  const groups: { agents: string[]; rules: Rule[]; delay: number }[] = [];
  let group = { agents: [] as string[], rules: [] as Rule[], delay: 0 };
  let readingRules = false;
  for (const line of body.split(/\r?\n/)) {
    const field = line.split('#', 1)[0].match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!field) continue;
    const [, rawKey, value] = field;
    const key = rawKey.toLowerCase();
    if (key === 'user-agent') {
      if (readingRules || groups.length === 0) {
        group = { agents: [], rules: [], delay: 0 };
        groups.push(group);
        readingRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length > 0 && ['allow', 'disallow', 'crawl-delay'].includes(key)) {
      readingRules = true;
      if (key === 'crawl-delay') group.delay = Math.max(0, Number(value) || 0);
      if (value && key !== 'crawl-delay') {
        const anchored = value.endsWith('$');
        const escaped = (anchored ? value.slice(0, -1) : value).split('*')
          .map(literal => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        group.rules.push({ pattern: new RegExp('^' + escaped + (anchored ? '$' : '')), weight: value.length, allow: key === 'allow' });
      }
    }
  }
  const matching = groups.filter(entry => entry.agents.includes(agent.toLowerCase()));
  const applicable = matching.length ? matching : groups.filter(entry => entry.agents.includes('*'));
  const rules = applicable.flatMap(entry => entry.rules).sort((left, right) =>
    right.weight - left.weight || Number(right.allow) - Number(left.allow));
  return {
    delayMs: Math.max(0, ...applicable.map(entry => entry.delay * 1000)),
    allowed: (url: URL) => rules.find(rule => rule.pattern.test(url.pathname + url.search))?.allow ?? true,
  };
}

export async function openCrawler(origin: string, read: Read) {
  let robots = '';
  try {
    robots = await read(origin + '/robots.txt');
  } catch (error) {
    if (!(error instanceof SourceHttpError) || error.status !== 404) throw error;
  }
  const policy = robotsPolicy(robots);
  // Skip this run instead of overrunning a publisher's long crawl interval.
  if (policy.delayMs > 10_000) throw new Error('robots.txt crawl delay exceeds refresh budget');
  let nextRequest = Date.now() + policy.delayMs;
  let rateLimited = false;
  const allowed = (url: URL) => url.origin === origin && !url.username && !url.password && policy.allowed(url);

  return {
    allowed,
    async page(url: URL) {
      if (!allowed(url)) throw new Error('robots.txt disallows ' + url.pathname);
      const start = Math.max(Date.now(), nextRequest);
      nextRequest = start + policy.delayMs;
      if (start > Date.now()) await delay(start - Date.now());
      if (rateLimited) throw new Error('Publisher rate limited this refresh');
      try {
        return await read(url.href, undefined, policy.delayMs === 0);
      } catch (error) {
        if (error instanceof SourceHttpError && error.status === 429) rateLimited = true;
        throw error;
      }
    },
  };
}

export async function mapConcurrent<Input, Output>(
  items: readonly Input[], concurrency: number, work: (item: Input) => Promise<Output>,
): Promise<PromiseSettledResult<Output>[]> {
  const results: PromiseSettledResult<Output>[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}
