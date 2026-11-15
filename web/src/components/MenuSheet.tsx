import { Ban, Check, Copy, RotateCcw, UserCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, getAgentInfo } from '../api';
import { useApp } from '../ctx';
import type { AgentInfo, AgentView, PolicyRule } from '../types';
import { PortionsEditor } from './cards/PortionsEditor';
import { Timeline } from './cards/OrderCard';
import { Fold } from './ui';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useApp();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      window.setTimeout(() => setDone(false), 1800);
    } catch {
      /* clipboard not available: the value is visible and selectable */
    }
  };
  return (
    <button type="button" className="btn btn-soft btn-small" onClick={() => void copy()} aria-label={`${t('copy')}: ${label}`}>
      {done ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {done ? t('copied') : t('copy')}
    </button>
  );
}

/** The account's credit limit (set by the wholesaler) with a small demo control to change or remove it. */
function CreditBlock({ onSubmit }: { onSubmit: () => void }) {
  const { t, fmt, state, act, busy } = useApp();
  const a = state.kitchen.authority;
  const limit = typeof a.creditLimit === 'number' ? a.creditLimit : null;
  const used = a.creditUsed ?? 0;
  const [value, setValue] = useState(limit === null ? '' : String(limit));
  useEffect(() => setValue(limit === null ? '' : String(limit)), [limit]);

  const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
  const valid = value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;
  const send = (next: number | null) => {
    onSubmit();
    void act({ type: 'set_credit_limit', limit: next }, { inline: true });
  };

  return (
    <div className="credit">
      <span className="facts-label">{t('credit.title')}</span>
      {limit === null ? (
        <p className="muted">{t('credit.none')}</p>
      ) : (
        <dl className="kv">
          <div>
            <dt>{t('credit.title')}</dt>
            <dd>{fmt.eur(limit)}</dd>
          </div>
          <div>
            <dt>{t('credit.used')}</dt>
            <dd>{fmt.eur(used)}</dd>
          </div>
          <div>
            <dt>{t('credit.free')}</dt>
            <dd>{fmt.eur(Math.max(0, a.creditAvailable ?? limit - used))}</dd>
          </div>
        </dl>
      )}
      <p className="hint">{t('credit.explain')}</p>
      <form
        className="credit-demo"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) send(parsed);
        }}
      >
        <span className="facts-label">{t('credit.demo')}</span>
        <div className="search-form">
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder="5000"
            aria-label={t('credit.input')}
          />
          <button type="submit" className="btn btn-soft" disabled={!valid || busy || parsed === limit}>
            {t('credit.set')}
          </button>
          {limit !== null ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => send(null)}>
              {t('credit.remove')}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

const amount = (v: string): number | null => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Two limit fields shared by an agent's row and the form for a new agent. */
function LimitFields({ perOrder, weekly, onPerOrder, onWeekly }: { perOrder: string; weekly: string; onPerOrder: (v: string) => void; onWeekly: (v: string) => void }) {
  const { t } = useApp();
  return (
    <>
      <label className="agent-limit">
        <span className="facts-label">{t('agents.perOrder')}</span>
        <input className="input" type="text" inputMode="decimal" value={perOrder} onChange={(e) => onPerOrder(e.currentTarget.value)} />
      </label>
      <label className="agent-limit">
        <span className="facts-label">{t('agents.weekly')}</span>
        <input className="input" type="text" inputMode="decimal" value={weekly} onChange={(e) => onWeekly(e.currentTarget.value)} />
      </label>
    </>
  );
}

function AgentRow({ agent, onSubmit }: { agent: AgentView; onSubmit: () => void }) {
  const { t, fmt, act, busy } = useApp();
  const [perOrder, setPerOrder] = useState(String(agent.perOrderLimit));
  const [weekly, setWeekly] = useState(String(agent.weeklyLimit));
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  useEffect(() => {
    setPerOrder(String(agent.perOrderLimit));
    setWeekly(String(agent.weeklyLimit));
  }, [agent.perOrderLimit, agent.weeklyLimit]);

  const a = amount(perOrder);
  const b = amount(weekly);
  const changed = a !== agent.perOrderLimit || b !== agent.weeklyLimit;
  return (
    <li className="agent-row">
      <div className="agent-row-head">
        <strong>{agent.name}</strong>
        <span className={`agent-status agent-status-${agent.status}`}>{agent.statusLabel}</span>
      </div>
      {agent.status === 'active' ? (
        <>
          <p className="hint">{t('agents.meta', { spent: fmt.eur(agent.spentThisWeek), date: fmt.dateTime(agent.expiresAt) })}</p>
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (a === null || b === null) return;
              onSubmit();
              void act({ type: 'agent_update', agentId: agent.id, perOrderLimit: a, weeklyLimit: b }, { inline: true });
            }}
          >
            <LimitFields perOrder={perOrder} weekly={weekly} onPerOrder={setPerOrder} onWeekly={setWeekly} />
            <button type="submit" className="btn btn-soft" disabled={busy || a === null || b === null || !changed}>
              {t('agents.save')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-danger"
              disabled={busy}
              onClick={() => {
                if (!confirmRevoke) return setConfirmRevoke(true);
                onSubmit();
                void act({ type: 'agent_revoke', agentId: agent.id }, { inline: true });
              }}
            >
              {t(confirmRevoke ? 'agents.revokeYes' : 'agents.revoke')}
            </button>
          </form>
        </>
      ) : (
        <p className="hint">{t('agents.limits', { perOrder: fmt.eur(agent.perOrderLimit), weekly: fmt.eur(agent.weeklyLimit) })}</p>
      )}
    </li>
  );
}

/** Registered agents of the account: each has its own token, limits and expiry. A person creates, changes and revokes them. */
function AgentsBlock({ onSubmit }: { onSubmit: () => void }) {
  const { t, state, act, busy } = useApp();
  const [name, setName] = useState('');
  const [perOrder, setPerOrder] = useState('');
  const [weekly, setWeekly] = useState('');
  const [days, setDays] = useState('30');
  const a = amount(perOrder);
  const b = amount(weekly);
  const d = Number(days);
  const valid = name.trim().length >= 2 && a !== null && b !== null && Number.isInteger(d) && d >= 1 && d <= 365;

  return (
    <div className="credit">
      <span className="facts-label">{t('agents.title')}</span>
      <p className="hint">{t('agents.intro')}</p>
      {state.agents.length === 0 ? (
        <p className="muted">{t('agents.none')}</p>
      ) : (
        <ul className="agent-rows">
          {state.agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} onSubmit={onSubmit} />
          ))}
        </ul>
      )}
      <form
        className="credit-demo"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || a === null || b === null) return;
          onSubmit();
          void act({ type: 'agent_create', name: name.trim(), perOrderLimit: a, weeklyLimit: b, validDays: d }, { inline: true }).then((ok) => {
            if (ok) setName('');
          });
        }}
      >
        <span className="facts-label">{t('agents.new')}</span>
        <div className="search-form">
          <label className="agent-limit">
            <span className="facts-label">{t('agents.name')}</span>
            <input className="input" type="text" maxLength={40} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </label>
          <LimitFields perOrder={perOrder} weekly={weekly} onPerOrder={setPerOrder} onWeekly={setWeekly} />
          <label className="agent-limit">
            <span className="facts-label">{t('agents.days')}</span>
            <input className="input" type="text" inputMode="numeric" value={days} onChange={(e) => setDays(e.currentTarget.value)} />
          </label>
          <button type="submit" className="btn btn-soft" disabled={!valid || busy}>
            {t('agents.create')}
          </button>
        </div>
      </form>
    </div>
  );
}

function AgentSection({ active }: { active: boolean }) {
  const { t, lang, profile, approver } = useApp();
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError('');
    getAgentInfo(lang, profile)
      .then((i) => !cancelled && setInfo(i))
      .catch((e) => !cancelled && setError(errorText(e, t)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, lang, profile, approver]);

  if (error) return <p className="inline-warn">{error}</p>;
  if (!info) return <p className="muted">{t('loading')}</p>;
  return (
    <div className="agent">
      <p className="muted">{t('mcp.intro')}</p>
      <div className="agent-field">
        <span className="facts-label">{t('mcp.url')}</span>
        <code>{info.mcpUrl}</code>
        <CopyButton value={info.mcpUrl} label={t('mcp.url')} />
      </div>
      <div className="agent-field">
        <span className="facts-label">{t('mcp.token')}</span>
        {info.token ? (
          <>
            <code>{info.token}</code>
            <CopyButton value={info.token} label={t('mcp.token')} />
          </>
        ) : null}
        <p className="hint">{info.tokenNote}</p>
      </div>
      <div className="agent-field">
        <span className="facts-label">{t('mcp.jwks')}</span>
        <code>{info.jwksUrl}</code>
        <CopyButton value={info.jwksUrl} label={t('mcp.jwks')} />
      </div>
      {info.note ? <p className="callout callout-info">{info.note}</p> : null}
      {info.tools.length > 0 ? (
        <div>
          <span className="facts-label">{t('mcp.tools')}</span>
          <ul className="tools">
            {info.tools.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code>
                <span>{tool.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const EFFECTS = ['auto', 'human', 'never'] as const;
const EFFECT_ICON = { auto: Check, human: UserCheck, never: Ban } as const;

/** The guardrail policy, grouped by what it lets Aimo / an agent do. */
function PolicyRules({ rules }: { rules: PolicyRule[] }) {
  const { t } = useApp();
  return (
    <div className="rules">
      <span className="facts-label">{t('rules')}</span>
      {EFFECTS.map((effect) => {
        const list = rules.filter((r) => r.effect === effect);
        if (list.length === 0) return null;
        const Icon = EFFECT_ICON[effect];
        return (
          <section key={effect} className={`rule-group rule-${effect}`}>
            <h4 className="rule-title">
              <span className="rule-icon" aria-hidden="true">
                <Icon size={14} strokeWidth={2.8} />
              </span>
              {t(`rule.${effect}`)}
            </h4>
            <ul className="bullets">
              {list.map((r) => (
                <li key={r.id}>{r.text}</li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function MenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, fmt, state, act, busy, approver, signIn, signOut } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const { kitchen, audit } = state;
  const a = kitchen.authority;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (!open) setConfirmReset(false);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="sheet-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
    >
      <div className="sheet-inner">
        <header className="sheet-head">
          <div>
            <h2 id="sheet-title">{kitchen.name}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>

        <div className="sheet-body">
          <Fold summary={t('kitchen')} className="fold-sheet" open>
            {!kitchen.portionsConfirmed ? <p className="card-sub card-sub-warn">{t('notConfirmed')}</p> : null}
            <PortionsEditor kitchen={kitchen} onSubmit={onClose} />
          </Fold>

          <Fold summary={t('authority')} className="fold-sheet" open>
            {approver ? (
              <p className="approver-line">
                <span>{t('login.as', { name: approver })}</span>
                <button type="button" className="btn btn-ghost btn-small" onClick={signOut}>
                  {t('login.out')}
                </button>
              </p>
            ) : (
              <p className="approver-line">
                <span className="hint">{state.integration.access.label}</span>
                {state.integration.access.open ? null : (
                  <button type="button" className="btn btn-ghost btn-small" onClick={signIn}>
                    {t('login.in')}
                  </button>
                )}
              </p>
            )}
            <dl className="kv">
              <div>
                <dt>{t('auth.auto')}</dt>
                <dd>{fmt.eur(a.autoApproveLimit)}</dd>
              </div>
              <div>
                <dt>{t('auth.agent')}</dt>
                <dd>{fmt.eur(a.agentAutoLimit)}</dd>
              </div>
              <div>
                <dt>{t('auth.budget')}</dt>
                <dd>{fmt.eur(a.weeklyBudget)}</dd>
              </div>
              <div>
                <dt>{t('auth.spent')}</dt>
                <dd>{fmt.eur(a.spentThisWeek)}</dd>
              </div>
            </dl>
            <CreditBlock onSubmit={onClose} />
            <AgentsBlock onSubmit={onClose} />
            {a.rules && a.rules.length > 0 ? <PolicyRules rules={a.rules} /> : null}
          </Fold>

          <Fold summary={t('memory')} className="fold-sheet">
            {kitchen.memory.length === 0 ? (
              <p className="muted">{t('noMemory')}</p>
            ) : (
              <ul className="memory">
                {kitchen.memory.map((m) => (
                  <li key={m.id}>
                    <span>{m.text}</span>
                    <span className="timeline-meta">{fmt.dateTime(m.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Fold>

          <Fold summary={t('mcp')} className="fold-sheet">
            <AgentSection active={open} />
          </Fold>

          <Fold summary={t('audit.title')} className="fold-sheet">
            {audit.length === 0 ? <p className="muted">{t('noAudit')}</p> : <Timeline items={audit} />}
          </Fold>

          <div className="sheet-reset">
            {confirmReset ? (
              <div className="confirm-row" role="group" aria-label={t('resetDemo')}>
                <span>{t('reset.confirm')}</span>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-danger-solid"
                    disabled={busy}
                    onClick={() => {
                      onClose();
                      void act({ type: 'reset_demo' }, { inline: true });
                    }}
                  >
                    {t('reset.yes')}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(false)}>
                    {t('cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-danger" onClick={() => setConfirmReset(true)}>
                <RotateCcw size={18} aria-hidden="true" />
                {t('resetDemo')}
              </button>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
