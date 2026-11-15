// Small JSON-file store for the single demo kitchen. Everything here is local demo state.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { CourseRole, Lang, OrderStatus, QuoteProof, Requirement } from '../../shared/types.ts';
import { config } from './config.ts';

export type L3 = { fi: string; sv: string; en: string };
export const l3 = (fi: string, sv: string, en: string): L3 => ({ fi, sv, en });
export const pick = (lang: Lang, t: L3 | string) => (typeof t === 'string' ? t : t[lang] ?? t.fi);

/** What a menu entry has chosen: an approved recipe, a suggestion, nothing yet, or the kitchen's own dish. */
export interface DayChoice { match: 'confirmed' | 'suggested' | 'missing' | 'custom'; recipeId?: string; suggestion?: { recipeId: string; why: L3 }; customName?: string }
export interface StoredDay {
  /** unique key; equals the date for weekly menus */
  id: string; label?: string; role?: CourseRole;
  date: string; dishName: string; match: 'confirmed' | 'suggested' | 'missing' | 'skipped' | 'custom';
  recipeId?: string; suggestion?: { recipeId: string; why: L3 }; importedPortions?: number; dietNotes?: string[];
  /** match 'custom': the kitchen's own dish name; no recipe, nothing is ordered for it */
  customName?: string;
  /** match 'skipped': the choice from before the removal, which `restore_day` brings back. Absent in older state files:
   *  such an entry is linked again the way the import links it. */
  removed?: DayChoice;
}
export interface StoredMenu {
  kind: 'week' | 'event';
  weekStart: string; source: { filename: string; kind: 'xlsx' | 'pdf' | 'demo' | 'manual'; importedAt: string };
  days: StoredDay[]; warnings: L3[];
}
export interface StoredOrderLine { productId: string; qty: number; unitPrice: number; groupIds: string[]; reqs: Requirement[]; why?: L3; substitution?: boolean; substituteFor?: string }
export interface StoredOrder {
  id: string; status: OrderStatus; createdAt: string; createdBy: L3; source: 'ui' | 'mcp'; title: L3;
  deliveryDate: string; lines: StoredOrderLine[]; net: number; vat: number;
  approval: { required: boolean; reasons: L3[]; decidedBy?: L3; decidedAt?: string };
  /** `repriced`: the re-check found a changed price, so the order was not sent and waits for one more approval */
  recheck?: { at: string; ok: boolean; changes: L3[]; repriced?: boolean };
  confirmation?: string; events: { at: string; actor: L3; text: L3 }[]; idempotencyKey: string; fromPlan?: boolean;
  /** the registered agent that created the order (absent: the UI, or the shared demo token) and the quote it came from */
  agentId?: string; quoteId?: string;
  quote?: QuoteProof; signedConfirmation?: string;
}
export interface StoredAudit { id: string; at: string; actor: L3; action: string; text: L3; orderId?: string; hash: string }
export interface StoredQuote {
  id: string; createdAt: string; expiresAt: string; agent: string; deliveryDate: string; request: string;
  lines: StoredOrderLine[]; net: number; vat: number; shortfall?: { amount: number; unit: string }[]; hash: string;
  /** set when an order was created from this quote: a quote is single-use */
  orderId?: string;
  /** Missing source means a legacy MCP quote, never a kitchen quote. */
  source?: 'ui' | 'mcp';
  proof?: QuoteProof;
  /** the registered agent the quote was given to; only that agent can use it */
  agentId?: string;
}
/** A registered external agent. Only the SHA-256 of its bearer token is kept; the account is the one whose state holds it. */
export interface StoredAgent {
  id: string; name: string; tokenHash: string;
  /** what the agent may decide alone, EUR excl. VAT; further grants (e.g. a substitution tolerance) belong here */
  authority: { perOrderLimit: number; weeklyLimit: number };
  createdAt: string; expiresAt: string; revokedAt?: string;
}
/** An order card ("draft" in code): a named list of products picked from search results, with its own delivery date. */
export interface StoredDraft {
  id: string;
  /** the buyer's own name; absent = the numbered default ("Kortti 2") */
  name?: string;
  /** number of the default name; also keeps the creation order */
  no: number;
  deliveryDate: string; createdAt: string;
  lines: { productId: string; qty: number; reqs: Requirement[] }[];
}

/** The plan's editing state at one moment: what "undo" restores. Orders, the draft, agents and limits are not part of it. */
export interface PlanSnapshot {
  /** `customName` and `removed` are absent in steps stored before they existed: restoring such a step clears them,
   *  which is what the entry had then */
  days: { id: string; role?: CourseRole; match: StoredDay['match']; recipeId?: string; suggestion?: StoredDay['suggestion']; customName?: string; removed?: DayChoice }[];
  /** the whole menu as it was (null: there was none), so undo can bring back a removed menu exactly. Absent in steps
   *  stored before menus could be removed: restoring such a step sets the entries' choices from `days` only. */
  menu?: StoredMenu | null;
  portionsTotal: number; groups: { requirement: Requirement; count: number }[]; portionsConfirmed: boolean;
  overrides: Record<string, string>; swaps: Record<string, string>; skipped: string[];
  edits: { qty: Record<string, number>; removed: string[] };
  memory: { id: string; text: L3; at: string }[];
}
/** One undo step: the state from before a change, and a short description of that change. */
export interface UndoStep { at: string; label: L3; before: PlanSnapshot }

export interface State {
  kitchen: {
    name: string; portionsTotal: number; groups: { requirement: Requirement; count: number }[]; portionsConfirmed: boolean;
    authority: { autoApproveLimit: number; agentAutoLimit: number; weeklyBudget: number; creditLimit?: number };
    memory: { id: string; text: L3; at: string }[];
  };
  /** approved product per `${ingredientKey}|${groupId}` — remembered kitchen preferences */
  overrides: Record<string, string>;
  /** product swaps chosen by the user (cheaper alternative etc.): original product id -> replacement */
  swaps: Record<string, string>;
  /** `${ingredientKey}|${groupId}` lines the user chose to leave out of the order */
  skipped: string[];
  edits: { qty: Record<string, number>; removed: string[] };
  /** order draft built from search results: explicit products and quantities, per account.
   *  Kept for older readers: once `drafts` exists, save() writes the selected order card's lines here. */
  draft: { productId: string; qty: number; reqs: Requirement[] }[];
  /** open order cards; absent in older state files, whose `draft` becomes the first card (see app.ts) */
  drafts?: StoredDraft[];
  /** the selected order card: additions go there */
  activeDraft?: string;
  menu?: StoredMenu;
  stock: { productId: string; amount: number }[];
  orders: StoredOrder[];
  audit: StoredAudit[];
  idempotency: Record<string, string>;
  quotes: StoredQuote[];
  /** registered external agents authorised for this account */
  agents: StoredAgent[];
  /** undo stack of plan edits (newest last, at most 20); emptied when an order is created from the plan */
  undo: UndoStep[];
  seq: number;
}

// ---------- customer accounts (profiles) ----------

export type ProfileKind = 'school' | 'event' | 'restaurant' | 'cafe';
export interface ProfileDef {
  id: string; kind: ProfileKind; name: string; description: L3;
  portionsTotal: number; authority: State['kitchen']['authority'];
  stock: State['stock']; demoFile: string;
  /** add bread, spread and milk to every menu day (lunch kitchens) */
  dailySides: boolean;
}

export const PROFILES: ProfileDef[] = [
  {
    id: 'school', kind: 'school', name: 'Koivurinteen koulun keittiö',
    description: l3('Koulukeittiö · viikon lounaslista, 350 annosta päivässä', 'Skolkök · veckans lunchlista, 350 portioner per dag', 'School kitchen · weekly lunch menu, 350 portions a day'),
    portionsTotal: 350, authority: { autoApproveLimit: 1500, agentAutoLimit: 500, weeklyBudget: 6000 },
    stock: [{ productId: '460001', amount: 10 }, { productId: '463624', amount: 10 }, { productId: '466090', amount: 5 }, { productId: '465097', amount: 2.5 }],
    demoFile: 'ruokalista-vko47.xlsx', dailySides: true,
  },
  {
    id: 'wedding', kind: 'event', name: 'Juhlapalvelu Kaisla',
    description: l3('Hää- ja juhlacatering · tilaus tapahtuman menun ja vierasmäärän mukaan', 'Bröllops- och festcatering · order enligt evenemangets meny och gästantal', 'Wedding and event catering · order from the event menu and guest count'),
    portionsTotal: 120, authority: { autoApproveLimit: 2500, agentAutoLimit: 800, weeklyBudget: 8000, creditLimit: 5000 },
    stock: [{ productId: '463624', amount: 5 }], demoFile: 'haamenu-kaisla.xlsx', dailySides: false,
  },
  {
    id: 'hotel', kind: 'restaurant', name: 'Hotelli Majakka · ravintola',
    description: l3('Hotellin ravintola · lounas ja aamiainen, ostoagentti käytössä', 'Hotellrestaurang · lunch och frukost, inköpsagent i bruk', 'Hotel restaurant · lunch and breakfast, purchasing agent in use'),
    portionsTotal: 180, authority: { autoApproveLimit: 3000, agentAutoLimit: 750, weeklyBudget: 12000, creditLimit: 20000 },
    stock: [{ productId: '460001', amount: 10 }, { productId: '466090', amount: 2.5 }], demoFile: 'ruokalista-vko47.xlsx', dailySides: true,
  },
  {
    // a sole trader: no menus or portion counts, small orders, small limits, and an own agent with a small mandate
    id: 'cafe', kind: 'cafe', name: 'Kahvila Aamu · yksinyrittäjä',
    description: l3('Yhden hengen kahvila · pienet tilaukset ilman ruokalistaa', 'Enmanscafé · små beställningar utan matsedel', 'One-person café · small orders, no menu'),
    portionsTotal: 40, authority: { autoApproveLimit: 300, agentAutoLimit: 100, weeklyBudget: 500, creditLimit: 1000 },
    stock: [], demoFile: 'ruokalista-vko47.xlsx', dailySides: false,
  },
];
export const DEFAULT_PROFILE = PROFILES[0].id;
export const profileDef = (id?: string) => PROFILES.find(p => p.id === id) ?? PROFILES[0];

function initial(id: string): State {
  const d = profileDef(id);
  return {
    kitchen: { name: d.name, portionsTotal: d.portionsTotal, groups: [], portionsConfirmed: false, authority: { ...d.authority }, memory: [] },
    overrides: {}, swaps: {}, skipped: [], edits: { qty: {}, removed: [] }, draft: [],
    stock: d.stock.map(x => ({ ...x })), orders: [], audit: [], idempotency: {}, quotes: [], agents: [], undo: [], seq: 0,
  };
}

interface Root { profiles: Record<string, State>; agentToken: string; orderSeq: number }
const newToken = () => config.agentToken || 'aimo-agent-' + randomBytes(16).toString('hex');
let root: Root = { profiles: Object.fromEntries(PROFILES.map(p => [p.id, initial(p.id)])), agentToken: newToken(), orderSeq: 0 };

// The active account is carried per request (AsyncLocalStorage), so the UI, the chat and external agents
// can work on different accounts at the same time.
const als = new AsyncLocalStorage<{ profile: string }>();
export const currentProfile = () => profileDef(als.getStore()?.profile);
export function runAs<T>(profile: unknown, fn: () => T): T {
  return als.run({ profile: profileDef(typeof profile === 'string' ? profile : undefined).id }, fn);
}
export const S = (): State => root.profiles[currentProfile().id];
export const agentToken = () => root.agentToken;
/** the registered agent holding this token hash, and the account it is authorised for */
export function agentByTokenHash(hash: string): { agent: StoredAgent; account: string } | undefined {
  for (const p of PROFILES) {
    const agent = root.profiles[p.id].agents.find(a => a.tokenHash === hash);
    if (agent) return { agent, account: p.id };
  }
  return undefined;
}
export const nextOrderNumber = () => ++root.orderSeq;

export function loadState() {
  if (existsSync(config.stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(config.stateFile, 'utf8'));
      if (raw.profiles) {
        root.agentToken = raw.agentToken ?? root.agentToken;
        root.orderSeq = raw.orderSeq ?? 0;
        for (const p of PROFILES) if (raw.profiles[p.id]) root.profiles[p.id] = { ...initial(p.id), ...raw.profiles[p.id] };
      }
    } catch { /* start fresh */ }
  }
  if (config.agentToken) root.agentToken = config.agentToken;
  save();
}

export function save() {
  // older readers of the state file see the selected order card as the single draft
  for (const s of Object.values(root.profiles)) if (s.drafts) s.draft = s.drafts.find(d => d.id === s.activeDraft)?.lines ?? [];
  mkdirSync(dirname(config.stateFile), { recursive: true });
  const tmp = config.stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(root));
  renameSync(tmp, config.stateFile);
}

/** Reset the active account only. */
export function resetState() {
  root.profiles[currentProfile().id] = initial(currentProfile().id);
  save();
}

export function audit(actor: L3, action: string, text: L3, orderId?: string) {
  const state = S();
  const prev = state.audit[state.audit.length - 1]?.hash ?? 'genesis';
  const entry = { id: 'a' + (++state.seq), at: new Date().toISOString(), actor, action, text, orderId };
  // hash chain: altering or removing an earlier entry breaks every later hash
  const hash = createHash('sha256').update(prev + JSON.stringify(entry)).digest('hex');
  state.audit.push({ ...entry, hash });
  if (state.audit.length > 600) state.audit.splice(0, state.audit.length - 600);
  save();
}

export const ACTOR = {
  kitchen: l3('Keittiöpäällikkö', 'Köksmästare', 'Kitchen manager'),
  aimo: l3('Aimo', 'Aimo', 'Aimo'),
  rules: l3('Aimon säännöt', 'Aimos regler', 'Aimo rules'),
  /** the shared demo token: the name is self-declared */
  agent: (name: string) => l3(`Ulkoinen agentti (${name})`, `Extern agent (${name})`, `External agent (${name})`),
  /** an agent identified by its own token */
  registeredAgent: (name: string) => l3(`Rekisteröity agentti (${name})`, `Registrerad agent (${name})`, `Registered agent (${name})`),
  /** a signed-in approver, by name */
  person: (name: string) => l3(name, name, name),
};
