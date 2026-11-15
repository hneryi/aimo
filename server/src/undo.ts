// Undo stack for plan edits. A step holds the plan's editing state from before one change: the whole menu (also whether
// there was one) and its days (state, recipe, the kitchen's own dish and what a removal would restore), portions and diet
// groups, accepted alternatives, product switches, left-out items, line edits and the substitutions the kitchen
// remembers. Orders, the order draft, agents and limits are never part of it.
import type { Lang, UiAction } from '../../shared/types.ts';
import { getProduct, localName } from './catalog.ts';
import { dayLabel, tr } from './i18n.ts';
import { UserError } from './planner.ts';
import { recipeName } from './recipes.ts';
import { type L3, type PlanSnapshot, S, audit, l3, pick, save } from './store.ts';

export const UNDO_LIMIT = 20;

/** UI actions that change the plan's editing state. Each one is recorded before it runs. */
export const UNDOABLE: UiAction['type'][] = [
  'confirm_recipe', 'set_course', 'skip_day', 'restore_day', 'set_custom_dish', 'clear_menu', 'set_portions', 'resolve_issue', 'skip_issue', 'reopen_issue',
  'swap_line', 'restore_product', 'set_line_qty', 'reset_line_qty', 'remove_line', 'restore_line',
];

export function snapshot(): PlanSnapshot {
  const st = S();
  return structuredClone({
    days: (st.menu?.days ?? []).map(d => ({ id: d.id ?? d.date, role: d.role, match: d.match, recipeId: d.recipeId, suggestion: d.suggestion, customName: d.customName, removed: d.removed })),
    // only an import changes a menu otherwise, and an import empties the stack: restoring the whole menu is exact
    menu: st.menu ?? null,
    portionsTotal: st.kitchen.portionsTotal, groups: st.kitchen.groups, portionsConfirmed: st.kitchen.portionsConfirmed,
    overrides: st.overrides, swaps: st.swaps, skipped: st.skipped, edits: st.edits, memory: st.kitchen.memory,
  });
}

/** Comparison key: key order and the timestamps of remembered substitutions do not count as a change. */
const sig = (s: PlanSnapshot) => JSON.stringify({ ...s, memory: s.memory.map(m => [m.id, m.text]) }, (_k, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v);

function restore(from: PlanSnapshot) {
  const st = S();
  const b = structuredClone(from);
  if (b.menu === null) st.menu = undefined; // there was no menu
  else if (b.menu && !st.menu) st.menu = b.menu; // a removed menu comes back as it was
  else if (b.menu && st.menu) {
    // the same menu: its object and its entries' objects stay (code holding them sees the restored state), and their
    // contents become exactly what was stored
    const live = new Map(st.menu.days.map(d => [d.id ?? d.date, d]));
    const days = b.menu.days.map(d => { const cur = live.get(d.id ?? d.date); return cur ? refill(cur, d) : d; });
    refill(st.menu, { ...b.menu, days });
  } else for (const s of b.days) {
    // a step stored before whole menus were kept: the entries' choices only
    const d = st.menu?.days.find(x => (x.id ?? x.date) === s.id);
    if (d) { d.role = s.role; d.match = s.match; d.recipeId = s.recipeId; d.suggestion = s.suggestion; d.customName = s.customName; d.removed = s.removed; }
  }
  st.kitchen.portionsTotal = b.portionsTotal; st.kitchen.groups = b.groups; st.kitchen.portionsConfirmed = b.portionsConfirmed;
  st.overrides = b.overrides; st.swaps = b.swaps; st.skipped = b.skipped; st.edits = b.edits; st.kitchen.memory = b.memory;
}

/** Make `to` hold exactly what `from` holds, keeping the object itself. */
function refill<T extends object>(to: T, from: T): T {
  for (const k of Object.keys(to)) delete (to as Record<string, unknown>)[k];
  return Object.assign(to, from);
}

/** Record `before` as an undo step, unless the change turned out to be a no-op. Returns whether a step was added. */
export function pushUndo(before: PlanSnapshot, label: L3): boolean {
  if (sig(before) === sig(snapshot())) return false;
  const st = S();
  st.undo ??= [];
  st.undo.push({ at: new Date().toISOString(), label, before });
  if (st.undo.length > UNDO_LIMIT) st.undo.splice(0, st.undo.length - UNDO_LIMIT);
  save();
  return true;
}

/** Run a plan edit and record it. The step is added even when `run` fails after changing something. */
export async function withUndo<T>(label: L3 | (() => L3), run: () => Promise<T> | T): Promise<T> {
  const before = snapshot();
  try { return await run(); }
  finally {
    let text: L3;
    try { text = typeof label === 'function' ? label() : label; } catch { text = GENERIC; }
    pushUndo(before, text);
  }
}

/** Take back the latest step. Leaves an audit entry; the log itself is never rewound. */
export function undoLast(actor: L3): L3 {
  const st = S();
  const step = st.undo?.pop();
  if (!step) throw new UserError(l3('Ei mitään kumottavaa.', 'Inget att ångra.', 'Nothing to undo.'));
  restore(step.before);
  audit(actor, 'undo', l3(`Kumottu: ${step.label.fi}`, `Ångrat: ${step.label.sv}`, `Undone: ${step.label.en}`));
  return step.label;
}

/** An order was created from the plan: what came before it can no longer be taken back. */
export function clearUndo() {
  S().undo = [];
  save();
}

export function undoView(lang: Lang): { label: string; steps: number } | undefined {
  const stack = S().undo ?? [];
  const top = stack[stack.length - 1];
  return top ? { label: pick(lang, top.label), steps: stack.length } : undefined;
}

// ---------- short descriptions, in three languages ----------

const GENERIC = l3('Suunnitelman muutos', 'Ändring i planen', 'Plan change');
const MENU_REMOVED = l3('Ruokalista poistettu', 'Matsedeln borttagen', 'Menu removed');
const MENU_REMOVED_LAST = l3('Viimeinen ruokalaji ja ruokalista poistettu', 'Sista rätten och matsedeln borttagna', 'Last dish and the menu removed');
const t3 = (f: (lang: Lang) => string): L3 => l3(f('fi'), f('sv'), f('en'));
const dayOf = (key: string) => S().menu?.days.find(x => (x.id ?? x.date) === key) ?? S().menu?.days.find(x => x.date === key);
const dayText = (lang: Lang, key: string) => {
  const d = dayOf(key);
  return d ? d.label ?? dayLabel(lang, d.date) : key;
};
const productText = (lang: Lang, id: string) => { const p = getProduct(id); return p ? localName(p, lang) : id; };

/** What an action changed, for the "Undo" button and the log. Evaluated after the action ran. */
export function undoLabel(a: UiAction): L3 {
  switch (a.type) {
    case 'confirm_recipe': return t3(l => tr(l, `Resepti valittu: ${dayText(l, a.date)} → ${recipeName(l, a.recipeId) ?? a.recipeId}`, `Recept valt: ${dayText(l, a.date)} → ${recipeName(l, a.recipeId) ?? a.recipeId}`, `Recipe chosen: ${dayText(l, a.date)} → ${recipeName(l, a.recipeId) ?? a.recipeId}`));
    case 'set_course': return l3('Ruokalajin rooli valittu', 'Rättens roll vald', 'Course role selected');
    // removing the last dish removed the whole menu: the label says so, the entry itself is gone
    case 'skip_day': return S().menu ? t3(l => tr(l, `Ruokalaji poistettu: ${dayText(l, a.date)}`, `Rätt borttagen: ${dayText(l, a.date)}`, `Dish removed: ${dayText(l, a.date)}`)) : MENU_REMOVED_LAST;
    case 'clear_menu': return MENU_REMOVED;
    case 'restore_day': return t3(l => tr(l, `Ruokalaji palautettu: ${dayText(l, a.date)}`, `Rätt återställd: ${dayText(l, a.date)}`, `Dish restored: ${dayText(l, a.date)}`));
    case 'set_custom_dish': {
      // an exact recipe name links the recipe: the label says what happened
      const d = dayOf(a.date);
      if (d?.match === 'confirmed') return t3(l => tr(l, `Resepti valittu: ${dayText(l, a.date)} → ${recipeName(l, d.recipeId) ?? ''}`, `Recept valt: ${dayText(l, a.date)} → ${recipeName(l, d.recipeId) ?? ''}`, `Recipe chosen: ${dayText(l, a.date)} → ${recipeName(l, d.recipeId) ?? ''}`));
      return t3(l => tr(l, `Oma ruokalaji: ${dayText(l, a.date)} → ${d?.customName ?? ''}`, `Egen rätt: ${dayText(l, a.date)} → ${d?.customName ?? ''}`, `Own dish: ${dayText(l, a.date)} → ${d?.customName ?? ''}`));
    }
    case 'set_portions': return l3('Annosmäärät muutettu', 'Portionsantalet ändrat', 'Portions changed');
    case 'resolve_issue': return t3(l => tr(l, `Vaihtoehto hyväksytty: ${productText(l, a.productId)}`, `Alternativ godkänt: ${productText(l, a.productId)}`, `Alternative accepted: ${productText(l, a.productId)}`));
    case 'skip_issue': return l3('Asia jätetty pois tilauksesta', 'Sak utelämnad ur ordern', 'Item left out of the order');
    case 'reopen_issue': return l3('Valinta avattu uudelleen', 'Valet öppnat igen', 'Choice opened again');
    case 'swap_line': return t3(l => tr(l, `Tuote vaihdettu: ${productText(l, a.productId)}`, `Produkt bytt: ${productText(l, a.productId)}`, `Product switched: ${productText(l, a.productId)}`));
    case 'set_line_qty': return t3(l => tr(l, `Rivin määrä muutettu: ${productText(l, a.lineId)}`, `Radens mängd ändrad: ${productText(l, a.lineId)}`, `Line quantity changed: ${productText(l, a.lineId)}`));
    case 'remove_line': return t3(l => tr(l, `Rivi poistettu: ${productText(l, a.lineId)}`, `Rad borttagen: ${productText(l, a.lineId)}`, `Line removed: ${productText(l, a.lineId)}`));
    case 'restore_line': return t3(l => tr(l, `Rivi palautettu: ${productText(l, a.lineId)}`, `Rad återställd: ${productText(l, a.lineId)}`, `Line restored: ${productText(l, a.lineId)}`));
    case 'reset_line_qty': return t3(l => tr(l, `Laskettu määrä palautettu: ${productText(l, a.lineId)}`, `Beräknad mängd återställd: ${productText(l, a.lineId)}`, `Calculated quantity restored: ${productText(l, a.lineId)}`));
    case 'restore_product': return t3(l => tr(l, `Tuotevaihto kumottu: ${productText(l, a.lineId)}`, `Produktbyte återtaget: ${productText(l, a.lineId)}`, `Product switch taken back: ${productText(l, a.lineId)}`));
    default: return GENERIC;
  }
}
