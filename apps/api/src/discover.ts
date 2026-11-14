import { categories, dayPlanLimit } from '@afisha/contracts';
import type { CatalogEvent, DiscoveryContext, DiscoveryResponse } from '@afisha/contracts';
import { normalizeText } from './catalog.ts';
import type { CatalogStore, EventFilters } from './catalog.ts';
import { datePeriod, localDate, localDay } from './filters.ts';
import { cleanContext, constraintIssue, isSearchReset, maximumAge, mergeIntent, readAgeReply, readIntent, readPlanRequest } from './intent.ts';
import type { Point, TravelEstimate } from './routing.ts';

type Interpret = (message: string, context: DiscoveryContext, cities: string[], date: string) => Promise<DiscoveryContext>;
type Recommend = (message: string, context: DiscoveryContext, candidates: CatalogEvent[]) =>
  Promise<{ picks: { id: string; reason?: string }[]; question?: string }>;
type Options = { clock?: () => Date; travel?: TravelEstimate; interpret?: Interpret; recommend?: Recommend; onInterpretFailure?: () => void };
type Match = DiscoveryResponse['events'][number];
type Rejection = 'age' | 'budget' | 'end' | 'start' | 'travel' | 'language' | 'unknownAge' | 'unknownPrice' | 'unknownEnd' | 'unknownTravel';

const shortDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', weekday: 'long', day: 'numeric', month: 'long' });
const dayAndMonth = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', day: 'numeric', month: 'long' });
const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const money = new Intl.NumberFormat('ru-RU');
const periods = { today: 'Сегодня', tomorrow: 'Завтра', weekend: 'Ближайшие выходные', week: 'Ближайшие 7 дней' };
const languages = { ru: 'Русский', ba: 'Башкирский' };
const transportLabels = { car: 'На машине', transit: 'На общественном транспорте', walk: 'Пешком', bike: 'На велосипеде', taxi: 'На такси' };
const planSuggestions = ['Одно событие', 'Несколько событий'];
const askPlanMode = 'Ищем одно событие или несколько на один день?';
const askPlanOrigin = 'Откуда начнётся маршрут? Укажите адрес, известную площадку или координаты.';

function dayShortlist<T>(options: T[], eventFor: (option: T) => CatalogEvent, limit: number, spread: boolean): T[] {
  if (!spread) return options.slice(0, limit);
  const buckets = new Map<string, T[]>();
  for (const option of options) {
    const event = eventFor(option);
    const hour = Number(time.format(new Date(event.startsAt)).slice(0, 2));
    const slot = `${event.category}:${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}`;
    const bucket = buckets.get(slot);
    if (bucket) bucket.push(option);
    else buckets.set(slot, [option]);
  }
  const selected: T[] = [];
  for (let index = 0; selected.length < Math.min(options.length, limit); index++) {
    for (const bucket of buckets.values()) {
      if (index < bucket.length) selected.push(bucket[index]);
      if (selected.length === limit) return selected;
    }
  }
  return selected;
}

function labelDate(date: string) {
  return shortDate.format(new Date(date + 'T12:00:00+05:00'));
}

function dateFilters(context: DiscoveryContext, now: Date): Pick<EventFilters, 'from' | 'until'> {
  if (context.date || context.period) return datePeriod(context.date ?? context.period ?? '', now);
  return {
    from: context.fromDate ? datePeriod(context.fromDate, now).from : undefined,
    until: context.untilDate ? datePeriod(localDay(context.untilDate, 1), now).from : undefined,
  };
}

function constraints(context: DiscoveryContext) {
  const labels: DiscoveryResponse['constraints'] = [];
  function show(label: string, value: string | undefined) {
    if (value) labels.push({ label, value });
  }
  show('Город', context.city);
  show('Подборка', context.planMode === 'single' ? 'Одно событие' : context.planMode === 'day'
    ? (context.planCount ? `${context.planCount} события на день` : 'Несколько событий на день') : undefined);
  show('Площадка', context.venue);
  show('Когда', context.date ? labelDate(context.date) : context.period ? periods[context.period] :
    context.fromDate && context.untilDate ? `${labelDate(context.fromDate)} — ${labelDate(context.untilDate)}` :
    context.fromDate ? `С ${labelDate(context.fromDate)}` : context.untilDate ? `По ${labelDate(context.untilDate)}` : undefined);
  show('Категория', context.category && categories[context.category]);
  show('Язык', context.language && languages[context.language]);
  show('Возраст', context.childAge === undefined ? context.child ? 'Уточняется' : undefined : String(context.childAge));
  show('Участники', context.partySize ? String(context.partySize) : undefined);
  show('Цена', context.cheaperThan !== undefined ? `Меньше ${money.format(context.cheaperThan)} ₽` : undefined);
  show(context.planMode === 'day' ? 'Бюджет на событие' : 'Бюджет', context.budget === undefined ? undefined : context.budget === 0 ? 'Бесплатно' :
    `До ${money.format(context.budget)} ₽${context.partySize ? ' на всех' : ' за билет'}`);
  show('Начало', context.earliestStart && `С ${context.earliestStart}`);
  show('Окончание', context.latestEnd && `До ${context.latestEnd}`);
  show('Дорога', context.travelMinutes && `До ${context.travelMinutes} мин` || undefined);
  show('Сортировка', context.sortByDistance ? 'Сначала ближе' : undefined);
  show('Откуда', context.origin);
  show('Транспорт', context.transport && transportLabels[context.transport]);
  show('Интерес', context.query);
  show('Предпочтение', context.preference);
  return labels;
}

function totalCost(event: CatalogEvent, context: DiscoveryContext): number | undefined {
  return event.priceMin === undefined ? undefined : event.priceMin * (context.partySize ?? 1);
}

function checkEvent(event: CatalogEvent, context: DiscoveryContext): Rejection[] {
  const reasons: Rejection[] = [];
  if (context.language && !normalizeText(event.language ?? '').split(' ').some(language =>
    context.language === 'ba' ? /^(?:ba$|bak$|башкирск|башкорт)/u.test(language) : /^(?:ru$|rus$|русск)/u.test(language))) {
    reasons.push('language');
  }
  if (context.childAge !== undefined) {
    if (event.ageLimit === undefined) reasons.push('unknownAge');
    else if (event.ageLimit > context.childAge) reasons.push('age');
  }
  if (context.budget !== undefined || context.cheaperThan !== undefined || context.free) {
    const cost = totalCost(event, context);
    if (cost === undefined) reasons.push('unknownPrice');
    else if ((context.budget !== undefined && cost > context.budget) ||
        (context.cheaperThan !== undefined && cost >= context.cheaperThan) || (context.free && cost !== 0)) reasons.push('budget');
  }
  const start = new Date(event.startsAt);
  if (context.earliestStart && time.format(start) < context.earliestStart) reasons.push('start');
  if (context.latestEnd) {
    if (!event.endsAt) reasons.push('unknownEnd');
    else {
      const end = new Date(event.endsAt);
      if (localDate(start) !== localDate(end) || time.format(end) > context.latestEnd) reasons.push('end');
    }
  }
  return reasons;
}

function explain(event: CatalogEvent, context: DiscoveryContext, now: Date, travel?: number): string[] {
  const start = new Date(event.startsAt);
  const end = event.endsAt && new Date(event.endsAt);
  const reasons = [end && localDate(start) !== localDate(end) && start < now
    ? `Идёт до ${shortDate.format(end)}`
    : shortDate.format(start) + ', ' + time.format(start)];
  if (context.childAge !== undefined && event.ageLimit !== undefined) reasons.push(`Возрастное ограничение ${event.ageLimit}+`);
  const cost = totalCost(event, context);
  if (cost !== undefined) {
    const isStartingPrice = event.priceMin !== event.priceMax && cost > 0;
    const group = (context.partySize ?? 1) > 1 ? ` на ${context.partySize} чел.` : ' за билет';
    reasons.push(cost === 0 ? 'Есть бесплатный вход' : `${isStartingPrice ? 'От ' : ''}${money.format(cost)} ₽${group}`);
  }
  if (context.latestEnd && event.endsAt) reasons.push(`Закончится в ${time.format(new Date(event.endsAt))}`);
  if (travel !== undefined) reasons.push(`Около ${travel} мин ${context.transport === 'taxi' ? 'на такси' : 'на машине'}`);
  return reasons;
}

const rejectionReason: Record<Rejection, [string, string?]> = {
  language: ['У найденных событий нужный язык не указан или указан другой.', 'Любой язык'],
  age: ['У некоторых событий возрастное ограничение выше указанного.', 'Без учёта возраста'],
  budget: ['Некоторые события выходят за бюджет.', 'Любая цена'],
  start: ['Некоторые события начинаются раньше указанного времени.', 'Любое время'],
  end: ['Некоторые события заканчиваются позже указанного времени.', 'Любое время'],
  travel: ['Некоторые проверенные маршруты занимают больше указанного времени.', 'Без учёта дороги'],
  unknownAge: ['У некоторых событий не указан возраст, поэтому их доступность ребёнку не подтверждена.', 'Без учёта возраста'],
  unknownPrice: ['Для некоторых событий не указана цена, поэтому соответствие бюджету не подтверждено.', 'Любая цена'],
  unknownEnd: ['У некоторых событий не указано время окончания.', 'Любое время'],
  unknownTravel: ['Не получилось проверить маршрут до некоторых площадок.', 'Без учёта дороги'],
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

export function createDiscovery(catalog: CatalogStore, { clock = () => new Date(), travel, interpret, recommend, onInterpretFailure }: Options = {}) {
  async function* searchCandidates(context: DiscoveryContext, now: Date, includeDates = true, sort?: EventFilters['sort']) {
    const filters: EventFilters = {
      city: context.city, category: context.category, venue: context.venue, query: context.query, limit: 50,
      sort, matchWords: true, ...(includeDates ? dateFilters(context, now) : {}),
    };
    for (let page = 1; page <= 10_000; page++) {
      const result = await catalog.search({ ...filters, page });
      yield* result.events;
      if (page * result.limit >= result.total) break;
    }
  }

  return async function discover(message: string, prior?: unknown, { planExperience = false }: { planExperience?: boolean } = {}): Promise<DiscoveryResponse> {
    const now = clock();
    const previous = isSearchReset(message) ? {} : cleanContext(prior);
    const { cities, venues } = await catalog.directories();
    const words = normalizeText(message);
    const closer = /^(?:а )?(?:что )?(?:поближе|ближе)(?: к .+)?$/u.test(words);
    if (/^(?:игнорируй|забудь|покажи системн|раскрой системн)|(?:^| )системный промпт(?: |$)/u.test(words) || !words) {
      return {
        status: 'clarify', message: 'Я помогу подобрать культурные события. Что вам хотелось бы посмотреть?',
        suggestions: ['Куда сходить в эти выходные?'], events: [], context: previous, constraints: constraints(previous),
      };
    }
    const redirect = /^(?:подпиши|отпиши|оформи подписку|отмени подписку|(?:купи|забронируй) билет)/u.test(words)
      ? 'Могу найти события и ссылки на билеты. Подписки можно изменить в меню Telegram-бота.'
      : /^(?:какая (?:будет )?погода|какой (?:сейчас )?курс|напиши (?:мне )?(?:стих|код)|расскажи (?:мне )?анекдот)/u.test(words)
        ? 'Я помогаю найти культурные события в Башкортостане. Могу подобрать афишу на нужный день.' : undefined;
    if (redirect) return { status: 'clarify', message: redirect, suggestions: [], events: [], context: previous, constraints: constraints(previous) };
    const ageReply = previous.child && previous.childAge === undefined ? readAgeReply(message) : undefined;
    const planRequest = readPlanRequest(message, planExperience && !previous.planMode && ageReply === undefined);
    const planning = planExperience || Boolean(previous.planMode || planRequest.mode);
    const issue = ageReply !== undefined && (!Number.isInteger(ageReply) || ageReply < 0 || ageReply > maximumAge)
      ? 'Укажите возраст числом от 0 до 120.'
      : planRequest.count !== undefined && (planRequest.count < 1 || planRequest.count > dayPlanLimit)
        ? 'На один день можно выбрать от одного до четырёх событий. Сколько событий ищем?'
        : constraintIssue(message, planning);
    if (issue) return { status: 'clarify', message: issue, suggestions: [], events: [], context: previous, constraints: constraints(previous) };
    const local = ageReply === undefined ? readIntent(message, previous, cities, now, venues, planning) : { ...previous, childAge: ageReply };
    if (ageReply !== undefined && /^\d+$/u.test(local.query ?? '')) delete local.query;
    let context = local;
    let modelUnavailable = false;
    const relax = /^(?:в любой день(?: без учета дороги)?|любая категория|любая цена|любое время|любой язык|любая площадка|без учета дороги|без учета возраста|без темы)$/u.test(words);
    const resetOnly = /^(?:новый поиск|начнем заново|сначала)$/u.test(words);
    const cityOnly = local.city && (words === normalizeText(local.city) || words === 'город ' + normalizeText(local.city));
    const preferenceReply = previous.awaitingPreference && local.preference !== previous.preference;
    const coordinateReply = /^\s*-?\d{1,2}\.\d+\s*[,;]\s*-?\d{1,3}\.\d+\s*$/.test(message);
    const venueReply = venues.some(venue => normalizeText(venue.name) === words &&
      (!previous.city || normalizeText(venue.city) === normalizeText(previous.city)));
    const originPending = previous.planMode === 'day' && previous.city && previous.date && previous.transport && !previous.origin;
    const addressReply = originPending && message.trim().length <= 120 && local.city === previous.city &&
      local.date === previous.date && local.earliestStart === previous.earliestStart && local.latestEnd === previous.latestEnd &&
      local.budget === previous.budget && local.transport === previous.transport &&
      /^(?:(?:ул(?:ица)?|проспект|пр-т|переулок|пер\.|бульвар|шоссе|площадь)\s*\.? +[^!?]+|[\p{L} -]+[ ,]\s*\d+(?:[\p{L}]|\/\d+)?(?:\s+к\.?\s*\d+)?)$/iu.test(message.trim());
    if (ageReply === undefined && !local.origin && (originPending || previous.travelMinutes || previous.sortByDistance) &&
        (coordinateReply || venueReply || addressReply || /^от (?!\d+ (?:руб|р)(?:\s|$))/u.test(words))) {
      local.origin = message.trim().replace(/^от\s+/iu, '');
      local.query = previous.query;
      local.venue = previous.venue;
    }
    const planningReply = planning && (local.planMode !== previous.planMode || local.planCount !== previous.planCount ||
      local.transport !== previous.transport || local.origin !== previous.origin);
    const awaitingPlanInput = planning && (!local.city || !local.planMode || local.planMode === 'day' && (!local.date || !local.transport));
    if (interpret && ageReply === undefined && !relax && !resetOnly && !cityOnly && !preferenceReply &&
        (!(planningReply || awaitingPlanInput) || words.length > 35 && local.origin === previous.origin)) {
      try {
        const interpreted = await interpret(message, previous, cities, localDate(now));
        context = mergeIntent(message, previous, local, interpreted, cities, venues, now, planning);
      } catch {
        onInterpretFailure?.();
        modelUnavailable = true;
        context = local;
      }
    }
    if (closer) context.sortByDistance = true;
    if (/^(?:а )?(?:подешевле|дешевле)(?:\s|$)/u.test(words) && context.budget !== 0) {
      if (previous.referencePrice !== undefined) context.cheaperThan = previous.referencePrice;
    }

    const more = /^(?:а )?(?:что |что-нибудь |есть )?еще(?: варианты| что| есть)?$/u.test(words);
    const seen = new Set(more ? previous.seenEventIds : []);
    const respond = (status: DiscoveryResponse['status'], message: string, suggestions: string[] = [], events: Match[] = []): DiscoveryResponse =>
      ({ status, message: modelUnavailable ? `ИИ временно недоступен. Использую обычный поиск. ${message}` : message, suggestions, events, context, constraints: constraints(context) });
    const askCity = 'В каком городе ищем?';
    const citySuggestions = cities.slice(0, 3).map(city => 'Город: ' + city);
    const dayBudget = context.planMode === 'day' && (context.budget !== undefined || /\d/u.test(words)) &&
      /(?:^| )(?:бюджет на (?:весь )?день|на весь (?:день|план|маршрут)|на все (?:события|мероприятия|билеты)|на вс[ею] (?:программу|подборку)|общий бюджет|всего на день)(?= |$)/u.test(words);
    if (dayBudget) {
      context.budget = previous.budget;
      context.free = previous.free;
      context.cheaperThan = previous.cheaperThan;
    }
    if (planning && (!context.city || !context.planMode)) {
      return respond('clarify', [!context.city && askCity, !context.planMode && askPlanMode].filter(Boolean).join(' '),
        [...(!context.planMode ? planSuggestions : []), ...(!context.city ? citySuggestions : [])]);
    }
    if (dayBudget) return respond('clarify', 'Какой предельный бюджет на одно событие? Общая стоимость дня зависит от выбранных билетов.',
      ['Только бесплатные', 'Любая цена']);
    if (/^(?:а )?(?:подешевле|дешевле)(?:\s|$)/u.test(words) && context.cheaperThan === undefined) {
      return respond('clarify', context.budget === 0 ? 'Уже ищу только бесплатные события. Можно изменить другие условия.'
        : 'В предыдущей подборке нет подтверждённой цены для сравнения. Какой максимальный бюджет указать?', ['Только бесплатные']);
    }
    if (context.city && !cities.some(city => normalizeText(city) === normalizeText(context.city ?? ''))) {
      return respond('no_results', `В каталоге пока нет предстоящих событий для города «${context.city}». Поэтому я не могу подобрать варианты по этим условиям.`,
        citySuggestions);
    }
    const dayPlan = context.planMode === 'day';
    const spreadDay = dayPlan && !context.query && !context.preference && context.cheaperThan === undefined && !context.sortByDistance;
    if (dayPlan && !context.date) {
      if (context.fromDate && context.fromDate === context.untilDate) context.date = context.fromDate;
      else return respond('clarify', 'На какой именно день составить план?', context.period === 'weekend'
        ? ['В субботу', 'В воскресенье'] : ['Сегодня', 'Завтра']);
    }
    const routeNeeded = context.sortByDistance || context.travelMinutes !== undefined;
    if ((dayPlan || (planning && routeNeeded)) && !context.transport) {
      return respond('clarify', 'На каком транспорте планируете передвигаться?', Object.values(transportLabels));
    }
    const blockers = new Map<Rejection, number>();
    const record = (reason: Rejection) => blockers.set(reason, (blockers.get(reason) ?? 0) + 1);
    const matches: Match[] = [];
    const repeated: Match[] = [];
    const shownTitles = new Set<string>();
    const ranker = !modelUnavailable && !context.query && context.cheaperThan === undefined && !context.sortByDistance ? recommend : undefined;
    const candidateLimit = ranker ? 25 : 5;
    async function rank(matches: Match[], limit: number) {
      const fallback = dayShortlist(matches, match => match.event, limit, spreadDay);
      if (!ranker || matches.length < 2) return { selected: fallback, ranked: false };
      try {
        const rankingMessage = planning && context.origin && context.origin !== previous.origin ? (context.preference ?? '') : message;
        const pool = dayShortlist(matches, match => match.event, candidateLimit, spreadDay);
        const result = await ranker(rankingMessage, context, pool.map(({ event }) => event));
        const byId = new Map(matches.map(match => [match.event.id, match]));
        const ranked = result.picks.flatMap(({ id, reason }) => {
          const match = byId.get(id);
          if (!match) return [];
          byId.delete(id);
          return [{ ...match, reasons: reason ? [reason, ...match.reasons] : match.reasons }];
        });
        const selected = ranked.length ? dayShortlist(dayPlan ? [...ranked, ...byId.values()] : ranked, match => match.event, limit, spreadDay) : fallback;
        return { selected, ranked: ranked.length > 0, question: result.question };
      } catch {
        onInterpretFailure?.();
        modelUnavailable = true;
        return { selected: fallback, ranked: false };
      }
    }
    const diversifyFilms = !context.query && !context.category && context.cheaperThan === undefined;
    const travelCandidates: CatalogEvent[] = [];
    const requiredDetails = [
      context.childAge !== undefined && 'возрастное ограничение',
      (context.budget !== undefined || context.cheaperThan !== undefined || context.free) && 'цена',
      context.latestEnd && 'время окончания',
    ].filter((detail): detail is string => typeof detail === 'string');
    let checked = 0;
    let complete = 0;
    let checkedOnlySample = false;
    let found = false;
    const askOrigin = 'Откуда вы поедете? Укажите название площадки или её адрес из афиши, либо координаты.';
    const dated = context.date || context.period || context.fromDate || context.untilDate;
    const sort = context.cheaperThan !== undefined ? 'price' : context.query ? 'relevance' :
      !context.category && (context.preference === 'Семейный досуг' || context.childAge !== undefined && context.childAge <= 12) ? 'family' :
        dated && !context.category ? 'sessions' : undefined;
    for await (const event of searchCandidates(context, now, true, sort)) {
      if (dayPlan && (localDate(new Date(event.startsAt)) !== context.date || Date.parse(event.startsAt) < now.getTime())) continue;
      found = true;
      if (seen.has(event.id)) continue;
      const blocked = checkEvent(event, context);
      checked++;
      if (!blocked.some(reason => reason === 'unknownAge' || reason === 'unknownPrice' || reason === 'unknownEnd')) complete++;
      if (blocked.length) {
        blocked.forEach(record);
        continue;
      }
      if (context.child && context.childAge === undefined) {
        return respond('clarify', 'Сколько лет ребёнку? Так я смогу проверить возрастные ограничения.', ['Без учёта возраста']);
      }
      if (routeNeeded) {
        travelCandidates.push(event);
        if (!spreadDay && travelCandidates.length > 25) {
          travelCandidates.pop();
          checkedOnlySample = true;
          break;
        }
      } else {
        const match = { event, reasons: explain(event, context, now) };
        if (dayPlan || ranker || (diversifyFilms && event.category === 'cinema')) {
          const title = normalizeText(event.title) + '|' + event.city;
          if (shownTitles.has(title)) {
            if (!dayPlan && repeated.length < 5) repeated.push(match);
            continue;
          }
          shownTitles.add(title);
        }
        matches.push(match);
        if (!spreadDay && matches.length === candidateLimit) break;
      }
    }
    if (spreadDay && !routeNeeded) matches.splice(0, matches.length, ...dayShortlist(matches, match => match.event, candidateLimit, true));
    if (spreadDay && travelCandidates.length > 25) {
      travelCandidates.splice(0, travelCandidates.length, ...dayShortlist(travelCandidates, event => event, 25, true));
      checkedOnlySample = true;
    }
    if (travelCandidates.length) {
      const routePreview = async (events: CatalogEvent[], next?: string): Promise<DiscoveryResponse> => {
        const day = context.date ? labelDate(context.date) : undefined;
        const limit = context.travelMinutes === undefined ? '' : ` Лимит в ${context.travelMinutes} мин пока не подтверждён.`;
        const opening = day ? `${day[0].toUpperCase()}${day.slice(1)} — есть варианты по остальным условиям.` : 'Вот варианты по остальным условиям.';
        const unverified = events.map(event => ({ event, reasons: [...explain(event, context, now), 'Время в пути не проверено'] }));
        const alternatives = dayPlan ? (await rank(unverified, 5)).selected : unverified.slice(0, 5);
        if (dayPlan) context.seenEventIds = [...seen, ...alternatives.map(({ event }) => event.id)].slice(-100);
        return {
          ...respond('clarify', `${opening} Сейчас я не могу проверить время в пути.${limit}${next ? ' ' + next : ''}`,
            [...(dayPlan ? ['А что ещё?'] : []), 'Без учёта дороги']),
          alternatives,
        };
      };
      if (!travel || (planning && context.transport !== 'car' && context.transport !== 'taxi')) {
        return routePreview(travelCandidates, dayPlan && !context.origin ? askPlanOrigin : undefined);
      }
      if (!context.origin) return routePreview(travelCandidates, dayPlan ? askPlanOrigin : askOrigin);
      let origin = originPoint(context.origin, []);
      if (!origin) {
        for await (const venue of searchCandidates({ city: context.city }, now, false)) {
          origin = originPoint(context.origin, [venue]);
          if (origin) break;
        }
      }
      if (!origin) {
        return routePreview(travelCandidates, 'Не нашёл точку отправления в каталоге. Пришлите координаты или точное название площадки.');
      }
      const estimates = await travel(origin, travelCandidates).catch(() => new Map<string, number>());
      if (context.sortByDistance) travelCandidates.sort((first, second) =>
        (estimates.get(first.id) ?? Infinity) - (estimates.get(second.id) ?? Infinity));
      for (const event of travelCandidates) {
        const minutes = estimates.get(event.id);
        if (minutes === undefined) record('unknownTravel');
        else if (context.travelMinutes !== undefined && minutes > context.travelMinutes) record('travel');
        else matches.push({ event, reasons: explain(event, context, now, minutes) });
        if (!spreadDay && matches.length === candidateLimit) break;
      }
      const unverified = travelCandidates.filter(event => !estimates.has(event.id));
      if (!matches.length && unverified.length) return routePreview(unverified);
    }
    matches.push(...repeated.slice(0, candidateLimit - matches.length));
    if (matches.length) {
      const shownLimit = context.planMode === 'single' ? 1 : 5;
      let matchingCities = [...new Set(matches.map(({ event }) => event.city))];
      if (recommend && !context.query && !context.city && !routeNeeded && !/любой город|в любом городе|вся республика/u.test(words)) {
        const eligible = await Promise.all(cities.map(async city => matchingCities.includes(city) ||
          Boolean(await firstAlternative({ ...context, city }, true))));
        matchingCities = cities.filter((_city, index) => eligible[index]);
        if (matchingCities.length > 1) {
          return respond('clarify', 'В каком городе ищем? От этого зависит подборка.', matchingCities.slice(0, 3).map(city => 'Город: ' + city));
        }
      }
      const { selected, ranked: recommendationShown, question: suggestedQuestion } = await rank(matches, shownLimit);
      const question = !context.preference && !previous.awaitingPreference && !more && matchingCities.length === 1 && !(dayPlan && !context.origin)
        ? suggestedQuestion : undefined;
      if (question) context.awaitingPreference = true;
      context.seenEventIds = [...seen, ...selected.map(({ event }) => event.id)].slice(-100);
      const prices = selected.map(({ event }) => totalCost(event, context)).filter((price): price is number => price !== undefined);
      context.referencePrice = prices.length ? Math.min(...prices) : undefined;
      const summary = checkedOnlySample && context.sortByDistance
        ? 'Показал ближайшие события среди 25 вариантов, для которых проверял дорогу.'
        : recommendationShown ? `Я бы начал с «${selected[0].event.title}».`
          : selected.length === 1 ? 'Нашёл подходящее событие.' : 'Вот что подходит по вашим условиям.';
      const nextQuestion = dayPlan && !context.origin ? askPlanOrigin : question;
      const planSummary = dayPlan && selected.length === 1 && !more
        ? 'По этим условиям пока есть только одно событие. Можно изменить условия и найти другие варианты.' : summary;
      return respond('matches', nextQuestion ? `${planSummary} ${nextQuestion}` : planSummary,
        ['А что ещё?', ...(context.referencePrice ? ['А подешевле?'] : []),
          ...(!context.date && context.period !== 'weekend' ? ['А на выходных?'] : [])], selected);
    }
    delete context.seenEventIds;
    if (more && found && !checkedOnlySample) {
      context.seenEventIds = [...seen];
      return respond('no_results', 'По этим условиям больше нет подтверждённых вариантов.');
    }
    context.referencePrice = undefined;
    async function firstAlternative(filters: DiscoveryContext, includeDates: boolean) {
      if (filters.travelMinutes || filters.sortByDistance || (filters.child && filters.childAge === undefined)) return;
      for await (const event of searchCandidates(filters, now, includeDates)) {
        const eventDate = localDate(new Date(event.startsAt));
        if (dayPlan && (Date.parse(event.startsAt) < now.getTime() || (includeDates ? eventDate !== context.date : eventDate === context.date))) continue;
        if (!seen.has(event.id) && checkEvent(event, filters).length === 0 &&
            (includeDates || (Date.parse(event.startsAt) >= now.getTime() && eventDate !== context.date))) return event;
      }
    }
    // Only suggest another day when every other requested condition is confirmed.
    const alternative = dated ? await firstAlternative(context, false) : undefined;
    const alternativeSuggestion = alternative ? [dayPlan ? `А ${dayAndMonth.format(new Date(alternative.startsAt))}?` : 'В любой день'] : [];
    const alternativeText = alternative ? ` Ближайший подходящий вариант в другой день — «${alternative.title}»: ${shortDate.format(new Date(alternative.startsAt))}, ${time.format(new Date(alternative.startsAt))}.` : '';
    const nearbyDate = dated && routeNeeded && !travelCandidates.length ? await firstAlternative({
      ...context, travelMinutes: undefined, origin: undefined, sortByDistance: undefined,
    }, false) : undefined;
    const nearbyText = nearbyDate
      ? ` Ближайший вариант по остальным условиям — ${shortDate.format(new Date(nearbyDate.startsAt))}. Например, ${nearbyDate.title}. Время в пути не проверено.`
      : '';
    const nearbySuggestion = nearbyDate ? [`А ${dayAndMonth.format(new Date(nearbyDate.startsAt))}?`, 'В любой день, без учёта дороги'] : [];
    if (blockers.size) {
      const ranked = [...blockers.entries()].sort((first, second) => second[1] - first[1]);
      const reasons = ranked.map(([reason]) => rejectionReason[reason][0]).join(' ');
      const coverage = complete < checked && !checkedOnlySample
        ? ` У ${money.format(complete)} из ${money.format(checked)} проверенных событий указаны все данные для фильтров (${requiredDetails.join(', ')}).`
        : '';
      const relaxations: [string, DiscoveryContext][] = [
        ['Любая цена', { ...context, budget: undefined, free: undefined, cheaperThan: undefined }],
        ['Любое время', { ...context, earliestStart: undefined, latestEnd: undefined }],
        ['Без учёта возраста', { ...context, child: undefined, childAge: undefined }],
        ['Без учёта дороги', { ...context, travelMinutes: undefined, origin: undefined, sortByDistance: undefined }],
        ['Любой язык', { ...context, language: undefined }],
      ];
      const observed = new Set(ranked.map(([reason]) => rejectionReason[reason][1]));
      const suggestions = (await Promise.all(relaxations.map(async ([label, filters]) =>
        observed.has(label) && await firstAlternative(filters, true) ? label : undefined))).filter(Boolean) as string[];
      const summary = checkedOnlySample ? 'Среди 25 проверенных вариантов совпадений нет.' : coverage
        ? 'Подтверждённых совпадений пока нет.' : 'По всем условиям совпадений нет.';
      return respond('no_results', summary + coverage + ' ' + reasons + alternativeText + nearbyText,
        [...alternativeSuggestion, ...nearbySuggestion, ...suggestions].slice(0, 3));
    }
    const missingCategory = context.category && !(await catalog.search({ city: context.city, category: context.category, limit: 1 })).total
      ? context.category : undefined;
    const [widerTopic, widerCategory, widerVenue] = await Promise.all([
      context.query && firstAlternative({ ...context, query: undefined }, true),
      context.category && firstAlternative({ ...context, category: undefined }, true),
      context.venue && firstAlternative({ ...context, venue: undefined }, true),
    ]);
    const suggestions = [
      ...alternativeSuggestion,
      ...nearbySuggestion,
      ...(widerTopic ? ['Без темы'] : []),
      ...(widerCategory ? ['Любая категория'] : []),
      ...(widerVenue ? ['Любая площадка'] : []),
    ];
    const reason = missingCategory
      ? `В каталоге нет предстоящих событий по категории «${categories[missingCategory]}»${context.city ? ` в городе «${context.city}»` : ''}.`
      : dayPlan && context.date && context.city && !context.query && !context.category && !context.venue
        ? `На ${labelDate(context.date)} в городе «${context.city}» в каталоге нет предстоящих событий.`
      : dated ? 'Нет событий по вашему запросу на эти даты в каталоге.'
        : 'В каталоге пока нет подходящих событий по этому запросу.';
    const widerText = widerTopic ? ' Если убрать тему, есть события по остальным условиям.'
      : widerCategory ? ' Есть события других категорий по остальным условиям.' :
        widerVenue ? ' Есть события на других площадках по остальным условиям.' : '';
    return respond('no_results', reason + alternativeText + nearbyText + widerText, suggestions);
  };
}
