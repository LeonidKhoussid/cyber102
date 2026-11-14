import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { DiscoveryResponse } from '@afisha/contracts';
import { AuthDialog, authPath, ChatActionDialog, ChatSidebar, chatsPath, errorText, jsonBody, useMobileSidebar } from './account.tsx';
import type { AuthMode, Chat, ChatAction, SavedTurn, Session } from './account.tsx';
import { EventCard } from './events.tsx';
import { request } from './http.ts';
import { Icon, Notice, Shell } from './ui.tsx';
import { useVoice } from './voice.ts';

const example = 'Куда пойти в субботу с ребёнком 8 лет в Стерлитамаке, до 1000 рублей на двоих, чтобы закончилось не позже 20:00 и ехать не больше 20 минут?';
const prompts = ['Какие выставки в Уфе на выходных?', 'Что бесплатного в Уфе на этой неделе?'];

type Turn = { message: string; answer?: DiscoveryResponse; error?: string; requestId?: string };
type SavedExchange = { chat: Chat; turn: SavedTurn };
const conversationKey = 'afisha.discovery.v1';
const withTranscript = (draft: string, text: string) => [draft.trim(), text].filter(Boolean).join(' ').slice(0, 1200);
const urlChat = () => new URLSearchParams(window.location.search).get('chat') || undefined;
const telegramStatus = () => new URLSearchParams(window.location.search).get('telegram');
function authFromUrl(): AuthMode | undefined {
  const path = window.location.pathname.replace(/\/$/, '');
  if (path === '/register') return 'register';
  if (path === '/login' || ['denied', 'error'].includes(telegramStatus() ?? '')) return 'login';
}

function setChatUrl(id: string | undefined, replace = false) {
  if (urlChat() === id && telegramStatus() === null) return;
  const url = new URL(window.location.href);
  url.searchParams.delete('telegram');
  if (id) url.searchParams.set('chat', id);
  else url.searchParams.delete('chat');
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

function savedTurns(): Turn[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(conversationKey) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function Answer({ answer, selectSuggestion, active }: { answer: DiscoveryResponse; selectSuggestion: (suggestion: string) => void; active: boolean }) {
  const cards = answer.events.length ? answer.events : answer.alternatives ?? [];
  const hasAlternatives = Boolean(answer.alternatives?.length);
  return <>
    <div className="answer-label"><span className="answer-mark"><Icon name="mark" /></span>
      <span>{answer.status === 'matches' ? 'Подборка событий' : hasAlternatives ? 'Варианты без проверки дороги' : answer.status === 'clarify' ? 'Нужно уточнение' : 'События не найдены'}</span>
    </div>
    <p className="answer-message">{answer.message}</p>
    {answer.constraints.length > 0 && <dl className="constraints" aria-label="Учтённые условия">{answer.constraints.map(({ label, value }) =>
      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {cards.length > 0 && <ul className="event-list">{cards.map(({ event, reasons }) =>
      <li key={event.id}><EventCard event={event} reasons={reasons} /></li>)}</ul>}
    {active && answer.suggestions.length > 0 && <div className="suggestions" aria-label="Варианты продолжения">{answer.suggestions.map(suggestion =>
      <button className="prompt-chip" key={suggestion} type="button" onClick={() => selectSuggestion(suggestion)}><Icon name="reply" />{suggestion}</button>)}</div>}
  </>;
}

export function Discovery() {
  const [draft, setDraft] = useState('');
  const [guestTurns, setGuestTurns] = useState<Turn[]>(savedTurns);
  const [accountTurns, setAccountTurns] = useState<Turn[]>([]);
  const [session, setSession] = useState<Session>();
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [sessionError, setSessionError] = useState<string>();
  const [authMode, setAuthMode] = useState<AuthMode | undefined>(authFromUrl);
  const [telegramIssue, setTelegramIssue] = useState(() => {
    if (telegramStatus() === 'denied') return 'Вход через Telegram отменён.';
    if (telegramStatus() === 'error') return 'Не удалось войти через Telegram. Попробуйте ещё раз.';
  });
  const [signingOut, setSigningOut] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [chatId, setChatId] = useState<string>();
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string>();
  const [drawer, setDrawer] = useState(false);
  const [chatAction, setChatAction] = useState<ChatAction>();
  const user = session?.user;
  const mobile = useMobileSidebar();
  const turns = user ? accountTurns : guestTurns;
  const setTurns = user ? setAccountTurns : setGuestTurns;
  const controller = useRef<AbortController | null>(null);
  const openingChat = useRef<AbortController | null>(null);
  const sessionCheck = useRef<AbortController | null>(null);
  const savingChats = useRef(new Map<string, Promise<SavedExchange>>());
  const accountId = useRef<string | undefined>(undefined);
  const historyVersion = useRef(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const lastQuestion = useRef<HTMLElement>(null);
  const inChat = turns.length > 0;
  const pending = inChat && !turns.at(-1)?.answer && !turns.at(-1)?.error;
  const count = turns.length;
  const voice = useVoice(text => {
    setDraft(previous => withTranscript(previous, text));
    field.current?.focus();
  });
  const voiceBusy = voice.status !== 'idle';
  const recording = voice.status === 'recording';

  useEffect(() => () => {
    controller.current?.abort();
    openingChat.current?.abort();
  }, []);
  useEffect(() => {
    if (authFromUrl() === 'login' && telegramStatus() !== null) setAuthRoute('login', true);
    const goToAuth = () => {
      if (accountId.current && authFromUrl()) setAuthRoute(undefined, true);
      else setAuthMode(authFromUrl());
    };
    window.addEventListener('popstate', goToAuth);
    return () => window.removeEventListener('popstate', goToAuth);
  }, []);
  useEffect(() => {
    const active = new AbortController();
    sessionCheck.current = active;
    setCheckingSession(true);
    setSessionError(undefined);
    request<Session>(authPath + '/session', { signal: active.signal })
      .then(result => {
        if (active.signal.aborted) return;
        accountId.current = result.user?.id;
        setSession(result);
      })
      .catch(error => {
        if (!active.signal.aborted) setSessionError(errorText(error, 'Не удалось проверить вход.'));
      })
      .finally(() => {
        if (!active.signal.aborted) setCheckingSession(false);
      });
    return () => active.abort();
  }, [sessionAttempt]);
  useEffect(() => {
    try {
      sessionStorage.setItem(conversationKey, JSON.stringify(guestTurns.filter(turn => turn.answer || turn.error)));
    } catch {
      // The conversation still works in memory when storage is unavailable.
    }
  }, [guestTurns]);
  useEffect(() => {
    if (count > 0) lastQuestion.current?.scrollIntoView({ block: 'start' });
  }, [count, chatId]);
  useEffect(() => {
    if (!user) return;
    const active = new AbortController();
    const version = historyVersion.current;
    setHistoryLoading(true);
    setHistoryError(undefined);
    request<{ chats: Chat[] }>(chatsPath, { signal: active.signal })
      .then(result => {
        if (active.signal.aborted) return;
        if (version === historyVersion.current) setChats(result.chats);
        else setHistoryAttempt(previous => previous + 1);
      })
      .catch(error => {
        if (!active.signal.aborted) setHistoryError(errorText(error, 'Не удалось загрузить историю.'));
      })
      .finally(() => {
        if (!active.signal.aborted) setHistoryLoading(false);
      });
    return () => active.abort();
  }, [user, historyAttempt]);
  useEffect(() => {
    if (!user) return;
    if (authFromUrl()) setAuthRoute(undefined, true);
    const goToChat = () => { void openChat(urlChat(), true); };
    const id = urlChat();
    if (id) void openChat(id, true);
    window.addEventListener('popstate', goToChat);
    return () => window.removeEventListener('popstate', goToChat);
  }, [user]);
  useEffect(() => {
    if (!mobile) setDrawer(false);
  }, [mobile]);

  function fill(value: string) {
    setDraft(value);
    field.current?.focus();
  }

  function setAuthRoute(mode?: AuthMode, replace = false) {
    setAuthMode(mode);
    const url = new URL(window.location.href);
    url.pathname = mode ? '/' + mode : '/';
    url.searchParams.delete('telegram');
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  function clearCurrentSearch() {
    voice.cancel();
    controller.current?.abort();
    controller.current = null;
    openingChat.current?.abort();
    openingChat.current = null;
    setDraft('');
    setChatLoading(false);
    setChatError(undefined);
    window.scrollTo({ top: 0 });
  }

  function rememberChat(chat: Chat) {
    historyVersion.current += 1;
    setChats(previous => {
      if (previous.some(item => item.id === chat.id && item.updatedAt > chat.updatedAt)) return previous;
      return [chat, ...previous.filter(item => item.id !== chat.id)]
        .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    });
  }

  async function openChat(id?: string, replace = false) {
    clearCurrentSearch();
    setDrawer(false);
    setAccountTurns([]);
    setChatId(id);
    setChatUrl(id, replace);
    if (!id) return;
    const active = new AbortController();
    openingChat.current = active;
    setChatLoading(true);
    try {
      // Reopening a chat while its answer is saving should include the completed exchange.
      await savingChats.current.get(id)?.catch(() => undefined);
      if (active.signal.aborted) return;
      const { chat, turns } = await request<{ chat: Chat; turns: SavedTurn[] }>(chatsPath + '/' + encodeURIComponent(id), { signal: active.signal });
      if (active.signal.aborted) return;
      rememberChat(chat);
      setAccountTurns(turns.map(({ message, requestId, response }) => ({ message, requestId, answer: response })));
    } catch (error) {
      if (!active.signal.aborted) setChatError(errorText(error, 'Не удалось открыть поиск.'));
    } finally {
      if (!active.signal.aborted) {
        openingChat.current = null;
        setChatLoading(false);
      }
    }
  }

  function reset() {
    if (user) void openChat();
    else {
      clearCurrentSearch();
      setGuestTurns([]);
    }
    requestAnimationFrame(() => field.current?.focus());
  }

  function signIn(result: Session) {
    clearCurrentSearch();
    sessionCheck.current?.abort();
    setCheckingSession(false);
    accountId.current = result.user?.id;
    setAccountTurns([]);
    setSession(result);
    setSessionError(undefined);
    setAuthRoute(undefined, true);
    setTelegramIssue(undefined);
    requestAnimationFrame(() => field.current?.focus());
  }

  async function signOut() {
    setSigningOut(true);
    setSessionError(undefined);
    try {
      await request<void>(authPath + '/logout', { method: 'POST' });
      clearCurrentSearch();
      accountId.current = undefined;
      setChatId(undefined);
      setChatUrl(undefined, true);
      setChats([]);
      setAccountTurns([]);
      setDrawer(false);
      setSession(current => current ? { ...current, user: null } : undefined);
      requestAnimationFrame(() => document.getElementById('sign-in')?.focus());
    } catch (error) {
      setDrawer(false);
      setSessionError(errorText(error, 'Не удалось выйти.'));
    } finally {
      setSigningOut(false);
    }
  }

  async function saveChatAction(title?: string) {
    if (!chatAction) return;
    const id = chatAction.chat.id;
    const path = chatsPath + '/' + encodeURIComponent(id);
    if (title !== undefined) {
      const { chat } = await request<{ chat: Chat }>(path, jsonBody('PATCH', { title }));
      rememberChat(chat);
    } else {
      // A turn already sent to the server may finish before deletion obtains the row lock.
      await savingChats.current.get(id)?.catch(() => undefined);
      await request<void>(path, { method: 'DELETE' });
      historyVersion.current += 1;
      setChats(previous => previous.filter(chat => chat.id !== id));
      if (chatId === id) void openChat(undefined, true);
    }
    setChatAction(undefined);
  }

  async function send(message: string, retry = false) {
    const cleaned = message.trim();
    if (!cleaned || controller.current || voiceBusy || chatLoading || chatError || checkingSession || signingOut) return;
    const context = turns.findLast(turn => turn.answer)?.answer?.context;
    const active = new AbortController();
    controller.current = active;
    const requestId = user ? (retry ? turns.at(-1)?.requestId : undefined) ??
      [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('') : undefined;
    const turn = { message: cleaned, requestId };
    setTurns(previous => [...(retry || (user && previous.at(-1)?.error) ? previous.slice(0, -1) : previous), turn]);
    if (!retry) setDraft('');
    try {
      let answer: DiscoveryResponse;
      if (user) {
        let id = chatId;
        if (!id) {
          const { chat } = await request<{ chat: Chat }>(chatsPath, jsonBody('POST', {}));
          if (accountId.current !== user.id) return;
          id = chat.id;
          if (!active.signal.aborted) {
            setChatId(id);
            setChatUrl(id, true);
          }
          rememberChat(chat);
        }
        const saving = request<SavedExchange>(chatsPath + '/' + encodeURIComponent(id) + '/turns',
          jsonBody('POST', { message: cleaned, requestId }));
        savingChats.current.set(id, saving);
        try {
          const saved = await saving;
          if (accountId.current === user.id) rememberChat(saved.chat);
          answer = saved.turn.response;
        } finally {
          savingChats.current.delete(id);
        }
      } else {
        answer = await request<DiscoveryResponse>('/api/v1/discover', {
          ...jsonBody('POST', { message: cleaned, context }), signal: active.signal,
        });
      }
      if (!active.signal.aborted) setTurns(previous => [...previous.slice(0, -1), { ...turn, answer }]);
    } catch (error) {
      if (!active.signal.aborted) setTurns(previous => [...previous.slice(0, -1), {
        ...turn, error: errorText(error, 'Не удалось получить ответ.'),
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

  const historySidebar = user && (!mobile || drawer) && <ChatSidebar account={user} chats={chats} chatId={chatId}
    loading={historyLoading} error={historyError} signingOut={signingOut} mobile={mobile}
    onClose={() => setDrawer(false)} onNew={reset} onSelect={id => void openChat(id)} onAction={setChatAction}
    onRetry={() => setHistoryAttempt(previous => previous + 1)} onLogout={() => void signOut()} />;
  const unavailable = checkingSession || chatLoading || Boolean(chatError) || signingOut;

  return <div className={user ? 'discovery-layout has-history' : 'discovery-layout'}>
    {!mobile && historySidebar}
    <Shell discovery headerStart={user && mobile && <button type="button" className="icon-button history-toggle" aria-label="История поиска"
      aria-haspopup="dialog" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="panel" /></button>}
    headerActions={<>
      {!user && inChat && <button type="button" className="text-link new-chat" aria-label="Новый поиск" title="Новый поиск" onClick={reset}><Icon name="plus" /></button>}
      {!user && <button id="sign-in" type="button" className="header-link sign-in" onClick={() => setAuthRoute('login')}><Icon name="user" />Войти</button>}
    </>}>
    <main id="main" className={inChat || chatLoading || chatError ? 'discovery conversation' : 'discovery welcome'}>
      {sessionError && <Notice text={sessionError} retry={!user ? () => setSessionAttempt(previous => previous + 1) : undefined} />}
      {chatLoading && <p className="loading" role="status"><span className="spinner" />Открываем поиск…</p>}
      {chatError && <Notice text={chatError} retry={() => void openChat(chatId, true)} />}
      {!inChat && !chatLoading && !chatError ? <div className="welcome-heading">
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
              {answer && <div className="answer"><Answer answer={answer} selectSuggestion={suggestion => void send(suggestion)} active={last} /></div>}
              {error && <div className="notice" role="alert"><p>{error}</p>{last && <button type="button" className="prompt-chip" onClick={() => void send(message, true)}><Icon name="refresh" />Повторить</button>}</div>}
              {!answer && !error && <p className="loading" role="status"><span className="spinner" />Ищу события…</p>}
            </section>;
          })}
        </div>
      </>}
      {!chatLoading && !chatError && <div className="composer-area">
        <form className="composer" aria-label="Поиск по вопросу" onSubmit={submit}>
          <label className="sr-only" htmlFor="question">{inChat ? 'Продолжить поиск' : 'Ваш вопрос'}</label>
          <textarea id="question" ref={field} placeholder={inChat ? 'Уточните условия или задайте новый вопрос…' : 'Например, куда сходить с ребёнком в субботу?'} value={voice.preview ? withTranscript(draft, voice.preview) : draft} maxLength={1200}
            onChange={event => setDraft(event.currentTarget.value)} onKeyDown={handleKey} readOnly={voiceBusy} rows={2} />
          <div className="composer-tools">
            {!inChat && !voiceBusy && <span className="composer-hint"><Icon name="mark" />Город, дата, бюджет — всё в одном вопросе</span>}
            <div className="composer-actions">
              <button className="send voice-button" type="button" aria-label={recording ? 'Остановить запись' : 'Записать голосом'}
                title={recording ? 'Остановить запись' : 'Записать голосом'} aria-pressed={recording}
                disabled={unavailable || pending || (voiceBusy && !recording)} onClick={() => recording ? voice.stop() : void voice.start()}>
                <Icon name={recording ? 'stop' : 'mic'} />
              </button>
              <button className="send" type="submit" aria-label="Отправить вопрос" disabled={unavailable || !draft.trim() || pending || voiceBusy}>
                {pending ? <span className="spinner" /> : <Icon name="up" />}
              </button>
            </div>
          </div>
        </form>
        {voiceBusy && <div className="voice-feedback">
          <span role="status">{recording ? 'Идёт запись · до 25 секунд' : voice.status === 'permission' ? 'Разрешите доступ к микрофону' : 'Уточняю текст записи…'}</span>
          <button type="button" className="text-link" onClick={voice.cancel}>Отменить</button>
        </div>}
        {voice.error && <p className="voice-feedback" role="alert">{voice.error}</p>}
      </div>}
      {!inChat && !chatLoading && !chatError && <section className="examples" aria-labelledby="examples-heading">
        <h2 id="examples-heading">Попробуйте спросить</h2>
        <button type="button" className="feature-prompt" disabled={unavailable} onClick={() => void send(example)}>
          <span className="prompt-icon"><Icon name="quote" /></span>
          <span>{example}</span>
          <Icon name="diagonal" />
        </button>
        <div className="suggestions">{prompts.map(prompt =>
          <button className="prompt-chip" key={prompt} type="button" disabled={unavailable} onClick={() => void send(prompt)}><Icon name="diagonal" />{prompt}</button>)}</div>
      </section>}
    </main>
    </Shell>
    {mobile && historySidebar}
    {!user && authMode && <AuthDialog mode={authMode} telegramEnabled={Boolean(session?.telegramEnabled)} telegramIssue={telegramIssue}
      onMode={mode => setAuthRoute(mode, true)} onClose={() => { setAuthRoute(undefined, true); setTelegramIssue(undefined); }} onSignedIn={signIn} />}
    {user && chatAction && <ChatActionDialog action={chatAction} onClose={() => setChatAction(undefined)} onSave={saveChatAction} />}
  </div>;
}
