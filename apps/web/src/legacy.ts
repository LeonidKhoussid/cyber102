import type { FastifyInstance } from 'fastify';
import { categories, publicUrl } from './catalog.ts';
import type { Catalog, CatalogEvent, EventPage } from './catalog.ts';
import { FilterError, localDate, parseFilters } from './filters.ts';
import type { QueryValues } from './filters.ts';

const siteName = 'Афиша Башкортостана';
const timeZone = 'Asia/Yekaterinburg';
const formatDate = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU', { ...options, timeZone });
const issueDate = formatDate({ day: 'numeric', month: 'long', year: 'numeric' });
const dayNumber = formatDate({ day: 'numeric' });
const monthName = formatDate({ month: 'long' });
const weekday = formatDate({ weekday: 'long' });
const longDate = formatDate({ day: 'numeric', month: 'long', weekday: 'long', year: 'numeric' });
const hourAndMinute = formatDate({ hour: '2-digit', minute: '2-digit' });
const priceAmount = new Intl.NumberFormat('ru-RU');
const eventCount = new Intl.PluralRules('ru-RU');
const countNouns = { one: 'событие', few: 'события', many: 'событий', other: 'события', zero: 'событий', two: 'события' };
const periods = [
  ['all', 'Все даты'], ['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['week', 'Неделя'],
] as const;
const filterKeys = ['q', 'city', 'venue', 'category', 'period', 'date', 'from', 'until', 'maxPrice', 'age', 'sort', 'limit'];
const removableFilters = [
  { keys: ['q'], label: 'Убрать поисковый запрос' },
  { keys: ['city'], label: 'Показать все города' },
  { keys: ['venue'], label: 'Показать все площадки' },
  { keys: ['category'], label: 'Показать все категории' },
  { keys: ['period', 'date', 'from', 'until'], label: 'Показать все даты' },
  { keys: ['maxPrice'], label: 'Убрать ограничение цены' },
  { keys: ['age'], label: 'Убрать фильтр по возрасту' },
];
const htmlCharacters: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? '').replace(/[&<>"']/g, character => htmlCharacters[character]);
}

function cleanQuery(query: QueryValues): QueryValues {
  return Object.fromEntries(filterKeys.flatMap(key => {
    const value = query[key];
    return typeof value === 'string' && value.trim() ? [[key, value.trim()]] : [];
  }));
}

function filterUrl(path: string, query: QueryValues, overrides: QueryValues): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...overrides })) {
    if (value) params.set(key, value);
  }
  return escapeHtml(params.size ? `${path}?${params}` : path);
}

function document(title: string, content: string, variant: 'home' | 'inner' | 'widget' = 'inner'): string {
  const now = new Date();
  const brand = variant === 'home'
    ? `<h1 class="masthead-title">${siteName}</h1>`
    : `<a class="masthead-title" href="/">${siteName}</a>`;
  const masthead = `<header class="masthead">
    <div class="masthead-line">
      <span>Республика Башкортостан</span>
      <time datetime="${localDate(now)}">${issueDate.format(now)}</time>
    </div>
    ${brand}
  </header>`;
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/tokens.css">
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body class="${variant}">
  <div class="shell">
    ${variant === 'widget' ? '' : `<a class="skip-link" href="#main">К содержанию</a>${masthead}`}
    <main id="main">${content}</main>
    ${variant === 'widget' ? '' : `<footer class="footer">
      <span>${siteName} · Прототип</span>
      <nav aria-label="Сервис"><a href="/widget">Виджет</a><a href="/docs">API</a></nav>
    </footer>`}
  </div>
</body>
</html>`;
}

function options(values: readonly (readonly [string, string])[], current?: string): string {
  return values.map(([value, label]) =>
    `<option value="${escapeHtml(value)}"${value === (current ?? '') ? ' selected' : ''}>${escapeHtml(label)}</option>`,
  ).join('');
}

function selectField(label: string, name: string, values: readonly (readonly [string, string])[], current?: string): string {
  const choices = current && !values.some(([value]) => value === current) ? [...values, [current, current] as const] : values;
  return `<label><span>${label}</span><select name="${name}">${options(choices, current)}</select></label>`;
}

function filterForm(directory: ReturnType<Catalog['directories']>, query: QueryValues): string {
  const venues = [...new Set(directory.venues.map(venue => venue.name))].sort((first, second) => first.localeCompare(second, 'ru'));
  const showDetails = Boolean(query.venue || query.date || query.from || query.until || query.maxPrice || query.age || query.sort);
  const numericField = (name: string, label: string, max: number) =>
    `<label><span>${label}</span><input type="number" inputmode="numeric" name="${name}" min="0" max="${max}" value="${escapeHtml(query[name])}"></label>`;
  const hidden = ['period', 'from', 'until', 'limit'].map(key => query[key]
    ? `<input type="hidden" name="${key}" value="${escapeHtml(query[key])}">`
    : '').join('');
  return `<form class="filters" action="/" method="get" aria-label="Поиск событий">
    ${hidden}
    <div class="filters-primary">
      <label><span>Поиск по афише</span><input type="search" name="q" maxlength="100" value="${escapeHtml(query.q)}" placeholder="Название или артист"></label>
      ${selectField('Город', 'city', [['', 'Все города'], ...directory.cities.map(city => [city, city] as const)], query.city)}
      ${selectField('Категория', 'category', [['', 'Любая'], ...directory.categories.map(category => [category.id, category.label] as const)], query.category)}
      <button class="button" type="submit">Найти <span aria-hidden="true">↗</span></button>
    </div>
    <details class="filters-details"${showDetails ? ' open' : ''}>
      <summary>Другие фильтры</summary>
      <div class="filters-secondary">
        ${selectField('Площадка', 'venue', [['', 'Все площадки'], ...venues.map(venue => [venue, venue] as const)], query.venue)}
        <label><span>Дата</span><input type="date" name="date" value="${escapeHtml(query.date)}"></label>
        ${numericField('maxPrice', 'Цена до, ₽', 1_000_000)}
        ${numericField('age', 'Возраст зрителя', 120)}
        ${selectField('Сортировка', 'sort', [['', 'По дате'], ['price', 'По цене']], query.sort === 'date' ? '' : query.sort)}
      </div>
      <button class="apply-filters" type="submit">Применить фильтры</button>
    </details>
  </form>`;
}

function periodNav(query: QueryValues): string {
  const current = query.date || query.from || query.until ? undefined : query.period ?? 'all';
  return `<nav class="periods" aria-label="Даты событий">${periods.map(([key, label]) =>
    `<a href="${filterUrl('/', query, { period: key === 'all' ? undefined : key, date: undefined, from: undefined, until: undefined })}"${key === current ? ' aria-current="true"' : ''}>${label}</a>`,
  ).join('')}</nav>`;
}

function priceLabel(event: CatalogEvent): string {
  const { priceMin, priceMax } = event;
  if (priceMin === undefined) return priceMax === undefined ? 'Цена не указана' : `до ${priceAmount.format(priceMax)} ₽`;
  if (priceMin === 0 && (priceMax === undefined || priceMax === 0)) return 'Бесплатно';
  if (priceMax === undefined) return `от ${priceAmount.format(priceMin)} ₽`;
  if (priceMin === priceMax) return `${priceAmount.format(priceMin)} ₽`;
  return `${priceAmount.format(priceMin)}–${priceAmount.format(priceMax)} ₽`;
}

function eventUrl(event: CatalogEvent): string {
  return `/events/${encodeURIComponent(event.id)}`;
}

function eventRow(event: CatalogEvent, embedded: boolean, currentYear: string): string {
  const startsAt = new Date(event.startsAt);
  const localStartsAt = escapeHtml(event.startsAt);
  const eventYear = localDate(startsAt).slice(0, 4);
  return `<li class="event-row">
    <time class="event-calendar" datetime="${localStartsAt}">
      <span class="event-day">${dayNumber.format(startsAt)}</span>
      <span>${monthName.format(startsAt)}</span>
      ${eventYear === currentYear ? '' : `<span>${eventYear}</span>`}
      <span class="event-weekday">${weekday.format(startsAt)}</span>
    </time>
    <div class="event-main">
      <p class="event-category">${escapeHtml(categories[event.category])}${event.ageLimit === undefined ? '' : ` <span>${escapeHtml(event.ageLimit)}+</span>`}</p>
      <h3><a href="${eventUrl(event)}"${embedded ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(event.title)}</a></h3>
      <p class="event-venue">${escapeHtml(event.city)} <span aria-hidden="true">·</span> ${escapeHtml(event.venue)}</p>
    </div>
    <div class="event-facts">
      <time datetime="${localStartsAt}">${hourAndMinute.format(startsAt)}</time>
      <span>${escapeHtml(priceLabel(event))}</span>
    </div>
    <span class="event-arrow" aria-hidden="true">↗</span>
  </li>`;
}

function pagination(path: string, listing: EventPage, query: QueryValues): string {
  const totalPages = Math.max(1, Math.min(10_000, Math.ceil(listing.total / listing.limit)));
  if (totalPages === 1 && listing.page === 1) return '';
  const link = (label: string, page: number, rel?: string) =>
    `<a href="${filterUrl(path, query, { page: String(page) })}"${rel ? ` rel="${rel}"` : ''}>${label}</a>`;
  if (listing.page > totalPages) {
    return `<nav class="pagination" aria-label="Страницы событий">${link('К первой странице', 1)}</nav>`;
  }
  return `<nav class="pagination" aria-label="Страницы событий">
    ${listing.page > 1 ? link('← Назад', listing.page - 1, 'prev') : '<span></span>'}
    <span>${listing.page} из ${totalPages}</span>
    ${listing.page < totalPages ? link('Далее →', listing.page + 1, 'next') : '<span></span>'}
  </nav>`;
}

function emptyState(catalog: Catalog, path: string, listing: EventPage, query: QueryValues): string {
  if (listing.total) return '<p>На этой странице нет событий.</p>';
  const candidates = removableFilters.filter(filter => filter.keys.some(key => query[key])).map(filter => ({
    ...filter,
    query: Object.fromEntries(Object.entries(query).filter(([key]) => !filter.keys.includes(key))),
  }));
  const candidate = candidates.find(filter => catalog.search({ ...parseFilters(filter.query), limit: 1 }).total) ?? candidates[0];
  if (!candidate) return '<p>В афише пока нет предстоящих событий.</p>';
  const reset = Object.keys(candidate.query).length ? `<a href="${path}">Сбросить фильтры</a>` : '';
  return `<p>Попробуйте изменить параметры поиска.</p>
    <a href="${filterUrl(path, candidate.query, {})}">${candidate.label}</a>
    ${reset}`;
}

function results(catalog: Catalog, path: string, listing: EventPage, query: QueryValues, embedded = false): string {
  const count = `${priceAmount.format(listing.total)} ${countNouns[eventCount.select(listing.total)]}`;
  const currentYear = localDate(new Date()).slice(0, 4);
  return `<section class="results" aria-labelledby="results-title">
    <div class="results-heading">
      <h2 id="results-title">${embedded ? 'События' : 'Ближайшие события'}</h2>
      <span>${count}</span>
    </div>
    ${listing.events.length ? `<ul class="event-list">${listing.events.map(event => eventRow(event, embedded, currentYear)).join('')}</ul>`
      : `<div class="notice"><h3>События не найдены</h3>
        ${emptyState(catalog, path, listing, query)}
      </div>`}
    ${pagination(path, listing, query)}
  </section>`;
}

function eventDetail(event: CatalogEvent): string {
  const startsAt = new Date(event.startsAt);
  const ticket = event.status === 'published' && publicUrl(event.ticketUrl);
  const image = publicUrl(event.imageUrl);
  const sources = event.sources.flatMap(source => {
    const url = publicUrl(source.url);
    if (!url) return [];
    const checked = source.verifiedAt
      ? `<span>Проверено <time datetime="${escapeHtml(source.verifiedAt)}">${issueDate.format(new Date(source.verifiedAt))}</time></span>`
      : '';
    return [`<li><a href="${escapeHtml(url)}">${escapeHtml(source.name)}</a>${checked}</li>`];
  });
  const end = event.endsAt && new Date(event.endsAt);
  const endLabel = end && (localDate(end) === localDate(startsAt) ? hourAndMinute.format(end) : `${longDate.format(end)}, ${hourAndMinute.format(end)}`);
  return `<a class="back-link" href="/">← К афише</a>
  <article class="detail">
    <p class="event-category">${escapeHtml(categories[event.category])}${event.ageLimit === undefined ? '' : ` <span>${escapeHtml(event.ageLimit)}+</span>`}</p>
    <h1>${escapeHtml(event.title)}</h1>
    ${event.status === 'cancelled' ? '<p class="cancelled">Событие отменено</p>' : ''}
    <div class="detail-layout">
      <dl class="event-details">
        <div><dt>Когда</dt><dd><time datetime="${escapeHtml(event.startsAt)}">${longDate.format(startsAt)}, ${hourAndMinute.format(startsAt)}</time>${endLabel ? ` — <time datetime="${escapeHtml(event.endsAt)}">${endLabel}</time>` : ''}</dd></div>
        <div><dt>Где</dt><dd>${escapeHtml(event.city)} · ${escapeHtml(event.venue)}${event.address ? `<br>${escapeHtml(event.address)}` : ''}</dd></div>
        <div><dt>Вход</dt><dd>${escapeHtml(priceLabel(event))}</dd></div>
        ${event.language ? `<div><dt>Язык</dt><dd>${escapeHtml(event.language)}</dd></div>` : ''}
      </dl>
      <div class="detail-body">
        ${image ? `<img class="event-image" src="${escapeHtml(image)}" alt="Афиша события" loading="lazy">` : ''}
        ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ''}
        ${ticket ? `<a class="button" href="${escapeHtml(ticket)}">К билетам <span aria-hidden="true">↗</span></a>` : ''}
        ${sources.length ? `<section class="event-sources"><h2>Источники</h2><ul>${sources.join('')}</ul></section>` : ''}
      </div>
    </div>
  </article>`;
}

const apiDocs = `<a class="back-link" href="/">← К афише</a>
<article class="docs">
  <h1>API афиши</h1>
  <p>Публичные данные доступны в JSON без авторизации.</p>
  <dl>
    <div><dt><a href="/api/v1/events?limit=3">GET /api/v1/events</a></dt><dd>Поиск предстоящих событий по датам, городу, площадке, категории, цене и возрасту зрителя.</dd></div>
    <div><dt><code>GET /api/v1/events/{id}</code></dt><dd>Карточка события, включая статус и источники.</dd></div>
    <div><dt><a href="/api/v1/directories">GET /api/v1/directories</a></dt><dd>Города, площадки и категории.</dd></div>
  </dl>
  <a class="button" href="/openapi.json">OpenAPI JSON <span aria-hidden="true">↗</span></a>
  <h2>Виджет</h2>
  <p>Страницу <a href="/widget">/widget</a> можно встроить через iframe. Она поддерживает параметры поиска из спецификации.</p>
</article>`;

export function registerWeb(server: FastifyInstance, catalog: Catalog) {
  for (const path of ['/', '/widget']) {
    const embedded = path === '/widget';
    server.get(path, (request, reply) => {
      const rawQuery = request.query as QueryValues;
      const query = cleanQuery(rawQuery);
      const variant = embedded ? 'widget' : 'home';
      reply.type('text/html; charset=utf-8');
      try {
        const filters = parseFilters(rawQuery);
        const listing = catalog.search(filters);
        if (embedded) {
          return reply.send(document(siteName, `<h1 class="widget-title">${siteName}</h1>${results(catalog, path, listing, query, true)}`, variant));
        }
        return reply.send(document(siteName, `${filterForm(catalog.directories(), query)}
          <div class="catalog-tools">${periodNav(query)}${Object.keys(query).length ? '<a class="reset-link" href="/">Сбросить</a>' : ''}</div>
          ${results(catalog, path, listing, query)}`, variant));
      } catch (error) {
        if (!(error instanceof FilterError)) throw error;
        return reply.code(400).send(document(siteName, `${embedded ? `<h1 class="widget-title">${siteName}</h1>` : ''}<div class="notice" role="alert">
          <h2>Проверьте фильтры</h2><p>${escapeHtml(error.message)}</p><a href="${path}">Сбросить фильтры</a>
        </div>`, variant));
      }
    });
  }

  server.get<{ Params: { id: string } }>('/events/:id', (request, reply) => {
    const event = catalog.getEvent(request.params.id);
    reply.type('text/html; charset=utf-8');
    if (!event) {
      return reply.code(404).send(document(`Событие не найдено · ${siteName}`,
        '<div class="notice"><h1>Событие не найдено</h1><a href="/">К афише</a></div>'));
    }
    return reply.send(document(`${event.title} · ${siteName}`, eventDetail(event)));
  });

  server.get('/docs', (_request, reply) => reply.type('text/html; charset=utf-8').send(document(`API · ${siteName}`, apiDocs)));
}
