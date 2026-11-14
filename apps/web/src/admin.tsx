import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { categories } from '@afisha/contracts';
import type { CatalogEvent, EventPage, EventStatus } from '@afisha/contracts';
import { EventTime } from './events.tsx';
import { request } from './http.ts';
import { Notice, Shell } from './ui.tsx';
import './admin.css';

const eventsPath = '/api/v1/admin/events';
const statuses = { draft: 'Черновик', published: 'Опубликовано', cancelled: 'Отменено' } as const;
type ImportReport = { added: number; updated: number; unchanged: number; rejected: { row: number; reason: string }[] };

function adminRequest<Result>(token: string, path: string, options: { method?: string; body?: string; contentType?: string; signal?: AbortSignal } = {}) {
  const { contentType, ...init } = options;
  return request<Result>(path, {
    ...init, redirect: 'error', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос.';
}

function StatusOptions() {
  return Object.entries(statuses).map(([status, label]) => <option key={status} value={status}>{label}</option>);
}

export function Admin() {
  const [token, setToken] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState('');

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = String(new FormData(event.currentTarget).get('token') ?? '').trim();
    if (!secret || unlocking) return;
    setUnlocking(true);
    setError('');
    try {
      await adminRequest<EventPage>(secret, `${eventsPath}?limit=1`);
      setToken(secret);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setUnlocking(false);
    }
  }

  return <Shell><main id="main" className="inner admin">
    <h1>Управление афишей</h1>
    {token ? <AdminCatalog token={token} onLock={() => setToken('')} /> : <form className="admin-panel account-form" onSubmit={unlock}>
      <label>Токен администратора<input name="token" type="password" autoComplete="off" required disabled={unlocking} /></label>
      {error && <Notice text={error} />}
      <button className="primary" type="submit" disabled={unlocking}>{unlocking ? 'Проверяем…' : 'Открыть управление'}</button>
    </form>}
  </main></Shell>;
}

function AdminCatalog({ token, onLock }: { token: string; onLock: () => void }) {
  const [filters, setFilters] = useState({ query: '', status: '', page: 1 });
  const [result, setResult] = useState<EventPage>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [report, setReport] = useState<ImportReport>();

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ q: filters.query, page: String(filters.page) });
    if (filters.status) params.set('status', filters.status);
    setLoading(true);
    setListError('');
    void adminRequest<EventPage>(token, `${eventsPath}?${params}`, { signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted) setResult(data);
      }).catch(error => {
        if (!controller.signal.aborted) setListError(errorMessage(error));
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, filters, revision]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setReport(undefined);
    try {
      await action();
      setRevision(value => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function importFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get('file');
    if (!(file instanceof File) || !file.size) return;
    void perform(async () => {
      const contentType = /\.json$/iu.test(file.name) ? 'application/json' : /\.csv$/iu.test(file.name) ? 'text/csv' : '';
      if (!contentType) throw new Error('Выберите файл CSV или JSON.');
      if (file.size > 1_048_576) throw new Error('Файл должен быть не больше 1 МБ.');
      setReport(await adminRequest<ImportReport>(token, '/api/v1/admin/import', { method: 'POST', body: await file.text(), contentType }));
      form.reset();
    });
  }

  function addEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    const body = JSON.stringify({ ...fields, startsAt: `${fields.startsAt}:00+05:00`,
      endsAt: fields.endsAt ? `${fields.endsAt}:00+05:00` : undefined });
    void perform(async () => {
      setReport(await adminRequest<ImportReport>(token, eventsPath, { method: 'POST', body, contentType: 'application/json' }));
      form.reset();
    });
  }

  function updateStatus(event: FormEvent<HTMLFormElement>, entry: CatalogEvent) {
    event.preventDefault();
    const status = new FormData(event.currentTarget).get('status');
    if (status === entry.status) return;
    void perform(async () => {
      const response = await adminRequest<{ status: EventStatus }>(token, `${eventsPath}/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH', body: JSON.stringify({ status }), contentType: 'application/json',
      });
      setNotice(`«${entry.title}» · ${statuses[response.status]}`);
    });
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFilters({ query: String(form.get('query') ?? '').trim(), status: String(form.get('status') ?? ''), page: 1 });
  }

  return <div className="admin-content">
    <button type="button" className="header-link" onClick={onLock}>Закрыть доступ</button>
    {error && <Notice text={error} />}
    {notice && <p className="notice" role="status">{notice}</p>}
    {report && <div className="notice" role="status">
      <p>Добавлено {report.added} · Обновлено {report.updated} · Без изменений {report.unchanged} · Отклонено {report.rejected.length}</p>
      {report.rejected.length > 0 && <details><summary>Причины отклонения</summary><ul>{report.rejected.map(({ row, reason }) => <li key={row}>Строка {row} · {reason}</li>)}</ul></details>}
    </div>}
    <details className="admin-panel">
      <summary>Добавить событие</summary>
      <form className="account-form" onSubmit={addEvent}>
        <label>Название<input name="title" required maxLength={500} /></label>
        <div className="admin-fields">
          <label>Город<input name="city" required maxLength={500} /></label>
          <label>Площадка<input name="venue" required maxLength={500} /></label>
          <label>Начало (UTC+5)<input name="startsAt" type="datetime-local" required /></label>
          <label>Окончание (UTC+5)<input name="endsAt" type="datetime-local" /></label>
          <label>Категория<select name="category" defaultValue="other">{Object.entries(categories).map(([category, label]) => <option key={category} value={category}>{label}</option>)}</select></label>
          <label>Статус<select name="status" defaultValue="draft"><StatusOptions /></select></label>
          <label>Цена от, ₽<input name="priceMin" type="number" min="0" step="0.01" /></label>
          <label>Возрастное ограничение<input name="ageLimit" type="number" min="0" max="21" /></label>
          <label>Источник<input name="sourceName" required maxLength={500} /></label>
          <label>Ссылка на источник<input name="sourceUrl" type="url" required /></label>
          <label>Адрес<input name="address" /></label>
          <label>Ссылка на билеты<input name="ticketUrl" type="url" /></label>
        </div>
        <label>Описание<textarea name="description" rows={3} maxLength={3000} /></label>
        <button type="submit" className="primary" disabled={busy}>Сохранить событие</button>
      </form>
    </details>
    <details className="admin-panel">
      <summary>Импорт CSV или JSON</summary>
      <form className="account-form" onSubmit={importFile}>
        <label>Файл до 1 МБ<input type="file" name="file" accept=".csv,.json" required /></label>
        <button type="submit" className="primary" disabled={busy}>Импортировать</button>
      </form>
    </details>
    <section aria-labelledby="admin-events-heading" className="admin-content">
      <h2 id="admin-events-heading">События</h2>
      <form className="account-form admin-search" onSubmit={search}>
        <label>Название<input name="query" type="search" maxLength={100} /></label>
        <label>Статус<select name="status"><option value="">Все статусы</option><StatusOptions /></select></label>
        <button type="submit" className="primary">Найти</button>
      </form>
      {listError ? <Notice text={listError} retry={() => setRevision(value => value + 1)} /> : loading ? <p role="status">Загружаем события…</p> :
        result && <>
          {result.events.length ? <ul className="event-list">{result.events.map(entry => <li key={`${entry.id}:${entry.status}`} className="event-card admin-event">
            <div><h3>{entry.title}</h3><p><EventTime event={entry} /> · {entry.city} · {entry.venue}</p></div>
            <form onSubmit={event => updateStatus(event, entry)} className="admin-status">
              <select name="status" defaultValue={entry.status} aria-label={`Статус события «${entry.title}»`}><StatusOptions /></select>
              <button type="submit" className="header-link" aria-label={`Обновить статус «${entry.title}»`} disabled={busy}>Обновить</button>
            </form>
          </li>)}</ul> : <p>События не найдены.</p>}
          {result.total > result.limit && <nav className="pagination" aria-label="Страницы событий">
            <button type="button" className="header-link" disabled={result.page <= 1} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>Назад</button>
            <span>{result.page} из {Math.ceil(result.total / result.limit)}</span>
            <button type="button" className="header-link" disabled={result.page * result.limit >= result.total} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>Далее</button>
          </nav>}
        </>}
    </section>
  </div>;
}
