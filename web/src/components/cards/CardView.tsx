import { Check, History, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../ctx';
import { unitText } from '../../format';
import type { Alternative, Card } from '../../types';
import { ProductRow } from '../ui';
import { AddToDraft, DraftCard } from './DraftCard';
import { DraftTarget } from './DraftTools';
import { IssueCard } from './IssueCard';
import { MenuCard } from './MenuCard';
import { OrderCard, Timeline } from './OrderCard';
import { PlanCard } from './PlanCard';
import { PortionsEditor } from './PortionsEditor';
import { RecipeChoices } from './RecipeChoices';

const NOTE_ICON = { info: Info, ok: Check, warn: TriangleAlert, block: OctagonAlert } as const;

function NoteCard({ card }: { card: Extract<Card, { type: 'note' }> }) {
  const Icon = NOTE_ICON[card.tone] ?? Info;
  return (
    <div className={`note note-${card.tone}`}>
      <Icon size={18} strokeWidth={2.4} aria-hidden="true" />
      <div>
        {card.title ? <p className="note-title">{card.title}</p> : null}
        <p>{card.text}</p>
        {card.recipeChoices ? <RecipeChoices date={card.recipeChoices.date} options={card.recipeChoices.options} /> : null}
      </div>
    </div>
  );
}

function ProductsCard({ card }: { card: Extract<Card, { type: 'products' }> }) {
  const { t } = useApp();
  return (
    <article className="card">
      <header className="card-head">
        <h3 className="card-title">{card.title}</h3>
        {card.subtitle ? <p className="card-sub">{card.subtitle}</p> : null}
        {card.items.length > 0 ? <DraftTarget /> : null}
      </header>
      {card.items.length === 0 ? <p className="muted">{t('noResults')}</p> : null}
      <div className="prod-list">
        {card.items.map((a) => (
          <ProductRow key={a.product.id} alt={a} footer={<AddToDraft alt={a} />} />
        ))}
      </div>
    </article>
  );
}

function ComparisonCard({ card }: { card: Extract<Card, { type: 'comparison' }> }) {
  const { t, fmt, act, busy } = useApp();
  const [switched, setSwitched] = useState<string | null>(null);
  const { current, lineId } = card;

  if (switched) {
    return (
      <div className="card issue-done">
        <span className="done-icon" aria-hidden="true">
          <Check size={16} strokeWidth={3} />
        </span>
        <p className="done-body">
          <span className="done-title">{t('switched', { name: switched })}</span>
        </p>
      </div>
    );
  }

  /** price difference against the current product, per kg/L when both sides state it */
  const diff = (a: Alternative): string | undefined => {
    if (a.note) return a.note;
    const mine = a.offer.comparisonPrice;
    const theirs = current?.offer.comparisonPrice;
    if (typeof mine !== 'number' || typeof theirs !== 'number') return undefined;
    if (!a.offer.comparisonUnit || a.offer.comparisonUnit !== current?.offer.comparisonUnit) return undefined;
    const delta = mine - theirs;
    if (Math.abs(delta) < 0.005) return t('samePrice');
    const amount = `${fmt.eur(Math.abs(delta))}/${unitText(a.offer.comparisonUnit)}`;
    return t(delta < 0 ? 'cheaperBy' : 'pricierBy', { amount });
  };

  return (
    <article className="card cmp">
      <header className="card-head">
        <h3 className="card-title">{card.title}</h3>
        {card.subtitle ? <p className="card-sub">{card.subtitle}</p> : null}
      </header>
      <div className="cmp-grid">
        {current ? <ProductRow alt={current} tag={t('current')} /> : null}
        {card.items.map((a) => (
          <ProductRow
            key={a.product.id}
            alt={{ ...a, note: diff(a) }}
            footer={
              lineId ? (
                a.suitable ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    disabled={busy}
                    onClick={() =>
                      void act({ type: 'swap_line', lineId, productId: a.product.id }, { inline: true }).then(
                        (ok) => ok && setSwitched(a.product.name),
                      )
                    }
                  >
                    {t('switchTo')}
                  </button>
                ) : (
                  <p className="prod-off-note">{t('notSwitchable')}</p>
                )
              ) : null
            }
          />
        ))}
      </div>
    </article>
  );
}

export function CardView({ card }: { card: Card }) {
  const { t, fmt } = useApp();
  switch (card.type) {
    case 'note':
      return <NoteCard card={card} />;
    case 'menu':
      return <MenuCard menu={card.menu} />;
    case 'portions':
      return (
        <article className="card">
          <header className="card-head">
            <h3 className="card-title">{t('portions')}</h3>
            {card.kitchen.portionLabel ? (
              <p className="card-sub">
                {fmt.num(card.kitchen.portionsTotal, 0)} {card.kitchen.portionLabel}
              </p>
            ) : null}
            {!card.kitchen.portionsConfirmed ? <p className="card-sub card-sub-warn">{t('notConfirmed')}</p> : null}
          </header>
          <PortionsEditor kitchen={card.kitchen} />
        </article>
      );
    case 'issue':
      return <IssueCard issue={card.issue} />;
    case 'plan':
      return <PlanCard plan={card.plan} />;
    case 'draft':
      return <DraftCard draft={card.draft} />;
    case 'comparison':
      return <ComparisonCard card={card} />;
    case 'products':
      return <ProductsCard card={card} />;
    case 'order':
      return <OrderCard order={card.order} />;
    case 'audit':
      return (
        <article className="card">
          <header className="card-head">
            <p className="card-kicker">
              <History size={15} aria-hidden="true" />
              {t('audit.title')}
            </p>
          </header>
          {card.entries.length === 0 ? <p className="muted">{t('noAudit')}</p> : <Timeline items={card.entries} />}
        </article>
      );
    default:
      return null;
  }
}
