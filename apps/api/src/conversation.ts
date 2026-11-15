import { categories, dayPlanLimit } from '@afisha/contracts';
import type { CatalogEvent, DiscoveryContext, DiscoveryResponse } from '@afisha/contracts';
import { normalizeText } from './catalog.ts';
import type { CatalogStore } from './catalog.ts';
import { checkEvent, constraints, explain } from './discover.ts';
import { localDate, parseFilters } from './filters.ts';
import { cleanContext } from './intent.ts';

type Model = (input: unknown, timeout?: number) => Promise<unknown>;
type Options = { planExperience?: boolean; guidedPlan?: boolean; selectedEventIds?: unknown };
type RecordValue = Record<string, unknown>;
type Stats = { modelCalls: number; searches: number; elapsedMs: number; outcome: 'ok' | 'unavailable' };
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replaceAll('\0', '').trim().slice(0, limit) : '';
const ids = (value: unknown, limit: number) => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/iu.test(id)))].slice(0, limit) : [];
const patchFields = new Set([
  'city', 'venue', 'category', 'date', 'period', 'fromDate', 'untilDate', 'earliestStart', 'latestEnd',
  'child', 'childAge', 'partySize', 'budget', 'free', 'language', 'travelMinutes', 'origin', 'transport',
  'planMode', 'planCount', 'preference', 'query', 'cheaperThan', 'memory', 'interestsKnown',
  'nearEventId', 'nearbyKm',
]);

function patchContext(previous: DiscoveryContext, input: unknown): DiscoveryContext {
  const next: RecordValue = { ...previous };
  const patch = object(input);
  if (patch.period != null || patch.fromDate != null || patch.untilDate != null) delete next.date;
  if (patch.date != null || patch.fromDate != null || patch.untilDate != null) delete next.period;
  for (const [key, value] of Object.entries(patch)) {
    if (!patchFields.has(key)) continue;
    if (value === null) delete next[key];
    else next[key] = key === 'childAge' && typeof value === 'number' ? Math.floor(value) : value;
  }
  if (patch.interestsKnown === undefined && (patch.category || patch.query || patch.preference)) next.interestsKnown = true;
  // Date shapes and numeric bounds are data validation, not interpretation of the user's language.
  const result = cleanContext(next);
  if (result.date) {
    delete result.period;
    delete result.fromDate;
    delete result.untilDate;
  }
  const memory = text(next.memory, 1600);
  if (memory) result.memory = memory;
  return result;
}

function history(input: unknown): NonNullable<DiscoveryContext['conversation']> {
  if (!Array.isArray(input)) return [];
  return input.slice(-12).flatMap(item => {
    const entry = object(item);
    const content = text(entry.content, 1200);
    return content && (entry.role === 'user' || entry.role === 'assistant') ? [{ role: entry.role, content }] : [];
  });
}

function filtersFor(context: DiscoveryContext) {
  return {
    city: context.city, venue: context.venue, category: context.category, q: context.query,
    date: context.date, period: context.period, from: context.fromDate, until: context.untilDate,
    age: context.childAge?.toString(),
    maxPrice: context.free ? '0' : context.budget === undefined ? undefined : String(Math.floor(context.budget / (context.partySize ?? 1))),
  };
}

function facts(event: CatalogEvent) {
  const { id, title, city, venue, category, startsAt, endsAt, priceMin, priceMax, ageLimit, language, address, status } = event;
  return { id, title, city, venue, category, startsAt, endsAt, priceMin, priceMax, ageLimit, language, address, status,
    description: event.description?.slice(0, 650), sources: event.sources.slice(0, 2).map(({ name, verifiedAt }) => ({ name, verifiedAt })), travelVerified: false };
}

function samePlace(a: CatalogEvent, b: CatalogEvent) {
  return normalizeText(a.venue) === normalizeText(b.venue) && (!a.address || !b.address || normalizeText(a.address) === normalizeText(b.address));
}

function proximity(event: CatalogEvent, anchor: CatalogEvent, radiusKm: number) {
  const located = (item: CatalogEvent) => typeof item.latitude === 'number' && Number.isFinite(item.latitude) && Math.abs(item.latitude) <= 90 &&
    typeof item.longitude === 'number' && Number.isFinite(item.longitude) && Math.abs(item.longitude) <= 180;
  let distance: number | undefined;
  if (event.city === anchor.city && event.address && anchor.address && normalizeText(event.address) === normalizeText(anchor.address)) distance = 0;
  else if (located(event) && located(anchor)) {
    const radians = Math.PI / 180;
    const latitude = (event.latitude! - anchor.latitude!) * radians;
    const longitude = (event.longitude! - anchor.longitude!) * radians;
    const a = Math.sin(latitude / 2) ** 2 + Math.cos(anchor.latitude! * radians) * Math.cos(event.latitude! * radians) * Math.sin(longitude / 2) ** 2;
    distance = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }
  return {
    status: distance === undefined ? 'unverified' as const : distance <= radiusKm ? 'nearby' as const : 'farther' as const,
    distanceKm: distance === undefined ? undefined : Math.round(distance * 100) / 100,
    distanceType: 'straight_line' as const,
  };
}

function proximitySummary(anchor: CatalogEvent, events: CatalogEvent[], context: DiscoveryContext): string {
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', day: 'numeric', month: 'long' });
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit' });
  const radius = context.nearbyKm ?? 2;
  const unknown = events.some(event => proximity(event, anchor, radius).status === 'unverified');
  const nearby = events.filter(event => proximity(event, anchor, radius).status === 'nearby').length;
  const reference = `«${text(anchor.title, 130)}» в «${text(anchor.venue, 140)}»`;
  const lines = [nearby === events.length
    ? `Нашёл варианты рядом с местом события ${reference}. Указаны расстояния по прямой и время по афише:`
    : nearby ? `Есть варианты рядом с местом события ${reference} и альтернативы с оговоркой по расположению. Разницу отметил у каждого:`
    : unknown ? `Подтвердить близость найденных вариантов к месту события ${reference} пока не удалось: для проверки недостаточно данных. Есть альтернативы по остальным условиям:`
    : `Эти варианты предлагаю как альтернативу запросу рядом с ${reference}: они находятся дальше радиуса поиска ${number.format(radius)} км по прямой.`];
  let shown = 0;
  for (const event of events) {
    const location = proximity(event, anchor, radius);
    const start = new Date(event.startsAt);
    const end = event.endsAt ? new Date(event.endsAt) : undefined;
    const hours = end ? `${time.format(start)}–${localDate(start) === localDate(end) ? '' : day.format(end) + ', '}${time.format(end)}` : time.format(start);
    const distance = location.status === 'unverified' ? 'Расстояние до выбранного места не проверено.'
      : `Около ${number.format(location.distanceKm!)} км по прямой от «${text(anchor.venue, 100)}»${location.status === 'farther' ? ' — дальше радиуса поиска' : ''}.`;
    const entry = `${shown + 1}. «${text(event.title, 180)}» — ${text(event.venue, 180)}${event.address ? ', ' + text(event.address, 160) : ''}. По афише: ${day.format(start)}, ${hours}. ${distance}`;
    if (lines.join('\n\n').length + entry.length > 1050 && shown) break;
    lines.push(entry);
    shown++;
  }
  if (shown < events.length) lines.push('Остальные варианты и их условия — в карточках ниже.');
  if (context.travelMinutes) lines.push(`Лимит в ${context.travelMinutes} мин на дорогу пока не подтверждён.`);
  lines.push(nearby === events.length ? 'Выберите подходящий вариант.' : 'Можно выбрать альтернативу с учётом этой оговорки по расположению.');
  return text(lines.join('\n\n'), 1200);
}

function planIssues(event: CatalogEvent, selected: CatalogEvent[], position?: 'before' | 'after', availableAfter?: string): string[] {
  const start = Date.parse(event.startsAt);
  const end = event.endsAt ? Date.parse(event.endsAt) : undefined;
  for (const saved of selected) {
    if (saved.id === event.id) continue;
    if (event.city !== saved.city || localDate(new Date(event.startsAt)) !== localDate(new Date(saved.startsAt))) return ['different_plan_day_or_city'];
    const savedStart = Date.parse(saved.startsAt);
    const availability = availableAfter ? Date.parse(`${localDate(new Date(saved.startsAt))}T${availableAfter}:00+05:00`) : undefined;
    const savedEnd = saved.endsAt ? Date.parse(saved.endsAt) : availability !== undefined && availability > savedStart ? availability : undefined;
    const before = end !== undefined && (end < savedStart || end === savedStart && samePlace(event, saved));
    const after = savedEnd !== undefined && (start > savedEnd || start === savedEnd && samePlace(event, saved));
    if (!(position === 'before' ? before : position === 'after' ? after : before || after)) return ['overlap_or_unconfirmed_end_time'];
  }
  return [];
}

function eventIssues(event: CatalogEvent, context: DiscoveryContext, now: Date): string[] {
  const issues: string[] = [...checkEvent(event, context)];
  if (event.status !== 'published' || Date.parse(event.endsAt ?? event.startsAt) < now.getTime()) issues.push('not_upcoming_or_published');
  if (context.city && normalizeText(context.city) !== normalizeText(event.city)) issues.push('wrong_city');
  if (context.venue && normalizeText(context.venue) !== normalizeText(event.venue)) issues.push('wrong_venue');
  if (context.category && context.category !== event.category) issues.push('wrong_category');
  const dates = parseFilters(filtersFor(context), now);
  const startsAt = Date.parse(event.startsAt);
  if (dates.from && startsAt < Date.parse(dates.from) || dates.until && startsAt >= Date.parse(dates.until)) issues.push('wrong_date');
  return issues;
}

/** The model owns understanding, retrieval choices and questions. Tools only query and verify catalog facts. */
export function createConversationalDiscovery(catalog: CatalogStore, options: {
  model: Model; clock?: () => Date; onTurn?: (stats: Stats) => void;
}) {
  return async (message: string, prior?: unknown, request: Options = {}): Promise<DiscoveryResponse> => {
    const started = performance.now();
    const now = (options.clock ?? (() => new Date()))();
    const previous = object(prior);
    const conversation = history(previous.conversation);
    let context = patchContext(cleanContext(prior), { memory: previous.memory });
    let position = context.planStep?.position;
    const steps: unknown[] = [];
    let modelCalls = 0;
    let searches = 0;
    const available = new Map<string, CatalogEvent>();
    let requestedProximity: { eventId: string; radiusKm?: number } | undefined;
    const anchors = new Map<string, CatalogEvent>();
    const selected = (await Promise.all(ids(request.selectedEventIds, dayPlanLimit).map(id => catalog.getEvent(id))))
      .filter((event): event is CatalogEvent => Boolean(event && event.status !== 'draft'))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const recentOffers = (await Promise.all(ids(previous.lastEventIds, 5).map(id => catalog.getEvent(id))))
      .filter((event): event is CatalogEvent => Boolean(event && event.status !== 'draft'));
    context.interestsKnown ??= Boolean(context.category || context.query || context.preference || selected.length);
    for (const event of [...selected, ...recentOffers]) available.set(event.id, event);
    const directories = await catalog.directories();
    async function referenceEvent() {
      if (!context.nearEventId) return;
      if (!anchors.has(context.nearEventId)) {
        const event = await catalog.getEvent(context.nearEventId);
        if (event && event.status !== 'draft') anchors.set(event.id, event);
      }
      return anchors.get(context.nearEventId);
    }
    function proximityDetails(anchor: CatalogEvent) {
      return { referenceEvent: facts(anchor), radiusKm: context.nearbyKm ?? 2,
        radiusSource: context.nearbyKm === undefined ? 'default_search_radius' : 'user',
        distanceType: 'straight_line', routeVerified: false };
    }
    function clearReferenceFilters(anchor: CatalogEvent) {
      context.city ??= anchor.city;
      if (context.venue && normalizeText(context.venue) === normalizeText(anchor.venue)) delete context.venue;
      if (context.query && normalizeText(context.query) === normalizeText(anchor.title)) delete context.query;
    }

    const respond = (status: DiscoveryResponse['status'], reply: string, events: CatalogEvent[], suggestions: string[], anchor?: CatalogEvent) => {
      context.lastEventIds = events.length ? events.map(event => event.id) : ids(previous.lastEventIds, 5);
      context.seenEventIds = [...new Set([...ids(previous.seenEventIds, 80), ...events.map(event => event.id)])].slice(-80);
      const result: DiscoveryResponse = { status, message: reply, constraints: constraints(context), suggestions, context, events: [] };
      if (anchor) result.constraints.push({ label: 'Рядом с', value: `${anchor.title} — ${anchor.venue}` });
      for (const event of events) {
        const location = anchor ? proximity(event, anchor, context.nearbyKm ?? 2) : undefined;
        const reasons = explain(event, context, now);
        if (anchor && location) {
          if (location.status === 'unverified') reasons.push(`Расстояние до «${anchor.venue}» не удалось проверить.`);
          else reasons.push(`До «${anchor.venue}» — около ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(location.distanceKm!)} км по прямой${location.status === 'farther' ? `; дальше радиуса поиска ${context.nearbyKm ?? 2} км` : ''}.`);
        }
        if (context.travelMinutes) reasons.push(`Лимит в ${context.travelMinutes} мин на дорогу не подтверждён.`);
        const card = { event, reasons };
        if (location && location.status !== 'nearby' || context.travelMinutes) {
          (result.alternatives ??= []).push(card);
          result.alternativeReason = location && location.status !== 'nearby' ? 'proximity' : result.alternativeReason ?? 'travel';
        } else result.events.push(card);
      }
      if (!result.events.length && result.alternatives?.length) {
        result.status = 'clarify';
      }
      // Distance and opening-time claims are rendered from verified records, not model guesses.
      if (anchor && events.length) result.message = proximitySummary(anchor, events, context);
      context.conversation = history([...conversation, { role: 'user', content: message }, { role: 'assistant', content: result.message }]);
      return result;
    };

    try {
      for (let turn = 0; turn < 5; turn++) {
        const remaining = 40_000 - (performance.now() - started);
        if (remaining <= 0) throw new Error('AI turn deadline exceeded');
        const reference = await referenceEvent();
        modelCalls++;
        const action = object(await options.model({
          message, conversation, context, selectedEvents: selected.map(facts), recentOffers: recentOffers.map(facts),
          localDate: localDate(now), localTime: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', timeStyle: 'short' }).format(now),
          timezone: 'Asia/Yekaterinburg (UTC+5)', knownCities: directories.cities, categories,
          guidedPlan: request.guidedPlan === true, planExperience: request.planExperience === true,
          proximity: reference ? proximityDetails(reference) : undefined,
          steps, remainingSteps: 5 - turn,
        }, Math.min(12_000, remaining)));
        const args = object(action.arguments);
        context = patchContext(context, args.context);
        if (args.position === 'before' || args.position === 'after') position = args.position;
        else if (args.position === 'any') position = undefined;

        if (action.action === 'search_events') {
          searches++;
          try {
            const anchor = await referenceEvent();
            if (context.nearEventId && !anchor) {
              steps.push({ action: 'search_events', error: 'The referenced event is not available. Ask which known event or venue the user means rather than guessing.' });
              continue;
            }
            if (anchor) {
              requestedProximity ??= { eventId: anchor.id, radiusKm: context.nearbyKm };
              clearReferenceFilters(anchor);
            }
            const query: Record<string, string | undefined> = { ...filtersFor(context), limit: '30' };
            for (const [key, value] of Object.entries(object(args.filters))) {
              if (!['q', 'city', 'venue', 'category', 'date', 'period', 'from', 'until', 'maxPrice', 'age', 'page', 'limit'].includes(key)) continue;
              if (value === null) delete query[key];
              else if (typeof value === 'string' || typeof value === 'number') query[key] = String(value);
            }
            if (anchor && query.venue && normalizeText(query.venue) === normalizeText(anchor.venue)) delete query.venue;
            if (anchor && query.q && normalizeText(query.q) === normalizeText(anchor.title)) delete query.q;
            const filters = parseFilters(query, now);
            filters.limit = Math.min(filters.limit ?? 30, 50);
            filters.sort = filters.query ? 'relevance' : 'sessions';
            filters.matchWords = Boolean(filters.query);
            const page = await catalog.search(filters);
            const excluded: Record<string, number> = {};
            const events: CatalogEvent[] = [];
            for (const event of page.events) {
              const issues = checkEvent(event, context);
              if (issues.length) {
                for (const issue of issues) excluded[issue] = (excluded[issue] ?? 0) + 1;
              } else {
                available.set(event.id, event);
                events.push(event);
              }
            }
            steps.push({ action: 'search_events', arguments: args, result: {
              total: page.total, page: page.page, morePages: page.page * page.limit < page.total, excluded,
              appliedFilters: query,
              proximity: anchor ? proximityDetails(anchor) : undefined,
              events: events.map(event => ({ ...facts(event), offerIssues: [
                ...eventIssues(event, context, now), ...(context.planMode === 'day' ? planIssues(event, selected, position, context.earliestStart) : []),
              ], proximity: anchor ? proximity(event, anchor, context.nearbyKm ?? 2) : undefined })),
            } });
          } catch {
            steps.push({ action: 'search_events', error: 'Invalid search filters. Use the documented fields and ISO local dates.' });
          }
          continue;
        }

        if (action.action === 'get_event') {
          const event = ids([args.id], 1)[0] ? await catalog.getEvent(String(args.id)) : undefined;
          if (event && event.status === 'published') available.set(event.id, event);
          steps.push({ action: 'get_event', result: event?.status === 'published' ? facts(event) : { error: 'Event not available' } });
          continue;
        }

        if (action.action !== 'respond') {
          steps.push({ error: 'Choose search_events, get_event or respond, with an arguments object.' });
          continue;
        }
        if (requestedProximity) {
          context.nearEventId = requestedProximity.eventId;
          context.nearbyKm = requestedProximity.radiusKm;
        }
        const anchor = await referenceEvent();
        if (anchor) clearReferenceFilters(anchor);
        const reply = text(args.message, 1200);
        const chosen = Array.isArray(args.event_ids) ? args.event_ids : [];
        if (context.nearEventId && !anchor && chosen.length) {
          steps.push({ action: 'respond', error: 'The referenced event is unavailable. Ask which event or venue the user means; do not offer unverified nearby matches.' });
          continue;
        }
        if (args.status === 'no_results' && !searches) {
          steps.push({ action: 'respond', error: 'Search the live catalog before claiming there are no matches.' });
          continue;
        }
        if (anchor && searches && !chosen.length && !(context.child && context.childAge === undefined)) {
          const alternatives = [...available.values()].filter(event => event.id !== anchor.id && !selected.some(saved => saved.id === event.id) &&
            !eventIssues(event, context, now).length && !(context.planMode === 'day' ? planIssues(event, selected, position, context.earliestStart) : []).length);
          if (alternatives.length) {
            steps.push({ action: 'respond', error: 'Do not end with a generic miss or ask permission before showing useful alternatives. Mention the reference event and venue, explain whether distance is too far or unverified, and include real suitable event_ids with that caveat. Preserve the proximity request and all other constraints.',
              alternatives: alternatives.slice(0, 5).map(event => ({ ...facts(event), proximity: proximity(event, anchor, context.nearbyKm ?? 2) })) });
            continue;
          }
        }
        const limit = 5;
        if (!reply || chosen.length > limit || chosen.some(id => typeof id !== 'string' || !available.has(id)) || new Set(chosen).size !== chosen.length) {
          steps.push({ action: 'respond', error: `Use a nonempty message and at most ${limit} unique IDs actually returned by the catalog.` });
          continue;
        }
        const verified: CatalogEvent[] = [];
        const errors: unknown[] = [];
        for (const id of chosen) {
          const event = await catalog.getEvent(String(id));
          const issues = event ? [...eventIssues(event, context, now),
            ...(context.planMode === 'day' ? planIssues(event, selected, position, context.earliestStart) : [])] : ['event_no_longer_available'];
          if (issues.length) errors.push({ id, issues });
          else if (event) verified.push(event);
        }
        if (errors.length) {
          steps.push({ action: 'respond', error: 'These offers do not meet the confirmed constraints. Repair the answer without inventing facts or silently relaxing requirements.', rejected: errors });
          continue;
        }
        if (verified.length && !context.interestsKnown) {
          steps.push({ action: 'respond', error: 'The user has not said what kind of event or experience they want. Ask a natural interests/mood question with optional reply choices and no event cards. Set interestsKnown=true only after they give interests or explicitly ask you to choose freely.' });
          continue;
        }
        if (context.planMode === 'day') {
          const offers = verified.filter(event => !selected.some(saved => saved.id === event.id));
          const offer = offers[0];
          if (offer) {
            context.city ??= offer.city;
            if (offers.every(event => localDate(new Date(event.startsAt)) === localDate(new Date(offer.startsAt)))) context.date ??= localDate(new Date(offer.startsAt));
          }
          context.planStep = offer ? { phase: 'offer', eventId: offer.id, anchor: selected.at(position === 'before' ? 0 : -1)?.id, position }
            : { phase: 'question', anchor: selected.at(-1)?.id, position };
          if (offers.length > 1) context.planStep.eventIds = offers.map(event => event.id);
        }
        const status = verified.length ? 'matches' : args.status === 'no_results' ? 'no_results' : args.status === 'matches' ? 'matches' : 'clarify';
        const suggestions = Array.isArray(args.suggestions) ? args.suggestions.slice(0, 4).map(value => text(value, 100)).filter(Boolean) : [];
        options.onTurn?.({ modelCalls, searches, elapsedMs: Math.round(performance.now() - started), outcome: 'ok' });
        return respond(status, reply, verified, suggestions, anchor);
      }
      throw new Error('AI tool budget exceeded');
    } catch {
      options.onTurn?.({ modelCalls, searches, elapsedMs: Math.round(performance.now() - started), outcome: 'unavailable' });
      return respond('clarify', 'Не удалось получить ответ ИИ. Ваш разговор сохранён — попробуйте отправить сообщение ещё раз через несколько секунд.', [], []);
    }
  };
}
