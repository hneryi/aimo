import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useApp } from '../ctx';
import type { Draft } from '../types';
import { DraftCard } from './cards/DraftCard';

export function DraftSheet({ draft, message, tone, returnFocus, onClose }: { draft?: Draft; message?: string; tone?: 'info' | 'warn'; returnFocus?: HTMLElement | null; onClose: () => void }) {
  const { t } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (draft && !dialog.open) dialog.showModal();
    if (!draft && dialog.open) dialog.close();
  }, [!!draft]);
  useEffect(() => {
    if (!draft) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [!!draft]);
  return (
    <dialog ref={ref} className="sheet draft-sheet" aria-labelledby="draft-sheet-title"
      onClose={() => {
        onClose();
        requestAnimationFrame(() => {
          if (ref.current?.open) return;
          const target = returnFocus?.isConnected && !returnFocus.matches(':disabled')
            ? returnFocus : document.querySelector<HTMLElement>('.draft-bar button:not(:disabled), #chat-input');
          target?.focus({ preventScroll: true });
        });
      }}
      onKeyDown={e => {
        if (e.key !== 'Tab') return;
        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
          .filter(el => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (first && (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2 id="draft-sheet-title">{t('draft.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}><X size={22} aria-hidden="true" /></button>
        </header>
        <div className="sheet-body">
          {message ? <p role="status" className={`callout ${tone === 'warn' ? 'callout-warn' : ''}`}>{message}</p> : null}
          {draft ? <DraftCard key={draft.id} draft={draft} /> : null}
        </div>
      </div>
    </dialog>
  );
}
