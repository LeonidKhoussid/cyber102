import { useState } from 'react';
import type { Directories, EventPage } from '@afisha/contracts';
import { EventCard } from './events.tsx';
import { useData } from './http.ts';
import { Notice, Shell, siteName } from './ui.tsx';

const number = new Intl.NumberFormat('ru-RU');
const plural = new Intl.PluralRules('ru-RU');
const periods = [['', 'Все даты'], ['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['week', 'Неделя']] as const;
export const filterKeys = ['q', 'city', 'venue', 'category', 'period', 'date', 'from', 'until', 'maxPrice', 'age', 'sort', 'limit', 'page'];
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

export function Listing({ embedded = false }: { embedded?: boolean }) {
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
