import { Bot, Check, FlaskConical, Info, PackageCheck, Plug, ShieldAlert, TriangleAlert, Truck } from 'lucide-react';
import { useState } from 'react';
import { orderActions } from '../../changes';
import { useApp } from '../../ctx';
import type { AuditEntry, Order, OrderEvent } from '../../types';
import { Chip, Fold, VerdictBadges } from '../ui';
import { TotalsRow } from './PlanCard';
import { OrderProof } from './OrderProof';

export function Timeline({ items }: { items: (OrderEvent | AuditEntry)[] }) {
  const { fmt } = useApp();
  return (
    <ol className="timeline">
      {items.map((e, i) => (
        <li key={'id' in e ? e.id : i}>
          <span className="timeline-meta">
            {fmt.dateTime(e.at)} · {e.actor}
            {'orderId' in e && e.orderId ? ` · ${e.orderId}` : ''}
          </span>
          <span className="timeline-text">{e.text}</span>
          {'hash' in e && e.hash ? <code className="timeline-hash">#{e.hash}</code> : null}
        </li>
      ))}
    </ol>
  );
}

export function OrderCard({ order }: { order: Order }) {
  const { t, fmt, act, busy } = useApp();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const pending = order.status === 'pending_approval';
  // only an order waiting for approval can still be stopped: the kitchen cancels its own, an agent's is rejected
  const can = orderActions(order);
  const cancelBox = confirmCancel ? (
    <div className="confirm-row" role="group" aria-label={t('cancelOrder.confirm')}>
      <span>{t('cancelOrder.confirm')}</span>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-danger-solid"
          disabled={busy}
          onClick={() => {
            setConfirmCancel(false);
            void act({ type: 'cancel_order', orderId: order.id }, { inline: true });
          }}
        >
          {t('cancelOrder.yes')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>
          {t('cancelOrder.no')}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <article className={`card order order-${order.status}`}>
      <header className="card-head">
        <div className="order-top">
          <p className="card-kicker">
            <PackageCheck size={15} aria-hidden="true" />
            {t('order')} {order.id}
          </p>
          <span className={`status status-${order.status}`}>{order.statusLabel}</span>
        </div>
        <h3 className="card-title">{order.title}</h3>
        {order.source === 'mcp' ? (
          <p className="agent-mark">
            <Bot size={16} aria-hidden="true" />
            {t('agentOrder')}
          </p>
        ) : null}
        <p className="card-sub">
          <Truck size={15} aria-hidden="true" />
          {t('delivery')} {order.deliveryLabel}
        </p>
        <p className="card-sub">
          {t('createdBy')}: {order.createdBy} · {fmt.dateTime(order.createdAt)}
        </p>
      </header>

      {order.approval.required || pending ? (
        <div className={`approval ${pending ? 'is-pending' : ''}`}>
          {order.approval.required ? (
            <>
              <p className="approval-title">
                <ShieldAlert size={17} aria-hidden="true" />
                {t(pending ? 'approval.needed' : 'approval.was')}
              </p>
              {order.approval.reasons.length > 0 ? (
                <ul className="bullets approval-reasons">
                  {order.approval.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {order.approval.decidedBy ? (
            <p className="approval-decided">
              {t('approval.decided', {
                who: order.approval.decidedBy,
                when: order.approval.decidedAt ? fmt.dateTime(order.approval.decidedAt) : '',
              }).replace(/,\s*$/, '')}
            </p>
          ) : null}
          {can.approve ? (
            <>
              <div className="btn-row approval-actions" role="group" aria-label={t('approval.step')}>
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={busy}
                  onClick={() => void act({ type: 'approve_order', orderId: order.id }, { inline: true })}
                >
                  {t('approve')}
                </button>
                {can.reject ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-danger"
                    disabled={busy}
                    onClick={() => void act({ type: 'reject_order', orderId: order.id }, { inline: true })}
                  >
                    {t('reject')}
                  </button>
                ) : null}
                {can.cancel && !confirmCancel ? (
                  <button type="button" className="btn btn-ghost btn-danger" disabled={busy} onClick={() => setConfirmCancel(true)}>
                    {t('cancelOrder')}
                  </button>
                ) : null}
              </div>
              {cancelBox}
              <p className="hint">{t('approval.final')}</p>
            </>
          ) : null}
        </div>
      ) : (
        <p className="callout callout-ok">
          <Check size={16} strokeWidth={2.8} aria-hidden="true" />
          <span>{t('approval.notNeeded')}</span>
        </p>
      )}

      {order.recheck ? (
        <div className={`recheck ${order.recheck.ok ? 'recheck-ok' : 'recheck-warn'}`}>
          <p className="recheck-title">
            {order.recheck.ok ? (
              <Check size={16} strokeWidth={2.8} aria-hidden="true" />
            ) : (
              <TriangleAlert size={16} strokeWidth={2.4} aria-hidden="true" />
            )}
            {t('recheck')} · {fmt.dateTime(order.recheck.at)}
          </p>
          {order.recheck.changes.length > 0 ? (
            <>
              <p>{t('recheck.changes')}</p>
              <ul className="bullets">
                {order.recheck.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>{t('recheck.ok')}</p>
          )}
        </div>
      ) : null}

      {order.confirmation ? (
        <p className="confirmation">
          <span className="facts-label">{t('confirmation')}</span>
          <code>{order.confirmation}</code>
          <Chip>{t('simulated')}</Chip>
        </p>
      ) : null}

      <OrderProof order={order} />

      <Fold summary={`${t('orderLines')} (${order.lines.length})`} className="fold-group" open={pending}>
        <ul className="order-lines">
          {order.lines.map((l, i) => (
            <li key={i}>
              <div className="line-top">
                <div className="line-name">
                  <span className="prod-name">{l.name}</span>
                  <span className="prod-meta">
                    {[`${fmt.num(l.qty)} ${l.unitLabel ?? ''}`.trim() + ` × ${fmt.eur(l.unitPrice)}`, l.packLabel]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <span className="line-total">{fmt.eur(l.lineTotal)}</span>
              </div>
              {l.groupLabels.length > 0 || l.checks.length > 0 ? (
                <div className="badges">
                  {l.groupLabels.map((g, i) => (
                    <Chip key={i} tone="leaf">
                      {g}
                    </Chip>
                  ))}
                  <VerdictBadges checks={l.checks} />
                </div>
              ) : null}
              {l.substitutionLabel ? <p className="order-why">{l.substitutionLabel}</p> : null}
              {l.why ? <p className="order-why">{l.why}</p> : null}
            </li>
          ))}
        </ul>
      </Fold>

      <TotalsRow totals={order.totals} />

      <div className="integration">
        <p className="int-line int-real">
          <Plug size={15} aria-hidden="true" />
          {t('int.real')}
        </p>
        <p className="int-line int-sim">
          <FlaskConical size={15} aria-hidden="true" />
          {t('int.sim')}
        </p>
        {order.integration.note ? <p className="int-note">{order.integration.note}</p> : null}
      </div>

      {order.events.length > 0 ? (
        <Fold summary={`${t('events')} (${order.events.length})`} className="fold-quiet">
          <Timeline items={order.events} />
        </Fold>
      ) : null}

      {can.final ? (
        <p className="callout callout-info order-final">
          <Info size={16} aria-hidden="true" />
          <span>{t('order.final')}</span>
        </p>
      ) : null}
    </article>
  );
}
