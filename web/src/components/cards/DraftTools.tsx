import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../../ctx';
import type { Draft } from '../../types';

/** Match the server's business day, also when the browser is in another time zone. */
const todayIso = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(new Date());

/** Put focus back on a control that was hidden while its form was open. */
const refocus = (el: { current: HTMLElement | null }) => requestAnimationFrame(() => el.current?.focus());

/** Name and delivery date are chosen together; only the name has a numbered fallback. */
export function NewDraftForm({ short }: { short?: boolean }) {
  const { t, act, busy } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setName('');
    setDate('');
    refocus(toggle);
  };

  if (!open) {
    return (
      <button ref={toggle} type="button" className="text-btn draft-new-btn" onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden="true" />
        {t(short ? 'cards.newShort' : 'cards.new')}
      </button>
    );
  }
  return (
    <form
      className="draft-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        void act({ type: 'draft_create', name: name.trim() || undefined, deliveryDate: date }, { inline: true }).then((ok) => ok && close());
      }}
    >
      <input
        ref={input}
        className="input"
        value={name}
        maxLength={60}
        autoComplete="off"
        aria-label={t('cards.name')}
        placeholder={t('cards.nameOptional')}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      />
      <label className="draft-field"><span className="facts-label">{t('cards.date')}</span><input className="input" type="date" required min={todayIso()} value={date} onChange={e => setDate(e.currentTarget.value)} /></label>
      <div className="btn-row">
        <button type="submit" className="btn btn-soft btn-small" disabled={busy}>
          {t('cards.create')}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={close}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

/** Where additions from a result card go: the selected order card, switchable when there are several. */
export function DraftTarget() {
  const { t, state, act, busy } = useApp();
  const id = useId();
  const drafts = state.drafts ?? [];
  if (drafts.length === 0) return null; // the first addition creates a card
  const active = drafts.find((d) => d.id === state.activeDraft);
  if (!active) return null;
  return (
    <div className="draft-target">
      {drafts.length > 1 ? (
        <>
          <label className="draft-target-label" htmlFor={id}>
            {t('cards.target')}
          </label>
          <select
            id={id}
            className="select draft-target-select"
            value={active.id}
            disabled={busy}
            onChange={(e) => {
              const draftId = e.currentTarget.value;
              void act({ type: 'draft_select', draftId }, { inline: true });
            }}
          >
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.deliveryLabel}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="draft-target-label">
          {t('cards.target')} <strong>{active.name}</strong>
        </p>
      )}
      <NewDraftForm short />
    </div>
  );
}

/** With several cards: whether this card receives additions, or a way to make it the one that does. */
export function DraftTargetMark({ draft }: { draft: Draft }) {
  const { t, state, act, busy } = useApp();
  if ((state.drafts?.length ?? 0) < 2) return null;
  if (state.activeDraft === draft.id) {
    return (
      <p className="draft-mark">
        <Check size={15} strokeWidth={3} aria-hidden="true" />
        {t('cards.isTarget')}
      </p>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-soft btn-small"
      disabled={busy}
      onClick={() => void act({ type: 'draft_select', draftId: draft.id }, { inline: true })}
    >
      {t('cards.makeTarget')}
    </button>
  );
}

/** Rename the card or change its delivery date. */
export function DraftEdit({ draft }: { draft: Draft }) {
  const { t, act, busy } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(draft.name);
  const [date, setDate] = useState(draft.deliveryDate);
  const first = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    refocus(toggle);
  };

  if (!open) {
    return (
      <button
        ref={toggle}
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => {
          setName(draft.name);
          setDate(draft.deliveryDate);
          setOpen(true);
        }}
      >
        <Pencil size={16} aria-hidden="true" />
        {t('cards.edit')}
      </button>
    );
  }
  return (
    <form
      className="draft-edit"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        // only what changed is sent: an untouched default name stays the default in every language
        const nextName = name.trim() === draft.name ? undefined : name;
        const nextDate = date === draft.deliveryDate ? undefined : date;
        if (nextName === undefined && nextDate === undefined) return close();
        void act({ type: 'draft_update', draftId: draft.id, name: nextName, deliveryDate: nextDate }, { inline: true }).then(
          (ok) => ok && close(),
        );
      }}
    >
      <label className="draft-field">
        <span className="facts-label">{t('cards.name')}</span>
        <input
          ref={first}
          className="input"
          value={name}
          maxLength={60}
          autoComplete="off"
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label className="draft-field">
        <span className="facts-label">{t('cards.date')}</span>
        <input
          className="input"
          type="date"
          required
          value={date}
          // a card whose day has passed can still be renamed; a new day must be today or later
          min={draft.pastDate ? undefined : todayIso()}
          onChange={(e) => setDate(e.currentTarget.value)}
        />
      </label>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
          {t('cards.save')}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={close}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

/** Delete the card after a confirmation; nothing is ordered. */
export function DraftDelete({ draft }: { draft: Draft }) {
  const { t, act, busy } = useApp();
  const [confirm, setConfirm] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  if (!confirm) {
    return (
      <button ref={toggle} type="button" className="btn btn-ghost btn-danger btn-small" onClick={() => setConfirm(true)}>
        <Trash2 size={16} aria-hidden="true" />
        {t('cards.delete')}
      </button>
    );
  }
  const question = t('cards.deleteConfirm', { name: draft.name });
  return (
    <div className="confirm-row" role="group" aria-label={question}>
      <span>{question}</span>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-danger-solid"
          disabled={busy}
          onClick={() => {
            setConfirm(false);
            void act({ type: 'draft_delete', draftId: draft.id }, { inline: true });
          }}
        >
          {t('cards.deleteYes')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          autoFocus
          onClick={() => {
            setConfirm(false);
            refocus(toggle);
          }}
        >
          {t('cards.deleteNo')}
        </button>
      </div>
    </div>
  );
}
