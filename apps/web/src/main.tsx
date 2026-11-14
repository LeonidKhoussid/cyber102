import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { filterKeys, Listing } from './catalog.tsx';
import { Discovery } from './discovery.tsx';
import { Detail } from './events.tsx';
import { Icon, Shell } from './ui.tsx';
import './styles.css';

const Admin = lazy(() => import('./admin.tsx').then(module => ({ default: module.Admin })));

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
  if (path === '/admin') return <Suspense fallback={<Shell><main id="main" className="inner"><p role="status">Загружаем управление…</p></main></Shell>}><Admin /></Suspense>;
  if (path === '/docs') return <Docs />;
  if (path === '/widget') return <Listing embedded />;
  const params = new URLSearchParams(window.location.search);
  if (path === '/catalog' || (path === '/' && filterKeys.some(key => params.has(key)))) return <Listing />;
  if (path === '/' || path === '/login' || path === '/register') return <Discovery />;
  return <Shell><main id="main" className="inner"><h1>Страница не найдена</h1><a className="back-link" href="/"><Icon name="left" /> К поиску</a></main></Shell>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
