import type { ReactNode } from 'react';

export const siteName = 'Афиша Башкортостана';

const glyphs = {
  mark: 'M12 2v20M2 12h20M5 5l14 14M19 5 5 19',
  up: 'M12 19V5m-6 6 6-6 6 6',
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 10v1a7 7 0 0 0 14 0v-1m-7 8v4m-3 0h6',
  stop: 'M7 7h10v10H7z',
  diagonal: 'M6 18 18 6M7 6h11v11',
  left: 'M20 12H4m6-6-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  grid: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v5m8-5v5',
  pin: 'M12 22s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  reply: 'M9 7 4 12l5 5m-5-5h11a5 5 0 0 1 5 5v2',
  quote: 'M9 6H5l-2 7v5h6v-6H5m16-6h-4l-2 7v5h6v-6h-4',
  refresh: 'M20 11a8 8 0 1 0-1.8 6M20 4v7h-7',
  panel: 'M3 5h18v14H3zM9 5v14',
  close: 'M6 6l12 12M18 6 6 18',
  chat: 'M21 4H3v13h5l4 4v-4h9z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m12-12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
  logout: 'M10 17l5-5-5-5m5 5H3m10-8h7v16h-7',
  edit: 'm5 15-1 5 5-1L20 8l-4-4zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5',
  telegram: 'm2.5 10 19-7-3.5 17-6-4-3.5 3v-5l8-7-10 5z',
} as const;

export function Icon({ name }: { name: keyof typeof glyphs }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={glyphs[name]} /></svg>;
}

export function Shell({ children, discovery = false, headerStart, headerActions }: { children: ReactNode; discovery?: boolean; headerStart?: ReactNode; headerActions?: ReactNode }) {
  return <div className={discovery ? 'shell shell-discovery' : 'shell'}>
    <a className="skip-link" href="#main">К содержанию</a>
    <header className="site-header">
      <div className="header-start">{headerStart}<a className="brand" href="/" aria-label={siteName}><span className="brand-icon"><Icon name="mark" /></span><span>Афиша<span className="brand-region"> Башкортостана</span></span></a></div>
      <nav aria-label="Основная навигация" className="header-nav">
        <a className="header-link" href={discovery ? '/catalog' : '/'}><Icon name={discovery ? 'grid' : 'reply'} />{discovery ? 'Все события' : 'Поиск'}</a>
        {headerActions}
      </nav>
    </header>
    {children}
    <footer className="site-footer">
      <span>Афиша Башкортостана · Прототип</span>
      <nav aria-label="Сервис"><a href="/widget">Виджет</a><a href="/docs">API</a></nav>
    </footer>
  </div>;
}

export function Notice({ text, retry }: { text: string; retry?: () => void }) {
  return <div className="notice" role="alert"><p>{text}</p>{retry && <button className="prompt-chip" type="button" onClick={retry}><Icon name="refresh" />Повторить</button>}</div>;
}
