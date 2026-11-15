import { CalendarX, Check, ChevronRight, ClipboardList, Info, OctagonAlert, PiggyBank, RotateCcw, Trash2, TriangleAlert, Truck } from 'lucide-react';
import { canReopen } from '../../changes';
import { useApp } from '../../ctx';
import type { Plan, PlanLine, Totals } from '../../types';
import { ResolvedIssue } from './IssueCard';
import { UndoButton } from './UndoButton';
import { Availability, CheckBlock, Chip, Fold, ProductExtras, ProductFacts, ProductMeta, Stepper, VerdictBadges, useQty } from '../ui';

export function TotalsRow({ totals }: { totals: Totals }) {
  const { t, fmt } = useApp();
  return (
    <dl className="totals">
      <div className="totals-main">
        <dt>
          {t('net')} <span className="totals-vat0">({t('vat0')})</span>
        </dt>
        <dd>{fmt.eur(totals.net)}</dd>
      </div>
      <div>
        <dt>{t('vat')}</dt>
        <dd>{fmt.eur(totals.vat)}</dd>
      </div>
      <div>
        <dt>{t('gross')}</dt>
        <dd>{fmt.eur(totals.gross)}</dd>
      </div>
    </dl>
  );
}

function Line({ line, issueKey }: { line: PlanLine; issueKey?: string }) {
  const { t, fmt, act, busy, scrollToCard } = useApp();
  const step = line.product.lotStep ?? 1;
  const [qty, changeQty] = useQty(line.orderQty, step, (n) =>
    act({ type: 'set_line_qty', lineId: line.id, qty: n }, { inline: true }),
  );

  // a group chip that only repeats the label of a verdict badge next to it adds nothing
  const groupChips = line.groupLabels.filter((g) => !line.checks.some((c) => c.requirementLabel === g));

  const amounts = [
    line.orderedAmount > 0 && line.unit ? t('ordering', { ordered: fmt.amount(line.orderedAmount, line.unit) }) : '',
    line.needed > 0 && line.unit ? t('need', { needed: fmt.amount(line.needed, line.unit) }) : '',
    line.fromStock > 0 && line.unit ? t('fromStock', { amount: fmt.amount(line.fromStock, line.unit) }) : '',
    step > 1 ? t('draft.lot', { n: step }) : '',
  ].filter(Boolean);

  return (
    <li className={`line line-${line.status}`}>
      <div className="line-top">
        <div className="line-name">
          <span className="prod-name">{line.product.name}</span>
          <ProductMeta product={line.product} />
        </div>
        <span className="line-total">{typeof line.lineTotal === 'number' ? fmt.eur(line.lineTotal) : t('noPrice')}</span>
      </div>

      {line.groupLabels.length > 0 || line.checks.length > 0 ? (
        <div className="badges">
          {groupChips.map((g, i) => (
            <Chip key={i} tone="leaf">
              {g}
            </Chip>
          ))}
          <VerdictBadges checks={line.checks} />
        </div>
      ) : null}

      <div className="line-qty">
        <Stepper value={qty} onChange={changeQty} step={step} label={`${t('qty')}: ${line.product.name}`} suffix={line.product.unitLabel} />
        {amounts.length > 0 ? <span className="line-amounts">{amounts.join(' · ')}</span> : null}
      </div>

      {typeof line.calculatedQty === 'number' && line.calculatedQty !== line.orderQty ? (
        <div className="line-revert">
          <span className="line-amounts">{t('plan.calculated', { n: `${line.calculatedQty} ${line.product.unitLabel}` })}</span>
          <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => void act({ type: 'reset_line_qty', lineId: line.id }, { inline: true })}>
            <RotateCcw size={16} aria-hidden="true" />
            {t('plan.resetQty')}
          </button>
        </div>
      ) : null}

      <Availability offer={line.offer} />

      {line.changed ? (
        <p className="line-changed">
          <span className="facts-label">{t('changed')}: </span>
          {line.changed}
        </p>
      ) : null}
      {line.swappedFrom ? (
        <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => void act({ type: 'restore_product', lineId: line.id }, { inline: true })}>
          <RotateCcw size={16} aria-hidden="true" />
          {t('plan.restoreProduct', { name: line.swappedFrom })}
        </button>
      ) : null}

      {issueKey ? (
        <button type="button" className="btn btn-warn-soft" onClick={() => scrollToCard(issueKey)}>
          {t('seeIssue')}
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ) : null}

      <Fold summary={t('lineDetails')} className="fold-quiet">
        <div className="line-detail">
          {line.why ? (
            <div>
              <span className="facts-label">{t('whySelected')}</span>
              <p>{line.why}</p>
            </div>
          ) : null}
          {line.uses.length > 0 ? (
            <div>
              <span className="facts-label">{t('uses')}</span>
              <ul className="uses">
                {line.uses.map((u, i) => (
                  <li key={i}>
                    <span className="uses-what">
                      <strong>{u.weekdayLabel}</strong> · {u.recipeName}
                      <span className="uses-group">
                        {u.groupLabel}
                        {u.ingredient ? ` · ${u.ingredient}` : ''}
                      </span>
                    </span>
                    <span className="uses-amount">{fmt.amount(u.amount, u.unit)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {line.checks.length > 0 ? (
            <div>
              <span className="facts-label">{t('allergenChecks')}</span>
              {line.checks.map((c) => (
                <CheckBlock key={c.requirement} check={c} />
              ))}
            </div>
          ) : null}
          <ProductExtras product={line.product} />
          <ProductFacts product={line.product} />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-soft"
              disabled={busy}
              onClick={() => void act({ type: 'find_cheaper', lineId: line.id }, { inline: true })}
            >
              <PiggyBank size={18} aria-hidden="true" />
              {t('cheaper')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-danger"
              disabled={busy}
              onClick={() => void act({ type: 'remove_line', lineId: line.id }, { inline: true })}
            >
              <Trash2 size={18} aria-hidden="true" />
              {t('remove')}
            </button>
          </div>
        </div>
      </Fold>
    </li>
  );
}

const GROUPS = ['blocked', 'warning', 'ok'] as const;
const GROUP_ICON = { blocked: OctagonAlert, warning: TriangleAlert, ok: Check } as const;

export function PlanCard({ plan }: { plan: Plan }) {
  const { t, fmt, state, act, busy, scrollToCard } = useApp();
  const open = plan.issues.filter((i) => !i.resolved);
  const blocking = open.filter((i) => i.severity === 'block').length;
  const groups = GROUPS.map((status) => ({ status, lines: plan.lines.filter((l) => l.status === status) })).filter(
    (g) => g.lines.length > 0,
  );
  const hasProblems = groups.some((g) => g.status !== 'ok');

  const decisions = plan.issues.filter(canReopen);
  const removed = plan.removedLines ?? [];

  const order = plan.orderId ? state.orders.find((o) => o.id === plan.orderId) : undefined;
  const ordered = !!plan.orderId && (!order || (order.status !== 'rejected' && order.status !== 'cancelled'));
  const needsApproval = plan.totals.net > state.kitchen.authority.autoApproveLimit;

  const issueKeyFor = (line: PlanLine): string | undefined => {
    if (line.status === 'ok') return undefined;
    const hit = open.find((i) => i.product?.id === line.product.id);
    return hit ? `issue:${hit.id}` : undefined;
  };

  return (
    <article className="card plan">
      <header className="card-head">
        <p className="card-kicker">
          <ClipboardList size={15} aria-hidden="true" />
          {t('plan.title')}
        </p>
        <h3 className="card-title">{plan.weekLabel}</h3>
        <p className="card-sub">
          <Truck size={15} aria-hidden="true" />
          {t('delivery')} {plan.deliveryLabel} · {t('nProducts', { n: plan.lines.length })}
        </p>
      </header>

      <TotalsRow totals={plan.totals} />

      {open.length > 0 ? (
        <div className={`plan-issues ${blocking > 0 ? 'is-blocking' : ''}`}>
          {blocking > 0 ? (
            <p className="plan-issues-title">
              <OctagonAlert size={16} strokeWidth={2.6} aria-hidden="true" />
              {t(blocking === 1 ? 'blocking.one' : 'blocking.other', { n: blocking })}
            </p>
          ) : null}
          <ul>
            {open.map((i) => (
              <li key={i.id}>
                <button type="button" className="link-row" onClick={() => scrollToCard(`issue:${i.id}`)}>
                  <span>{i.title}</span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {plan.notCovered?.length ? (
        <div className="callout callout-info plan-uncovered">
          <CalendarX size={16} aria-hidden="true" />
          <div>
            <p>{t(state.menu?.kind === 'event' ? 'plan.notCoveredEvent' : 'plan.notCovered')}</p>
            <ul className="bullets">
              {plan.notCovered.map((d) => (
                <li key={d.date}>{t(d.kind === 'custom' ? 'plan.notCovered.custom' : 'plan.notCovered.skipped', { day: d.day, name: d.name })}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {plan.lines.length === 0 ? <p className="muted">{t('emptyPlan')}</p> : null}

      {groups.map(({ status, lines }) => {
        const Icon = GROUP_ICON[status];
        const title = (
          <span className={`group-title group-${status}`}>
            <Icon size={15} strokeWidth={2.8} aria-hidden="true" />
            {t(`grp.${status}`)}
            <span className="group-count">{lines.length}</span>
          </span>
        );
        const list = (
          <ul className="lines">
            {lines.map((l) => (
              <Line key={l.id} line={l} issueKey={issueKeyFor(l)} />
            ))}
          </ul>
        );
        // when something needs attention, the lines that are fine fold away so the eye lands on the problems
        return status === 'ok' && hasProblems ? (
          <Fold key={status} summary={title} className="fold-group">
            {list}
          </Fold>
        ) : (
          <section key={status} className="plan-group">
            <h4 className="plan-group-head">{title}</h4>
            {list}
          </section>
        );
      })}

      {decisions.length > 0 ? (
        <Fold summary={<span className="group-title">{t('plan.decisions', { n: decisions.length })}</span>} className="fold-group">
          <ul className="plan-decisions">
            {decisions.map((i) => (
              <li key={i.id}>
                <ResolvedIssue issue={i} compact />
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}

      {removed.length > 0 ? (
        <section className="plan-group plan-removed" aria-labelledby={`removed-${plan.id}`}>
          <h4 className="plan-group-head" id={`removed-${plan.id}`}>
            <span className="group-title">
              <Trash2 size={15} strokeWidth={2.4} aria-hidden="true" />
              {t('plan.removed', { n: removed.length })}
            </span>
          </h4>
          <p className="hint">{t('plan.removedHint')}</p>
          <ul className="removed-lines">
            {removed.map((r) => (
              <li key={r.id}>
                <span className="removed-name">
                  <span className="prod-name">{r.name}</span>
                  <span className="prod-meta">{r.ingredient}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-soft btn-small"
                  disabled={busy}
                  aria-label={t('restore.line', { name: r.name })}
                  onClick={() => void act({ type: 'restore_line', lineId: r.id }, { inline: true })}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                  {t('restore')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="card-foot">
        <UndoButton />
        <p className="sim-note">{state.integration.ordering.label}</p>
        {ordered ? (
          <p className="callout callout-ok">
            <Check size={16} strokeWidth={2.8} aria-hidden="true" />
            <span>{t('orderExists', { id: plan.orderId ?? '' })}</span>
          </p>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg"
              disabled={!plan.ready || busy || plan.lines.length === 0}
              onClick={() => void act({ type: 'create_order' }, { inline: true })}
            >
              {t(needsApproval ? 'sendForApproval' : 'createOrder')} · {fmt.eur(plan.totals.net)}
            </button>
            {!plan.ready ? <p className="hint hint-center">{t('notReady')}</p> : null}
            <p className="hint hint-center until-order">
              <Info size={15} aria-hidden="true" />
              {t('untilOrder')}
            </p>
          </>
        )}
      </footer>
    </article>
  );
}
