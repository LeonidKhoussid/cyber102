import { categories, dayPlanLimit } from '@afisha/contracts';
import type { DiscoveryContext } from '@afisha/contracts';
import { isLocalDate, normalizeText } from './catalog.ts';
import { localDate, localDay } from './filters.ts';

const regionalCities: [string, RegExp][] = [
  ['Уфа', /(?:^|\s)(?:уфа|уфе|уфу|уфы|уфой)(?=\s|$)/u],
  ['Стерлитамак', /(?:^|\s)стерлитамак(?:е|а|ом)?(?=\s|$)/u],
  ['Салават', /(?:^|\s)салават(?:е|а|ом)?(?=\s|$)/u],
  ['Нефтекамск', /(?:^|\s)нефтекамск(?:е|а|ом)?(?=\s|$)/u],
  ['Октябрьский', /(?:^|\s)октябрьск(?:ий|ом|ого)(?=\s|$)/u],
  ['Туймазы', /(?:^|\s)(?:туймаз(?:ы|ах|ов)|туймазинск(?:ий|ом))(?=\s|$)/u],
  ['Ишимбай', /(?:^|\s)ишимба(?:й|е|я)(?=\s|$)/u],
  ['Сибай', /(?:^|\s)сиба(?:й|е|я)(?=\s|$)/u],
  ['Белорецк', /(?:^|\s)белорецк(?:е|а|ом)?(?=\s|$)/u],
  ['Бирск', /(?:^|\s)бирск(?:е|а|ом)?(?=\s|$)/u],
  ['Мелеуз', /(?:^|\s)мелеуз(?:е|а|ом)?(?=\s|$)/u],
  ['Магнитогорск', /(?:^|\s)магнитогорск(?:е|а|ом)?(?=\s|$)/u],
  ['Кумертау', /(?:^|\s)кумертау(?=\s|$)/u],
];
const categoryPatterns = {
  concert: /концерт|музыкальн(?:ый|ого) вечер/u,
  theatre: /спектакл|постановк|балет|мюзикл|(?:^| )театр/u,
  exhibition: /выставк|экспозици/u,
  festival: /фестивал/u,
  cinema: /(?:^| )(?:кино[а-я]*|фильм[а-я]*|мультфильм[а-я]*|мультик[а-я]*|мультсеанс[а-я]*)(?= |$)/u,
  tour: /экскурси/u,
};
const weekdays = [
  ['воскресенье', 'вс', 'вск'], ['понедельник', 'пн', 'пон'], ['вторник', 'вт'],
  ['среду', 'среда', 'ср'], ['четверг', 'чт'], ['пятницу', 'пятница', 'пт'], ['субботу', 'суббота', 'сб', 'суб'],
];
const weekdayQualifier = '(?:ближайши[йеую]|следующи[йеую]|этот|эту|это)';
const weekdayReply = new RegExp(`^(?:а )?(?:на |в )?(?:${weekdayQualifier} )?(.+)$`, 'u');
const shortWeekdays = weekdays.flat().filter(day => day.length <= 3).join('|');
const shortWeekdayPhrase = new RegExp(`(?:^| )(?:в|на) (?:${weekdayQualifier} )?((?:${shortWeekdays})(?: (?:и|или|либо) (?:в |на )?(?:${shortWeekdays}))*)(?= |$)`, 'gu');
const familyOuting = /^(?:я |мы )?(?:хочу|хотим|планирую|планируем) (?:провести (?:весь )?день|погулять|отдохнуть|(?:куда-нибудь |куда нибудь )?сходить) (?:вместе )?с семь[еь]+й$/u;

function weekdayChoices(words: string): string[] {
  return (weekdayReply.exec(words)?.[1] ?? '').split(/ (?:и|или|либо) /u).map(choice => choice.replace(/^(?:в|на) /u, ''));
}

function mentionedWeekdays(words: string): number[] {
  const choices = new Set(weekdayChoices(words));
  for (const [, phrase] of words.matchAll(shortWeekdayPhrase)) {
    for (const choice of weekdayChoices(phrase)) choices.add(choice);
  }
  return weekdays.flatMap((forms, index) => {
    const [full, ...aliases] = forms;
    const matched = ` ${words} `.includes(` ${full} `) || aliases.some(alias => choices.has(alias));
    return matched ? [index] : [];
  });
}

function misplacedQuery(value: string): boolean {
  const words = normalizeText(value);
  return familyOuting.test(words) || /^(?:а )?(?:на|в) /u.test(words) &&
    weekdayChoices(words).every(choice => weekdays.some(forms => forms.includes(choice)));
}
const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const monthForms = 'январе феврале марте апреле мае июне июле августе сентябре октябре ноябре декабре'.split(' ');
const namedDatePattern = new RegExp(`(?:^|\\D)(\\d{1,2})\\s+(${months.join('|')})(?:\\s+(\\d{4}))?`, 'gu');
const dateRangePattern = new RegExp(`(?:^|\\s)(?:(\\d{1,2})\\s+и\\s+|с\\s+(\\d{1,2})\\s+(?:по|до)\\s+)(\\d{1,2})\\s+(${months.join('|')})(?:\\s+(\\d{4}))?`, 'u');
const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const spokenAges = 'ноль один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать семнадцать восемнадцать девятнадцать двадцать'.split(' ');
export const maximumAge = 120;
type KnownVenue = { name: string; city: string };

export function readAgeReply(message: string): number | undefined {
  const text = message.trim().toLowerCase().replaceAll('ё', 'е');
  const token = /^(?:(?:ему|ей|ребенку)\s+)?([+-]?\d+(?:[.,]\d+)?|\p{L}+)(?:\s+(?:лет|года|год))?[.!?]*$/u.exec(text)?.[1];
  if (!token) return;
  if (/\d/u.test(token)) return Number(token.replace(',', '.'));
  const age = spokenAges.indexOf(token);
  if (age !== -1) return age;
}

export function cleanContext(input: unknown): DiscoveryContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const values = input as Record<string, unknown>;
  const result: DiscoveryContext = {};
  for (const field of ['city', 'venue', 'origin', 'query', 'preference'] as const) {
    const value = values[field];
    if (typeof value === 'string' && value.trim() && value.length <= 120) result[field] = value.trim();
  }
  const category = values.category;
  if (typeof category === 'string' && Object.hasOwn(categories, category)) result.category = category as DiscoveryContext['category'];
  const period = values.period;
  if (period === 'today' || period === 'tomorrow' || period === 'weekend' || period === 'week') result.period = period;
  if (typeof values.date === 'string' && isLocalDate(values.date)) result.date = values.date;
  if (typeof values.fromDate === 'string' && typeof values.untilDate === 'string' &&
      isLocalDate(values.fromDate) && isLocalDate(values.untilDate) && values.fromDate <= values.untilDate) {
    result.fromDate = values.fromDate;
    result.untilDate = values.untilDate;
  }
  if (values.language === 'ba' || values.language === 'ru') result.language = values.language;
  if (values.planMode === 'single' || values.planMode === 'day') result.planMode = values.planMode;
  if (result.planMode === 'day' && typeof values.planCount === 'number' && Number.isInteger(values.planCount) &&
      values.planCount >= 2 && values.planCount <= dayPlanLimit) result.planCount = values.planCount;
  const step = values.planStep as Record<string, unknown> | undefined;
  if (result.planMode === 'day' && (step?.phase === 'question' || step?.phase === 'offer')) {
    const optionalId = (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value) ? value : undefined;
    result.planStep = { phase: step.phase, anchor: optionalId(step.anchor), eventId: optionalId(step.eventId),
      position: step.position === 'before' || step.position === 'after' ? step.position : undefined,
      resumeAfter: typeof step.resumeAfter === 'string' && validTime.test(step.resumeAfter) ? step.resumeAfter : undefined };
  }
  if (values.transport === 'car' || values.transport === 'transit' || values.transport === 'walk' ||
      values.transport === 'bike' || values.transport === 'taxi') result.transport = values.transport;
  for (const field of ['latestEnd', 'earliestStart'] as const) {
    const value = values[field];
    if (typeof value === 'string' && validTime.test(value)) result[field] = value;
  }
  for (const [field, minimum, maximum] of [
    ['childAge', 0, maximumAge], ['partySize', 1, 30], ['budget', 0, 1_000_000],
    ['travelMinutes', 1, 240], ['cheaperThan', 0, 30_000_000], ['referencePrice', 0, 30_000_000],
  ] as const) {
    const value = values[field];
    if (typeof value === 'number' && (field === 'budget' || field === 'referencePrice' || field === 'cheaperThan' ? Number.isFinite(value) : Number.isInteger(value)) && value >= minimum && value <= maximum) result[field] = value;
  }
  for (const field of ['child', 'free', 'sortByDistance', 'awaitingPreference'] as const) {
    if (typeof values[field] === 'boolean') result[field] = values[field];
  }
  if (Array.isArray(values.seenEventIds)) {
    result.seenEventIds = values.seenEventIds.slice(-100).filter((id): id is string =>
      typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id));
  }
  return result;
}

function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length > right.length) return oneEditApart(right, left);
  let index = 0;
  while (left[index] === right[index] && index < left.length) index++;
  if (left.length < right.length) return left.slice(index) === right.slice(index + 1);
  if (left.slice(index + 1) === right.slice(index + 1)) return true;
  return left[index] === right[index + 1] && left[index + 1] === right[index] &&
    left.slice(index + 2) === right.slice(index + 2);
}

function explicitCities(words: string, cities: string[]): string[] {
  return [...new Set([
    ...regionalCities.filter(([_name, pattern]) => pattern.test(words)).map(([name]) => name),
    ...cities.filter(name => (' ' + words + ' ').includes(' ' + normalizeText(name) + ' ')),
  ])];
}

function mentionedCity(words: string, cities: string[]): string | undefined {
  const [exact] = explicitCities(words, cities);
  if (exact) return exact;
  // A near match must be in a city position and identify only one known city.
  const place = words.includes(' ') ? /(?:^| )(?:в|город) ([а-я]{5,})(?= |$)/gu : /^([а-я]{5,})$/gu;
  const wordsToCheck = [...words.matchAll(place)];
  const candidates = new Set([...cities, ...regionalCities.map(([name]) => name)].filter(name => {
    const canonical = normalizeText(name);
    return canonical.length >= 5 && wordsToCheck.some(([, word]) =>
      [word, word.replace(/(?:ом|[аеу])$/u, '')].some(form => oneEditApart(form, canonical)));
  }));
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

function mentionedVenue(words: string, city: string | undefined, venues: readonly KnownVenue[]): KnownVenue | undefined {
  const text = words.split(' ');
  const candidates = venues.filter(venue => !city || normalizeText(venue.city) === normalizeText(city));
  const exact = candidates.filter(venue => (' ' + words + ' ').includes(' ' + normalizeText(venue.name) + ' '));
  if (exact.length === 1) return exact[0];
  const namedVenues = candidates.filter(venue => {
    const name = normalizeText(venue.name).match(/^(?:кинотеатр|киноцентр) ([а-я]{5,})$/u)?.[1];
    return name && text.some((word, index) => ['в', 'на'].includes(text[index - 1]) &&
      (word === name || word.replace(/[аеуы]$/u, '') === name));
  });
  if (namedVenues.length === 1) return namedVenues[0];
  const matches = candidates.filter(venue => {
    const tokens = normalizeText(venue.name).split(' ').filter(token => token.length >= 3);
    return text.some((token, index) => {
      if (index + 2 >= text.length || !['в', 'на'].includes(token)) return false;
      const fragment = text.slice(index + 1, index + 3);
      return tokens.some((item, position) => fragment.every((word, offset) => {
        const target = tokens[position + offset];
        return target && (word === target || word.length >= 4 &&
          (word.replace(/[аеуы]$/u, '') === target || word.slice(0, -1) === target.slice(0, -1)));
      }));
    });
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function dateWithNamedMonth(day: string, month: string, year: string): string {
  return `${year}-${String(months.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function freshIntent(words: string, city: string | undefined, previous: DiscoveryContext) {
  if (isSearchReset(words)) return true;
  return Boolean(city && previous.city && city !== previous.city &&
    /^(?:найди|покажи|подбери|посоветуй|куда|какие|что интересного|что посмотреть) /u.test(words));
}

export function isSearchReset(message: string): boolean {
  return /^(?:новый поиск|начнем заново|сначала)(?: |$)/u.test(normalizeText(message));
}

export function readPlanRequest(message: string, countReply = false): { mode?: DiscoveryContext['planMode']; count?: number } {
  const stripped = normalizeText(message.replace(/[«"][^»"]+[»"]/gu, ' '));
  const words = /(?:^| )не .+? а (.+)$/u.exec(stripped)?.[1] ?? stripped;
  const counts: Record<string, number> = { одно: 1, один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4,
    пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 };
  const token = /(?:^| )(\d+|одно|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять) (?:событи[еяй]|мероприяти[еяй]|концерт(?:а|ов)?|спектакл[яейь]|выстав(?:ка|ки|ку|ок)|экскурси[яюий]|кино(?:сеанс(?:а|ов)?)?|сеанс(?:а|ов)?|фильм(?:а|ов)?|мультфильм(?:а|ов)?)(?= |$)/u.exec(words)?.[1]
    ?? (countReply ? /^(?:давайте? |хочу )?(\d+|одно|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)$/u.exec(words)?.[1] : undefined);
  if (/(?:одно|один|\d) (?:событи[еяй] )?или (?:несколько|\d)/u.test(words)) return {};
  if (token) {
    const count = counts[token] ?? Number(token);
    return { mode: count === 1 ? 'single' : 'day', count };
  }
  if (/(?:^| )(?:несколько (?:событи[йя]|мероприятий|вариантов)|план на (?:день|сегодня|завтра|выходн[а-я]*|\d{1,4})|(?:составь|собери|сделай|построй|запланируй)(?: мне)?(?: семейный| спокойный)? (?:план|маршрут|выходной))(?= |$)/u.test(words) ||
      (countReply && /^(?:давайте? |хочу )?(?:несколько|план|маршрут)$/u.test(words))) return { mode: 'day' };
  return {};
}

function readTransport(words: string): DiscoveryContext['transport'] | null {
  const choice = /(?:^| )не .+? (?:а|но) (.+)$/u.exec(words)?.[1] ?? words;
  const options = {
    car: /(?:^| )(?:на (?:своей |личной )?(?:машине|авто|автомобиле)|(?:есть|у нас) машина|за рулем)(?= |$)|^(?:машина|авто)$/u,
    transit: /(?:^| )(?:на (?:автобусе|троллейбусе|трамвае|метро|маршрутке|общественном(?: транспорте)?)|общественным транспортом|автобусом|трамваем)(?= |$)|^(?:автобус|общественный транспорт)$/u,
    walk: /(?:^| )пешком(?= |$)/u,
    bike: /(?:^| )(?:на (?:велосипеде|велике)|велосипедом)(?= |$)|^велосипед$/u,
    taxi: /(?:^| )на такси(?= |$)|^такси$/u,
  };
  const matches = (Object.keys(options) as (keyof typeof options)[]).filter(mode => options[mode].test(choice));
  if (matches.length === 1 && !/(?:^| )(?:не (?:на|пешком)|без машины)(?= |$)/u.test(choice)) return matches[0];
  if (matches.length || /(?:^| )(?:без машины|(?:у меня|у нас) нет машины|машины нет)(?= |$)/u.test(choice)) return null;
}

function timeWindow(text: string) {
  const window = /(?:^|\s)с\s+(\d{1,2})(?::(\d{2}))?\s+(?:до|по)\s+(\d{1,2})(?::(\d{2}))?(\s+час(?:ов|а)?)?(?=$|[^\d:])/u.exec(text);
  if (window && (window[2] || window[4] || window[5])) {
    return { start: formatTime(window[1], window[2]), end: formatTime(window[3], window[4]) };
  }
}

function formatTime(hour: string, minute = '00'): string {
  return `${hour.padStart(2, '0')}:${minute}`;
}

export function constraintIssue(message: string, planning = false): string | undefined {
  const plain = message.replace(/[«"][^»"]+[»"]/gu, ' ');
  const words = normalizeText(plain);
  const text = plain.toLowerCase().replaceAll('ё', 'е').replace(/[\u00a0\u202f]/g, ' ');
  if ((!planning && /(?:составь|собери|запланируй) (?:мне )?(?:семейный |спокойный )?(?:план|маршрут|выходной)|(?:^| )(?:только пешком|пешком не|дойти пешком)(?= |$)/u.test(words)) ||
      /(?:^| )(?:в радиусе|расстояние между|не дальше|не более \d+(?: \d+)? (?:км|километр[а-я]*))(?= |$)/u.test(words)) {
    return 'Могу подобрать события по городу, дате, цене и возрасту. Для прогулки или маршрута между площадками пока не могу проверить расстояние. Хотите поискать отдельные события?';
  }
  if (/(?:^|[\s,:])[-−]\s*\d[\d ,.]*\s*(?:₽|руб|р(?:[ .]|$))/u.test(text)) {
    return 'Бюджет не может быть отрицательным. Какую максимальную цену указать?';
  }
  const party = /(?:на|для) (\d+) (?:человек|взрослых|гостей|билет)/u.exec(words);
  if (party && (Number(party[1]) < 1 || Number(party[1]) > 30)) {
    return 'На сколько человек искать? Укажите число от 1 до 30.';
  }
  const travel = /(?:ехать|дорог[аиу]|поездк[аиу]|добраться)[^\d.!?]{0,30}(\d{1,3})\s*мин/iu.exec(message);
  if (travel && (Number(travel[1]) < 1 || Number(travel[1]) > 240)) {
    return 'Укажите предел поездки от 1 до 240 минут.';
  }
  const time = /(?:не позже|не позднее|после|не раньше)\s+(\d{1,2}):(\d{2})/iu.exec(text);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59)) {
    return 'Проверьте время. Например, «после 18:00» или «до 20:00».';
  }
  const date = /\b\d{4}-\d{2}-\d{2}\b/u.exec(text)?.[0];
  if (date && !isLocalDate(date)) return 'Такой даты нет. Какой день выбрать?';
  const days = [...text.matchAll(namedDatePattern)];
  for (const [, day, month, year] of days) {
    if (!isLocalDate(dateWithNamedMonth(day, month, year ?? '2028'))) return 'Такой даты нет. Какой день выбрать?';
  }
  if (days.length === 2 && dateConnector(text, days[0], days[1]) === 'и') {
    const first = dateWithNamedMonth(days[0][1], days[0][2], days[0][3] ?? '2028');
    const second = dateWithNamedMonth(days[1][1], days[1][2], days[1][3] ?? days[0][3] ?? '2028');
    const adjacent = first === second || (first < second ? localDay(first, 1) === second : localDay(second, 1) === first);
    if (!adjacent) return 'Это два отдельных дня. Для какого из них показать события сначала?';
  }
  const range = dateRangePattern.exec(text);
  if (range && Number(range[1] ?? range[2]) > Number(range[3])) return 'Уточните даты: последний день должен быть после первого.';
  const window = timeWindow(text);
  if (window && (!validTime.test(window.start) || !validTime.test(window.end))) {
    return 'Проверьте время. Например, «с 18:00 до 20:00».';
  }
  if (window && window.start > window.end) return 'Это время до следующего утра? Напишите, на какой день искать события.';
}

function dateConnector(text: string, first: RegExpMatchArray, second: RegExpMatchArray) {
  return normalizeText(text.slice((first.index ?? 0) + first[0].length, (second.index ?? 0) + 1));
}

export function readIntent(message: string, previous: DiscoveryContext, cities: string[], now: Date, venues: readonly KnownVenue[] = [], planning = false): DiscoveryContext {
  const quoted = /[«"]([^»"]{2,100})[»"]/u.exec(message)?.[1];
  const plain = message.replace(/[«"][^»"]{2,100}[»"]/gu, value => ' '.repeat(value.length));
  const text = plain.toLowerCase().replaceAll('ё', 'е').replace(/[\u00a0\u202f]/g, ' ');
  const origin = /(?:едем от|поедем от|поеду от|выезжаем от|отправляемся от|отправляюсь от|точка отправления\s*:|откуда\s*:)\s*([^!?\n]{2,120})/u.exec(text);
  const nearby = /(?:ближе|поближе) к\s+([^!?\n]{2,120})/u.exec(text);
  const originPhrase = origin ?? nearby;
  const words = normalizeText(originPhrase ? text.slice(0, originPhrase.index) : text);
  const today = localDate(now);
  const explicitCity = /(?:^|[,.;])\s*город\s*:\s*([\p{L}-]+(?:[ -][\p{L}-]+){0,3})\s*(?=$|[,.;!?])/iu.exec(plain)?.[1];
  const cityOptions = planning ? explicitCities(words, cities) : [];
  const city = planning ? cityOptions.length === 1 ? cityOptions[0] : cityOptions.length ? undefined : explicitCity
    : mentionedCity(words, cities) ?? explicitCity;
  const context = freshIntent(words, city, previous) ? {} : { ...previous };
  if (context.query && misplacedQuery(context.query)) {
    if (familyOuting.test(normalizeText(context.query))) context.preference ??= 'Семейный досуг';
    delete context.query;
  }
  const priorQuery = context.query;
  if (cityOptions.length > 1) {
    delete context.city;
    delete context.origin;
    delete context.venue;
  }
  if (city) {
    if (context.city && context.city !== city) {
      delete context.origin;
      delete context.venue;
      delete context.sortByDistance;
    }
    context.city = city;
  }
  if (/любой город|в любом городе|вся республика/u.test(words)) {
    delete context.city;
    delete context.origin;
    delete context.venue;
    delete context.sortByDistance;
  }

  const venue = mentionedVenue(words, city, venues);
  if (venue) {
    if (context.city && normalizeText(context.city) !== normalizeText(venue.city)) {
      delete context.origin;
      delete context.sortByDistance;
    }
    context.venue = venue.name;
    if (!planning) context.city = venue.city;
  }
  if (/любая площадка|на любой площадке|без площадки/u.test(words)) delete context.venue;

  // Words describing the selected venue itself do not specify an event category.
  const venueName = venue ? normalizeText(venue.name) : '';
  const preferencePattern = /(?:^|[,.!?;])\s*((?:люблю|предпочитаю|(?:мне )?нравятся?)\s+[^.!?,;]{2,100})/iu;
  const statedPreference = planning && !quoted ? preferencePattern.exec(plain)?.[1] : undefined;
  const categoryTerms = statedPreference ? words.replace(normalizeText(statedPreference), ' ').trim() : words;
  const categoryWords = /(?:^| )не .+? а (.+)$/u.exec(categoryTerms)?.[1] ?? categoryTerms;
  const category = Object.entries(categoryPatterns).find(([_category, pattern]) => {
    const term = pattern.exec(categoryWords)?.[0];
    if (!term) return false;
    if (!pattern.test(venueName)) return true;
    const count = (text: string) => [...text.matchAll(new RegExp(pattern.source, 'gu'))].length;
    return count(categoryWords) > count(venueName) ||
      new RegExp(`^(?:найди |покажи |ищу |есть ли |какие )?(?:${pattern.source})`, 'u').test(categoryWords);
  })?.[0];
  if (category) {
    context.category = category as DiscoveryContext['category'];
    if (category !== previous.category) {
      delete context.query;
      delete context.preference;
      delete context.awaitingPreference;
    }
  }
  if (/любая категория|любые события/u.test(words)) delete context.category;

  const language = /(?:на|с поддержкой) башкирск(?:ом|ого)(?: язык[ае])?(?= |$)/u.test(words) ? 'ba'
    : /на русском языке/u.test(words) ? 'ru' : undefined;
  if (language) context.language = language;
  if (/любой язык|без учета языка/u.test(words)) delete context.language;

  let date = /\b\d{4}-\d{2}-\d{2}\b/.exec(text)?.[0];
  let fromDate: string | undefined;
  let untilDate: string | undefined;
  const calendarYear = today.slice(0, 4);
  const namedDays = [...text.matchAll(namedDatePattern)];
  const namedDay = namedDays[0];
  const range = dateRangePattern.exec(text);
  const monthIndex = monthForms.findIndex((month, index) =>
    new RegExp(`(?:^| )в (?:${month}|(?:начале|середине|конце) ${months[index]})(?= |$)`, 'u').test(words));
  if (range) {
    const firstDay = range[1] ?? range[2];
    const [, , , lastDay, month, explicitYear] = range;
    const year = explicitYear ?? calendarYear;
    const first = dateWithNamedMonth(firstDay, month, year);
    const last = dateWithNamedMonth(lastDay, month, year);
    if (isLocalDate(first) && isLocalDate(last) && first <= last) {
      const rangeYear = !explicitYear && last < today ? String(Number(year) + 1) : year;
      fromDate = dateWithNamedMonth(firstDay, month, rangeYear);
      untilDate = dateWithNamedMonth(lastDay, month, rangeYear);
    }
  }
  if (!range && namedDays.length === 2 && /^(?:и|по|до)$/u.test(dateConnector(text, namedDays[0], namedDays[1]))) {
    const [, firstDay, firstMonth, firstYear] = namedDays[0];
    const [, lastDay, lastMonth, lastYear] = namedDays[1];
    const first = dateWithNamedMonth(firstDay, firstMonth, firstYear ?? calendarYear);
    let last = dateWithNamedMonth(lastDay, lastMonth, lastYear ?? firstYear ?? calendarYear);
    if (!lastYear && last < first && dateConnector(text, namedDays[0], namedDays[1]) !== 'и') {
      last = `${Number(last.slice(0, 4)) + 1}${last.slice(4)}`;
    }
    if (isLocalDate(first) && isLocalDate(last)) {
      [fromDate, untilDate] = [first, last].sort();
    }
  } else if (!range && namedDay) {
    date = dateWithNamedMonth(namedDay[1], namedDay[2], namedDay[3] ?? calendarYear);
    if (!namedDay[3] && date < today && !/проходил|прошл[а-я]*|состоял/u.test(words)) {
      date = `${Number(calendarYear) + 1}${date.slice(4)}`;
    }
  } else if (!range && monthIndex !== -1) {
    const month = String(monthIndex + 1).padStart(2, '0');
    const year = month < today.slice(5, 7) ? String(Number(calendarYear) + 1) : calendarYear;
    const first = `${year}-${month}-01`;
    const last = new Date(Date.UTC(Number(year), monthIndex + 1, 0)).toISOString().slice(0, 10);
    fromDate = /в середине/u.test(words) ? localDay(first, 10) : /в конце/u.test(words) ? localDay(first, 20) : first;
    untilDate = /в начале/u.test(words) ? localDay(first, 9) : /в середине/u.test(words) ? localDay(first, 19) : last;
  }
  const namedWeekdays = mentionedWeekdays(words);
  const weekday = namedWeekdays[0] ?? -1;
  if (!date && !fromDate && weekday >= 0) {
    const current = new Date(today + 'T00:00:00Z').getUTCDay();
    const distance = (weekday - current + 7) % 7;
    date = localDay(today, distance + (/следующ/u.test(words) && distance === 0 ? 7 : 0));
  }
  const period = /послезавтра/u.test(words) ? undefined : /завтра/u.test(words) ? 'tomorrow' :
    /сегодня|сегодняшн/u.test(words) ? 'today' : /выходны/u.test(words) ? 'weekend' :
    /эту неделю|на (?:этой |ближайшей )?неделе|семь дней|7 дней/u.test(words) ? 'week' : undefined;
  const relativeDays = new Set(words.match(/(?:^|(?<= ))(?:сегодня|завтра|послезавтра)(?= |$)/gu));
  const ambiguousDate = namedWeekdays.length > 1 || relativeDays.size > 1 || new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/gu)).size > 1 ||
    namedDays.length > 1 && /(?:^| )или(?= |$)/u.test(words);
  if (planning && ambiguousDate) {
    delete context.date;
    delete context.period;
    delete context.fromDate;
    delete context.untilDate;
  } else if (fromDate && untilDate) {
    context.fromDate = fromDate;
    context.untilDate = untilDate;
    delete context.date;
    delete context.period;
  } else if (isLocalDate(date ?? '') || /послезавтра/u.test(words)) {
    context.date = date && isLocalDate(date) ? date : localDay(today, 2);
    delete context.period;
    delete context.fromDate;
    delete context.untilDate;
  } else if (period) {
    context.date = period === 'today' ? today : period === 'tomorrow' ? localDay(today, 1) : undefined;
    context.period = period;
    delete context.fromDate;
    delete context.untilDate;
  } else if (/в любой день|любые даты|без даты/u.test(words)) {
    delete context.date;
    delete context.period;
    delete context.fromDate;
    delete context.untilDate;
  }

  const age = /(?:^|\s)(\d{1,3})\s*(?:лет|года|год)(?=\s|$)/u.exec(words);
  const ageLabel = /(?:^| )(?:для )?(двух|трех|четырех|пяти|шести|семи|восьми|девяти|десяти)лет(?:ки|ка|ке|ок|нему|ней|него)(?= |$)/u.exec(words)?.[1];
  if (ageLabel) {
    context.child = true;
    context.childAge = 'двух трех четырех пяти шести семи восьми девяти десяти'.split(' ').indexOf(ageLabel) + 2;
  }
  if (/ребен|ребят|дет(?:и|ей|ям|ьми|ск)|семейн|школьник|подрост/u.test(words)) context.child = true;
  if (age && Number(age[1]) <= maximumAge && (context.child || /^(?:ему |ей )?\d{1,3} (?:лет|год|года)$/u.test(words))) {
    context.child = true;
    const range = /от (\d{1,2}) до (\d{1,2}) (?:лет|год|года)/u.exec(words);
    context.childAge = range ? Math.min(Number(range[1]), Number(range[2])) : Number(age[1]);
  }
  if (/без детей|только взросл|без учета возраста/u.test(words)) {
    delete context.child;
    delete context.childAge;
  }

  const party = /(?:на|для)\s+(?:(двоих|троих|четверых|пятерых|шестерых)|(\d{1,2})\s+(?:человек[а-я]*|взрослых|гостей|билет[а-я]*|детей))(?=\s|$)/u.exec(words);
  const people: Record<string, number> = { двоих: 2, троих: 3, четверых: 4, пятерых: 5, шестерых: 6 };
  if (party) context.partySize = party[2] ? Number(party[2]) : people[party[1]];
  if (/на одного|за человека|на человека|за билет/u.test(words)) context.partySize = 1;

  const thousands = /(\d+(?:[.,]\d+)?)\s*(?:тыс(?:яч[аи]?)?\.?|к)(?=\s*(?:₽|руб|р\.|на |за |[,!?]|$))/u.exec(text);
  const rubles = /(?<![\d.,])(\d[\d ]{0,10}(?:[.,]\d{1,2})?)\s*(?:₽|руб(?:лей|ля|ль)?|р\.?)(?=[\s.,?!]|$)/u.exec(text);
  const bareBudget = /(?:до|бюджет|не дороже|дешевле)\s+(\d[\d ]{0,9})(?=\s+(?:на\s+(?:двоих|троих|четверых|одного|человека|\d)|за\s+(?:человека|билет))|\s*[,!?]?$)/u.exec(text);
  const budget = thousands ? Number(thousands[1].replace(',', '.')) * 1000 :
    rubles || bareBudget ? Number((rubles?.[1] ?? bareBudget?.[1] ?? '').replaceAll(' ', '').replace(',', '.')) : undefined;
  if (budget !== undefined) {
    context.budget = budget;
    context.free = budget === 0;
    delete context.cheaperThan;
    if (budget > 0 && /(?:^| )(?:дешевле|меньше) \d/u.test(words)) context.cheaperThan = budget;
  }
  if (/бесплатн|свободный вход/u.test(words)) {
    context.free = true;
    context.budget = 0;
    delete context.cheaperThan;
  }
  if (/любая цена|без ограничений по цене/u.test(words)) {
    delete context.budget;
    delete context.free;
    delete context.cheaperThan;
  }

  const window = timeWindow(text);
  const ending = /(?:не позже|не позднее|законч(?:ить|илось|иться|атся|ится)\s+(?:к|до)|окончание\s+до)\s*(\d{1,2})(?::([0-5]\d))?/u.exec(text);
  const starting = /(?:после|не раньше|начало с)\s+(\d{1,2})(?::([0-5]\d)|\s*(?:час(?:ов|а)?|утра|вечера|дня)|(?=[\s,.!?]|$)(?!\s+[\p{L}]))/u.exec(text)
    ?? /(\d{1,2}):([0-5]\d)\s+или\s+позже/u.exec(text);
  if (window) {
    context.earliestStart = window.start;
    context.latestEnd = window.end;
  }
  if (ending) context.latestEnd = formatTime(ending[1], ending[2]);
  if (starting) {
    const eveningHour = /вечера|дня/u.test(starting[0]) && Number(starting[1]) < 12 ? String(Number(starting[1]) + 12) : starting[1];
    context.earliestStart = formatTime(eveningHour, starting[2]);
  }
  if (/вечером/u.test(words) && !starting) context.earliestStart = '17:00';
  if (/любое время|без ограничений по времени/u.test(words)) {
    delete context.latestEnd;
    delete context.earliestStart;
  }

  const travel = /(?:ехать|дорог[аиу]|поездк[аиу]|добраться)[^\d.!?]{0,30}(\d{1,3})\s*мин/u.exec(text)
    ?? /(\d{1,3})\s*мин(?:ут[уы]?)?\s*(?:езды|на дорогу)/u.exec(text);
  if (travel) context.travelMinutes = Number(travel[1]);
  const plan = planning ? readPlanRequest(message, !previous.planMode) : {};
  if (plan.mode) {
    context.planMode = plan.mode;
    if (plan.mode === 'single') delete context.planCount;
    else if (plan.count !== undefined) context.planCount = plan.count;
  }
  const transport = planning ? readTransport(normalizeText(text)) : undefined;
  if (transport) context.transport = transport;
  if (transport === null) delete context.transport;
  if (originPhrase) {
    let location = message.slice(originPhrase.index + originPhrase[0].length - originPhrase[1].length,
      originPhrase.index + originPhrase[0].length).replace(/[,.;]+$/, '').trim();
    if (planning) location = location.split(/[,;]\s*(?:(?:поед[уе]м?|добер[уе]мся)\s+)?(?:на (?:машине|авто|автобусе|трамвае|такси|велосипеде)|пешком|бюджет|завтра|сегодня|город\s*:)(?=\s|$)/iu)[0];
    const knownOrigin = mentionedVenue('в ' + normalizeText(location), context.city, venues);
    context.origin = knownOrigin?.name ?? location;
  }
  if (nearby || /^(?:а |можно )?(?:ближе|поближе)(?: |$)/u.test(words)) context.sortByDistance = true;
  if (/без учета дороги|без учета времени в пути|без ограничения на дорогу/u.test(words)) {
    delete context.travelMinutes;
    delete context.origin;
    delete context.sortByDistance;
  }

  const familyPreference = !quoted && familyOuting.test(words);
  if (familyPreference) context.preference = 'Семейный досуг';
  if (statedPreference) context.preference = statedPreference.trim();
  const namedInterest = /(?:^|\s)(джаз|рок|опера|стендап|классическая музыка)(?=\s|$)/u.exec(words)?.[1];
  const headTitle = /^(?:найди|покажи|ищу|есть ли)\s+(?:спектакль|выставку|концерт|экскурсию|фестиваль|мюзикл|балет)\s+([^,.!?]+?)(?=\s+(?:в|на|с|до|после)\s+|[,.!?]|$)/iu.exec(plain)?.[1]?.trim();
  const inferredTitle = headTitle && !/^(?:мне|интересн[а-я]*|люб[а-я]*|сегодня|завтра|бесплатн[а-я]*)$/iu.test(headTitle) &&
    !/^\d/u.test(headTitle) ? headTitle : undefined;
  if (quoted || inferredTitle || (namedInterest && !statedPreference)) context.query = quoted ?? inferredTitle ?? namedInterest;
  if (!context.query && /(?:^|\s)(?:куда|что|где|найди|покажи|ищу|есть)(?:\s|$)/u.test(words)) {
    const explicit = /(?:^|\s)(?:найди|покажи|ищу)\s+([^,.!?]{2,100})/iu.exec(message)?.[1]?.trim();
    if (explicit && !city && !category && !date && !period && !age && !budget && !travel && !plan.mode && !transport &&
        !/^(?:мне|что|любые|интересн|события|мероприятия|варианты)/iu.test(explicit)) context.query = explicit;
  }
  const requestWords = /куда|пойти|сходить|что|найди|покажи|есть|афиша|посоветуй|подбер|предложи|событи|мероприяти|подешевле|дешевле|еще|ближе|без |люб(?:ая|ое|ой|ые)|начнем заново|сначала|новый поиск/u;
  const planningGreeting = planning && /^(?:привет|здравствуй(?:те)?|добры[йое] (?:день|утро|вечер))$/u.test(words);
  if (!requestWords.test(words) && !familyPreference && !ambiguousDate && !city && !category && !date && !fromDate && !period && !age && budget === undefined &&
    !travel && !originPhrase && !window && !starting && !ending && !party && !language && !venue && !plan.mode && transport === undefined && !statedPreference && !planningGreeting &&
    !/бесплатн|послезавтра/u.test(words) && !/^\d+$/u.test(words) && words.length > 1 && words.length <= 100) {
    context.query = message.trim();
  }
  if (words === 'без темы') delete context.query;
  const genreReply = previous.seenEventIds?.length && !quoted &&
    /^(?:(?:лучше|хочу|хочется|давайте) )?(?:музыкальн[а-я]* сказк[а-я]*|комеди[а-я]*|фэнтези|приключени[а-я]*|мультфильм[а-я]*|драм[а-я]*|классическ[а-я]* музык[а-я]*)(?: |$)/u.test(words);
  if (context.awaitingPreference || genreReply) {
    delete context.awaitingPreference;
    const unchangedFilters = (['city', 'category', 'date', 'period', 'fromDate', 'untilDate', 'venue', 'language',
      'earliestStart', 'latestEnd', 'childAge', 'partySize', 'budget', 'cheaperThan', 'travelMinutes', 'origin', 'sortByDistance', 'planMode', 'planCount', 'transport'] as const)
      .every(field => previous[field] === context[field]);
    const directPreference = !quoted && !familyPreference && !namedWeekdays.length && !ambiguousDate && unchangedFilters && words.length <= 120 &&
      /[а-я]/u.test(words) && !/^(?:а )?(?:что ещ[её]|покажи|найди|ищу|без |любо)/u.test(words);
    const noPreference = /^(?:любые|все равно|без разницы|нет предпочтений)$/u.test(words);
    if (directPreference || noPreference) {
      context.query = priorQuery;
      if (directPreference) context.preference = message.trim().slice(0, 120);
      else delete context.preference;
    }
  }
  return cleanContext(context);
}

export function mergeIntent(
  message: string,
  previous: DiscoveryContext,
  local: DiscoveryContext,
  interpreted: DiscoveryContext,
  cities: string[],
  venues: readonly KnownVenue[] = [],
  now = new Date(),
  planning = false,
): DiscoveryContext {
  const words = normalizeText(message.replace(/[«"][^»"]+[»"]/gu, ' '));
  const cityChanged = local.city !== previous.city;
  const result = { ...local };
  if (freshIntent(words, local.city, previous) || isSearchReset(message)) return result;
  const explicit = readIntent(message, {}, cities, now, venues, planning);
  const has = (value: string) => (' ' + words + ' ').includes(' ' + normalizeText(value) + ' ');
  const evidence = {
    city: interpreted.city !== undefined && (has(interpreted.city) || words.split(' ').some(word => {
      const city = normalizeText(interpreted.city ?? '');
      return city.length >= 5 && city.slice(0, -1) === word.slice(0, -1);
    })),
    category: /спектакл|концерт|выстав|постановк|сцен|театр|балет|опера|экспозиц|музе[йяе]|фестивал|ярмарк|кино|фильм|экскурси|прогулк|мастер класс|музык/u.test(words),
    date: /сегодня|завтра|недел|выходн|месяц|суббо|воскрес|понедельник|вторник|сред[аеуы]|четверг|пятниц/u.test(words) ||
      [...months, ...monthForms].some(month => has(month)) || /\d{4}[-.]\d{2}[-.]\d{2}/u.test(message),
    age: /(?:^| )(?:ребен[а-я]*|дет[а-я]*|семей[а-я]*|школь[а-я]*)(?= |$)/u.test(words),
    price: /бюджет|бесплатн|рубл|не дороже|дешевле|цен[ауы]|стоимост/u.test(words) || message.includes('₽'),
    time: /врем[яени]|утр[ао]|днем|вечер|час[ао]|законч|начал|позже|раньше/u.test(words) || /\d:\d{2}/u.test(message),
    party: /двоих|троих|четверых|человек|взросл|гост[яеи]|билет/u.test(words),
    travel: /путь|поезд|дорог|ехат|добрат/u.test(words) && /минут|\d мин/u.test(words),
  };
  const set = <Field extends keyof DiscoveryContext>(field: Field, allowed: boolean) => {
    if (allowed && local[field] === previous[field] && explicit[field] === undefined && interpreted[field] !== undefined) {
      result[field] = interpreted[field];
    }
  };
  if (!planning && !cityChanged && evidence.city && interpreted.city) {
    const spelling = cities.find(city => normalizeText(city) === normalizeText(interpreted.city ?? ''));
    set('city', Boolean(spelling || has(interpreted.city)));
    if (result.city !== local.city) {
      delete result.venue;
      delete result.origin;
      delete result.sortByDistance;
    }
  }
  const modelVenue = venues.find(venue => interpreted.venue &&
    normalizeText(venue.name) === normalizeText(interpreted.venue) &&
    (!result.city || normalizeText(result.city) === normalizeText(venue.city)));
  if (modelVenue && has(modelVenue.name)) set('venue', true);
  set('category', evidence.category && !result.venue && !(planning && explicit.preference));
  const localDateChanged = (['date', 'period', 'fromDate', 'untilDate'] as const).some(field =>
    local[field] !== previous[field] || explicit[field] !== undefined);
  if (evidence.date && !localDateChanged && local.planMode !== 'day') {
    if (interpreted.fromDate && interpreted.untilDate) {
      delete result.date;
      delete result.period;
      result.fromDate = interpreted.fromDate;
      result.untilDate = interpreted.untilDate;
    } else if (interpreted.date || interpreted.period) {
      delete result.fromDate;
      delete result.untilDate;
      result.date = interpreted.date;
      result.period = interpreted.period;
    }
  }
  set('child', evidence.age);
  set('childAge', evidence.age || previous.child === true);
  set('budget', evidence.price);
  set('free', evidence.price);
  set('partySize', evidence.party);
  set('earliestStart', evidence.time);
  set('latestEnd', evidence.time);
  set('travelMinutes', evidence.travel);
  const query = interpreted.query && normalizeText(interpreted.query);
  const preference = interpreted.preference && normalizeText(interpreted.preference);
  const wholeSearch = query === words && Boolean(explicit.city || explicit.date || explicit.period || explicit.fromDate ||
    explicit.planMode || explicit.transport || explicit.preference);
  const genericQuery = query && /^(?:(?:семейн|детск|классическ|интересн|хорош|легк|весел|бесплатн|музыкальн)[а-я]* )+(?:концерт|спектакл|фильм|выставк|событи|кино|мультфильм)[а-я]*$/u.test(query);
  if (!explicit.query && preference && has(preference) &&
      /люб[люи]|нрав|хоч|предпоч|настроен|важно|чтобы был[аои]|посовету|подбер/u.test(words)) {
    result.preference = interpreted.preference;
  }
  if (genericQuery && result.category && !result.preference && has(query)) result.preference = interpreted.query;
  if (query && !wholeSearch && !genericQuery && !misplacedQuery(query) && !mentionedWeekdays(query).length && has(query) && !/^(?:\d+|мероприяти[а-я]*|событи[а-я]*|выставк[а-я]*|концерт[а-я]*|спектакл[а-я]*|театр[а-я]*|кино[а-я]*|фильм[а-я]*|мультфильм[а-я]*|мультик[а-я]*|бесплатн[а-я]*|дешевле|сегодня|завтра|выходны[а-я]*|что угодно)$/u.test(query) &&
      (!preference || !(' ' + preference + ' ').includes(' ' + query + ' ')) &&
      !cities.some(city => normalizeText(city) === query)) set('query', true);
  return cleanContext(result);
}
