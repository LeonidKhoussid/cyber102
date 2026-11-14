import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { CatalogEvent, DiscoveryContext, DiscoveryResponse } from '@afisha/contracts';
import { AuthDialog, authPath, ChatActionDialog, ChatSidebar, chatsPath, errorText, jsonBody, useMobileSidebar } from './account.tsx';
import type { AuthMode, Chat, ChatAction, SavedTurn, Session } from './account.tsx';
import { EventPlan, locationKey, planRejection, useEventPlan } from './event-plan.tsx';
import { eventLocalDay, EventCard } from './events.tsx';
import { request } from './http.ts';
import { Icon, Notice, Shell, SidebarLeftIcon } from './ui.tsx';
import { useVoice } from './voice.ts';

const prompts = [
  'Куда сходить с ребёнком в Стерлитамаке?',
  'Какие выставки в Уфе на выходных?',
  'Составь план на субботу в Уфе',
];

type Turn = { message: string; answer?: DiscoveryResponse; error?: string; requestId?: string };
type SavedExchange = { chat: Chat; turn: SavedTurn };

function QuestionJump({ turns, transcript }: { turns: Turn[]; transcript: RefObject<HTMLDivElement | null> }) {
  const rail = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<{ index: number; top: number }>();
  const count = turns.length;

  useEffect(() => {
    const log = transcript.current;
    if (!log) return;
    const sections = log.children;
    let frame = 0;
    function update() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        let first = 0;
        let last = count - 1;
        const readingLine = 40;
        while (first < last) {
          const middle = Math.ceil((first + last) / 2);
          if ((sections[middle]?.getBoundingClientRect().top ?? Infinity) <= readingLine) first = middle;
          else last = middle - 1;
        }
        setActive(first);
      });
    }
    const observer = new ResizeObserver(update);
    observer.observe(log);
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [count, transcript]);

  useEffect(() => {
    const list = rail.current;
    const marker = list?.children[active];
    if (!list || !marker) return;
    const markerBounds = marker.getBoundingClientRect();
    const listBounds = list.getBoundingClientRect();
    if (markerBounds.top < listBounds.top) list.scrollTop += markerBounds.top - listBounds.top;
    else if (markerBounds.bottom > listBounds.bottom) list.scrollTop += markerBounds.bottom - listBounds.bottom;
  }, [active]);

  function showPreview(index: number, button: HTMLButtonElement) {
    const bounds = button.getBoundingClientRect();
    setPreview({ index, top: bounds.top + bounds.height / 2 });
  }

  function jump(index: number) {
    const question = transcript.current?.children[index]?.querySelector<HTMLElement>('.question');
    if (!question) return;
    setPreview(undefined);
    question.focus({ preventScroll: true });
    question.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  const previewTurn = preview && turns[preview.index];
  return <nav className="question-jump" aria-label="Вопросы в этом диалоге">
    <div className="question-jump-track" ref={rail} onScroll={() => setPreview(undefined)}>
      {turns.map(({ message }, index) => <button key={index} type="button" className="question-jump-marker"
        aria-label={`Вопрос ${index + 1}. ${message}`} aria-current={active === index ? 'location' : undefined}
        onPointerEnter={event => { if (event.pointerType === 'mouse') showPreview(index, event.currentTarget); }}
        onPointerLeave={() => setPreview(undefined)}
        onFocus={event => showPreview(index, event.currentTarget)} onBlur={() => setPreview(undefined)}
        onClick={() => jump(index)}><span /></button>)}
    </div>
    {previewTurn && <div className="question-jump-preview" aria-hidden="true" style={{ top: `clamp(5rem, ${preview.top}px, calc(100dvh - 5rem))` }}>
      <p>{previewTurn.message}</p>
      {previewTurn.answer && <span>{previewTurn.answer.message}</span>}
    </div>}
  </nav>;
}

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

function Answer({ answer, selectSuggestion, active, cardAction, planLink, busy }: {
  answer: DiscoveryResponse; selectSuggestion: (suggestion: string) => void; active: boolean;
  cardAction: (event: CatalogEvent, context: DiscoveryContext) => ReactNode; planLink?: ReactNode; busy: boolean;
}) {
  const cards = answer.events.length ? answer.events : answer.alternatives ?? [];
  const hasAlternatives = Boolean(answer.alternatives?.length);
  return <>
    <h2 className="answer-label"><span className="answer-mark"><Icon name="mark" /></span>
      <span>{answer.status === 'matches' ? 'Подборка событий' : hasAlternatives ? 'Варианты без проверки дороги' : answer.status === 'clarify' ? 'Нужно уточнение' : 'События не найдены'}</span>
    </h2>
    <p className="answer-message">{answer.message}</p>
    {answer.constraints.length > 0 && <dl className="constraints" aria-label="Учтённые условия">{answer.constraints.map(({ label, value }) =>
      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {planLink}
    {cards.length > 0 && <ul className="event-list">{cards.map(({ event, reasons }) =>
      <li key={event.id}><EventCard event={event} reasons={reasons} action={cardAction(event, answer.context)} /></li>)}</ul>}
    {active && answer.suggestions.length > 0 && <div className="suggestions" aria-label="Варианты продолжения">{answer.suggestions.map(suggestion =>
      <button className="prompt-chip" key={suggestion} type="button" disabled={busy} onClick={() => selectSuggestion(suggestion)}><Icon name="reply" />{suggestion}</button>)}</div>}
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatAction, setChatAction] = useState<ChatAction>();
  const user = session?.user;
  const plan = useEventPlan(user?.id, chatId);
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
  const transcript = useRef<HTMLDivElement>(null);
  const lastQuestion = useRef<HTMLElement>(null);
  const inChat = turns.length > 0;
  const pending = inChat && !turns.at(-1)?.answer && !turns.at(-1)?.error;
  const count = turns.length;
  const latestContext = turns.findLast(turn => turn.answer)?.answer?.context;
  const firstSaved = plan.events[0];
  const planContext = firstSaved ? turns.findLast(({ answer }) => answer?.context.planMode === 'day' &&
    answer.context.city && locationKey(answer.context.city) === locationKey(firstSaved.city) &&
    answer.context.date === eventLocalDay(firstSaved))?.answer?.context : latestContext;
  const knownLocations = turns.flatMap(({ answer }) => [...answer?.events ?? [], ...answer?.alternatives ?? []].map(({ event }) => event));
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
      plan.clearGuest();
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
          jsonBody('POST', { message: cleaned, requestId, planExperience: true }));
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
          ...jsonBody('POST', { message: cleaned, context, planExperience: true }), signal: active.signal,
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

  function closeHistory() {
    if (mobile) setDrawer(false);
    else {
      setSidebarCollapsed(true);
      requestAnimationFrame(() => document.getElementById('open-history')?.focus());
    }
  }

  function openHistory() {
    if (mobile) setDrawer(true);
    else {
      setSidebarCollapsed(false);
      requestAnimationFrame(() => document.getElementById('close-history')?.focus());
    }
  }

  const desktopHistory = Boolean(user && !mobile && !sidebarCollapsed);
  const historySidebar = user && (mobile ? drawer : desktopHistory) && <ChatSidebar account={user} chats={chats} chatId={chatId}
    loading={historyLoading} error={historyError} signingOut={signingOut} mobile={mobile}
    onClose={closeHistory} onNew={reset} onSelect={id => void openChat(id)} onAction={setChatAction}
    onRetry={() => setHistoryAttempt(previous => previous + 1)} onLogout={() => void signOut()} />;
  const unavailable = checkingSession || chatLoading || Boolean(chatError) || signingOut;
  const busy = unavailable || pending || voiceBusy;
  const showPlan = Boolean(firstSaved || latestContext?.planMode === 'day' || plan.loadError);
  const differentPlan = Boolean(firstSaved && (
    (latestContext?.city && locationKey(latestContext.city) !== locationKey(firstSaved.city)) ||
    (latestContext?.date && latestContext.date !== eventLocalDay(firstSaved))));
  const canEditRoute = !differentPlan && latestContext?.planMode === 'day';

  function cardPlanAction(event: CatalogEvent, context: DiscoveryContext) {
    const saved = plan.events.some(item => item.id === event.id);
    if (!saved && (context.planMode !== 'day' || !context.date)) return;
    const date = context.date ?? eventLocalDay(event);
    const reason = saved ? undefined : planRejection(plan.events, event, date);
    return <div className="event-plan-action">
      <button type="button" className="prompt-chip" aria-pressed={saved} disabled={unavailable || plan.loading || Boolean(plan.loadError || plan.saving || reason)}
        onClick={() => void plan.toggle(event, date, saved)}><Icon name={saved ? 'close' : 'plus'} />{saved ? 'Убрать из плана' : 'Добавить в план'}</button>
      {reason && <small>{reason}</small>}
    </div>;
  }

  function jumpToPlan() {
    const element = document.getElementById('event-plan');
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  function editPlanOrigin() {
    const prefix = 'Точка отправления: ';
    const origin = planContext?.origin ?? '';
    fill(prefix + origin);
    requestAnimationFrame(() => field.current?.setSelectionRange(prefix.length, prefix.length + origin.length));
  }

  return <div className={desktopHistory ? 'discovery-layout has-history' : 'discovery-layout'}>
    {!mobile && historySidebar}
    <Shell discovery headerStart={user && !desktopHistory && <button id="open-history" type="button" className="icon-button history-toggle" aria-label="История поиска"
      title="Открыть историю" aria-haspopup={mobile ? 'dialog' : undefined} aria-expanded={mobile && drawer} onClick={openHistory}><SidebarLeftIcon /></button>}
    headerActions={<>
      {!user && inChat && <button type="button" className="text-link new-chat" aria-label="Новый поиск" title="Новый поиск" onClick={reset}><Icon name="plus" /></button>}
      {!user && <button id="sign-in" type="button" className="header-link sign-in" aria-label="Войти" onClick={() => setAuthRoute('login')}><Icon name="user" /><span>Войти</span></button>}
    </>}>
    <main id="main" className={inChat || chatLoading || chatError ? 'discovery conversation' : 'discovery welcome'}>
      {sessionError && <Notice text={sessionError} retry={!user ? () => setSessionAttempt(previous => previous + 1) : undefined} />}
      {chatLoading && <p className="loading" role="status"><span className="spinner" />Открываем поиск…</p>}
      {chatError && <Notice text={chatError} retry={() => void openChat(chatId, true)} />}
      {!inChat && !chatLoading && !chatError ? <div className="welcome-heading">
        <h1>Куда <span>пойдём?</span></h1>
      </div> : <>
        <h1 className="sr-only">Поиск событий</h1>
        {count > 1 && <QuestionJump key={chatId ?? (user ? 'account' : 'guest')} turns={turns} transcript={transcript} />}
        <div ref={transcript} className="transcript" role="log" aria-label="Диалог о событиях">
          {turns.map(({ message, answer, error }, index) => {
            const last = index === count - 1;
            return <section className="turn" key={index} ref={last ? lastQuestion : undefined} aria-label={`Запрос ${index + 1}`}>
              <p className="question" tabIndex={-1}><span className="sr-only">Ваш вопрос </span>{message}</p>
              {answer && <div className="answer"><Answer answer={answer} selectSuggestion={suggestion => void send(suggestion)} active={last}
                busy={busy} cardAction={cardPlanAction} planLink={last && showPlan && <button type="button" className="prompt-chip plan-jump" onClick={jumpToPlan}>
                  <Icon name="calendar" />План дня{plan.events.length > 0 && ` · ${plan.events.length}`}</button>} /></div>}
              {error && <div className="notice" role="alert"><p>{error}</p>{last && <button type="button" className="prompt-chip" onClick={() => void send(message, true)}><Icon name="refresh" />Повторить</button>}</div>}
              {!answer && !error && <p className="loading" role="status"><span className="spinner" />Ищу события…</p>}
            </section>;
          })}
        </div>
        {!chatLoading && !chatError && showPlan && <EventPlan plan={plan} context={planContext} waiting={busy} differentPlan={differentPlan}
          canEditRoute={canEditRoute} knownLocations={knownLocations}
          onRemove={event => void plan.toggle(event, eventLocalDay(event), true)} onOrigin={editPlanOrigin}
          onTransport={text => void send(text)} />}
      </>}
      {!chatLoading && !chatError && <div className="composer-area">
        <form className="composer" aria-label="Поиск по вопросу" onSubmit={submit}>
          <label className="sr-only" htmlFor="question">{inChat ? 'Продолжить поиск' : 'Ваш вопрос'}</label>
          <textarea id="question" ref={field} placeholder={inChat ? 'Уточните условия или задайте новый вопрос…' : 'Укажите город, дату или то, что хотите посмотреть'} value={voice.preview ? withTranscript(draft, voice.preview) : draft} maxLength={1200}
            onChange={event => setDraft(event.currentTarget.value)} onKeyDown={handleKey} readOnly={voiceBusy} rows={2} />
          <div className="composer-tools">
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
      {!inChat && !chatLoading && !chatError && <ul className="examples" aria-label="Примеры запросов">
        {prompts.map(prompt => <li key={prompt}>
          <button className="example-prompt" type="button" disabled={unavailable} onClick={() => void send(prompt)}>{prompt}<Icon name="diagonal" /></button>
        </li>)}
      </ul>}
    </main>
    </Shell>
    {mobile && historySidebar}
    {!user && authMode && <AuthDialog mode={authMode} telegramEnabled={Boolean(session?.telegramEnabled)} telegramIssue={telegramIssue}
      onMode={mode => setAuthRoute(mode, true)} onClose={() => { setAuthRoute(undefined, true); setTelegramIssue(undefined); }} onSignedIn={signIn} />}
    {user && chatAction && <ChatActionDialog action={chatAction} onClose={() => setChatAction(undefined)} onSave={saveChatAction} />}
  </div>;
}
