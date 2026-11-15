import { ShoppingCart, TriangleAlert } from 'lucide-react';
import { useApp } from '../ctx';
import { NewDraftForm } from './cards/DraftTools';

/** The open order cards at a glance: name, delivery day, lines and total. A row opens the card in the workspace. */
export function TodayDrafts() {
  const { t, fmt, state, busy, openDraft } = useApp();
  const drafts = state.drafts ?? [];
  const many = drafts.length > 1;
  return (
    <section className="panel panel-drafts" aria-labelledby="drafts-title">
      <h3 id="drafts-title" className="panel-label">
        <ShoppingCart size={15} aria-hidden="true" />
        {t('cards.title')}
        {drafts.length > 0 ? <span className="group-count">{drafts.length}</span> : null}
      </h3>
      {drafts.length === 0 ? (
        <p className="fact-sub">{t('cards.none')}</p>
      ) : (
        <ul className="draft-list">
          {drafts.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="draft-row"
                disabled={busy}
                onClick={() => openDraft(d.id)}
              >
                <span className="draft-row-name">
                  {d.name}
                  {many && d.id === state.activeDraft ? <span className="draft-row-tag">{t('cards.active')}</span> : null}
                </span>
                <span className={`draft-row-meta ${d.pastDate ? 'is-past' : ''}`}>
                  {d.pastDate ? <TriangleAlert size={14} aria-hidden="true" /> : null}
                  {d.deliveryLabel}
                  {d.pastDate ? ` (${t('cards.pastShort')})` : ''} ·{' '}
                  {d.lines.length === 1 ? t('lines.one') : t('lines', { n: d.lines.length })} · {fmt.eur(d.totals.net)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <NewDraftForm />
    </section>
  );
}
