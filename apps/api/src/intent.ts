import { categories } from '@afisha/contracts';
import type { DiscoveryContext } from '@afisha/contracts';
import { isLocalDate, normalizeText } from './catalog.ts';
import { localDate, localDay } from './filters.ts';

const regionalCities: [string, RegExp][] = [
  ['Уфа', /(?:^|\s)(?:уфа|уфе|уфу|уфы|уфой)(?=\s|$)/u],
  ['Стерлитамак', /(?:^|\s)стерлитамак(?:е|а|ом)?(?=\s|$)/u],
  ['Салават', /(?:^|\s)салават(?:е|а|ом)?(?=\s|$)/u],
  ['Нефтекамск', /(?:^|\s)нефтекамск(?:е|а|ом)?(?=\s|$)/u],
  ['Октябрьский', /(?:^|\s)октябрьск(?:ий|ом|ого)(?=\s|$)/u],
  ['Туймазы', /(?:^|\s)туймаз(?:ы|ах|ов)(?=\s|$)/u],
  ['Ишимбай', /(?:^|\s)ишимба(?:й|е|я)(?=\s|$)/u],
  ['Сибай', /(?:^|\s)сиба(?:й|е|я)(?=\s|$)/u],
  ['Белорецк', /(?:^|\s)белорецк(?:е|а|ом)?(?=\s|$)/u],
  ['Бирск', /(?:^|\s)бирск(?:е|а|ом)?(?=\s|$)/u],
  ['Мелеуз', /(?:^|\s)мелеуз(?:е|а|ом)?(?=\s|$)/u],
];
const categoryPatterns = {
  concert: /концерт|музыкальн(?:ый|ого) вечер/u,
  theatre: /спектакл|постановк|театр|балет|мюзикл/u,
  exhibition: /выставк|экспозици/u,
  festival: /фестивал/u,
  cinema: /кино|кинопоказ/u,
  tour: /экскурси/u,
};
const weekdays = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
const months = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function cleanContext(input: unknown): DiscoveryContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const values = input as Record<string, unknown>;
  const result: DiscoveryContext = {};
  for (const field of ['city', 'origin', 'query'] as const) {
    const value = values[field];
    if (typeof value === 'string' && value.trim() && value.length <= 120) result[field] = value.trim();
  }
  const category = values.category;
  if (typeof category === 'string' && Object.hasOwn(categories, category)) result.category = category as DiscoveryContext['category'];
  const period = values.period;
  if (period === 'today' || period === 'tomorrow' || period === 'weekend' || period === 'week') result.period = period;
  if (typeof values.date === 'string' && isLocalDate(values.date)) result.date = values.date;
  for (const field of ['latestEnd', 'earliestStart'] as const) {
    const value = values[field];
    if (typeof value === 'string' && validTime.test(value)) result[field] = value;
  }
  for (const [field, minimum, maximum] of [
    ['childAge', 0, 17], ['partySize', 1, 30], ['budget', 0, 1_000_000],
    ['travelMinutes', 1, 240], ['cheaperThan', 0, 30_000_000], ['referencePrice', 0, 30_000_000],
  ] as const) {
    const value = values[field];
    if (typeof value === 'number' && (field === 'budget' || field === 'referencePrice' || field === 'cheaperThan' ? Number.isFinite(value) : Number.isInteger(value)) && value >= minimum && value <= maximum) result[field] = value;
  }
  for (const field of ['child', 'free'] as const) {
    if (typeof values[field] === 'boolean') result[field] = values[field];
  }
  if (Array.isArray(values.seenEventIds)) {
    result.seenEventIds = values.seenEventIds.slice(-100).filter((id): id is string =>
      typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id));
  }
  return result;
}

function mentionedCity(words: string, cities: string[]): string | undefined {
  const city = regionalCities.find(([_name, pattern]) => pattern.test(words))?.[0];
  return city ?? cities.find(name => (' ' + words + ' ').includes(' ' + normalizeText(name) + ' '));
}

export function constraintIssue(message: string): string | undefined {
  const words = normalizeText(message);
  const party = /(?:на|для) (\d+) (?:человек|взрослых|гостей|билет)/u.exec(words);
  if (party && (Number(party[1]) < 1 || Number(party[1]) > 30)) {
    return 'На сколько человек искать? Укажите число от 1 до 30.';
  }
  const travel = /(?:ехать|дорог[аиу]|поездк[аиу]|добраться)[^\d.!?]{0,30}(\d{1,3})\s*мин/iu.exec(message);
  if (travel && (Number(travel[1]) < 1 || Number(travel[1]) > 240)) {
    return 'Укажите предел поездки от 1 до 240 минут.';
  }
  const time = /(?:не позже|не позднее|после|не раньше)\s+(\d{1,2}):(\d{2})/iu.exec(message);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59)) {
    return 'Проверьте время. Например, «после 18:00» или «до 20:00».';
  }
  const date = /\b\d{4}-\d{2}-\d{2}\b/u.exec(message)?.[0];
  if (date && !isLocalDate(date)) return 'Такой даты нет. Какой день выбрать?';
}

export function readIntent(message: string, previous: DiscoveryContext, cities: string[], now: Date): DiscoveryContext {
  const text = message.toLowerCase().replaceAll('ё', 'е').replace(/[\u00a0\u202f]/g, ' ');
  const origin = /(?:едем от|поедем от|выезжаем от|отправляемся от|точка отправления\s*:|откуда\s*:)\s*([^!?\n]{2,120})/u.exec(text);
  const words = normalizeText(origin ? text.slice(0, origin.index) : message);
  const today = localDate(now);
  const fresh = /^(?:новый поиск|начнем заново|сначала)(?:\s|$)/u.test(words);
  const context = fresh ? {} : { ...previous };
  const explicitCity = /(?:^|[,.;])\s*город\s*:\s*([\p{L}-]+(?:[ -][\p{L}-]+){0,3})\s*(?=$|[,.;!?])/iu.exec(message)?.[1];
  const city = mentionedCity(words, cities) ?? explicitCity;
  if (city) {
    if (context.city && context.city !== city) delete context.origin;
    context.city = city;
  }
  if (/любой город|в любом городе|вся республика/u.test(words)) {
    delete context.city;
    delete context.origin;
  }

  const category = Object.entries(categoryPatterns).find(([_category, pattern]) => pattern.test(words))?.[0];
  if (category) {
    context.category = category as DiscoveryContext['category'];
    delete context.query;
  }
  if (/любая категория|любые события/u.test(words)) delete context.category;

  let date = /\b\d{4}-\d{2}-\d{2}\b/.exec(text)?.[0];
  const namedDay = new RegExp(`(?:^|\\D)(\\d{1,2})\\s+(${months.join('|')})(?:\\s+(\\d{4}))?`, 'u').exec(text);
  if (namedDay) {
    const month = String(months.indexOf(namedDay[2]) + 1).padStart(2, '0');
    date = `${namedDay[3] ?? today.slice(0, 4)}-${month}-${namedDay[1].padStart(2, '0')}`;
    if (!namedDay[3] && date < today) date = `${Number(today.slice(0, 4)) + 1}${date.slice(4)}`;
  }
  const weekday = weekdays.findIndex(day => (' ' + words + ' ').includes(' ' + day + ' '));
  if (!date && weekday >= 0) {
    const current = new Date(today + 'T00:00:00Z').getUTCDay();
    const distance = (weekday - current + 7) % 7;
    date = localDay(today, distance + (/следующ/u.test(words) && distance === 0 ? 7 : 0));
  }
  const period = /послезавтра/u.test(words) ? undefined : /завтра/u.test(words) ? 'tomorrow' :
    /сегодня|сегодняшн/u.test(words) ? 'today' : /выходны/u.test(words) ? 'weekend' :
    /эту неделю|на (?:этой |ближайшей )?неделе|семь дней|7 дней/u.test(words) ? 'week' : undefined;
  if (isLocalDate(date ?? '') || /послезавтра/u.test(words)) {
    context.date = date && isLocalDate(date) ? date : localDay(today, 2);
    delete context.period;
  } else if (period) {
    context.date = period === 'today' ? today : period === 'tomorrow' ? localDay(today, 1) : undefined;
    context.period = period;
  } else if (/в любой день|любые даты|без даты/u.test(words)) {
    delete context.date;
    delete context.period;
  }

  const age = /(?:^|\s)(\d{1,2})\s*(?:лет|года|год)(?=\s|$)/u.exec(words);
  if (/ребен|ребят|дет(?:и|ей|ям|ьми|ск)|семейн|школьник/u.test(words)) context.child = true;
  if (age && Number(age[1]) <= 17 && (context.child || /^(?:ему |ей )?\d{1,2} (?:лет|год|года)$/u.test(words))) {
    context.child = true;
    const range = /от (\d{1,2}) до (\d{1,2}) (?:лет|год|года)/u.exec(words);
    context.childAge = range ? Math.min(Number(range[1]), Number(range[2])) : Number(age[1]);
  }
  if (/без детей|только взросл/u.test(words)) {
    delete context.child;
    delete context.childAge;
  }

  const party = /(?:на|для)\s+(двоих|троих|четверых|пятерых|шестерых|\d{1,2})(?=\s|$)/u.exec(words);
  const people: Record<string, number> = { двоих: 2, троих: 3, четверых: 4, пятерых: 5, шестерых: 6 };
  if (party) context.partySize = people[party[1]] ?? Number(party[1]);
  if (/на одного|за человека|на человека|за билет/u.test(words)) context.partySize = 1;

  const thousands = /(\d+(?:[.,]\d+)?)\s*(?:тыс(?:яч[аи]?)?\.?|к)(?=\s*(?:₽|руб|р\.|на |за |[,!?]|$))/u.exec(text);
  const rubles = /(?<![\d.,])(\d[\d ]{0,10}(?:[.,]\d{1,2})?)\s*(?:₽|руб(?:лей|ля|ль)?|р\.?)(?=[\s.,?!]|$)/u.exec(text);
  const bareBudget = /(?:до|бюджет)\s+(\d[\d ]{0,9})(?=\s+(?:на\s+(?:двоих|троих|четверых|одного|человека|\d)|за\s+(?:человека|билет))|$)/u.exec(text);
  const budget = thousands ? Number(thousands[1].replace(',', '.')) * 1000 :
    rubles || bareBudget ? Number((rubles?.[1] ?? bareBudget?.[1] ?? '').replaceAll(' ', '').replace(',', '.')) : undefined;
  if (budget !== undefined) {
    context.budget = budget;
    context.free = budget === 0;
    delete context.cheaperThan;
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

  const ending = /(?:не позже|не позднее|законч(?:илось|иться|атся|ится)\s+(?:к|до)|окончание\s+до)\s*(\d{1,2})(?::([0-5]\d))?/u.exec(text);
  const starting = /(?:после|не раньше|начало с)\s+(\d{1,2})(?::([0-5]\d)|\s*час(?:ов|а)?|(?=[\s,.!?]|$)(?!\s+[\p{L}]))/u.exec(text);
  if (ending) context.latestEnd = `${ending[1].padStart(2, '0')}:${ending[2] ?? '00'}`;
  if (starting) context.earliestStart = `${starting[1].padStart(2, '0')}:${starting[2] ?? '00'}`;
  if (/вечером/u.test(words) && !starting) context.earliestStart = '17:00';
  if (/любое время|без ограничений по времени/u.test(words)) {
    delete context.latestEnd;
    delete context.earliestStart;
  }

  const travel = /(?:ехать|дорог[аиу]|поездк[аиу]|добраться)[^\d.!?]{0,30}(\d{1,3})\s*мин/u.exec(text)
    ?? /(\d{1,3})\s*мин(?:ут[уы]?)?\s*(?:езды|на дорогу)/u.exec(text);
  if (travel) context.travelMinutes = Number(travel[1]);
  if (origin) context.origin = message.slice(origin.index + origin[0].length - origin[1].length, origin.index + origin[0].length).replace(/[,.;]+$/, '').trim();
  if (/без учета дороги|без учета времени в пути|без ограничения на дорогу/u.test(words)) {
    delete context.travelMinutes;
    delete context.origin;
  }

  const quoted = /[«"]([^»"]{2,100})[»"]/u.exec(message)?.[1];
  const namedInterest = /(?:^|\s)(джаз|рок|опера|стендап|классическая музыка)(?=\s|$)/u.exec(words)?.[1];
  if (quoted || namedInterest) context.query = quoted ?? namedInterest;
  if (!context.query && /(?:^|\s)(?:куда|что|где|найди|покажи|ищу|есть)(?:\s|$)/u.test(words)) {
    const explicit = /(?:^|\s)(?:найди|покажи|ищу)\s+([^,.!?]{2,100})/iu.exec(message)?.[1]?.trim();
    if (explicit && !city && !category && !date && !period && !age && !budget && !travel &&
        !/^(?:мне|что|любые|интересн|события|мероприятия|варианты)/iu.test(explicit)) context.query = explicit;
  }
  const requestWords = /куда|пойти|сходить|что|найди|покажи|есть|афиша|посоветуй|подбер|предложи|событи|мероприяти|подешевле|дешевле|еще|ближе|без |люб(?:ая|ое|ой|ые)|начнем заново|сначала|новый поиск/u;
  if (!requestWords.test(words) && !city && !category && !date && !period && !age && !budget && !travel && !origin &&
    !starting && !ending && !party && !/бесплатн/u.test(words) && words.length > 1 && words.length <= 100) {
    context.query = message.trim();
  }
  return cleanContext(context);
}
