import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { DiscoveryResponse } from '@afisha/contracts';
import { EventCard } from './events.tsx';
import { request } from './http.ts';
import { Icon, Shell } from './ui.tsx';

const example = 'Куда пойти в субботу с ребёнком 8 лет в Стерлитамаке, до 1000 рублей на двоих, чтобы закончилось не позже 20:00 и ехать не больше 20 минут?';
const prompts = ['Какие выставки в Уфе на выходных?', 'Что бесплатного в Уфе на этой неделе?'];

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

export function Discovery() {
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
