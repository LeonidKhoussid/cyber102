import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { categories } from '@afisha/contracts';
import type { CatalogEvent, Directories, DiscoveryResponse, EventPage } from '@afisha/contracts';
import './styles.css';

const siteName = 'Афиша Башкортостана';
const example = 'Куда пойти в субботу с ребёнком 8 лет в Стерлитамаке, до 1000 рублей на двоих, чтобы закончилось не позже 20:00 и ехать не больше 20 минут?';
const prompts = ['Какие выставки в Уфе на выходных?', 'Что бесплатного в Уфе на этой неделе?'];
const timeZone = 'Asia/Yekaterinburg';
const date = new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', weekday: 'short' });
const detailDate = new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' });
const localDay = new Intl.DateTimeFormat('sv-SE', { timeZone, day: 'numeric', month: 'numeric', year: 'numeric' });
const number = new Intl.NumberFormat('ru-RU');
const plural = new Intl.PluralRules('ru-RU');

const glyphs = {
  mark: 'M12 2v20M2 12h20M5 5l14 14M19 5 5 19',
  up: 'M12 19V5m-6 6 6-6 6 6',
  diagonal: 'M6 18 18 6M7 6h11v11',
  left: 'M20 12H4m6-6-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  grid: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v5m8-5v5',
  pin: 'M12 22s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  reply: 'M9 7 4 12l5 5m-5-5h11a5 5 0 0 1 5 5v2',
  quote: 'M9 6H5l-2 7v5h6v-6H5m16-6h-4l-2 7v5h6v-6h-4',
  refresh: 'M20 11a8 8 0 1 0-1.8 6M20 4v7h-7',
} as const;

function Icon({ name }: { name: keyof typeof glyphs }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={glyphs[name]} /></svg>;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const unavailable = 'Сервис временно недоступен. Попробуйте ещё раз.';
  const response = await fetch(url, options).catch(() => { throw new Error(unavailable); });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(body?.message ?? unavailable);
  }
  return response.json().catch(() => { throw new Error(unavailable); });
}

function useData<T>(url: string) {
  const [result, setResult] = useState<{ data?: T; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({});
    request<T>(url, { signal: controller.signal })
      .then(data => setResult({ data }))
      .catch(error => {
        if (!controller.signal.aborted) setResult({ error: error.message });
      });
    return () => controller.abort();
  }, [url, attempt]);
  return { ...result, retry: () => setAttempt(attempt + 1) };
}

function publicLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    return undefined;
  }
}

function price(event: CatalogEvent) {
  const { priceMin, priceMax } = event;
  if (priceMin === undefined) return priceMax === undefined ? 'Цена не указана' : `до ${number.format(priceMax)} ₽`;
  if (priceMin === 0 && (priceMax === undefined || priceMax === 0)) return 'Бесплатно';
  if (priceMax === undefined) return `от ${number.format(priceMin)} ₽`;
  if (priceMin === priceMax) return `${number.format(priceMin)} ₽`;
  return `${number.format(priceMin)}–${number.format(priceMax)} ₽`;
}

function EventTime({ event, detailed = false }: { event: CatalogEvent; detailed?: boolean }) {
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : undefined;
  const format = detailed ? detailDate : date;
  return <>
    <time dateTime={event.startsAt}>{format.format(start)}, {time.format(start)}</time>
    {end && <> — <time dateTime={event.endsAt}>{localDay.format(start) !== localDay.format(end) && `${format.format(end)}, `}{time.format(end)}</time></>}
  </>;
}

function Sources({ event, detailed = false }: { event: CatalogEvent; detailed?: boolean }) {
  const sources = event.sources.flatMap(source => {
    const url = publicLink(source.url);
    return url ? [{ ...source, url }] : [];
  });
  if (!sources.length) return null;
  return <div className={detailed ? 'sources detail-sources' : 'sources'}>
    {detailed ? <h2>Источники</h2> : <span>Источники</span>}
    <ul>{sources.map(source => <li key={source.url}>
      <a href={source.url} target="_blank" rel="noreferrer">{source.name} <Icon name="diagonal" /></a>
      {detailed && source.verifiedAt && <small>Проверено <time dateTime={source.verifiedAt}>{detailDate.format(new Date(source.verifiedAt))}</time></small>}
    </li>)}</ul>
  </div>;
}

function EventCard({ event, reasons, embedded }: { event: CatalogEvent; reasons?: string[]; embedded?: boolean }) {
  const ticket = publicLink(event.ticketUrl);
  return <article className="event-card">
    <div className="event-heading">
      <div>
        <p className="event-category">{categories[event.category]}{event.ageLimit !== undefined && <span>{event.ageLimit}+</span>}</p>
        <h3><a href={`/events/${encodeURIComponent(event.id)}`} target={embedded ? '_blank' : undefined} rel={embedded ? 'noreferrer' : undefined}>{event.title} <Icon name="diagonal" /></a></h3>
      </div>
      <span className="event-price">{price(event)}</span>
    </div>
    <div className="event-facts">
      <div><Icon name="calendar" /><span><EventTime event={event} /></span></div>
      <div><Icon name="pin" /><span>{event.city} · {event.venue}</span></div>
    </div>
    {reasons && reasons.length > 0 && <ul className="reasons">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    {reasons && <Sources event={event} />}
    {reasons && ticket && <a className="text-link ticket-link" href={ticket} target="_blank" rel="noreferrer">К билетам <Icon name="diagonal" /></a>}
  </article>;
}

function Shell({ children, discovery = false, reset }: { children: ReactNode; discovery?: boolean; reset?: () => void }) {
  return <div className={discovery ? 'shell shell-discovery' : 'shell'}>
    <a className="skip-link" href="#main">К содержанию</a>
    <header className="site-header">
      <a className="brand" href="/" aria-label={siteName}><span className="brand-icon"><Icon name="mark" /></span><span>Афиша<span className="brand-region"> Башкортостана</span></span></a>
      <nav aria-label="Основная навигация" className="header-nav">
        {reset && <button type="button" className="text-link new-chat" aria-label="Новый поиск" onClick={reset}><Icon name="plus" /><span>Новый поиск</span></button>}
        <a className="header-link" href={discovery ? '/catalog' : '/'}><Icon name={discovery ? 'grid' : 'reply'} />{discovery ? 'Все события' : 'Поиск'}</a>
      </nav>
    </header>
    {children}
    <footer className="site-footer">
      <span>Афиша Башкортостана · Прототип</span>
      <nav aria-label="Сервис"><a href="/widget">Виджет</a><a href="/docs">API</a></nav>
    </footer>
  </div>;
}

type Turn = { message: string; answer?: DiscoveryResponse; error?: string };
const conversationKey = 'afisha.discovery.v1';

function savedTurns(): Turn[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(conversationKey) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function Answer({ answer, fill, active }: { answer: DiscoveryResponse; fill: (suggestion: string) => void; active: boolean }) {
  return <>
    <div className="answer-label"><span className="answer-mark"><Icon name="mark" /></span>
      <span>{answer.status === 'matches' ? 'Подборка событий' : answer.status === 'clarify' ? 'Нужно уточнение' : 'События не найдены'}</span>
    </div>
    <p className="answer-message">{answer.message}</p>
    {answer.constraints.length > 0 && <dl className="constraints" aria-label="Учтённые условия">{answer.constraints.map(({ label, value }) =>
      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {answer.events.length > 0 && <ul className="event-list">{answer.events.map(({ event, reasons }) =>
      <li key={event.id}><EventCard event={event} reasons={reasons} /></li>)}</ul>}
    {active && answer.suggestions.length > 0 && <div className="suggestions" aria-label="Варианты продолжения">{answer.suggestions.map(suggestion =>
      <button className="prompt-chip" key={suggestion} type="button" onClick={() => fill(suggestion)}><Icon name="reply" />{suggestion}</button>)}</div>}
  </>;
}

function Discovery() {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>(savedTurns);
  const controller = useRef<AbortController | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const lastQuestion = useRef<HTMLElement>(null);
  const inChat = turns.length > 0;
  const pending = inChat && !turns.at(-1)?.answer && !turns.at(-1)?.error;
  const count = turns.length;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    try {
      sessionStorage.setItem(conversationKey, JSON.stringify(turns.filter(turn => turn.answer || turn.error)));
    } catch {
      // The conversation still works in memory when storage is unavailable.
    }
  }, [turns]);
  useEffect(() => {
    if (count > 0) lastQuestion.current?.scrollIntoView({ block: 'start' });
  }, [count]);

  function fill(value: string) {
    setDraft(value);
    field.current?.focus();
  }

  function reset() {
    controller.current?.abort();
    controller.current = null;
    setTurns([]);
    fill('');
    window.scrollTo({ top: 0 });
  }

  async function send(message: string, retry = false) {
    const cleaned = message.trim();
    if (!cleaned || controller.current) return;
    const context = turns.findLast(turn => turn.answer)?.answer?.context;
    const active = new AbortController();
    controller.current = active;
    setTurns(previous => [...(retry ? previous.slice(0, -1) : previous), { message: cleaned }]);
    if (!retry) setDraft('');
    try {
      const answer = await request<DiscoveryResponse>('/api/v1/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cleaned, context }),
        signal: active.signal,
      });
      if (!active.signal.aborted) setTurns(previous => [...previous.slice(0, -1), { message: cleaned, answer }]);
    } catch (error) {
      if (!active.signal.aborted) setTurns(previous => [...previous.slice(0, -1), {
        message: cleaned,
        error: error instanceof Error ? error.message : 'Не удалось получить ответ.',
      }]);
    } finally {
      if (controller.current === active) controller.current = null;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft);
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return <Shell discovery reset={inChat ? reset : undefined}>
    <main id="main" className={inChat ? 'discovery conversation' : 'discovery welcome'}>
      {!inChat ? <div className="welcome-heading">
        <div className="sky" aria-hidden="true"><i /><i /><i /><i /></div>
        <h1>Куда пойдём<span>?</span></h1>
        <p>Спросите, что посмотреть и куда сходить в Башкортостане.</p>
      </div> : <>
        <h1 className="sr-only">Поиск событий</h1>
        <div className="transcript" role="log" aria-label="Диалог о событиях">
          {turns.map(({ message, answer, error }, index) => {
            const last = index === count - 1;
            return <section className="turn" key={index} ref={last ? lastQuestion : undefined} aria-label={`Запрос ${index + 1}`}>
              <p className="question"><span className="sr-only">Ваш вопрос </span>{message}</p>
              {answer && <div className="answer"><Answer answer={answer} fill={fill} active={last} /></div>}
              {error && <div className="notice" role="alert"><p>{error}</p>{last && <button type="button" className="prompt-chip" onClick={() => void send(message, true)}><Icon name="refresh" />Повторить</button>}</div>}
              {!answer && !error && <p className="loading" role="status"><span className="spinner" />Ищу события…</p>}
            </section>;
          })}
        </div>
      </>}
      <div className="composer-area">
        <form className="composer" aria-label="Поиск по вопросу" onSubmit={submit}>
          <label className="sr-only" htmlFor="question">{inChat ? 'Продолжить поиск' : 'Ваш вопрос'}</label>
          <textarea id="question" ref={field} placeholder={inChat ? 'Уточните условия или задайте новый вопрос…' : 'Например, куда сходить с ребёнком в субботу?'} value={draft} maxLength={1200}
            onChange={event => setDraft(event.currentTarget.value)} onKeyDown={handleKey} rows={2} />
          <div className="composer-tools">
            {!inChat && <span className="composer-hint"><Icon name="mark" />Город, дата, бюджет — всё в одном вопросе</span>}
            <button className="send" type="submit" aria-label="Отправить вопрос" disabled={!draft.trim() || pending}>
              {pending ? <span className="spinner" /> : <Icon name="up" />}
            </button>
          </div>
        </form>
      </div>
      {!inChat && <section className="examples" aria-labelledby="examples-heading">
        <h2 id="examples-heading">Попробуйте спросить</h2>
        <button type="button" className="feature-prompt" onClick={() => fill(example)}>
          <span className="prompt-icon"><Icon name="quote" /></span>
          <span>{example}</span>
          <Icon name="diagonal" />
        </button>
        <div className="suggestions">{prompts.map(prompt =>
          <button className="prompt-chip" key={prompt} type="button" onClick={() => fill(prompt)}><Icon name="diagonal" />{prompt}</button>)}</div>
      </section>}
    </main>
  </Shell>;
}

const periods = [['', 'Все даты'], ['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['week', 'Неделя']] as const;
const filterKeys = ['q', 'city', 'venue', 'category', 'period', 'date', 'from', 'until', 'maxPrice', 'age', 'sort', 'limit', 'page'];
const emptyDirectory: Directories = { cities: [], categories: [], venues: [] };

function filterLink(path: string, params: URLSearchParams, changes: Record<string, string>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next.size ? `${path}?${next}` : path;
}

function Select({ label, name, value, options }: { label: string; name: string; value: string; options: readonly (readonly [string, string])[] }) {
  const [selected, setSelected] = useState(value);
  const choices = selected && !options.some(([id]) => id === selected) ? [...options, [selected, selected] as const] : options;
  return <label>{label}<select name={name} value={selected} onChange={event => setSelected(event.currentTarget.value)}>
    {choices.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
  </select></label>;
}

function Filters({ params }: { params: URLSearchParams }) {
  const { data = emptyDirectory, error, retry } = useData<Directories>('/api/v1/directories');
  const value = (key: string) => params.get(key) ?? '';
  const venues = [...new Set(data.venues.map(venue => venue.name))].sort((first, second) => first.localeCompare(second, 'ru'));
  return <>
    <form className="filters" action="/catalog" method="get" aria-label="Фильтры каталога">
      {['period', 'from', 'until', 'limit'].map(key => value(key) && <input key={key} type="hidden" name={key} value={value(key)} />)}
      <div className="filter-row">
        <label>Поиск по афише<input type="search" name="q" placeholder="Название или артист" maxLength={100} defaultValue={value('q')} /></label>
        <Select label="Город" name="city" value={value('city')} options={[[ '', 'Все города' ], ...data.cities.map(city => [city, city] as const)]} />
        <Select label="Категория" name="category" value={value('category')} options={[[ '', 'Любая' ], ...data.categories.map(category => [category.id, category.label] as const)]} />
        <button className="primary" type="submit">Найти</button>
      </div>
      <details open={['venue', 'date', 'from', 'until', 'maxPrice', 'age', 'sort'].some(key => value(key)) || undefined}>
        <summary>Другие фильтры</summary>
        <div className="filter-row more-filters">
          <Select label="Площадка" name="venue" value={value('venue')} options={[[ '', 'Все площадки' ], ...venues.map(venue => [venue, venue] as const)]} />
          <label>Дата<input type="date" name="date" defaultValue={value('date')} /></label>
          <label>Цена до, ₽<input type="number" name="maxPrice" min={0} max={1_000_000} defaultValue={value('maxPrice')} /></label>
          <label>Возраст зрителя<input type="number" name="age" min={0} max={120} defaultValue={value('age')} /></label>
          <Select label="Сортировка" name="sort" value={value('sort') === 'date' ? '' : value('sort')} options={[[ '', 'По дате' ], [ 'price', 'По цене' ]]} />
        </div>
        <button className="prompt-chip" type="submit">Применить фильтры</button>
      </details>
    </form>
    {error && <Notice text="Не удалось загрузить варианты фильтров." retry={retry} />}
    <div className="catalog-tools">
      <nav aria-label="Даты событий" className="periods">{periods.map(([id, label]) => <a key={id}
        href={filterLink('/catalog', params, { period: id, date: '', from: '', until: '', page: '' })}
        aria-current={!['date', 'from', 'until'].some(key => value(key)) && (value('period') === id || (!id && value('period') === 'all')) ? 'true' : undefined}>{label}</a>)}</nav>
      {params.size > 0 && <a className="text-link" href="/catalog">Сбросить</a>}
    </div>
  </>;
}

function Notice({ text, retry }: { text: string; retry?: () => void }) {
  return <div className="notice" role="alert"><p>{text}</p>{retry && <button className="prompt-chip" type="button" onClick={retry}><Icon name="refresh" />Повторить</button>}</div>;
}

function Listing({ embedded = false }: { embedded?: boolean }) {
  const path = embedded ? '/widget' : '/catalog';
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of [...params]) if (!filterKeys.includes(key) || !value.trim()) params.delete(key);
  const { data, error, retry } = useData<EventPage>(`/api/v1/events?${params}`);
  const totalPages = data ? Math.max(1, Math.min(10_000, Math.ceil(data.total / data.limit))) : 1;
  const pageLink = (page: number) => filterLink(path, params, { page: String(page) });
  const content = <main id="main" className={embedded ? 'inner widget' : 'inner listing'}>
    <h1>{embedded ? siteName : 'Все события'}</h1>
    {!embedded && <Filters params={params} />}
    {error ? <><Notice text={error} retry={retry} /><a className="text-link" href={path}>Сбросить фильтры</a></> : data ? <section aria-label="Результаты поиска">
      <p className="result-count">{number.format(data.total)} {({ one: 'событие', few: 'события', many: 'событий', other: 'событий', zero: 'событий', two: 'события' })[plural.select(data.total)]}</p>
      {data.events.length > 0 ? <ul className="event-list">{data.events.map(event => <li key={event.id}><EventCard event={event} embedded={embedded} /></li>)}</ul> :
        <div className="notice"><h2>События не найдены</h2><p>{data.total ? 'На этой странице нет событий.' : params.size ? 'Попробуйте изменить параметры поиска.' : 'В афише пока нет предстоящих событий.'}</p>{params.size > 0 && <a className="text-link" href={path}>Сбросить фильтры</a>}</div>}
      {(totalPages > 1 || data.page > totalPages) && <nav className="pagination" aria-label="Страницы событий">
        {data.page > totalPages ? <a href={pageLink(1)}>К первой странице</a> : <>
          {data.page > 1 && <a rel="prev" href={pageLink(data.page - 1)}>← Назад</a>}
          <span>{data.page} из {totalPages}</span>
          {data.page < totalPages && <a rel="next" href={pageLink(data.page + 1)}>Далее →</a>}
        </>}
      </nav>}
    </section> : <p className="loading" role="status"><span className="spinner" />Загружаю события…</p>}
  </main>;
  return embedded ? content : <Shell>{content}</Shell>;
}

function Detail({ id }: { id: string }) {
  const { data: event, error, retry } = useData<CatalogEvent>(`/api/v1/events/${id}`);
  const ticket = event?.status === 'published' ? publicLink(event.ticketUrl) : undefined;
  const image = publicLink(event?.imageUrl);
  useEffect(() => { if (event) document.title = `${event.title} · ${siteName}`; }, [event]);
  return <Shell><main id="main" className="inner detail">
    <a className="back-link" href="/catalog"><Icon name="left" /> Все события</a>
    {error ? <Notice text={error} retry={retry} /> : event ? <article>
      <p className="event-category">{categories[event.category]}{event.ageLimit !== undefined && <span>{event.ageLimit}+</span>}</p>
      <h1>{event.title}</h1>
      {event.status === 'cancelled' && <p className="notice">Событие отменено</p>}
      <div className="detail-layout">
        <dl className="detail-facts">
          <div><dt>Когда</dt><dd><EventTime event={event} detailed /></dd></div>
          <div><dt>Где</dt><dd>{event.city} · {event.venue}{event.address && <><br />{event.address}</>}</dd></div>
          <div><dt>Вход</dt><dd>{price(event)}</dd></div>
          {event.language && <div><dt>Язык</dt><dd>{event.language}</dd></div>}
        </dl>
        <div className="detail-body">
          {image && <img className="event-image" src={image} alt="" loading="lazy" />}
          {event.description && <p className="description">{event.description}</p>}
          {ticket && <a className="primary" href={ticket} target="_blank" rel="noreferrer">К билетам <Icon name="diagonal" /></a>}
          <Sources event={event} detailed />
        </div>
      </div>
    </article> : <p className="loading" role="status"><span className="spinner" />Загружаю событие…</p>}
  </main></Shell>;
}

function Docs() {
  return <Shell><main id="main" className="inner docs">
    <h1>API афиши</h1>
    <p>Публичные данные доступны в JSON без авторизации.</p>
    <dl className="detail-facts">
      <div><dt><a href="/api/v1/events?limit=3">GET /api/v1/events</a></dt><dd>Поиск предстоящих событий по датам, городу, площадке, категории, цене и возрасту зрителя.</dd></div>
      <div><dt><code>GET /api/v1/events/{'{id}'}</code></dt><dd>Карточка события со статусом и источниками.</dd></div>
      <div><dt><a href="/api/v1/directories">GET /api/v1/directories</a></dt><dd>Города, площадки и категории.</dd></div>
      <div><dt><code>POST /api/v1/discover</code></dt><dd>Поиск событий по вопросу на русском языке с уточнениями в диалоге.</dd></div>
    </dl>
    <a className="primary" href="/openapi.json">OpenAPI JSON <Icon name="diagonal" /></a>
    <h2>Виджет</h2>
    <p>Страницу <a className="text-link" href="/widget">/widget</a> можно встроить через iframe. Она поддерживает параметры поиска из спецификации.</p>
  </main></Shell>;
}

function App() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const event = path.match(/^\/events\/([^/]+)$/);
  if (event) return <Detail id={event[1]} />;
  if (path === '/docs') return <Docs />;
  if (path === '/widget') return <Listing embedded />;
  const params = new URLSearchParams(window.location.search);
  if (path === '/catalog' || (path === '/' && filterKeys.some(key => params.has(key)))) return <Listing />;
  if (path === '/') return <Discovery />;
  return <Shell><main id="main" className="inner"><h1>Страница не найдена</h1><a className="back-link" href="/"><Icon name="left" /> К поиску</a></main></Shell>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
