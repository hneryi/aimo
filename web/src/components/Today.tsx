import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Info,
  OctagonAlert,
  Plug,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { sampleFiles } from '../api';
import { useApp } from '../ctx';
import { menuCardDays, shownDish } from '../recipeOptions';
import type { Attention } from '../types';
import { TodayDrafts } from './TodayDrafts';

const STORE_KEY = 'aimo.todayCollapsed';
const ATTENTION_ICON = { block: OctagonAlert, warn: TriangleAlert, info: Info } as const;

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

function WeekStrip() {
  const { t, fmt, state, act, busy, scrollToCard } = useApp();
  const menu = state.menu;

  if (!menu) {
    const sample = sampleFiles(state.kitchen.kind);
    return (
      <div className="today-empty">
        <p className="today-empty-title">{t('noMenu.title')}</p>
        <p className="today-empty-text">{t('noMenu.text')}</p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void act({ type: 'load_demo_menu' }, { label: t('trySample') })}
        >
          <Sparkles size={18} aria-hidden="true" />
          {t('trySample')}
        </button>
        <p className="today-samples">
          {t('sampleDownload')}{' '}
          <a href={sample.xlsx} download>
            <FileSpreadsheet size={15} aria-hidden="true" />
            Excel
          </a>{' '}
          <a href={sample.pdf} download>
            <FileText size={15} aria-hidden="true" />
            PDF
          </a>
        </p>
      </div>
    );
  }

  const openMenu = () => {
    if (!scrollToCard('menu')) void act({ type: 'show_menu' });
  };

  // an event menu is one date with several courses: the chips are headed by the course, not the weekday
  const event = menu.kind === 'event';
  const first = event ? menu.days[0]?.date : undefined;
  // the server's label usually names the date already; add it only when it does not
  const eventDate = first && !menu.weekLabel.includes(fmt.dayMonth(first)) ? first : undefined;

  return (
    <div className="week">
      <p className="panel-label">
        <CalendarDays size={15} aria-hidden="true" />
        <span>
          {menu.weekLabel}
          {eventDate ? ` · ${fmt.day(eventDate)}` : ''}
        </span>
      </p>
      <ul className={`week-strip ${event ? 'is-event' : ''}`}>
        {menuCardDays(menu.days).shown.map((d) => {
          const flagged = d.match === 'suggested' || d.match === 'missing';
          return (
            <li key={d.id ?? d.date}>
              <button
                type="button"
                className={`daychip daychip-${d.match}`}
                onClick={openMenu}
                disabled={busy}
                title={d.match === 'custom' ? `${shownDish(d)} · ${t('custom.tag')}` : shownDish(d)}
              >
                <span className="daychip-wd">
                  {event && d.label ? d.label : fmt.weekdayShort(d.date)}
                  {flagged ? (
                    <span className="daychip-flag">
                      <span className="sr-only">{t('dayNeedsAttention')}</span>
                    </span>
                  ) : null}
                </span>
                <span className="daychip-dish">{shownDish(d)}</span>
                {d.match === 'custom' ? <span className="daychip-note">{t('custom.short')}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AttentionList({ items }: { items: Attention[] }) {
  const { t, act, busy } = useApp();
  const [all, setAll] = useState(false);
  const LIMIT = 3;
  if (items.length === 0) {
    return (
      <p className="attention-none">
        <CircleCheck size={17} aria-hidden="true" />
        {t('allGood')}
      </p>
    );
  }
  const shown = all ? items : items.slice(0, LIMIT);
  return (
    <>
      <ul className="attention">
        {shown.map((a) => {
          const Icon = ATTENTION_ICON[a.tone] ?? Info;
          const body = (
            <>
              <Icon size={17} strokeWidth={2.4} className="attention-icon" aria-hidden="true" />
              <span className="attention-text">{a.text}</span>
            </>
          );
          const action = a.action;
          return (
            <li key={a.id} className={`attention-item tone-${a.tone}`}>
              {action ? (
                <button type="button" className="attention-btn" disabled={busy} onClick={() => void act(action)}>
                  {body}
                  <ChevronRight size={16} className="attention-go" aria-hidden="true" />
                </button>
              ) : (
                <div className="attention-btn">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > LIMIT ? (
        <button type="button" className="text-btn" onClick={() => setAll(!all)}>
          {all ? t('showLess') : t('showAll', { n: items.length })}
        </button>
      ) : null}
    </>
  );
}

/** "What matters today": glanceable, not a KPI grid. */
export function Today() {
  const { t, fmt, state, act, busy, showPortions, scrollToCard } = useApp();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const { kitchen, plan, deliveries, integration } = state;
  // the open order cards have a list of their own below
  const attention = state.attention.filter((x) => x.action?.type !== 'show_draft');
  const a = kitchen.authority;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(STORE_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  const groups = kitchen.groups.filter((g) => g.count > 0);
  const remaining = a.weeklyBudget - a.spentThisWeek;
  const pct = (n: number) => `${Math.max(0, Math.min(100, a.weeklyBudget > 0 ? (n / a.weeklyBudget) * 100 : 0))}%`;
  const planShare = plan && !plan.orderId ? plan.totals.net : 0;
  const event = kitchen.kind === 'event';
  // a café without a menu has no week strip and no portion count to show
  const lean = kitchen.kind === 'cafe' && !state.menu;
  const hasCredit = typeof a.creditLimit === 'number';
  const creditLimit = a.creditLimit ?? 0;
  const creditUsed = a.creditUsed ?? 0;
  const creditFree = a.creditAvailable ?? creditLimit - creditUsed;
  const creditPct = `${Math.max(0, Math.min(100, creditLimit > 0 ? (creditUsed / creditLimit) * 100 : 100))}%`;

  const openPlan = () => {
    if (!scrollToCard('plan')) void act({ type: 'show_plan' });
  };

  return (
    <aside className={`today ${collapsed ? 'is-collapsed' : ''}`} aria-labelledby="today-title">
      <div className="today-head">
        <div>
          <h2 id="today-title">{t('today')}</h2>
          <p className="today-date">{fmt.longDay(state.now)}</p>
        </div>
        <button
          type="button"
          className="icon-btn today-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'today.show' : 'today.hide')}
        >
          <ChevronDown size={20} aria-hidden="true" />
        </button>
      </div>

      <div className="today-body">
        {lean ? null : (
          <section className="panel panel-week" aria-label={t(state.menu?.kind === 'event' ? 'eventMenu' : 'weekMenu')}>
            <WeekStrip />
          </section>
        )}

        <div className="facts-row">
          {lean ? null : (
            <button type="button" className="panel fact" onClick={showPortions}>
              <span className="panel-label">
                <Users size={15} aria-hidden="true" />
                {t('portions')}
              </span>
              <span className="fact-main">
                {kitchen.portionLabel ? (
                  <>
                    {fmt.num(kitchen.portionsTotal, 0)} <span className="fact-unit">{kitchen.portionLabel}</span>
                  </>
                ) : (
                  <>
                    {t('portionsCount', { n: fmt.num(kitchen.portionsTotal, 0) })}{' '}
                    <span className="fact-unit">{t('perDay')}</span>
                  </>
                )}
              </span>
              {groups.length > 0 ? (
                <span className="fact-sub">{groups.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(' · ')}</span>
              ) : null}
              {!kitchen.portionsConfirmed ? (
                <span className="fact-flag">
                  <TriangleAlert size={14} aria-hidden="true" />
                  {t('notConfirmed')}
                </span>
              ) : null}
            </button>
          )}

          <button type="button" className="panel fact" onClick={openPlan} disabled={!plan || busy}>
            <span className="panel-label">
              <Wallet size={15} aria-hidden="true" />
              {t(event ? 'eventCost' : lean ? 'weekSpent' : 'weekCost')}
            </span>
            {plan ? (
              <span className="fact-main">
                {fmt.eur(plan.totals.net)} <span className="fact-unit">{t('vat0')}</span>
              </span>
            ) : lean ? (
              <span className="fact-main">
                {fmt.eur(a.spentThisWeek)} <span className="fact-unit">{t('vat0')}</span>
              </span>
            ) : (
              <span className="fact-sub">{t('noPlanYet')}</span>
            )}
            <span className="budget" aria-hidden="true">
              <span className="budget-spent" style={{ width: pct(a.spentThisWeek) }} />
              <span className="budget-plan" style={{ width: pct(planShare) }} />
            </span>
            <span className={`fact-sub ${remaining < 0 ? 'fact-over' : ''}`}>
              {remaining >= 0
                ? t('budgetLeft', { amount: fmt.eur(remaining) })
                : t('budgetOver', { amount: fmt.eur(-remaining) })}
            </span>
            {hasCredit ? (
              <>
                <span className={`budget budget-credit ${creditFree <= 0 ? 'is-full' : ''}`} aria-hidden="true">
                  <span className="budget-used" style={{ width: creditPct }} />
                </span>
                <span className={`fact-sub ${creditFree <= 0 ? 'fact-over' : ''}`}>
                  {t('credit.line', { limit: fmt.eurShort(creditLimit), free: fmt.eurShort(Math.max(0, creditFree)) })}
                </span>
              </>
            ) : null}
          </button>

          <div className="panel fact">
            <span className="panel-label">
              <Truck size={15} aria-hidden="true" />
              {t('deliveries')}
            </span>
            {deliveries.length === 0 ? (
              <span className="fact-sub">{t('noDeliveries')}</span>
            ) : (
              <ul className="deliveries">
                {deliveries.map((d) => (
                  <li key={d.orderId}>
                    <span className="delivery-when">{d.label}</span>
                    <span className={`status status-${d.status}`}>{d.statusLabel}</span>
                    <span className="delivery-meta">
                      {d.lineCount === 1 ? t('lines.one') : t('lines', { n: d.lineCount })} · {fmt.eur(d.total)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <TodayDrafts />

        <section className="panel panel-attention" aria-labelledby="attention-title">
          <h3 id="attention-title" className="panel-label">
            {t('attention')}
            {attention.length > 0 ? <span className="group-count">{attention.length}</span> : null}
          </h3>
          <AttentionList items={attention} />
        </section>

        <section className="sources" aria-label={t('dataSources')}>
          <p className={`source ${integration.valioMock.ok ? '' : 'source-down'}`}>
            <Plug size={14} aria-hidden="true" />
            {integration.valioMock.label}
          </p>
          <p className={`source ${integration.llm.ok ? '' : 'source-down'}`}>
            <Sparkles size={14} aria-hidden="true" />
            {integration.llm.label}
          </p>
          <p className="source source-sim">
            <FlaskConical size={14} aria-hidden="true" />
            {integration.ordering.label}
          </p>
          <p className={`source ${integration.access.open ? 'source-sim' : ''}`}>
            <ShieldCheck size={14} aria-hidden="true" />
            {integration.access.label}
          </p>
        </section>
      </div>
    </aside>
  );
}
