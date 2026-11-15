import { X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorText, postLogin } from '../api';
import { useApp } from '../ctx';
import type { TurnResponse } from '../types';
import { CopyButton } from './MenuSheet';

/** Asks for the approver's name and PIN when an action needs one; the caller then repeats that action. */
export function LoginDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const { t, lang } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setPin('');
      setError('');
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError('');
    try {
      const who = await postLogin(name.trim(), pin, lang);
      setPin('');
      onDone(who);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setSending(false);
    }
  };

  return (
    <dialog ref={ref} className="sheet sheet-compact" aria-labelledby="login-title" onClose={onClose}>
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2 id="login-title">{t('login.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <form className="sheet-body access-form" onSubmit={(e) => void submit(e)}>
          <p className="muted">{t('login.why')}</p>
          <label>
            <span className="facts-label">{t('login.name')}</span>
            <input className="input" type="text" autoComplete="username" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </label>
          <label>
            <span className="facts-label">{t('login.pin')}</span>
            <input className="input" type="password" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.currentTarget.value)} />
          </label>
          {error ? (
            <p className="inline-warn" role="alert">
              {error}
            </p>
          ) : null}
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={sending || !name.trim() || !pin}>
              {t('login.submit')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {t('cancel')}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

/** Shows a new agent's bearer token: the only time it can be read. */
export function TokenDialog({ issued, onClose }: { issued: TurnResponse['issuedToken'] | null; onClose: () => void }) {
  const { t } = useApp();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (issued && !d.open) d.showModal();
    if (!issued && d.open) d.close();
  }, [issued]);

  return (
    <dialog ref={ref} className="sheet sheet-compact" aria-labelledby="token-title" onClose={onClose}>
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2 id="token-title">{t('token.title', { name: issued?.name ?? '' })}</h2>
        </header>
        <div className="sheet-body">
          <p className="callout callout-warn">{t('token.once')}</p>
          <div className="agent-field">
            <code>{issued?.token}</code>
            <CopyButton value={issued?.token ?? ''} label={t('token.title', { name: issued?.name ?? '' })} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t('token.done')}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
