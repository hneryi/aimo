import { Check, ChevronDown, CircleHelp, Clock, Info, Leaf, Minus, Plus, TriangleAlert, Truck, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { unitText } from '../format';
import type { AllergenCheck, Alternative, Evidence, Offer, ProductView, Verdict } from '../types';

// ---------- verdicts ----------

const VERDICT_ICON = { ok: Check, fail: X, unknown: CircleHelp } as const;

/** Never colour-only: icon shape + text differ for each verdict; "unknown" is dashed amber, never green. */
export function VerdictBadge({ verdict, label }: { verdict: Verdict; label?: string }) {
  const { t } = useApp();
  const Icon = VERDICT_ICON[verdict];
  return (
    <span className={`verdict verdict-${verdict}`}>
      <span className="verdict-icon" aria-hidden="true">
        <Icon size={13} strokeWidth={3} />
      </span>
      <span>
        {label ? <span className="verdict-req">{label}: </span> : null}
        {t(`v.${verdict}`)}
      </span>
    </span>
  );
}

export function VerdictBadges({ checks }: { checks: AllergenCheck[] }) {
  if (!checks.length) return null;
  return (
    <div className="badges">
      {checks.map((c, i) => (
        <VerdictBadge key={i} verdict={c.verdict} label={c.requirementLabel} />
      ))}
    </div>
  );
}

const TONE_ICON = { ok: Check, fail: X, unknown: CircleHelp, info: Info } as const;

export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  const { t } = useApp();
  if (!evidence.length) return null;
  return (
    <ul className="evidence">
      {evidence.map((e, i) => {
        const Icon = TONE_ICON[e.tone];
        return (
          <li key={i} className={`ev ev-${e.tone}`}>
            <span className="ev-mark" aria-hidden="true">
              <Icon size={13} strokeWidth={3} />
            </span>
            <span className="ev-body">
              <span className="ev-kind">{t(`ev.${e.kind}`)}</span>
              <span className="ev-text">{e.text}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One requirement checked against one product: verdict, one-sentence summary and the evidence behind it. */
export function CheckBlock({ check }: { check: AllergenCheck }) {
  // the summary often ends by repeating the first piece of evidence word for word: keep only its lead sentence then
  const first = check.evidence[0]?.text.trim();
  let summary = check.summary.trim();
  if (first && summary.includes(first)) {
    const cut = summary.indexOf('. ');
    summary = cut > 0 ? summary.slice(0, cut + 1) : summary === first ? '' : summary;
  }
  return (
    <div className={`check check-${check.verdict}`}>
      <VerdictBadge verdict={check.verdict} label={check.requirementLabel} />
      {summary ? <p className="check-summary">{summary}</p> : null}
      <EvidenceList evidence={check.evidence} />
    </div>
  );
}

// ---------- small building blocks ----------

export function Chip({ children, tone }: { children: ReactNode; tone?: 'leaf' | 'plain' }) {
  return <span className={`chip chip-${tone ?? 'plain'}`}>{children}</span>;
}

export function Fold({
  summary,
  children,
  open,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  className?: string;
}) {
  return (
    <details className={`fold ${className ?? ''}`} open={open}>
      <summary>
        <span className="fold-label">{summary}</span>
        <ChevronDown size={18} className="fold-chevron" aria-hidden="true" />
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

export function Stepper({
  value,
  onChange,
  label,
  min = 0,
  max = 99999,
  suffix,
  disabled,
  step = 1,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
  step?: number;
}) {
  const { t } = useApp();
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  return (
    <div className="stepper">
      <button
        type="button"
        className="stepper-btn"
        onClick={() => onChange(clamp(value - step))}
        disabled={disabled || value <= min}
        aria-label={`${t('decrease')}: ${label}`}
      >
        <Minus size={18} aria-hidden="true" />
      </button>
      <input
        className="stepper-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={label}
        value={String(value)}
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const digits = e.currentTarget.value.replace(/\D/g, '');
          onChange(clamp(digits === '' ? min : Number(digits)));
        }}
      />
      {suffix ? <span className="stepper-suffix">{suffix}</span> : null}
      <button
        type="button"
        className="stepper-btn"
        onClick={() => onChange(clamp(value + step))}
        disabled={disabled || value >= max}
        aria-label={`${t('increase')}: ${label}`}
      >
        <Plus size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * A quantity the user is tapping: follows the server, sends the change after a short pause and never fights the
 * user in between. The value sent is rounded up to the product's lot step.
 */
export function useQty(serverQty: number, step: number, send: (n: number) => Promise<boolean>): [number, (n: number) => void] {
  const [qty, setQty] = useState(serverQty);
  const timer = useRef<number | undefined>(undefined);
  const server = useRef(serverQty);
  server.current = serverQty;

  useEffect(() => {
    if (timer.current === undefined) setQty(serverQty);
  }, [serverQty]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (n: number) => {
    setQty(n);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const snapped = Math.ceil(n / step) * step;
      setQty(snapped);
      if (snapped === server.current) return;
      void send(snapped).then((ok) => {
        if (!ok && timer.current === undefined) setQty(server.current);
      });
    }, 650);
  };
  return [qty, change];
}

// ---------- products ----------

const AVAIL_ICON = {
  available: Check,
  limited: TriangleAlert,
  unknown_qty: CircleHelp,
  unavailable: X,
  no_data: CircleHelp,
} as const;

export function Availability({ offer }: { offer: Offer }) {
  const { t, fmt } = useApp();
  const Icon = AVAIL_ICON[offer.availability] ?? CircleHelp;
  return (
    <span className="avail-wrap">
      <span className={`avail avail-${offer.availability}`}>
        <Icon size={14} strokeWidth={2.6} aria-hidden="true" />
        {offer.availabilityLabel}
      </span>
      {offer.cutoffPassed ? (
        <span className="avail avail-unavailable">
          <Clock size={14} strokeWidth={2.6} aria-hidden="true" />
          {t('cutoffPassed')}
        </span>
      ) : offer.closingTime ? (
        <span className="avail avail-plain">
          <Clock size={14} strokeWidth={2.2} aria-hidden="true" />
          {t('orderBy', { time: fmt.dateTime(offer.closingTime) })}
        </span>
      ) : null}
    </span>
  );
}

export function Price({ offer, unitLabel }: { offer: Offer; unitLabel: string }) {
  const { t, fmt } = useApp();
  if (typeof offer.price !== 'number') return <span className="price price-none">{t('noPrice')}</span>;
  return (
    <span className="price">
      <span className="price-main">
        {fmt.eur(offer.price)}
        {unitLabel ? <span className="price-unit"> / {unitLabel}</span> : null}
      </span>
      {typeof offer.comparisonPrice === 'number' && offer.comparisonUnit ? (
        <span className="price-cmp">
          {fmt.eur(offer.comparisonPrice)}/{unitText(offer.comparisonUnit)}
        </span>
      ) : null}
    </span>
  );
}

/** Supplier facts exactly as received: ingredient list, declared allergens, claims. Nothing is inferred here. */
export function ProductFacts({ product }: { product: ProductView }) {
  const { t, fmt } = useApp();
  const d = product.declared;
  const rows: [string, string[]][] = [
    [t('contains'), d.contains],
    [t('mayContain'), d.mayContain],
    [t('freeFrom'), d.freeFrom],
  ];
  return (
    <div className="facts">
      <div className="facts-block">
        <span className="facts-label">{t('ingredients')}</span>
        {product.hasIngredientList && product.ingredients ? (
          <p className="ingredients">{product.ingredients}</p>
        ) : (
          <p className="facts-missing">{t('noIngredients')}</p>
        )}
      </div>
      {product.hasAllergenDeclaration ? (
        rows
          .filter(([, list]) => list.length > 0)
          .map(([label, list]) => (
            <p key={label} className="facts-row">
              <span className="facts-label">{label}: </span>
              {list.join(', ')}
            </p>
          ))
      ) : (
        <p className="facts-missing">{t('noDeclaration')}</p>
      )}
      {product.claims.length > 0 ? (
        <div className="badges">
          {product.claims.map((c, i) => (
            <Chip key={i}>{c}</Chip>
          ))}
        </div>
      ) : null}
      {product.dataUpdated ? (
        <p className="facts-updated">{t('dataUpdated', { date: fmt.day(product.dataUpdated) })}</p>
      ) : null}
    </div>
  );
}

/** Secondary facts from the challenge dataset; shown only when the supplier data has them (never as 0). */
export function ProductExtras({ product }: { product: ProductView }) {
  const { t, fmt } = useApp();
  const rel = product.deliveryReliability;
  const co2 = product.co2PerKg;
  const hasRel = typeof rel === 'number' && Number.isFinite(rel);
  const hasCo2 = typeof co2 === 'number' && Number.isFinite(co2);
  if (!hasRel && !hasCo2 && !product.packagingLabels?.length && !product.countryOfOrigin) return null;
  return (
    <span className="extras">
      {product.packagingLabels?.map(label => <span className="chip chip-plain" key={label.id} title={product.packagingLabelNote}>{label.name}</span>)}
      {product.originLabel ? <span className="chip chip-plain">{product.originLabel}</span> : null}
      {hasRel ? (
        <span className="extra">
          <Truck size={13} aria-hidden="true" />
          {t('reliability', { pct: fmt.pct(rel) })}
        </span>
      ) : null}
      {hasCo2 ? (
        <span className="extra">
          <Leaf size={13} aria-hidden="true" />
          {t('co2', { n: fmt.num(co2, 1) })}
        </span>
      ) : null}
    </span>
  );
}

export function ProductMeta({ product }: { product: ProductView }) {
  // pack size is optional (piece goods): print only what the supplier data actually has
  const parts = [product.brand || product.vendor, product.packLabel].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="prod-meta">{parts.join(' · ')}</span>;
}

/**
 * One product with its live offer and allergen verdicts. Used for alternatives, search results and
 * product lists. When `select` is given the row is a radio option, unless the product is not verified suitable.
 */
export function ProductRow({
  alt,
  select,
  tag,
  footer,
}: {
  alt: Alternative;
  select?: { name: string; checked: boolean; onSelect: () => void };
  tag?: string;
  footer?: ReactNode;
}) {
  const { t } = useApp();
  const { product, offer, checks } = alt;
  const selectable = !!select && alt.suitable;
  const hasEvidence = checks.some((c) => c.evidence.length > 0 || c.summary) || product.hasIngredientList || !!alt.basis?.sustainabilityRule;

  const head = (
    <>
      {select ? (
        <span className="prod-radio">
          {selectable ? (
            <input
              type="radio"
              name={select.name}
              checked={select.checked}
              onChange={select.onSelect}
              aria-label={product.name}
            />
          ) : (
            <span className="prod-radio-off" aria-hidden="true">
              <X size={14} strokeWidth={3} />
            </span>
          )}
        </span>
      ) : null}
      <span className="prod-main">
        <span className="prod-top">
          <span className="prod-name">
            {product.name}
            {tag ? <span className="prod-tag">{tag}</span> : null}
          </span>
          <Price offer={offer} unitLabel={product.unitLabel} />
        </span>
        <ProductMeta product={product} />
        {alt.roles?.length || alt.tierLabel ? (
          <span className="prod-tags">
            {alt.roles?.map(r => <span className="prod-tag" key={r.role}>{r.label}</span>)}
            {alt.tierLabel ? <span className="prod-tag">{alt.tierLabel}</span> : null}
          </span>
        ) : null}
        <Availability offer={offer} />
        <ProductExtras product={product} />
        <VerdictBadges checks={checks} />
        {alt.note ? <span className="prod-note">{alt.note}</span> : null}
        {product.packagingLabels?.length ? <span className="prod-meta">{product.packagingLabelNote}</span> : null}
        {select && !alt.suitable ? <span className="prod-off-note">{t('notSelectable')}</span> : null}
      </span>
    </>
  );

  return (
    <div
      className={`prod ${selectable && select?.checked ? 'is-selected' : ''} ${select && !alt.suitable ? 'is-off' : ''}`}
    >
      {selectable ? <label className="prod-head prod-head-pick">{head}</label> : <div className="prod-head">{head}</div>}
      {hasEvidence ? (
        <Fold summary={t('showEvidence')} className="fold-quiet prod-fold">
          {alt.basis?.sustainabilityRule ? <p className="prod-meta">{alt.basis.sustainabilityRule}</p> : null}
          {checks.map((c) => (
            <CheckBlock key={c.requirement} check={c} />
          ))}
          <ProductFacts product={product} />
        </Fold>
      ) : null}
      {footer}
    </div>
  );
}
