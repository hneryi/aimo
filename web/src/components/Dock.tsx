import { Bot, ChevronRight, Mic, Paperclip, SendHorizontal, ShieldAlert, Square, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../ctx';
import { SPEECH_LOCALE } from '../format';
import type { UiAction } from '../types';

// Minimal typing for the Web Speech API (not part of lib.dom).
interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechResultEvent {
  results: ArrayLike<SpeechResult>;
}
interface Recognizer {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognizerCtor = new () => Recognizer;

function speechCtor(): RecognizerCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface Bubble {
  id: number;
  text: string;
  tone: 'info' | 'warn';
  /** the confirmation of a plan edit that added an undo step: it offers to take that step back */
  undo?: boolean;
}

/** An order that arrived in the background (e.g. from an external agent) and waits for the user's approval. */
export interface Notice {
  id: string;
  action: UiAction;
  orderId: string;
  agent: boolean;
}

export function Dock({
  status,
  bubble,
  onDismissBubble,
  notice,
  onOpenNotice,
  onDismissNotice,
  showChips,
}: {
  /** localized progress text while a request runs */
  status: string | null;
  bubble: Bubble | null;
  onDismissBubble: () => void;
  notice: Notice | null;
  onOpenNotice: () => void;
  onDismissNotice: () => void;
  /** the first-run welcome already offers the same prompts, larger */
  showChips: boolean;
}) {
  const { t, fmt, lang, state, busy, act, sendChat, pickFile, openDraft } = useApp();
  const draft = state.drafts.find(d => d.id === state.activeDraft);
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const recognizer = useRef<Recognizer | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  const Speech = speechCtor();

  // the stream needs to know how much room the dock takes
  useEffect(() => {
    const el = dock.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty('--dock-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => recognizer.current?.abort(), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    sendChat(value);
    setText('');
  };

  const toggleMic = () => {
    if (listening) {
      recognizer.current?.stop();
      return;
    }
    if (!Speech) return;
    const rec = new Speech();
    rec.lang = SPEECH_LOCALE[lang];
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let transcript = '';
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
        final = e.results[i].isFinal;
      }
      setText(transcript);
      if (final && transcript.trim()) {
        sendChat(transcript.trim());
        setText('');
      }
    };
    rec.onend = () => {
      setListening(false);
      recognizer.current = null;
    };
    rec.onerror = () => {
      setListening(false);
      recognizer.current = null;
    };
    recognizer.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recognizer.current = null;
    }
  };

  const mood = busy ? 'is-thinking' : listening ? 'is-listening' : '';

  return (
    <div className="dock" ref={dock}>
      <div className="shell dock-shell">
        <div className="dock-inner">
          {bubble || notice ? (
            <div className="dock-float">
              {notice ? (
                <div className="notice" key={notice.id} role="alert">
                  <button type="button" className="notice-open" onClick={onOpenNotice} disabled={busy}>
                    {notice.agent ? (
                      <Bot size={20} aria-hidden="true" />
                    ) : (
                      <ShieldAlert size={20} aria-hidden="true" />
                    )}
                    <span className="notice-text">
                      {t(notice.agent ? 'alert.agentOrder' : 'alert.order')}
                      <span className="notice-id">{notice.orderId}</span>
                    </span>
                    <span className="notice-go">
                      {t('alert.open')}
                      <ChevronRight size={16} aria-hidden="true" />
                    </span>
                  </button>
                  <button type="button" className="bubble-close" onClick={onDismissNotice} aria-label={t('close')}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {bubble ? (
                <div className={`bubble bubble-${bubble.tone}`} key={bubble.id} role="status">
                  <span>{bubble.text}</span>
                  {bubble.undo && state.undo ? (
                    <button
                      type="button"
                      className="bubble-undo"
                      disabled={busy}
                      title={t('undo.chip', { what: state.undo.label })}
                      aria-label={t('undo.chip', { what: state.undo.label })}
                      onClick={() => {
                        onDismissBubble();
                        void act({ type: 'undo' }, { inline: true });
                      }}
                    >
                      <Undo2 size={16} aria-hidden="true" />
                      {t('menuEdit.undo')}
                    </button>
                  ) : null}
                  <button type="button" className="bubble-close" onClick={onDismissBubble} aria-label={t('close')}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="dock-top">
            <img className={`dock-mascot ${mood}`} src="/mascot-192.png" alt="" width={68} height={68} />
            {notice ? <span className="dock-badge" aria-hidden="true" /> : null}
            {listening || status ? (
              <p className="dock-status">
                {listening ? t('listening') : status}
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </p>
            ) : state.undo || (showChips && state.suggestions.length > 0) ? (
              <>
                {state.undo ? (
                  // the latest plan edit can always be taken back from here: outside the scrolling chips, never off screen
                  <button
                    type="button"
                    className="prompt-chip undo-chip"
                    onClick={() => void act({ type: 'undo' }, { inline: true })}
                    title={t('undo.chip', { what: state.undo.label })}
                    aria-label={t('undo.chip', { what: state.undo.label })}
                  >
                    <Undo2 size={17} aria-hidden="true" />
                    <span className="undo-chip-text">{t('undo.chip', { what: state.undo.label })}</span>
                  </button>
                ) : null}
                {showChips && state.suggestions.length > 0 ? (
                  <ul className="chips" aria-label={t('suggestions')}>
                    {state.suggestions.map((s, i) => (
                      <li key={i}>
                        <button type="button" className="prompt-chip" onClick={() => sendChat(s)}>
                          {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="draft-bar">
            {draft ? <>
              <span className="draft-bar-info"><strong title={draft.name}>{draft.name}</strong><span>{draft.deliveryLabel} · {draft.lines.length === 1 ? t('lines.one') : t('lines', { n: draft.lines.length })} · {fmt.eur(draft.totals.net)} ({t('vat0')}, {t('draft.estimate')}){draft.lines.some(l => l.lineTotal == null) ? ` · ${t('noPrice')}` : ''}</span></span>
              <button type="button" className="btn btn-soft btn-small" disabled={busy} onClick={() => openDraft(draft.id)}>{t('draft.open')}</button>
            </> : <span className="draft-bar-info">{t('cards.none')}</span>}
          </div>
          <form className="dock-bar" onSubmit={submit}>
            <button type="button" className="icon-btn" onClick={pickFile} disabled={busy} aria-label={t('attach')} title={t('attach')}>
              <Paperclip size={21} aria-hidden="true" />
            </button>
            <input
              id="chat-input"
              className="dock-input"
              type="text"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              placeholder={t('input.placeholder')}
              aria-label={t('input.placeholder')}
              enterKeyHint="send"
              autoComplete="off"
            />
            {Speech ? (
              <button
                type="button"
                className={`icon-btn ${listening ? 'is-live' : ''}`}
                onClick={toggleMic}
                disabled={busy && !listening}
                aria-pressed={listening}
                aria-label={t(listening ? 'mic.stop' : 'mic')}
                title={t(listening ? 'mic.stop' : 'mic')}
              >
                {listening ? <Square size={18} aria-hidden="true" /> : <Mic size={21} aria-hidden="true" />}
              </button>
            ) : null}
            <button type="submit" className="icon-btn send-btn" disabled={busy || !text.trim()} aria-label={t('send')} title={t('send')}>
              <SendHorizontal size={21} aria-hidden="true" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
