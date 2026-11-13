import type { CatalogEvent } from '@afisha/contracts';

export type Point = { latitude: number; longitude: number };
export type TravelEstimate = (origin: Point, events: CatalogEvent[]) => Promise<Map<string, number>>;

export function osrmEstimator(originUrl: string): TravelEstimate {
  const endpoint = new URL(originUrl);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('ROUTING_ORIGIN must be an HTTP(S) URL without credentials.');
  }
  return async (origin, events) => {
    const located = events.filter(event => event.latitude !== undefined && event.longitude !== undefined);
    if (!located.length) return new Map();
    const coordinates = [
      `${origin.longitude},${origin.latitude}`,
      ...located.map(event => `${event.longitude},${event.latitude}`),
    ].join(';');
    const request = new URL('/table/v1/driving/' + coordinates, endpoint);
    request.searchParams.set('sources', '0');
    request.searchParams.set('destinations', located.map((_event, index) => index + 1).join(';'));
    request.searchParams.set('annotations', 'duration');
    const response = await fetch(request, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      return new Map();
    }
    const result = await response.json() as { code?: string; durations?: unknown[][] };
    const seconds = result.code === 'Ok' ? result.durations?.[0] : undefined;
    return new Map(located.flatMap((event, index) => {
      const duration = seconds?.[index];
      return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? [[event.id, Math.ceil(duration / 60)] as const] : [];
    }));
  };
}
