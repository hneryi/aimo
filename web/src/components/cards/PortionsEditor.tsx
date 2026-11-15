import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { portionGroups } from '../../changes';
import { useApp } from '../../ctx';
import type { Key } from '../../i18n';
import type { DietGroup, Kitchen, Requirement } from '../../types';
import { Stepper } from '../ui';

const REQUIREMENTS: Requirement[] = [
  'gluten_free',
  'wheat_free',
  'lactose_free',
  'milk_free',
  'egg_free',
  'nut_free',
  'soy_free',
  'fish_free',
];

interface Row {
  /** null = a custom group the set_portions action cannot address; shown read-only */
  requirement: Requirement | null;
  id: string;
  label: string;
  count: number;
}

function requirementOf(g: DietGroup): Requirement | null {
  if ((REQUIREMENTS as string[]).includes(g.id)) return g.id as Requirement;
  return g.requirements.length === 1 ? g.requirements[0] : null;
}

const rowsOf = (k: Kitchen): Row[] =>
  k.groups.map((g) => ({ requirement: requirementOf(g), id: g.id, label: g.label, count: g.count }));

/** Total portions per day + one stepper per diet group, each removable. Saves with the `set_portions` action. */
export function PortionsEditor({ kitchen, onSubmit }: { kitchen: Kitchen; onSubmit?: () => void }) {
  const { t, act, busy } = useApp();
  const [total, setTotal] = useState(kitchen.portionsTotal);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(kitchen));
  const [adding, setAdding] = useState<Requirement | ''>('');

  // follow the server whenever it reports new numbers
  const signature = JSON.stringify([kitchen.portionsTotal, kitchen.groups.map((g) => [g.id, g.label, g.count])]);
  useEffect(() => {
    setTotal(kitchen.portionsTotal);
    setRows(rowsOf(kitchen));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const special = rows.reduce((sum, r) => sum + r.count, 0);
  const standard = total - special;
  const used = new Set(rows.map((r) => r.requirement));
  const free = REQUIREMENTS.filter((r) => !used.has(r));
  const dirty = total !== kitchen.portionsTotal || JSON.stringify(rows) !== JSON.stringify(rowsOf(kitchen));
  const canSave = standard >= 0 && total > 0 && (dirty || !kitchen.portionsConfirmed);

  const setCount = (id: string, count: number) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, count } : r)));
  const removeRow = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id));
  const reset = () => {
    setTotal(kitchen.portionsTotal);
    setRows(rowsOf(kitchen));
    setAdding('');
  };

  const addGroup = () => {
    if (!adding) return;
    setRows((prev) => [...prev, { requirement: adding, id: adding, label: t(`req.${adding}` as Key), count: 1 }]);
    setAdding('');
  };

  const save = () => {
    onSubmit?.();
    void act(
      {
        type: 'set_portions',
        total,
        groups: portionGroups(rows, rowsOf(kitchen)),
      },
      { inline: true },
    );
  };

  return (
    <div className="portions-editor">
      <div className="portions-row portions-total">
        <span className="portions-label">{t('total')}</span>
        <Stepper value={total} onChange={setTotal} label={t('total')} min={0} step={10} />
      </div>
      {rows.map((r) => (
        <div className="portions-row" key={r.id}>
          <span className="portions-label portions-label-group">
            <span>{r.label}</span>
            {r.requirement ? (
              <button
                type="button"
                className="icon-btn portions-remove"
                onClick={() => removeRow(r.id)}
                aria-label={t('portions.removeAria', { name: r.label })}
                title={t('portions.removeAria', { name: r.label })}
              >
                <Trash2 size={18} aria-hidden="true" />
              </button>
            ) : null}
          </span>
          {r.requirement ? (
            <Stepper value={r.count} onChange={(n) => setCount(r.id, n)} label={r.label} min={0} />
          ) : (
            <span className="portions-fixed">{r.count}</span>
          )}
        </div>
      ))}
      <div className="portions-row portions-standard">
        <span className="portions-label">{t('standard')}</span>
        <span className="portions-fixed">{standard}</span>
      </div>
      {standard < 0 ? (
        <p className="inline-warn" role="alert">
          {t('groupsExceed')}
        </p>
      ) : null}
      {free.length > 0 ? (
        <div className="portions-add">
          <select
            className="select"
            value={adding}
            onChange={(e) => setAdding(e.currentTarget.value as Requirement | '')}
            aria-label={t('addGroup')}
          >
            <option value="">{t('chooseDiet')}</option>
            {free.map((r) => (
              <option key={r} value={r}>
                {t(`req.${r}` as Key)}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-soft" onClick={addGroup} disabled={!adding}>
            <Plus size={18} aria-hidden="true" />
            {t('add')}
          </button>
        </div>
      ) : null}
      {dirty ? (
        <p className="hint portions-pending" role="status">
          {t('portions.pending')}
        </p>
      ) : null}
      <button type="button" className="btn btn-primary btn-block" onClick={save} disabled={!canSave || busy}>
        {t('savePortions')}
      </button>
      {dirty ? (
        <button type="button" className="btn btn-ghost btn-block" onClick={reset} disabled={busy}>
          <RotateCcw size={17} aria-hidden="true" />
          {t('portions.reset')}
        </button>
      ) : null}
    </div>
  );
}
