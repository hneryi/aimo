import { Info, Plus, ShoppingCart, Trash2, TriangleAlert, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../ctx';
import type { Alternative, Draft, DraftLine } from '../../types';
import { Availability, ProductMeta, Stepper, VerdictBadges, useQty } from '../ui';
import { DraftDelete, DraftEdit, DraftTargetMark } from './DraftTools';
import { TotalsRow } from './PlanCard';

/** Footer of a search result: put the product on the selected order card as a number of sales units. The button names
 *  that card; without any card the first addition creates one. */
export function AddToDraft({ alt }: { alt: Alternative }) {
  const { t, state, act, busy } = useApp();
  const { product } = alt;
  const step = product.lotStep ?? 1;
  const target = state.drafts?.find((d) => d.id === state.activeDraft);
  const inDraft = target?.lines.find((l) => l.product.id === product.id)?.qty ?? 0;
  const [qty, setQty] = useState(inDraft || step);
  useEffect(() => {
    setQty(inDraft || step);
  }, [target?.id, inDraft, step]);

  // only products verified for the requirements they were searched with can be ordered
  if (!alt.checks.every((c) => c.verdict === 'ok')) return <p className="prod-off-note">{t('draft.notAddable')}</p>;
  if (typeof alt.offer.price !== 'number') return null;

  const snapped = Math.max(step, Math.ceil(qty / step) * step);
  const label = !target
    ? t('draft.add')
    : inDraft
      ? t('draft.update', { name: target.name })
      : t('cards.addTo', { name: target.name });
  return (
    <div className="prod-add">
      <Stepper
        value={qty}
        onChange={setQty}
        min={step}
        step={step}
        label={`${t('qty')}: ${product.name}`}
        suffix={product.unitLabel}
        disabled={busy}
      />
      <button
        type="button"
        className="btn btn-soft btn-small prod-add-btn"
        disabled={busy || (state.drafts.length > 0 && !target) || snapped === inDraft}
        onClick={() =>
          void act(
            {
              type: 'draft_set',
              productId: product.id,
              qty: snapped,
              requirements: alt.checks.map((c) => c.requirement),
              // the card the button names, even if the selection changed elsewhere meanwhile
              draftId: target?.id,
            },
            { inline: true },
          ).then((ok) => ok && setQty(snapped))
        }
      >
        <Plus size={18} aria-hidden="true" />
        <span className="prod-add-label">{label}</span>
      </button>
      {(inDraft && target) || step > 1 ? (
        <span className="prod-add-note">
          {[
            inDraft && target ? t('draft.inDraft', { name: target.name, n: `${inDraft} ${product.unitLabel}` }) : '',
            step > 1 ? t('draft.lot', { n: step }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      ) : null}
    </div>
  );
}

function Row({ line, draftId }: { line: DraftLine; draftId: string }) {
  const { t, fmt, act, busy } = useApp();
  const { product } = line;
  const step = product.lotStep ?? 1;
  // a card's own line always changes that card, not the selected one
  const [qty, changeQty] = useQty(line.qty, step, (n) =>
    act({ type: 'draft_set', productId: product.id, qty: n, draftId }, { inline: true }),
  );

  return (
    <li className="line line-ok">
      <div className="line-top">
        <div className="line-name">
          <span className="prod-name">{product.name}</span>
          <ProductMeta product={product} />
        </div>
        <span className="line-total">{typeof line.lineTotal === 'number' ? fmt.eur(line.lineTotal) : t('noPrice')}</span>
      </div>
      <VerdictBadges checks={line.checks} />
      <div className="line-qty">
        <Stepper
          value={qty}
          onChange={changeQty}
          min={step}
          step={step}
          label={`${t('qty')}: ${product.name}`}
          suffix={product.unitLabel}
        />
        {step > 1 ? <span className="line-amounts">{t('draft.lot', { n: step })}</span> : null}
        <button
          type="button"
          className="btn btn-ghost btn-danger btn-small"
          disabled={busy}
          onClick={() => void act({ type: 'draft_set', productId: product.id, qty: 0, draftId }, { inline: true })}
        >
          <Trash2 size={18} aria-hidden="true" />
          {t('remove')}
        </button>
      </div>
      <Availability offer={line.offer} />
    </li>
  );
}

/** An order card: a named list with its own delivery date, built from search results. It becomes an order through the
 *  same checks as any other, and ordering removes the card. */
export function DraftCard({ draft }: { draft: Draft }) {
  const { t, fmt, state, act, busy } = useApp();
  const needsApproval = draft.totals.net > state.kitchen.authority.autoApproveLimit;
  const isTarget = (state.drafts?.length ?? 0) > 1 && state.activeDraft === draft.id;
  return (
    <article className={`card plan draft-card ${isTarget ? 'is-target' : ''}`}>
      <header className="card-head">
        <p className="card-kicker">
          <ShoppingCart size={15} aria-hidden="true" />
          {t('draft.title')}
        </p>
        <h3 className="card-title">{draft.name}</h3>
        <p className={`card-sub ${draft.pastDate ? 'card-sub-warn' : ''}`}>
          <Truck size={15} aria-hidden="true" />
          {t('delivery')} {draft.deliveryLabel} · {t('nProducts', { n: draft.lines.length })}
        </p>
      </header>

      <div className="draft-tools">
        <DraftTargetMark draft={draft} />
        <DraftEdit draft={draft} />
      </div>

      {draft.pastDate ? (
        <p className="inline-warn draft-past">
          <TriangleAlert size={16} aria-hidden="true" />
          {t('cards.pastDate')}
        </p>
      ) : null}

      {draft.lines.length > 0 ? (
        <>
          <TotalsRow totals={draft.totals} />
          <ul className="lines">
            {draft.lines.map((l) => (
              <Row key={l.product.id} line={l} draftId={draft.id} />
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">{t('cards.empty')}</p>
      )}

      <footer className="card-foot">
        <p className="sim-note">{state.integration.ordering.label}</p>
        <button
          type="button"
          className="btn btn-primary btn-block btn-lg"
          disabled={busy || draft.lines.length === 0 || !!draft.pastDate}
          onClick={() => void act({ type: 'draft_order', draftId: draft.id }, { inline: true })}
        >
          {t(needsApproval ? 'sendForApproval' : 'createOrder')} · {fmt.eur(draft.totals.net)}
        </button>
        <p className="hint hint-center">{t('draft.note')}</p>
        <p className="hint hint-center until-order">
          <Info size={15} aria-hidden="true" />
          {t('untilOrder')}
        </p>
        <DraftDelete draft={draft} />
      </footer>
    </article>
  );
}
