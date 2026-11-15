import type { Card, DashboardState, Issue, TurnResponse } from './types';

/** A card in the workspace stream. `key` identifies the thing it shows so it can be updated in place. */
export interface StreamCard {
  key: string;
  card: Card;
}

export interface Turn {
  id: number;
  user?: string;
  reply?: string;
  error?: string;
  cards: StreamCard[];
  /** reply to an in-place edit: shown small, never scrolled to, replaced by the next one */
  quiet?: boolean;
  /** the turn that restores earlier work after a page load; its greeting is UI chrome, not a server reply */
  resumed?: boolean;
  /** search results folded to one line by a newer request (undefined: never folded); the user can open it again */
  folded?: boolean;
}

export function panelDraft(s: DashboardState, panel: { id: string; profile: string } | null) {
  return panel && s.profile.id === panel.profile && s.activeDraft === panel.id
    ? s.drafts.find(d => d.id === panel.id)
    : undefined;
}

let seq = 0;
export const nextId = (): number => ++seq;

export function cardKey(card: Card): string {
  switch (card.type) {
    case 'menu':
      return 'menu';
    case 'portions':
      return 'portions';
    case 'plan':
      return 'plan';
    case 'draft':
      return `draft:${card.draft.id}`;
    case 'audit':
      return 'audit';
    case 'issue':
      return `issue:${card.issue.id}`;
    case 'order':
      return `order:${card.order.id}`;
    case 'comparison':
      return card.lineId ? `cmp:${card.lineId}` : `cmp:${nextId()}`;
    case 'products':
      return `products:${nextId()}`;
    case 'note':
      return `note:${nextId()}`;
  }
}

export const cardDomId = (key: string): string => `card-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
/** DOM id of one menu entry's card in the menu card, or of a part of it (its restore button in the removed list) */
export const dayDomId = (entry: string, part = 'card'): string => cardDomId(`day:${entry}:${part}`);

export function keyCards(cards: Card[]): StreamCard[] {
  const byKey = new Map<string, StreamCard>();
  for (const card of cards ?? []) {
    if (card.type === 'draft') continue;
    const key = cardKey(card);
    byKey.set(key, { key, card }); // a later card for the same thing wins
  }
  return [...byKey.values()];
}

const issueCard = (issue: Issue): StreamCard => ({ key: `issue:${issue.id}`, card: { type: 'issue', issue } });

/** Refresh a card that is already in the stream from the latest state; null = it no longer applies. */
function syncCard(sc: StreamCard, s: DashboardState): StreamCard | null {
  const c = sc.card;
  switch (c.type) {
    case 'menu':
      return s.menu ? { key: sc.key, card: { type: 'menu', menu: s.menu } } : null;
    case 'plan':
      return s.plan ? { key: sc.key, card: { type: 'plan', plan: s.plan } } : null;
    case 'draft':
      return null;
    case 'portions':
      return { key: sc.key, card: { type: 'portions', kitchen: s.kitchen } };
    case 'issue': {
      // without a menu nothing of its shopping list is left to decide, resolved items included
      if (!s.menu) return null;
      const live = s.plan?.issues.find((i) => i.id === c.issue.id);
      if (live) return issueCard(live);
      // an open issue the current plan does not know about is stale
      if (!c.issue.resolved && (s.plan || !s.menu)) return null;
      return sc;
    }
    case 'order': {
      const live = s.orders.find((o) => o.id === c.order.id);
      return live ? { key: sc.key, card: { type: 'order', order: live } } : null;
    }
    case 'comparison':
      if (!s.plan || (c.lineId && !s.plan.lines.some((l) => l.id === c.lineId))) return null;
      return sc;
    case 'note':
      // recipe choices for a menu entry that is no longer there (the menu was removed) have nothing to choose for
      if (c.recipeChoices && !s.menu?.days.some((d) => (d.id ?? d.date) === c.recipeChoices?.date)) return null;
      return sc;
    default:
      return sc;
  }
}

/** Every open issue of the plan should be reachable: add missing issue cards just before the plan card. */
function ensureIssueCards(turns: Turn[], s: DashboardState): Turn[] {
  if (!s.plan) return turns;
  const have = new Set(turns.flatMap((t) => t.cards.map((c) => c.key)));
  if (!have.has('plan')) return turns;
  const missing = s.plan.issues.filter((i) => !i.resolved && !have.has(`issue:${i.id}`)).map(issueCard);
  if (missing.length === 0) return turns;
  return turns.map((turn) => {
    const at = turn.cards.findIndex((c) => c.key === 'plan');
    if (at < 0) return turn;
    return { ...turn, cards: [...turn.cards.slice(0, at), ...missing, ...turn.cards.slice(at)] };
  });
}

function syncTurns(turns: Turn[], s: DashboardState, skip?: (key: string) => StreamCard | null | undefined): Turn[] {
  const next: Turn[] = [];
  for (const turn of turns) {
    const cards: StreamCard[] = [];
    for (const sc of turn.cards) {
      const forced = skip?.(sc.key);
      if (forced === null) continue;
      const synced = forced ?? syncCard(sc, s);
      if (synced) cards.push(synced);
    }
    // a turn whose results all moved or went away is dropped to keep the stream tidy
    if (cards.length === 0 && turn.cards.length > 0) continue;
    next.push({ ...turn, cards });
  }
  return next;
}

/** A stream of nothing but quiet replies has no work on it: it is empty, so the welcome view shows (the reply itself is
 *  in the confirmation bubble). */
export const tidyTurns = (turns: Turn[]): Turn[] => (turns.every((t) => t.quiet) ? [] : turns);

/** Turns the user can close (X): anything that is not the menu, its shopping list or a question about them. Closing only
 *  hides the turn: nothing changes on the server, an order stays an order. */
export const isClosable = (turn: Turn): boolean =>
  !turn.cards.some(({ card }) => card.type === 'menu' || card.type === 'plan' || card.type === 'issue');

/** Hide one closable turn; when nothing else is left, the welcome view shows. */
export const closeTurn = (turns: Turn[], id: number): Turn[] =>
  tidyTurns(turns.filter((t) => t.id !== id || !isClosable(t)));

/** Only search results and suggestions fold away. Anything that asks for a decision (order cards, orders, the plan,
 *  allergen issues) is never part of such a turn, so it stays open. */
export const isFoldable = (turn: Turn): boolean =>
  turn.cards.length > 0 && turn.cards.every(({ card }) =>
    card.type === 'products' || (card.type === 'note' && card.tone !== 'block' && !card.recipeChoices));

/** A new request folds the earlier search turns to one line each. */
export const foldEarlier = (turns: Turn[]): Turn[] =>
  turns.map((turn) => (isFoldable(turn) && !turn.folded ? { ...turn, folded: true } : turn));

/** True when an in-place action only touches cards that are already on screen. */
export function isQuiet(turns: Turn[], incoming: StreamCard[]): boolean {
  const have = new Set(turns.flatMap((t) => t.cards.map((c) => c.key)));
  return incoming.every((c) => have.has(c.key));
}

export function applyResponse(
  prev: Turn[],
  res: TurnResponse,
  incoming: StreamCard[],
  opts: { turnId: number; inline: boolean; user?: string },
): Turn[] {
  const have = new Set(prev.flatMap((t) => t.cards.map((c) => c.key)));
  const inPlace = new Map<string, StreamCard>();
  const fresh: StreamCard[] = [];
  for (const c of incoming) {
    if (c.card.type === 'draft') continue;
    if (opts.inline && have.has(c.key)) inPlace.set(c.key, c);
    else fresh.push(c);
  }
  const freshKeys = new Set(fresh.map((c) => c.key));

  // cards answered by a chat turn move down to that turn; in-place edits stay where they are
  let turns = syncTurns(prev, res.state, (key) => (freshKeys.has(key) ? null : inPlace.get(key)));

  if (fresh.length === 0 && opts.inline) {
    if (res.reply) {
      const last = turns[turns.length - 1];
      const quiet: Turn = { id: opts.turnId, reply: res.reply, cards: [], quiet: true };
      turns = last?.quiet ? [...turns.slice(0, -1), quiet] : [...turns, quiet];
    }
  } else {
    const earlier = turns.filter((t) => !t.quiet);
    // the user started a new request: earlier search results fold to one line each
    const newRequest = !opts.inline && !!opts.user;
    turns = [...(newRequest ? foldEarlier(earlier) : earlier), { id: opts.turnId, user: opts.user, reply: res.reply, cards: fresh }];
  }
  return tidyTurns(ensureIssueCards(turns, res.state));
}

/** After a language change or reload: refresh the cards that mirror state. */
export function resyncTurns(prev: Turn[], s: DashboardState): Turn[] {
  return tidyTurns(ensureIssueCards(syncTurns(prev, s), s));
}

/** On first load, show the work that already exists so the workspace is never blank after a refresh. */
export function seedTurns(s: DashboardState): Turn[] {
  const cards: StreamCard[] = [];
  if (s.menu) cards.push({ key: 'menu', card: { type: 'menu', menu: s.menu } });
  if (s.plan) {
    for (const issue of s.plan.issues) if (!issue.resolved) cards.push(issueCard(issue));
    cards.push({ key: 'plan', card: { type: 'plan', plan: s.plan } });
  }
  const latest = [...s.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest) cards.push({ key: `order:${latest.id}`, card: { type: 'order', order: latest } });
  return cards.length ? [{ id: nextId(), resumed: true, cards }] : [];
}

/** Put a card the UI itself creates (e.g. the portions editor) at the bottom of the stream. */
export function withLocalCard(prev: Turn[], card: Card, turnId: number): Turn[] {
  const sc: StreamCard = { key: cardKey(card), card };
  const rest: Turn[] = [];
  for (const turn of prev) {
    const cards = turn.cards.filter((c) => c.key !== sc.key);
    if (cards.length === 0 && turn.cards.length > 0) continue;
    rest.push(cards.length === turn.cards.length ? turn : { ...turn, cards });
  }
  return [...rest, { id: turnId, cards: [sc] }];
}
