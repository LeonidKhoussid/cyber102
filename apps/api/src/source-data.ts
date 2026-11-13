import { load } from 'cheerio';
import type { SourceEvent } from './catalog.ts';

export type SourceResult = { name: string; events: SourceEvent[]; rejected: number; error?: string };
const ufaOffset = '+05:00';

export type RecordValue = Record<string, unknown>;

export function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

export function clean(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || undefined : undefined;
}

export function plainHtml(value: unknown): string {
  if (typeof value !== 'string') return '';
  const html = load(value);
  html('script, style').remove();
  html('br, p, li, h2, h3').append(' ');
  return clean(html.root().text()) ?? '';
}

export function safeUrl(value: unknown, origin?: string): URL | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, origin);
    if (url.protocol === 'https:' && !url.username && !url.password && (!origin || url.origin === origin)) return url;
  } catch {
    return;
  }
}

export function publicPage(value: unknown, origin: string, path: RegExp): URL | undefined {
  const url = safeUrl(value, origin);
  if (url && !url.search && !url.hash && path.test(url.pathname)) return url;
}

export function inUfa(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const date = value.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!date || !Number.isFinite(Date.parse(value))) return;
  if (new Date(date[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== date[1]) return;
  return new Date(Date.parse(value) + 5 * 60 * 60 * 1000).toISOString().replace(/(?:\.000)?Z$/, ufaOffset);
}

export function numberBetween(value: unknown, lower: number, upper: number): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return;
  const result = Number(value);
  return result >= lower && result <= upper && Number.isFinite(result) ? result : undefined;
}

export function category(value: string): SourceEvent['category'] {
  if (/фестивал|Festival/i.test(value)) return 'festival';
  if (/кино|ScreeningEvent/i.test(value)) return 'cinema';
  if (/экскурси|Tour/i.test(value)) return 'tour';
  if (/театр|спектакл|балет|опера|мюзикл|TheaterEvent/i.test(value)) return 'theatre';
  if (/выставк|экспозици|ExhibitionEvent/i.test(value)) return 'exhibition';
  if (/концерт|MusicEvent/i.test(value)) return 'concert';
  return 'other';
}

const cancelledNotice = /^(?:официально )?(?:отмен[её]н[ао]?|отменяется|не состоится)(?=$|[\s.!?,:;—–])/i;
const postponedNotice = /^(?:официально )?(?:перен[её]с[её]н[ао]?|переносится|отложен[ао]?)(?=$|[\s.!?,:;—–])/i;

export function eventNotice(title: string, ...texts: string[]): SourceEvent['status'] {
  const genericSubjects = ['данное мероприятие', 'мероприятие', 'концерт', 'спектакль', 'фестиваль', 'показ', 'событие', 'выставка'];
  const names = [title, ...(title.match(/«[^»]+»/g) ?? [])].flatMap((name) => [name, 'концерт ' + name, 'спектакль ' + name]);
  const subjects = [...names, ...genericSubjects].map((subject) => subject.toLowerCase());
  let status: SourceEvent['status'] = 'published';
  for (const text of texts) {
    for (const sentence of text.split(/(?:[.!?]+\s+|\n+)/)) {
      const statement = sentence.trim().replace(/^(?:(?:внимание|важно|к сожалению)\s*[:!,–—]\s*)+/i, '').toLowerCase();
      const subject = subjects.find((candidate) => statement.startsWith(candidate + ' '));
      const predicate = subject ? statement.slice(subject.length).trim() : statement;
      if (cancelledNotice.test(predicate)) return 'cancelled';
      if (postponedNotice.test(predicate)) status = 'draft';
    }
  }
  return status;
}

function isEventNode(node: RecordValue) {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some(type => typeof type === 'string' && /^(?:https?:\/\/schema\.org\/)?[A-Za-z]*Event$/.test(type));
}

export function structuredData(html: ReturnType<typeof load>, match: (node: RecordValue) => boolean = isEventNode): RecordValue[] {
  const events: RecordValue[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = record(value);
    if (match(node)) {
      events.push(node);
      return;
    }
    visit(node['@graph']);
    visit(node.itemListElement);
    visit(node.item);
  }
  html('script[type="application/ld+json"]').each((_index, element) => {
    try { visit(JSON.parse(html(element).html() ?? '')); } catch { /* Ignore unrelated malformed JSON-LD scripts. */ }
  });
  return events;
}
