import { Check, Coffee, GraduationCap, PartyPopper, UtensilsCrossed, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useApp } from '../ctx';

const KIND_ICON = { school: GraduationCap, event: PartyPopper, restaurant: UtensilsCrossed, cafe: Coffee } as const;

/** Account picker: each customer account has its own menu, orders, limits and memory. */
export function ProfileSheet({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const { t, state, profile } = useApp();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet sheet-compact"
      aria-labelledby="profile-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2 id="profile-title">{t('profile.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          <p className="muted">{t('profile.hint')}</p>
          <ul className="profiles">
            {(state.profiles ?? []).map((p) => {
              const Icon = KIND_ICON[p.kind] ?? UtensilsCrossed;
              const active = p.id === profile;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`profile-item ${active ? 'is-active' : ''}`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      onClose();
                      if (!active) onPick(p.id);
                    }}
                  >
                    <span className="profile-icon" aria-hidden="true">
                      <Icon size={22} />
                    </span>
                    <span className="profile-text">
                      <span className="profile-name">{p.name}</span>
                      {p.description ? <span className="profile-desc">{p.description}</span> : null}
                    </span>
                    {active ? (
                      <span className="profile-active">
                        <Check size={15} strokeWidth={3} aria-hidden="true" />
                        {t('profile.active')}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </dialog>
  );
}
