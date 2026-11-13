import { categories, isLocalDate } from './catalog.ts';
import type { Category, EventFilters } from './catalog.ts';

const localDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' });

export function localDate(now: Date): string {
  return localDateFormatter.format(now);
}

export function localDay(date: string, offset = 0): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

const localMidnight = (date: string) => new Date(`${date}T00:00:00+05:00`).toISOString();

export function datePeriod(period: string, now = new Date()): Pick<EventFilters, 'from' | 'until'> {
  const today = localDate(now);
  if (period === 'today') return { from: localMidnight(today), until: localMidnight(localDay(today, 1)) };
  if (period === 'tomorrow') return { from: localMidnight(localDay(today, 1)), until: localMidnight(localDay(today, 2)) };
  if (period === 'week') return { from: localMidnight(today), until: localMidnight(localDay(today, 7)) };
  if (period === 'weekend') {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const saturday = localDay(today, weekday === 0 ? -1 : 6 - weekday);
    return { from: localMidnight(saturday), until: localMidnight(localDay(saturday, 2)) };
  }
  if (isLocalDate(period)) return { from: localMidnight(period), until: localMidnight(localDay(period, 1)) };
  return {};
}

import type { QueryValues } from '@afisha/contracts';
export type { QueryValues } from '@afisha/contracts';

export class FilterError extends Error {}

export function parseFilters(query: QueryValues, now = new Date()): EventFilters {
  function textField(key: string, max: number): string | undefined {
    const value = query[key];
    if (value === undefined) return;
    if (typeof value !== 'string' || value.trim().length > max) throw new FilterError('Проверьте параметры поиска.');
    return value.trim() || undefined;
  }

  function numberField(key: string, min: number, max: number): number | undefined {
    const value = textField(key, 10);
    if (value === undefined) return;
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
      throw new FilterError('Введите число в допустимом диапазоне.');
    }
    return number;
  }

  const category = textField('category', 25);
  if (category && !Object.hasOwn(categories, category)) throw new FilterError('Неизвестная категория.');
  const period = textField('period', 10);
  const date = textField('date', 10);
  const from = textField('from', 10);
  const until = textField('until', 10);
  if ([date, from, until].some(value => value !== undefined && !isLocalDate(value))) {
    throw new FilterError('Введите дату в формате ГГГГ-ММ-ДД.');
  }
  if (period && !['today', 'tomorrow', 'weekend', 'week'].includes(period)) {
    throw new FilterError('Неизвестный период.');
  }
  if (from && until && from > until) throw new FilterError('Дата окончания должна быть не раньше даты начала.');
  const sort = textField('sort', 5);
  if (sort && sort !== 'date' && sort !== 'price') throw new FilterError('Неизвестная сортировка.');

  const dates = date ? datePeriod(date, now) : period ? datePeriod(period, now) : {
    from: from && localMidnight(from), until: until && localMidnight(localDay(until, 1)),
  };
  return {
    query: textField('q', 100), city: textField('city', 100), venue: textField('venue', 160),
    category: category as Category | undefined, ...dates, maxPrice: numberField('maxPrice', 0, 1_000_000),
    age: numberField('age', 0, 120), page: numberField('page', 1, 10_000), limit: numberField('limit', 1, 50),
    sort: sort === 'date' || sort === 'price' ? sort : undefined,
  };
}
