import { categories } from '@afisha/contracts';
import type { CatalogEvent, DiscoveryContext, DiscoveryResponse } from '@afisha/contracts';
import { normalizeText } from './catalog.ts';
import type { Catalog, EventFilters } from './catalog.ts';
import { datePeriod, localDate } from './filters.ts';
import { cleanContext, constraintIssue, readIntent } from './intent.ts';
import type { Point, TravelEstimate } from './routing.ts';

type Interpret = (message: string, context: DiscoveryContext, cities: string[], date: string) => Promise<DiscoveryContext>;
type Options = { clock?: () => Date; travel?: TravelEstimate; interpret?: Interpret };
type Match = DiscoveryResponse['events'][number];
type Rejection = 'age' | 'budget' | 'end' | 'start' | 'travel' | 'unknownAge' | 'unknownPrice' | 'unknownEnd' | 'unknownTravel';

const shortDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', weekday: 'long', day: 'numeric', month: 'long' });
const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const money = new Intl.NumberFormat('ru-RU');
const periods = { today: 'Сегодня', tomorrow: 'Завтра', weekend: 'Ближайшие выходные', week: 'Ближайшие 7 дней' };

function labelDate(date: string) {
  return shortDate.format(new Date(date + 'T12:00:00+05:00'));
}

function constraints(context: DiscoveryContext) {
  const labels: DiscoveryResponse['constraints'] = [];
  function show(label: string, value: string | undefined) {
    if (value) labels.push({ label, value });
  }
  show('Город', context.city);
  show('Когда', context.date ? labelDate(context.date) : context.period && periods[context.period]);
  show('Категория', context.category && categories[context.category]);
  show('Ребёнок', context.childAge === undefined ? context.child ? 'Возраст уточняется' : undefined : `${context.childAge} лет`);
  show('Участники', context.partySize ? String(context.partySize) : undefined);
  show('Цена', context.cheaperThan !== undefined ? `Меньше ${money.format(context.cheaperThan)} ₽` : undefined);
  show('Бюджет', context.budget === undefined ? undefined : context.budget === 0 ? 'Бесплатно' :
    `До ${money.format(context.budget)} ₽${context.partySize ? ' на всех' : ' за билет'}`);
  show('Начало', context.earliestStart && `С ${context.earliestStart}`);
  show('Окончание', context.latestEnd && `До ${context.latestEnd}`);
  show('Дорога', context.travelMinutes && `До ${context.travelMinutes} мин` || undefined);
  show('Откуда', context.origin);
  show('Интерес', context.query);
  return labels;
}

function totalCost(event: CatalogEvent, context: DiscoveryContext): number | undefined {
  return event.priceMin === undefined ? undefined : event.priceMin * (context.partySize ?? 1);
}

function checkEvent(event: CatalogEvent, context: DiscoveryContext): Rejection | undefined {
  if (context.childAge !== undefined) {
    if (event.ageLimit === undefined) return 'unknownAge';
    if (event.ageLimit > context.childAge) return 'age';
  }
  if (context.budget !== undefined || context.cheaperThan !== undefined || context.free) {
    const cost = totalCost(event, context);
    if (cost === undefined) return 'unknownPrice';
    if ((context.budget !== undefined && cost > context.budget) ||
        (context.cheaperThan !== undefined && cost >= context.cheaperThan) || (context.free && cost !== 0)) return 'budget';
  }
  const start = new Date(event.startsAt);
  if (context.earliestStart && time.format(start) < context.earliestStart) return 'start';
  if (context.latestEnd) {
    if (!event.endsAt) return 'unknownEnd';
    const end = new Date(event.endsAt);
    if (localDate(start) !== localDate(end) || time.format(end) > context.latestEnd) return 'end';
  }
}

function explain(event: CatalogEvent, context: DiscoveryContext, travel?: number): string[] {
  const reasons = [shortDate.format(new Date(event.startsAt)) + ', ' + time.format(new Date(event.startsAt))];
  if (context.childAge !== undefined && event.ageLimit !== undefined) reasons.push(`Возрастное ограничение ${event.ageLimit}+`);
  const cost = totalCost(event, context);
  if (cost !== undefined) {
    const isStartingPrice = event.priceMin !== event.priceMax && cost > 0;
    const group = (context.partySize ?? 1) > 1 ? ` на ${context.partySize} чел.` : ' за билет';
    reasons.push(cost === 0 ? 'Есть бесплатный вход' : `${isStartingPrice ? 'От ' : ''}${money.format(cost)} ₽${group}`);
  }
  if (context.latestEnd && event.endsAt) reasons.push(`Закончится в ${time.format(new Date(event.endsAt))}`);
  if (travel !== undefined) reasons.push(`Около ${travel} мин на машине`);
  return reasons;
}

const rejectionReason: Record<Rejection, [string, string?]> = {
  age: ['Для ребёнка нет подтверждённых вариантов с подходящим возрастным ограничением.'],
  budget: ['Варианты с указанной ценой выходят за бюджет.', 'Любая цена'],
  start: ['Варианты начинаются раньше указанного времени.', 'Любое время'],
  end: ['Варианты заканчиваются позже указанного времени.', 'Любое время'],
  travel: ['Проверенные маршруты занимают больше времени, чем указано.', 'Без учёта дороги'],
  unknownAge: ['У части вариантов источник не указал возраст. Не могу подтвердить, что они подойдут ребёнку.'],
  unknownPrice: ['У части вариантов источник не указал цену. Не могу подтвердить, что они уложатся в бюджет.', 'Любая цена'],
  unknownEnd: ['У части вариантов источник не указал окончание. Не могу подтвердить, что они закончатся вовремя.', 'Любое время'],
  unknownTravel: ['Не получилось проверить маршрут до подходящих площадок.', 'Без учёта дороги'],
};

function originPoint(origin: string, venues: CatalogEvent[]): Point | undefined {
  const match = /^\s*(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)\s*$/.exec(origin);
  if (match) {
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (latitude >= 51 && latitude <= 57 && longitude >= 52 && longitude <= 61) return { latitude, longitude };
    return;
  }
  const normalized = normalizeText(origin);
  const matching = venues.find(event => [event.venue, event.address].some(value => value && normalizeText(value) === normalized)
    && event.latitude !== undefined && event.longitude !== undefined);
  if (matching?.latitude !== undefined && matching.longitude !== undefined) {
    return { latitude: matching.latitude, longitude: matching.longitude };
  }
}

export function createDiscovery(catalog: Catalog, { clock = () => new Date(), travel, interpret }: Options = {}) {
  function* searchCandidates(context: DiscoveryContext, now: Date, includeDates = true) {
    const filters: EventFilters = {
      city: context.city, category: context.category, query: context.query, limit: 50,
      ...(includeDates ? datePeriod(context.date ?? context.period ?? '', now) : {}),
    };
    for (let page = 1; page <= 10_000; page++) {
      const result = catalog.search({ ...filters, page });
      yield* result.events;
      if (page * result.limit >= result.total) break;
    }
  }

  return async function discover(message: string, prior?: unknown): Promise<DiscoveryResponse> {
    const now = clock();
    const previous = cleanContext(prior);
    const cities = catalog.directories().cities;
    const words = normalizeText(message);
    if (/^(?:игнорируй|забудь|покажи системн|раскрой системн)|(?:^| )системный промпт(?: |$)/u.test(words) || !words) {
      return {
        status: 'clarify', message: 'Я помогу подобрать культурные события. Что вам хотелось бы посмотреть?',
        suggestions: ['Куда сходить в эти выходные?'], events: [], context: previous, constraints: constraints(previous),
      };
    }
    const issue = constraintIssue(message);
    if (issue) return { status: 'clarify', message: issue, suggestions: [], events: [], context: previous, constraints: constraints(previous) };
    const local = readIntent(message, previous, cities, now);
    let context = local;
    if (interpret && !/^(?:новый поиск|начнем заново|сначала)(?:\s|$)/u.test(words)) {
      try {
        const interpreted = await interpret(message, previous, cities, localDate(now));
        // Use the parser to fill gaps, and preserve explicit local edits and removals.
        const explicit = new Set([...Object.keys(previous), ...Object.keys(local)].filter(key =>
          previous[key as keyof DiscoveryContext] !== local[key as keyof DiscoveryContext]));
        const merged = { ...local, ...interpreted } as Record<string, unknown>;
        for (const key of explicit) merged[key] = local[key as keyof DiscoveryContext];
        if (local.date && !explicit.has('period')) delete merged.period;
        context = cleanContext(merged);
      } catch {
        context = local;
      }
    }
    if (previous.travelMinutes && !previous.origin && !context.origin && !context.query?.startsWith('новый поиск') &&
        (/^\s*-?\d{1,2}\.\d+\s*[,;]\s*-?\d{1,3}\.\d+\s*$/.test(message) ||
        (/^от\s+/u.test(words) && !/^(?:от)\s+\d+\s*(?:руб|р)(?:\s|$)/u.test(words)))) {
      context.origin = message.trim().replace(/^от\s+/iu, '');
      context.query = previous.query;
    }
    if (/^(?:а )?(?:подешевле|дешевле)(?:\s|$)/u.test(words) && context.budget !== 0) {
      if (previous.referencePrice !== undefined) context.cheaperThan = previous.referencePrice;
    }

    const more = /^(?:а )?(?:что |что-нибудь |есть )?еще(?: варианты| что| есть)?$/u.test(words);
    const seen = new Set(more ? previous.seenEventIds : []);
    delete context.seenEventIds;
    const respond = (status: DiscoveryResponse['status'], message: string, suggestions: string[] = [], events: Match[] = []): DiscoveryResponse =>
      ({ status, message, suggestions, events, context, constraints: constraints(context) });
    if (/^(?:а )?(?:подешевле|дешевле)(?:\s|$)/u.test(words) && context.cheaperThan === undefined) {
      return respond('clarify', context.budget === 0 ? 'Уже ищу только бесплатные события. Можно изменить другие условия.'
        : 'В предыдущей подборке нет подтверждённой цены для сравнения. Какой максимальный бюджет указать?', ['Только бесплатные']);
    }
    if (context.city && !cities.some(city => normalizeText(city) === normalizeText(context.city ?? ''))) {
      return respond('no_results', `В каталоге пока нет предстоящих событий для города «${context.city}». Поэтому я не могу подобрать варианты по этим условиям.`,
        cities.slice(0, 3).map(city => 'Город: ' + city));
    }
    const blockers = new Map<Rejection, number>();
    const record = (reason: Rejection) => blockers.set(reason, (blockers.get(reason) ?? 0) + 1);
    const matches: Match[] = [];
    const travelCandidates: CatalogEvent[] = [];
    let checkedOnlySample = false;
    let found = false;
    for (const event of searchCandidates(context, now)) {
      found = true;
      if (seen.has(event.id)) continue;
      const blocked = checkEvent(event, context);
      if (blocked) {
        record(blocked);
        continue;
      }
      if (context.child && context.childAge === undefined) {
        return respond('clarify', 'Сколько лет ребёнку? Проверю возрастные ограничения в карточках.');
      }
      if (context.travelMinutes !== undefined) {
        if (!context.origin) return respond('clarify',
          'Откуда вы поедете? Напишите название площадки или её адрес из афиши, либо координаты. Рассчитаю ориентировочное время на машине, если маршрут доступен.',
          ['Без учёта дороги']);
        travelCandidates.push(event);
        if (travelCandidates.length > 25) {
          travelCandidates.pop();
          checkedOnlySample = true;
          break;
        }
      } else {
        matches.push({ event, reasons: explain(event, context) });
        if (matches.length === 5) break;
      }
    }
    if (travelCandidates.length) {
      const origin = context.origin && originPoint(context.origin,
        [...searchCandidates({ city: context.city }, now, false)]);
      if (!origin) {
        return respond('clarify', 'Не нашёл точку отправления в каталоге. Пришлите координаты или точное название площадки.', ['Без учёта дороги']);
      }
      const estimates = travel ? await travel(origin, travelCandidates).catch(() => new Map<string, number>()) : new Map<string, number>();
      for (const event of travelCandidates) {
        const minutes = estimates.get(event.id);
        if (minutes === undefined) record('unknownTravel');
        else if (minutes > (context.travelMinutes ?? 0)) record('travel');
        else matches.push({ event, reasons: explain(event, context, minutes) });
        if (matches.length === 5) break;
      }
    }
    if (matches.length) {
      context.seenEventIds = [...seen, ...matches.map(({ event }) => event.id)].slice(-100);
      const prices = matches.map(({ event }) => totalCost(event, context)).filter((price): price is number => price !== undefined);
      context.referencePrice = prices.length ? Math.min(...prices) : undefined;
      return respond('matches', matches.length === 1 ? 'Нашёл подходящее событие.' : 'Вот что подходит по вашим условиям.',
        [context.referencePrice === 0 || context.referencePrice === undefined ? 'А что ещё?' : 'А подешевле?', 'А на выходных?'], matches);
    }
    if (more && found && !blockers.size) {
      context.seenEventIds = [...seen];
      return respond('no_results', 'По этим условиям дополнительных событий в каталоге нет.',
        ['В любой день', 'Любая категория']);
    }
    context.referencePrice = undefined;
    if (blockers.size) {
      const ranked = [...blockers.entries()].sort((first, second) => second[1] - first[1]);
      const [reason, suggestion] = rejectionReason[ranked[0][0]];
      return respond('no_results', (checkedOnlySample ? 'Среди 25 проверенных вариантов совпадений нет. ' : 'По всем условиям совпадений нет. ') + reason,
        [suggestion, context.date || context.period ? 'В любой день' : undefined].filter((value): value is string => Boolean(value)));
    }
    if (!found && (context.date || context.period)) {
      return respond('no_results', 'На эти даты в каталоге нет событий по вашему запросу.', ['В любой день', 'А на выходных?']);
    }
    return respond('no_results', 'В каталоге пока нет подходящих событий по этому запросу.',
      context.category ? ['Любая категория'] : ['А на выходных?']);
  };
}
