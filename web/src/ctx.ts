import { createContext, useContext } from 'react';
import type { Fmt } from './format';
import type { TFn } from './i18n';
import type { Alternative, DashboardState, Lang, Requirement, UiAction } from './types';

/** A wholesaler search for the kitchen's own dish of one menu entry (GET /api/products/search). It runs only when the
 *  user asks (a button or Enter), never on every keystroke: the supplier API has a rate limit. */
export interface DishSearch {
  q: string;
  /** the one dietary requirement the products were checked for; empty = no special-diet check */
  req: Requirement[];
  status: 'searching' | 'done' | 'error';
  items: Alternative[];
  error?: string;
  seq: number;
}

export interface ActOpts {
  /** the action was triggered from inside a result card: update cards in place, don't jump the stream */
  inline?: boolean;
  /** short text shown as the user's message for this turn */
  label?: string;
}

export interface AppCtx {
  lang: Lang;
  t: TFn;
  fmt: Fmt;
  state: DashboardState;
  /** id of the active customer account, sent with every request */
  profile: string | undefined;
  /** a request is running; action buttons should be disabled */
  busy: boolean;
  /** POST /api/action. Resolves true when the server accepted it. */
  act: (action: UiAction, opts?: ActOpts) => Promise<boolean>;
  /** put an editable portions card into the stream */
  showPortions: () => void;
  /** scroll to a card in the stream; returns false when it is not there */
  scrollToCard: (key: string) => boolean;
  openDraft: (id: string) => void;
  /** open the native file picker for a menu file */
  pickFile: () => void;
  sendChat: (text: string) => void;
  /** wholesaler searches of the kitchen's own dishes, by menu entry id; shown in that entry's card */
  dishSearch: Record<string, DishSearch>;
  /** search the wholesaler for one menu entry's own dish; the latest search of an entry wins */
  searchDish: (entry: string, q: string, req?: Requirement[]) => void;
  /** name of the signed-in approver; null when nobody is signed in (always null in open demo mode) */
  approver: string | null;
  /** open the approver sign-in without a pending action */
  signIn: () => void;
  signOut: () => void;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}
