// Rules for what the UI offers to change. They follow what the server actually allows, so no button promises something
// that would be refused.
import type { DashboardState, Issue, Order, Requirement, UiAction } from './types';

export interface OrderActions {
  /** approve and send */
  approve: boolean;
  /** the kitchen's own order waiting for approval: it can be cancelled (cancel_order) */
  cancel: boolean;
  /** an external agent's order waiting for approval: it can be rejected (reject_order) */
  reject: boolean;
  /** sent (or approved for sending): nothing can stop it any more, so say so instead of offering a button */
  final: boolean;
}

/** The server rejects or cancels only an order that waits for approval; after that nothing can be taken back. */
export function orderActions(o: Pick<Order, 'status' | 'source'>): OrderActions {
  const pending = o.status === 'pending_approval';
  return {
    approve: pending,
    cancel: pending && o.source === 'ui',
    reject: pending && o.source !== 'ui',
    final: o.status === 'submitted' || o.status === 'approved',
  };
}

/** Plan edits: the server records each one on its undo stack (server/src/undo.ts UNDOABLE). */
export const PLAN_EDITS: ReadonlySet<UiAction['type']> = new Set<UiAction['type']>([
  'confirm_recipe', 'set_course', 'skip_day', 'restore_day', 'set_custom_dish', 'clear_menu', 'set_portions', 'resolve_issue',
  'skip_issue', 'reopen_issue', 'swap_line', 'restore_product', 'set_line_qty', 'reset_line_qty', 'remove_line', 'restore_line',
]);

/** Edits made on a menu entry (its dish or course role) or on the whole menu (its X). They are confirmed where the user
 *  is working: the view stays on the entry, also when the answer brings new cards such as the first shopping list. */
export const MENU_EDITS: ReadonlySet<UiAction['type']> = new Set<UiAction['type']>([
  'confirm_recipe', 'set_course', 'skip_day', 'restore_day', 'set_custom_dish', 'clear_menu',
]);

const UNDO_LIMIT = 20;

/**
 * Did this request add an undo step? Only then may its confirmation offer "Undo": otherwise the button would take back
 * an earlier change than the one the confirmation talks about. A full stack (20 steps) stays at 20, so there a step is
 * assumed when the newest label is the same kind of change.
 */
export function undoRecorded(before: DashboardState['undo'], after: DashboardState['undo']): boolean {
  if (!after) return false;
  if (!before) return true;
  return after.steps > before.steps || after.label !== before.label || after.steps >= UNDO_LIMIT;
}

/** A resolved allergen item (an accepted alternative or a left-out line) can be opened again with `reopen_issue`. */
export const canReopen = (issue: Pick<Issue, 'id' | 'resolved' | 'kind'>): boolean =>
  issue.resolved && issue.id.startsWith('al|') && (issue.kind === 'allergen_fail' || issue.kind === 'allergen_unknown');

/** The diet groups `set_portions` is sent: every row of the form, and a row the user removed as count 0, because the
 *  server keeps every group it is not sent. Rows without a requirement (custom groups) cannot be addressed and are left
 *  out, as before. */
export function portionGroups(
  rows: { requirement: Requirement | null; count: number }[],
  saved: { requirement: Requirement | null }[],
): { requirement: Requirement; count: number }[] {
  const kept = rows.flatMap((r) => (r.requirement ? [{ requirement: r.requirement, count: r.count }] : []));
  const gone = saved.flatMap((r) =>
    r.requirement && !rows.some((x) => x.requirement === r.requirement) ? [{ requirement: r.requirement, count: 0 }] : [],
  );
  return [...kept, ...gone];
}
