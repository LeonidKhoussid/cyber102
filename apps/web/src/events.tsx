import { useEffect } from 'react';
import { categories } from '@afisha/contracts';
import type { CatalogEvent } from '@afisha/contracts';
import { useData } from './http.ts';
import { Icon, Notice, Shell, siteName } from './ui.tsx';

const timeZone = 'Asia/Yekaterinburg';
const date = new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', weekday: 'short' });
const detailDate = new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' });
const localDay = new Intl.DateTimeFormat('sv-SE', { timeZone, day: 'numeric', month: 'numeric', year: 'numeric' });
const number = new Intl.NumberFormat('ru-RU');

export function publicLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    return undefined;
  }
}

export function price(event: CatalogEvent) {
  const { priceMin, priceMax } = event;
  if (priceMin === undefined) return priceMax === undefined ? 'Цена не указана' : `до ${number.format(priceMax)} ₽`;
  if (priceMin === 0 && (priceMax === undefined || priceMax === 0)) return 'Бесплатно';
  if (priceMax === undefined) return `от ${number.format(priceMin)} ₽`;
  if (priceMin === priceMax) return `${number.format(priceMin)} ₽`;
  return `${number.format(priceMin)}–${number.format(priceMax)} ₽`;
}

export function EventTime({ event, detailed = false }: { event: CatalogEvent; detailed?: boolean }) {
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : undefined;
  const format = detailed ? detailDate : date;
  return <>
    <time dateTime={event.startsAt}>{format.format(start)}, {time.format(start)}</time>
    {end && <> — <time dateTime={event.endsAt}>{localDay.format(start) !== localDay.format(end) && `${format.format(end)}, `}{time.format(end)}</time></>}
  </>;
}

export function Sources({ event, detailed = false }: { event: CatalogEvent; detailed?: boolean }) {
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

export function EventCard({ event, reasons, embedded }: { event: CatalogEvent; reasons?: string[]; embedded?: boolean }) {
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

export function Detail({ id }: { id: string }) {
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
