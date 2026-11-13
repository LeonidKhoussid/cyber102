import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type { Category, EventStatus, SourceEvent } from './catalog.ts';

function sourceRow(raw: unknown, type: 'import' | 'manual'): SourceEvent {
  const fields = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  function text(key: string): string | undefined {
    const value = fields[key];
    return typeof value === 'string' ? value.trim() || undefined : undefined;
  }
  function number(key: string): number | undefined {
    const value = fields[key];
    if (value === undefined || value === null || value === '') return;
    return typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()))
      ? Number(value) : Number.NaN;
  }
  const stableFields = [text('sourceUrl'), text('title'), text('startsAt'), text('venue')];
  return {
    sourceKey: text('sourceKey') ?? createHash('sha256').update(JSON.stringify(stableFields)).digest('hex'),
    title: text('title') ?? '', category: text('category') as Category, startsAt: text('startsAt') ?? '',
    endsAt: text('endsAt'), city: text('city') ?? '', venue: text('venue') ?? '', address: text('address'),
    description: text('description')?.slice(0, 3000), priceMin: number('priceMin'), priceMax: number('priceMax'),
    ageLimit: number('ageLimit'), language: text('language'), latitude: number('latitude'), longitude: number('longitude'),
    imageUrl: text('imageUrl'), ticketUrl: text('ticketUrl'), sourceUrl: text('sourceUrl') ?? '',
    sourceName: text('sourceName') ?? '', sourceType: type, status: (text('status') ?? 'draft') as EventStatus, raw,
  };
}

export function parseImport(body: unknown, type: 'import' | 'manual' = 'import'): SourceEvent[] {
  const rows: unknown = type === 'manual' ? [body] : typeof body === 'string'
    ? parse(body, { columns: true, bom: true, skip_empty_lines: true, max_record_size: 32_768 })
    : body;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) {
    throw new Error('Загрузите от 1 до 1000 записей.');
  }
  return rows.map(row => sourceRow(row, type));
}
