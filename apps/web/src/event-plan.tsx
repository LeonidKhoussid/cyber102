import { useEffect, useRef, useState } from 'react';
import { dayPlanLimit } from '@afisha/contracts';
import type { CatalogEvent, DiscoveryContext } from '@afisha/contracts';
import { chatsPath, errorText, jsonBody } from './account.tsx';
import { eventLocalDay, EventTime } from './events.tsx';
import { request, useData } from './http.ts';
import { Icon, Notice } from './ui.tsx';
import { formatRouteDuration, YandexRoute } from './yandex-route.tsx';
import type { RouteLocation, RouteResult } from './yandex-route.tsx';

const guestPlanKey = 'afisha.event-plan.v1';
const dayLabel = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', day: 'numeric', month: 'long', weekday: 'long' });
const departureLabel = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const transportOptions = {
  car: 'На машине', transit: 'На общественном транспорте', walk: 'Пешком', bike: 'На велосипеде', taxi: 'На такси',
} as const;

type PlanData = { events: CatalogEvent[] };
type AccountPlan = PlanData & { key?: string; loading?: boolean; loadError?: string; writeError?: string; saving?: boolean };

function readGuestPlan(): CatalogEvent[] {
  try {
    const events = JSON.parse(sessionStorage.getItem(guestPlanKey) ?? '[]');
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

export function useEventPlan(accountId?: string, chatId?: string) {
  const [guestEvents, setGuestEvents] = useState(readGuestPlan);
  const [accountPlan, setAccountPlan] = useState<AccountPlan>({ events: [] });
  const [attempt, setAttempt] = useState(0);
  const writes = useRef(new Map<string, Promise<PlanData>>());
  const key = accountId && chatId ? `${accountId}/${chatId}` : undefined;
  const endpoint = accountId && chatId ? `${chatsPath}/${encodeURIComponent(chatId)}/event-plan` : undefined;

  useEffect(() => {
    try {
      sessionStorage.setItem(guestPlanKey, JSON.stringify(guestEvents));
    } catch {
      // A guest can still edit their current plan without browser storage.
    }
  }, [guestEvents]);

  useEffect(() => {
    if (!key || !endpoint) return;
    const active = new AbortController();
    setAccountPlan({ key, events: [], loading: true });
    async function load(path: string, planKey: string) {
      try {
        await writes.current.get(planKey)?.catch(() => undefined);
        if (active.signal.aborted) return;
        const result = await request<PlanData>(path, { signal: active.signal });
        if (!active.signal.aborted) setAccountPlan({ key: planKey, events: result.events });
      } catch (error) {
        if (!active.signal.aborted) setAccountPlan({ key: planKey, events: [], loadError: errorText(error, 'Не удалось загрузить план дня.') });
      }
    }
    void load(endpoint, key);
    return () => active.abort();
  }, [attempt, endpoint, key]);

  const selected = accountId ? (key && accountPlan.key === key ? accountPlan : { events: [], loading: Boolean(chatId) }) : { events: guestEvents };

  async function toggle(event: CatalogEvent, date: string, remove: boolean) {
    const select = (events: CatalogEvent[]) => remove ? events.filter(item => item.id !== event.id) : [...events, event];
    if (!accountId) {
      if (!remove && (guestEvents.some(saved => saved.id === event.id) || planRejection(guestEvents, event, date))) return;
      const events = select(guestEvents);
      setGuestEvents(events);
      return events;
    }
    if (!key || !endpoint || selected.loading || selected.loadError || writes.current.has(key)) return;
    const path = `${endpoint}/${encodeURIComponent(event.id)}`;
    const operation = request<PlanData>(path, remove ? { method: 'DELETE' } : jsonBody('PUT', { date }));
    writes.current.set(key, operation);
    setAccountPlan(previous => ({ ...previous, saving: true, writeError: undefined }));
    try {
      const { events } = await operation;
      setAccountPlan(previous => previous.key === key && !previous.loading ? { key, events } : previous);
      return events;
    } catch (error) {
      setAccountPlan(previous => previous.key === key && !previous.loading ? {
        ...previous, saving: false, writeError: errorText(error, 'Не удалось изменить план дня.'),
      } : previous);
    } finally {
      writes.current.delete(key);
    }
  }

  return { ...selected, toggle, clearGuest: () => setGuestEvents([]), retry: () => setAttempt(previous => previous + 1) };
}

export function planRejection(events: CatalogEvent[], event: CatalogEvent, date: string) {
  if (event.status !== 'published') return 'Событие недоступно.';
  if (eventLocalDay(event) !== date) return 'Событие в другой день.';
  const first = events[0];
  if (first && (locationKey(first.city) !== locationKey(event.city) || eventLocalDay(first) !== date)) return 'В плане уже есть события на другой день или в другом городе.';
  if (events.length >= dayPlanLimit) return 'В плане уже четыре события.';
}

export const locationKey = (value: string) => value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function eventLocation(event: CatalogEvent): RouteLocation {
  return {
    label: event.venue,
    city: event.city,
    address: event.address?.trim() ? `${event.city}, ${event.address}` : undefined,
    latitude: event.latitude,
    longitude: event.longitude,
  };
}

function startLocation(origin: string, city: string, knownLocations: CatalogEvent[]): RouteLocation {
  const label = 'Точка отправления';
  const coordinates = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/u.exec(origin);
  if (coordinates && Math.abs(Number(coordinates[1])) <= 90 && Math.abs(Number(coordinates[2])) <= 180) {
    return { label, city, latitude: Number(coordinates[1]), longitude: Number(coordinates[2]) };
  }
  const cityKey = locationKey(city);
  const originKey = locationKey(origin);
  const known = knownLocations.filter(event => event.status === 'published' && locationKey(event.city) === cityKey &&
    [event.venue, `${event.city}, ${event.venue}`].some(name => locationKey(name) === originKey)).map(eventLocation)
    .filter(location => location.address || (location.latitude !== undefined && location.longitude !== undefined));
  const candidate = known[0];
  if (candidate && known.every(location => location.address === candidate.address &&
    location.latitude === candidate.latitude && location.longitude === candidate.longitude)) return { ...candidate, label };
  return {
    label, city,
    address: ` ${originKey} `.includes(` ${cityKey} `) ? origin : `${city}, ${origin}`,
  };
}

function Journey({ events, origin, originLocation, transport, travelMinutes }: {
  events: CatalogEvent[]; origin?: string; originLocation?: RouteLocation;
  transport: NonNullable<DiscoveryContext['transport']>; travelMinutes?: number;
}) {
  const { data, error, retry } = useData<{ yandexApiKey?: string }>('/api/v1/maps/config');
  const heading = useRef<HTMLHeadingElement>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const stops = originLocation ? events : events.slice(1);
  const start = originLocation ?? eventLocation(events[0]);
  const transfers = route?.legs.length === stops.length ? route.legs : undefined;
  const departure = originLocation && transfers && new Date(Date.parse(events[0].startsAt) - transfers[0].durationSeconds * 1000);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, []);

  return <section className="plan-route" aria-labelledby="plan-route-heading">
    <h3 id="plan-route-heading" ref={heading} tabIndex={-1}>Маршрут</h3>
    <p className="plan-meta plan-context">{transportOptions[transport]} · Откуда: {origin ?? events[0].venue}</p>
    {error && <Notice text="Не удалось загрузить настройки карты." retry={retry} />}
    {data || error ?
      <YandexRoute apiKey={data?.yandexApiKey ?? null} mode={transport} origin={start}
        stops={stops.map(eventLocation)} onResult={setRoute} /> :
      <p className="loading" role="status"><span className="spinner" />Загружаем карту…</p>}
    {departure && <p className="plan-meta">Отправление к первому событию — ориентировочно не позже <time dateTime={departure.toISOString()}>{departureLabel.format(departure)}</time>.</p>}
    {!transfers && travelMinutes !== undefined && <p className="plan-warning">Условие «не больше {travelMinutes} мин на дорогу» пока не проверено.</p>}
    {transfers && <ol aria-label="Отрезки маршрута" className="plan-transfers">{stops.map((event, index) => {
      const previous = events[originLocation ? index - 1 : index];
      const ride = transfers[index].durationSeconds;
      const gapSeconds = previous?.endsAt && (Date.parse(event.startsAt) - Date.parse(previous.endsAt)) / 1000;
      const tooShort = typeof gapSeconds === 'number' && gapSeconds >= 0 && ride > gapSeconds;
      return <li key={event.id}>
        <span>{previous?.venue ?? 'Точка отправления'} → {event.venue}</span>
        <strong>{ride === 0 ? 'На месте' : `≈ ${formatRouteDuration(ride)}`}</strong>
        {tooShort && <small className="plan-warning">Не хватает времени на дорогу до «{event.title}».</small>}
        {travelMinutes !== undefined && ride > travelMinutes * 60 && <small className="plan-warning">Дорога займёт больше {travelMinutes} мин.</small>}
      </li>;
    })}</ol>}
  </section>;
}

function BuildJourney({ events, origin, originLocation, transport, travelMinutes, waiting }: {
  events: CatalogEvent[]; origin?: string; originLocation?: RouteLocation;
  transport?: DiscoveryContext['transport']; travelMinutes?: number; waiting: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  return <>
    <button type="button" className="primary plan-build" disabled={waiting || !transport} onClick={() => setAttempt(previous => previous + 1)}>
      <Icon name="pin" />{attempt ? 'Перестроить маршрут' : 'Построить маршрут'}
    </button>
    {attempt > 0 && transport && <Journey key={attempt} events={events}
      origin={origin} originLocation={originLocation} transport={transport} travelMinutes={travelMinutes} />}
  </>;
}

export function EventPlan({ plan, context, open, onToggle, waiting, differentPlan, canEditRoute, knownLocations, onRemove, onOrigin, onResetOrigin, onTransport }: {
  plan: ReturnType<typeof useEventPlan>; context?: DiscoveryContext; waiting: boolean; differentPlan: boolean;
  open: boolean; onToggle: () => void;
  canEditRoute: boolean; knownLocations: CatalogEvent[];
  onRemove: (event: CatalogEvent) => void; onOrigin: () => void; onResetOrigin: () => void; onTransport: (text: string) => void;
}) {
  const [editTransport, setEditTransport] = useState(false);
  const events = [...plan.events].sort((first, second) => Date.parse(first.startsAt) - Date.parse(second.startsAt));
  const first = events[0];
  const date = first ? eventLocalDay(first) : context?.date;
  const city = first?.city ?? context?.city;
  const enough = events.length >= 2;
  const eligible = events.every(event => event.status === 'published');
  const origin = context?.origin;
  const transport = context?.transport;
  const blocked = waiting || plan.saving;
  const originLocation = origin && city ? startLocation(origin, city, [...events, ...knownLocations]) : undefined;

  return <section id="event-plan" className="event-plan" aria-labelledby="event-plan-heading" data-open={open}>
    <header className="plan-heading">
      <h2 id="event-plan-heading">
        <button id="event-plan-toggle" type="button" aria-expanded={open} aria-controls="event-plan-content" onClick={onToggle}>
          <Icon name="calendar" /><span>План дня</span>
          <span className="plan-chevron"><Icon name="chevron" /></span>
        </button>
      </h2>
      <span className="plan-count" aria-live="polite">{events.length} из {dayPlanLimit}</span>
    </header>
    <div id="event-plan-content" className="plan-disclosure" inert={!open} aria-hidden={!open}>
      <div className="plan-clip"><div className="plan-content">
        {(city || date) && <p className="plan-meta plan-context">{[city, date && dayLabel.format(new Date(`${date}T12:00:00+05:00`))].filter(Boolean).join(' · ')}</p>}
        {plan.loading && <p className="loading" role="status"><span className="spinner" />Загружаем план дня…</p>}
        {plan.loadError && <Notice text={plan.loadError} retry={plan.retry} />}
        {plan.writeError && <Notice text={plan.writeError} />}
        {differentPlan && <p className="plan-warning">Чтобы собрать план на другой день или в другом городе, сначала уберите сохранённые события.</p>}
        {events.length > 0 ? <ol className="plan-agenda" aria-label="События по времени">{events.map((event, index) => {
          const start = Date.parse(event.startsAt);
          const end = event.endsAt ? Date.parse(event.endsAt) : start;
          const overlap = events.some((other, otherIndex) => {
            if (otherIndex === index) return false;
            const otherStart = Date.parse(other.startsAt);
            const otherEnd = other.endsAt ? Date.parse(other.endsAt) : otherStart;
            return start === otherStart || (start < otherEnd && otherStart < end);
          });
          return <li key={event.id}>
            <div className="plan-event-details">
              <a className="plan-event-title" href={`/events/${encodeURIComponent(event.id)}`}>{event.title}</a>
              <p className="plan-event-time"><EventTime event={event} /></p>
              <p className="plan-meta">{event.venue}{event.address && ` · ${event.address}`}</p>
              {event.status !== 'published' && <p className="plan-warning">Событие недоступно. Уберите его, чтобы построить маршрут.</p>}
              {!event.endsAt && <p className="plan-warning">Время окончания не указано.</p>}
              {overlap && <p className="plan-warning">Пересекается по времени с другим событием.</p>}
            </div>
            <button type="button" className="prompt-chip" aria-label={`Убрать из плана: ${event.title}`} disabled={blocked} onClick={() => onRemove(event)}><Icon name="close" />Убрать</button>
          </li>;
        })}</ol> : !plan.loading && !plan.loadError && <p className="plan-meta">Добавьте события из подборки.</p>}
        {first && !enough && <p className="plan-meta">Добавьте ещё одно событие для маршрута.</p>}
        {first && enough && eligible && <div className="plan-setup">
          {!origin && <p className="plan-meta">Маршрут начнётся с первого события.</p>}
          {canEditRoute && (!transport || editTransport) && <div>
            <p className="plan-meta">Как будете добираться?</p>
            <div className="suggestions">{Object.values(transportOptions).map(label => <button type="button" key={label} className="prompt-chip" disabled={blocked}
              onClick={() => { setEditTransport(false); onTransport(label); }}>{label}</button>)}</div>
          </div>}
          {canEditRoute && <div className="plan-tools">
            <button type="button" className="prompt-chip" disabled={blocked} onClick={onOrigin}><Icon name="pin" />{origin ? 'Изменить точку отправления' : 'Добавить точку отправления'}</button>
            {origin && <button type="button" className="prompt-chip" disabled={blocked} onClick={onResetOrigin}>Начать с первого события</button>}
            {transport && !editTransport && <button type="button" className="prompt-chip" disabled={blocked} onClick={() => setEditTransport(true)}>Изменить транспорт</button>}
          </div>}
          <BuildJourney key={JSON.stringify([originLocation, transport, events])} events={events}
            origin={origin} originLocation={originLocation} transport={transport} travelMinutes={context?.travelMinutes} waiting={Boolean(blocked)} />
        </div>}
      </div></div>
    </div>
  </section>;
}
