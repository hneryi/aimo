import { Ban, Check, ChevronDown, CircleHelp } from 'lucide-react';
import { useId, useState } from 'react';
import { useApp } from '../../ctx';
import { cardDomId, type StreamCard } from '../../stream';
import type { Alternative, Card } from '../../types';
import { Availability, CheckBlock, Fold, Price, ProductExtras, ProductFacts, ProductMeta, ProductRow, VerdictBadges } from '../ui';
import { AddToDraft } from './DraftCard';
import { DraftTarget } from './DraftTools';

type Group = Extract<Card, { type: 'products' }>;

const STATUS_ICON = { found: Check, choose: CircleHelp, none: Ban } as const;

/** An ingredient search as one compact list, a row per ingredient. Aimo helps to find; the buyer decides what goes on a
 *  card. Nothing is added on their behalf, and an ambiguous ingredient has nothing preselected. */
export function IngredientList({ groups }: { groups: StreamCard[] }) {
  const { t } = useApp();
  return (
    <article className="card ing">
      <header className="card-head">
        <h3 className="card-title">
          {t('ing.title')} <span className="group-count">{groups.length}</span>
        </h3>
        <DraftTarget />
      </header>
      <ul className="ing-list">
        {groups.map((sc) =>
          sc.card.type === 'products' ? <IngredientRow key={sc.key} domId={cardDomId(sc.key)} group={sc.card} /> : null,
        )}
      </ul>
    </article>
  );
}

function IngredientRow({ group, domId }: { group: Group; domId: string }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const info = group.ingredient;
  const items = group.items;
  if (!info) return null;
  const status = items.length === 0 ? 'none' : info.status;
  // an unambiguous ingredient shows its first verified product right on the row; the press opens the others
  const pick = status === 'found' ? items[0] : undefined;
  const more = pick ? items.slice(1) : items;
  const Icon = STATUS_ICON[status];
  const label =
    status === 'none'
      ? t('ing.none')
      : status === 'choose'
        ? t('ing.choose')
        : items.length === 1
          ? t('ing.options.one')
          : t('ing.options', { n: items.length });
  const head = (
    <span className="ing-head-main">
      <span className="ing-name">
        {info.name}
        {info.amount ? <span className="ing-amount"> · {info.amount}</span> : null}
      </span>
      <span className={`ing-status ing-status-${status}`}>
        <Icon size={14} strokeWidth={2.6} aria-hidden="true" />
        {label}
      </span>
    </span>
  );
  return (
    <li className={`ing-row ing-row-${status}`} id={domId}>
      {more.length > 0 ? (
        <button type="button" className="ing-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          {head}
          <ChevronDown size={18} className="ing-chevron" aria-hidden="true" />
        </button>
      ) : (
        <div className="ing-head">{head}</div>
      )}
      {status !== 'found' && info.reason ? <p className="ing-reason">{info.reason}</p> : null}
      {pick ? <QuickPick alt={pick} /> : null}
      {more.length > 0 ? (
        <div id={bodyId} className="ing-body" hidden={!open}>
          {open ? (
            <>
              {info.excluded ? <p className="ing-excluded">{info.excluded}</p> : null}
              <div className="prod-list">
                {more.map((a) => (
                  <ProductRow key={a.product.id} alt={a} footer={<AddToDraft alt={a} />} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The first verified product of an unambiguous ingredient: name, price and checks on one compact block, with the
 *  quantity and the add button. The supplier evidence stays one press away, as on a full product card. */
function QuickPick({ alt }: { alt: Alternative }) {
  const { t } = useApp();
  const { product, offer, checks } = alt;
  const hasEvidence = checks.some((c) => c.evidence.length > 0 || c.summary) || product.hasIngredientList || !!alt.basis || !!product.countryOfOrigin || !!product.packagingLabels?.length;
  return (
    <div className="ing-pick">
      <div className="ing-pick-top">
        <span className="prod-name">{product.name}</span>
        <Price offer={offer} unitLabel={product.unitLabel} />
      </div>
      <ProductMeta product={product} />
      {alt.roles?.length ? <span className="prod-tags">{alt.roles.map(r => <span className="prod-tag" key={r.role}>{r.label}</span>)}</span> : null}
      <div className="ing-pick-facts">
        <Availability offer={offer} />
        <VerdictBadges checks={checks} />
      </div>
      {alt.note ? <span className="prod-note">{alt.note}</span> : null}
      {hasEvidence ? (
        <Fold summary={t('showEvidence')} className="fold-quiet prod-fold">
          <ProductExtras product={product} />
          {product.packagingLabelNote ? <p className="prod-meta">{product.packagingLabelNote}</p> : null}
          {alt.basis?.sustainabilityRule ? <p className="prod-meta">{alt.basis.sustainabilityRule}</p> : null}
          {checks.map((c) => (
            <CheckBlock key={c.requirement} check={c} />
          ))}
          <ProductFacts product={product} />
        </Fold>
      ) : null}
      <AddToDraft alt={alt} />
    </div>
  );
}
