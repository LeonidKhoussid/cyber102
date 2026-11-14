import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Icon } from './ui.tsx';
import './yandex-route.css';

export type RouteMode = 'car' | 'transit' | 'walk' | 'bike' | 'taxi';
export type RouteLocation = { label: string; address?: string | null; city?: string; latitude?: number | null; longitude?: number | null };
type RouteMetrics = { durationSeconds: number; distanceMeters: number | null };
export type RouteResult = RouteMetrics & { legs: RouteMetrics[] };

type Coordinates = [latitude: number, longitude: number];
type RoutePoint = string | Coordinates;
type AddressPoint = { address: string; city?: string };
type ResolvablePoint = Coordinates | AddressPoint;
type Bounds = [Coordinates, Coordinates];
type Properties = { get(name: string): unknown };
type ActiveRoute = {
  properties: Properties;
  getPaths(): { each(callback: (path: { properties: Properties }) => void): void };
};
type MultiRoute = {
  model: {
    destroy(): void;
    getWayPoints(): { getReferencePointIndex(): number; properties: Properties }[];
    events: {
      add(event: string, listener: () => void): void;
      remove(event: string, listener: () => void): void;
    };
  };
  getActiveRoute(): ActiveRoute | null;
};
type YandexMap = {
  geoObjects: { add(route: MultiRoute): void; remove(route: MultiRoute): void; getBounds(): Bounds | null };
  setBounds(bounds: Bounds, options: { checkZoomRange: boolean; zoomMargin: number }): void;
  destroy(): void;
};
type YandexMaps = {
  ready(success: () => void, failure: () => void): void;
  Map: new (
    container: HTMLElement,
    state: { center: Coordinates; zoom: number; controls: string[]; behaviors: string[] },
    options: { autoFitToViewport: string },
  ) => YandexMap;
  multiRouter: {
    MultiRoute: new (
      model: { referencePoints: RoutePoint[]; params: { routingMode: string; results: number } },
      options: { boundsAutoApply: boolean },
    ) => MultiRoute;
  };
};

const routingModes: Record<RouteMode, string> = { car: 'auto', transit: 'masstransit', walk: 'pedestrian', bike: 'bicycle', taxi: 'auto' };
const linkModes: Record<RouteMode, string> = { car: 'auto', transit: 'mt', walk: 'pd', bike: 'bc', taxi: 'taxi' };
const mapTimeout = 12_000;
const routeTimeout = 10_000;
let mapsPromise: Promise<YandexMaps> | undefined;

function loadMaps(key: string) {
  mapsPromise ??= new Promise<YandexMaps>((resolve, reject) => {
    const url = new URL('https://api-maps.yandex.ru/2.1/');
    url.search = new URLSearchParams({ apikey: key, lang: 'ru_RU', coordorder: 'latlong' }).toString();
    const script = document.createElement('script');
    script.src = url.href;
    script.async = true;

    const fail = () => {
      window.clearTimeout(timeout);
      detachHandlers();
      script.remove();
      reject(new Error('Yandex Maps SDK unavailable'));
    };
    const detachHandlers = () => { script.onload = null; script.onerror = null; };
    const timeout = window.setTimeout(fail, mapTimeout);
    script.onerror = fail;
    script.onload = () => {
      const maps = (window as Window & { ymaps?: YandexMaps }).ymaps;
      if (!maps) return fail();
      try {
        maps.ready(() => {
          window.clearTimeout(timeout);
          detachHandlers();
          resolve(maps);
        }, fail);
      } catch {
        fail();
      }
    };
    document.head.append(script);
  }).catch(error => {
    mapsPromise = undefined;
    throw error;
  });
  return mapsPromise;
}

function routePoint({ address, city, latitude, longitude }: RouteLocation): ResolvablePoint | null {
  if (typeof latitude === 'number' && Math.abs(latitude) <= 90 &&
      typeof longitude === 'number' && Math.abs(longitude) <= 180) return [latitude, longitude];
  const text = address?.trim();
  return text ? { address: text, city } : null;
}

function nextPointKey(point: ResolvablePoint) {
  return Array.isArray(point) ? point.join(',') : point.address.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}

function yandexMapsLink(points: ResolvablePoint[], mode: RouteMode, widget = false) {
  const url = new URL(widget ? 'https://yandex.ru/map-widget/v1/' : 'https://yandex.ru/maps/');
  const rtext = points.map(point => Array.isArray(point) ? point.join(',') : point.address.replaceAll('~', ' ')).join('~');
  url.search = new URLSearchParams({ mode: 'routes', rtext, rtt: linkModes[mode] }).toString();
  return url.href;
}

function propertyNumber(properties: Properties, name: string) {
  const metric = properties.get(name) as { value?: unknown } | null;
  const value = metric?.value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function metrics(properties: Properties, useTraffic = false): RouteMetrics | null {
  const durationSeconds = (useTraffic ? propertyNumber(properties, 'durationInTraffic') : null) ?? propertyNumber(properties, 'duration');
  return durationSeconds === null ? null : { durationSeconds, distanceMeters: propertyNumber(properties, 'distance') };
}

function measure(route: ActiveRoute, expectedLegs: number, routingMode: string): RouteResult {
  const paths: Properties[] = [];
  route.getPaths().each(path => paths.push(path.properties));
  if (paths.length !== expectedLegs) throw new Error('Yandex route has missing legs');
  const useTraffic = routingMode === 'auto' && propertyNumber(route.properties, 'durationInTraffic') !== null &&
    paths.every(path => propertyNumber(path, 'durationInTraffic') !== null);
  const total = metrics(route.properties, useTraffic);
  const legs = paths.map(path => metrics(path, useTraffic));
  if (!total || legs.some(leg => leg === null)) throw new Error('Yandex route has missing duration');
  return { ...total, legs: legs.filter(leg => leg !== null) };
}

class UnresolvedAddress extends Error {}

function addressWords(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

function validateAddresses(route: MultiRoute, points: ResolvablePoint[]) {
  if (points.every(Array.isArray)) return;
  const waypoints = route.model.getWayPoints();
  for (const [index, point] of points.entries()) {
    if (Array.isArray(point)) continue;
    const waypoint = waypoints.find(item => item.getReferencePointIndex() === index);
    const metadata = waypoint?.properties.get('geocoderMetaData') as {
      kind?: string;
      precision?: string;
      text?: string;
      Address?: { Components?: { kind: string; name: string }[] };
    } | undefined;
    const resolvedAddress = metadata?.text ?? waypoint?.properties.get('address');
    const resolvedCities = metadata?.Address?.Components?.filter(component => component.kind === 'locality') ?? [];
    const expectedCity = addressWords(point.city ?? '');
    const matchingCity = !expectedCity || (resolvedCities.length
      ? resolvedCities.some(city => addressWords(city.name) === expectedCity)
      : typeof resolvedAddress === 'string' && ` ${addressWords(resolvedAddress)} `.includes(` ${expectedCity} `));
    if (metadata?.kind !== 'house' || metadata.precision !== 'exact' || !matchingCity) throw new UnresolvedAddress(point.address);
  }
}

function getRoute(maps: YandexMaps, map: YandexMap, points: ResolvablePoint[], routingMode: string, signal: AbortSignal) {
  return new Promise<RouteResult>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const route = new maps.multiRouter.MultiRoute(
      { referencePoints: points.map(point => Array.isArray(point) ? point : point.address), params: { routingMode, results: 1 } },
      { boundsAutoApply: false },
    );
    const { events } = route.model;
    let added = false;
    const clearRequest = () => {
      window.clearTimeout(timeout);
      events.remove('requestsuccess', success);
      events.remove('requestfail', failure);
    };
    const dispose = () => {
      clearRequest();
      signal.removeEventListener('abort', abort);
      if (added) map.geoObjects.remove(route);
      route.model.destroy();
    };
    const fail = (error: unknown) => {
      dispose();
      reject(error);
    };
    const success = () => {
      try {
        const selected = route.getActiveRoute();
        if (!selected) throw new Error('Yandex could not find a route');
        const result = measure(selected, points.length - 1, routingMode);
        validateAddresses(route, points);
        clearRequest();
        resolve(result);
      } catch (error) {
        fail(error);
      }
    };
    const failure = () => fail(new Error('Yandex route request failed'));
    const abort = () => fail(signal.reason);
    const timeout = window.setTimeout(failure, routeTimeout);
    events.add('requestsuccess', success);
    events.add('requestfail', failure);
    signal.addEventListener('abort', abort, { once: true });
    try {
      added = true;
      map.geoObjects.add(route);
    } catch (error) {
      fail(error);
    }
  });
}

async function getFullRoute(maps: YandexMaps, map: YandexMap, points: ResolvablePoint[], mode: RouteMode, signal: AbortSignal): Promise<RouteResult> {
  const distinct = points.filter((point, index) => index === 0 || nextPointKey(points[index - 1]) !== nextPointKey(point));
  const repeated = distinct.length !== points.length;
  if (distinct.length === 1) {
    const result = await getRoute(maps, map, [distinct[0], distinct[0]], routingModes[mode], signal);
    return { ...result, legs: points.slice(1).map(() => result.legs[0]) };
  }
  let result: RouteResult;
  try {
    result = await getRoute(maps, map, distinct, routingModes[mode], signal);
  } catch (error) {
    if (distinct.length <= 2 || signal.aborted || error instanceof UnresolvedAddress) throw error;
    // Some modes and endpoints do not return all paths for a multistop request.
    const legs = await Promise.all(distinct.slice(1).map((point, index) => getRoute(maps, map, [distinct[index], point], routingModes[mode], signal)));
    const distanceMeters = legs.every(leg => leg.distanceMeters !== null) ? legs.reduce((sum, leg) => sum + (leg.distanceMeters ?? 0), 0) : null;
    result = { durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0), distanceMeters, legs: legs.flatMap(leg => leg.legs) };
  }
  if (!repeated) return result;
  let legIndex = 0;
  return {
    ...result,
    legs: points.slice(1).map((point, index) => nextPointKey(point) === nextPointKey(points[index])
      ? { durationSeconds: 0, distanceMeters: 0 }
      : result.legs[legIndex++]),
  };
}

const distanceFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export function formatRouteDuration(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const remainder = minutes % 60;
  return `${Math.floor(minutes / 60)} ч${remainder ? ` ${remainder} мин` : ''}`;
}

function formatDistance(meters: number) {
  return meters < 1000 ? `${Math.round(meters)} м` : `${distanceFormat.format(meters / 1000)} км`;
}

export function YandexRoute({ apiKey, mode, origin, stops, onResult }: {
  apiKey?: string | null;
  mode: RouteMode;
  origin: RouteLocation;
  stops: RouteLocation[];
  onResult?: (result: RouteResult | null) => void;
}) {
  const mapNode = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ id: string; result: RouteResult | null; unresolvedAddress?: string }>();
  const publishResult = useEffectEvent((result: RouteResult | null) => onResult?.(result));
  const locations = [origin, ...stops];
  const points = locations.map(routePoint);
  const missing = locations.filter((_, index) => points[index] === null);
  const validPoints = !missing.length && stops.length > 0 && stops.length <= 4 ? points.filter(point => point !== null) : null;
  const href = validPoints ? yandexMapsLink(validPoints, mode) : null;
  const serializedPoints = validPoints ? JSON.stringify(validPoints) : null;
  const key = apiKey?.trim() || '';
  const requestId = JSON.stringify([mode, serializedPoints, attempt, Boolean(key)]);
  const active = state?.id === requestId ? state : undefined;
  const widget = validPoints && (!key || (active && !active.result && !active.unresolvedAddress))
    ? yandexMapsLink(validPoints, mode, true) : null;
  const stationary = validPoints?.every(point => nextPointKey(point) === nextPointKey(validPoints[0]));

  useEffect(() => {
    setState(undefined);
    publishResult(null);
    const node = mapNode.current;
    if (!key || !serializedPoints || !node) return;
    let map: YandexMap | undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const routePoints = JSON.parse(serializedPoints) as ResolvablePoint[];
    const run = async () => {
      try {
        const maps = await loadMaps(key);
        if (signal.aborted) return;
        const center = routePoints.find((point): point is Coordinates => Array.isArray(point)) ?? [54.7352, 55.9587];
        const currentMap = new maps.Map(node, {
          center, zoom: 12, controls: ['zoomControl'], behaviors: ['drag', 'multiTouch', 'dblClickZoom'],
        }, { autoFitToViewport: 'always' });
        map = currentMap;
        const result = await getFullRoute(maps, currentMap, routePoints, mode, signal);
        if (signal.aborted) return;
        const bounds = currentMap.geoObjects.getBounds();
        if (bounds) currentMap.setBounds(bounds, { checkZoomRange: true, zoomMargin: 32 });
        setState({ id: requestId, result });
        publishResult(result);
      } catch (error) {
        if (signal.aborted) return;
        controller.abort();
        map?.destroy();
        map = undefined;
        setState({ id: requestId, result: null, unresolvedAddress: error instanceof UnresolvedAddress ? error.message : undefined });
      }
    };
    void run();
    return () => {
      controller.abort();
      map?.destroy();
    };
  }, [key, mode, serializedPoints, requestId]);

  return <section className="yandex-route" aria-label="Маршрут в Яндекс Картах">
    {key && validPoints && <div
      ref={mapNode}
      className={`yandex-route-map${active?.result ? '' : ' yandex-route-map-hidden'}`}
      aria-label="Интерактивная карта маршрута"
      aria-hidden={!active?.result || undefined}
      inert={!active?.result || undefined}
    />}
    {widget && <iframe className="yandex-route-map" title="Интерактивная карта маршрута" src={widget} />}
    <div className="yandex-route-status" aria-live="polite">
      {!stops.length ? null
        : missing.length ? <p>Для маршрута нужны адреса: {missing.map(location => location.label).join(', ')}.</p>
          : !validPoints ? <p>Можно добавить до четырёх остановок.</p>
            : !key ? null
              : !active ? <p>Строим маршрут…</p>
                : active.result ? <p><strong>В пути около {formatRouteDuration(active.result.durationSeconds)}</strong>{active.result.distanceMeters !== null && ` · ${formatDistance(active.result.distanceMeters)}`}</p>
                  : active.unresolvedAddress ? <p>Яндекс Карты не нашли точный адрес «{active.unresolvedAddress}». Уточните адрес или используйте координаты.</p>
                    : <p>Оценки для отдельных участков недоступны. <button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p>}
      {active?.result && !stationary && <p>Оценка по текущим условиям.</p>}
      {mode === 'taxi' && active?.result && <p>Оценка по автомобильному маршруту. Добавьте время на подачу такси.</p>}
    </div>
    {href && <a className="text-link yandex-route-link" href={href} target="_blank" rel="noreferrer">Открыть в Яндекс Картах <Icon name="diagonal" /></a>}
  </section>;
}
