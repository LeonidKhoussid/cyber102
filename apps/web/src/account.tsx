import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { DiscoveryResponse } from '@afisha/contracts';
import { request } from './http.ts';
import { Icon } from './ui.tsx';

export type Account = { id: string; email?: string; name: string };
export type Session = { user: Account | null; telegramEnabled: boolean };
export type Chat = { id: string; title: string; createdAt: string; updatedAt: string };
export type SavedTurn = { requestId: string; message: string; response: DiscoveryResponse; createdAt: string };
export type ChatAction = { chat: Chat; type: 'rename' | 'delete' };

export const authPath = '/api/v1/auth';
export const chatsPath = '/api/v1/chats';

export function jsonBody(method: string, value: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

export function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function Dialog({ children, className, labelledBy, onClose }: { children: ReactNode; className: string; labelledBy: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className={className} aria-labelledby={labelledBy} onCancel={event => {
    event.preventDefault();
    onClose();
  }} onClick={event => {
    if (event.target === event.currentTarget) onClose();
  }}>{children}</dialog>;
}

export type AuthMode = 'login' | 'register';

export function AuthDialog({ mode, telegramEnabled, telegramIssue, onMode, onClose, onSignedIn }: {
  mode: AuthMode; telegramEnabled: boolean; telegramIssue?: string; onMode: (mode: AuthMode) => void;
  onClose: () => void; onSignedIn: (session: Session) => void;
}) {
  const [error, setError] = useState(telegramIssue);
  const [busy, setBusy] = useState(false);
  const register = mode === 'register';
  const nameField = useRef<HTMLInputElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  useEffect(() => { (register ? nameField : emailField).current?.focus(); }, [register]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const email = String(form.get('email')).trim();
      const password = String(form.get('password'));
      const name = String(form.get('name') ?? '').trim();
      if (register && !name) {
        setError('Укажите имя.');
        return;
      }
      onSignedIn(await request<Session>(authPath + '/' + mode, jsonBody('POST', {
        email, password, ...(register ? { name } : {}),
      })));
    } catch (error) {
      setError(errorText(error, 'Не удалось войти.'));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="account-dialog" labelledBy="account-title" onClose={() => { if (!busy) onClose(); }}>
    <div className="dialog-content">
      <header className="dialog-header">
        <span className="brand-icon"><Icon name="mark" /></span>
        <button type="button" className="icon-button" aria-label="Закрыть" disabled={busy} onClick={onClose}><Icon name="close" /></button>
      </header>
      <h2 id="account-title">{register ? 'Создать аккаунт' : 'Войти в Афишу'}</h2>
      <p className="dialog-copy">Сохраняйте поиски и продолжайте с того же места.</p>
      <form className="account-form" onSubmit={event => void submit(event)}>
        {register && <label>Имя<input ref={nameField} type="text" name="name" maxLength={80} autoComplete="name" required disabled={busy} /></label>}
        <label>Электронная почта<input ref={emailField} type="email" name="email" maxLength={254} autoComplete="email" required disabled={busy} /></label>
        <label>Пароль<input type="password" name="password" minLength={register ? 8 : undefined} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} required disabled={busy} /></label>
        {register && <p className="field-hint">Не менее 8 символов.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Подождите…' : register ? 'Зарегистрироваться' : 'Войти'}</button>
      </form>
      {telegramEnabled ? busy
        ? <button className="header-link telegram-link" type="button" disabled><Icon name="telegram" />Продолжить с Telegram</button>
        : <a className="header-link telegram-link" href={authPath + '/telegram/start'}><Icon name="telegram" />Продолжить с Telegram</a>
        : <p className="field-hint telegram-note">Вход через Telegram пока недоступен.</p>}
      <p className="account-switch">
        {register ? 'Уже есть аккаунт?' : 'Впервые здесь?'}
        <button type="button" className="text-link" disabled={busy} onClick={() => {
          onMode(register ? 'login' : 'register');
          setError(undefined);
        }}>{register ? 'Войти' : 'Создать аккаунт'}</button>
      </p>
    </div>
  </Dialog>;
}

const mobileSidebar = () => window.matchMedia('(max-width: 850px)');
function subscribeToSidebar(callback: () => void) {
  const query = mobileSidebar();
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

export function useMobileSidebar() {
  return useSyncExternalStore(subscribeToSidebar, () => mobileSidebar().matches);
}

export function ChatSidebar({ account, chats, chatId, loading, error, signingOut, mobile, onClose, onNew, onSelect, onAction, onRetry, onLogout }: {
  account: Account; chats: Chat[]; chatId?: string; loading: boolean; error?: string; signingOut: boolean; mobile: boolean;
  onClose: () => void; onNew: () => void; onSelect: (id: string) => void; onAction: (action: ChatAction) => void;
  onRetry: () => void; onLogout: () => void;
}) {
  const content = <div className="history-sidebar">
    <div className="history-top">
      <button className="history-new" type="button" onClick={onNew}><Icon name="plus" />Новый поиск</button>
      {mobile && <button className="icon-button" type="button" aria-label="Закрыть историю" onClick={onClose}><Icon name="close" /></button>}
    </div>
    <nav className="history-nav" aria-labelledby="history-title">
      <h2 id="history-title">История поиска</h2>
      {loading && <p className="history-note" role="status">Загружаем историю…</p>}
      {error && <div className="history-note" role="alert">{error} <button className="text-link" type="button" onClick={onRetry}>Повторить</button></div>}
      {!loading && !error && !chats.length && <p className="history-note">Здесь появятся ваши поиски.</p>}
      {chats.length > 0 && <ul className="history-list">
        {chats.map(chat => <li className="history-item" key={chat.id} data-active={chatId === chat.id ? 'true' : undefined}>
          <button className="history-open" type="button" aria-current={chatId === chat.id ? 'true' : undefined} title={chat.title} onClick={() => onSelect(chat.id)}>
            <Icon name="chat" /><span>{chat.title}</span>
          </button>
          <div className="history-actions">
            <button className="icon-button" type="button" title="Переименовать" aria-label={'Переименовать поиск: ' + chat.title} onClick={() => onAction({ chat, type: 'rename' })}><Icon name="edit" /></button>
            <button className="icon-button" type="button" title="Удалить" aria-label={'Удалить поиск: ' + chat.title} onClick={() => onAction({ chat, type: 'delete' })}><Icon name="trash" /></button>
          </div>
        </li>)}
      </ul>}
    </nav>
    <div className="history-account">
      <span className="history-avatar" aria-hidden="true">{[...account.name.trim()][0]?.toLocaleUpperCase('ru') || 'А'}</span>
      <div className="history-identity">
        <strong title={account.name}>{account.name}</strong>
        {account.email && <span title={account.email}>{account.email}</span>}
      </div>
      <button className="icon-button" type="button" aria-label="Выйти" title="Выйти" disabled={signingOut} onClick={onLogout}><Icon name="logout" /></button>
    </div>
  </div>;
  return mobile
    ? <Dialog className="history-drawer" labelledBy="history-title" onClose={onClose}>{content}</Dialog>
    : <aside className="history-rail">{content}</aside>;
}

export function ChatActionDialog({ action, onClose, onSave }: { action: ChatAction; onClose: () => void; onSave: (title?: string) => Promise<void> }) {
  const [title, setTitle] = useState(action.chat.title);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const rename = action.type === 'rename';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (rename && !title.trim())) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(rename ? title.trim() : undefined);
    } catch (error) {
      setError(errorText(error, 'Не удалось обновить поиск.'));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="account-dialog" labelledBy="chat-action-title" onClose={() => { if (!busy) onClose(); }}>
    <form className="dialog-content account-form" onSubmit={event => void submit(event)}>
      <h2 id="chat-action-title">{rename ? 'Переименовать поиск' : 'Удалить поиск?'}</h2>
      {rename ? <label>Название поиска<input name="title" required maxLength={80} value={title} onChange={event => setTitle(event.currentTarget.value)} disabled={busy} /></label>
        : <p className="dialog-copy">«{action.chat.title}» и все сообщения в нём будут удалены.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-buttons">
        <button type="button" className="header-link" disabled={busy} onClick={onClose}>Отмена</button>
        <button type="submit" className={rename ? 'primary' : 'primary destructive'} disabled={busy || (rename && !title.trim())}>
          {busy ? 'Подождите…' : rename ? 'Сохранить' : 'Удалить'}
        </button>
      </div>
    </form>
  </Dialog>;
}
