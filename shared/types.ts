// Shared contract between the Aimo backend (server/) and the web UI (web/).
// Every user-facing string that depends on data (allergen reasons, assistant text, issue
// titles, unit labels) is produced by the server in the requested language.

export type Lang = 'fi' | 'sv' | 'en';

/** Dietary requirements. gluten_free and wheat_free are independent; so are lactose_free and milk_free. */
export type Requirement =
  | 'gluten_free' | 'wheat_free' | 'lactose_free' | 'milk_free'
  | 'egg_free' | 'nut_free' | 'soy_free' | 'fish_free';

/** ok = verified from supplier data, fail = not suitable, unknown = data missing/conflicting (never treated as safe). */
export type Verdict = 'ok' | 'fail' | 'unknown';

export interface Evidence {
  /** where the fact comes from */
  kind: 'declared' | 'ingredient' | 'claim' | 'missing' | 'note';
  tone: 'ok' | 'fail' | 'unknown' | 'info';
  text: string;
}

export interface AllergenCheck {
  requirement: Requirement;
  requirementLabel: string; // "Vehnätön"
  verdict: Verdict;
  summary: string; // one sentence, e.g. "Ei sovi vehnättömään: sisältää gluteenitonta vehnätärkkelystä."
  evidence: Evidence[];
}

export interface ProductView {
  id: string;
  name: string;
  brand?: string;
  vendor?: string;
  salesUnit: string; // raw code, e.g. "SK"
  unitLabel: string; // localized, e.g. "säkki"
  /** order quantities must be a multiple of this many sales units (supplier lot size); absent = 1 */
  lotStep?: number;
  packSize?: { value: number; unit: 'kg' | 'L' }; // physical content of one sales unit (structured supplier data only)
  packLabel: string; // "10 kg / säkki" or "pakkauskoko ei tiedossa"
  ingredients?: string; // supplier ingredient list, in the best available language
  declared: { contains: string[]; mayContain: string[]; freeFrom: string[] }; // localized allergen names
  claims: string[]; // localized claims, e.g. "Gluteeniton", "Laktoositon"
  dataUpdated?: string; // ISO date of supplier data
  hasIngredientList: boolean;
  hasAllergenDeclaration: boolean;
  /** historical delivery reliability 0..1 from the challenge dataset (history, not a promise) */
  deliveryReliability?: number;
  /** category-level average kg CO2-eq per kg from the challenge dataset (not a measured SKU footprint) */
  co2PerKg?: number;
  /** Supplier-declared packaging labels, not independently certified by Aimo. */
  packagingLabels?: { id: string; name: string }[];
  countryOfOrigin?: string;
  originLabel?: string;
  packagingLabelNote?: string;
}

export type AvailabilityStatus = 'available' | 'limited' | 'unknown_qty' | 'unavailable' | 'no_data';

/** Live price + availability from the Valio Aimo challenge mock API. */
export interface Offer {
  source: 'valio_mock';
  observedAt: string; // ISO
  price?: number; // EUR excl. VAT per sales unit
  priceWithTax?: number;
  vatRate?: number;
  comparisonPrice?: number; // EUR excl. VAT per kg / L
  comparisonUnit?: string;
  availability: AvailabilityStatus;
  availabilityLabel: string; // localized
  availableAmount?: number; // sales units; absent when the supplier does not state a quantity
  availableDate?: string; // YYYY-MM-DD
  closingTime?: string; // ISO order cutoff
  cutoffPassed?: boolean;
  error?: string;
}

export interface Alternative {
  product: ProductView;
  offer: Offer;
  checks: AllergenCheck[];
  /** all requested requirements are verified ok */
  suitable: boolean;
  note?: string; // e.g. "0,62 €/kg halvempi"
  roles?: { role: 'cheapest' | 'most_reliable' | 'most_sustainable'; label: string }[];
  basis?: {
    costToCover: number; salesUnits: number; coveredAmount: number;
    reliability?: number; packagingLabels: string[]; countryOfOrigin?: string; co2PerKg?: number;
    sustainabilityRule?: string;
  };
  tier?: 'supplier_substitute' | 'same_category' | 'other_verified';
  tierLabel?: string;
}

export interface DietGroup {
  id: string; // 'gluten_free', 'wheat_free', or custom
  label: string; // localized: "Gluteeniton"
  requirements: Requirement[];
  count: number; // portions per day
}

/** One guardrail rule, shown to people and returned to agents as-is. */
export interface PolicyRule { id: string; effect: 'auto' | 'human' | 'never'; text: string }

export interface Authority {
  rules?: PolicyRule[];
  /** orders at or below this total (EUR excl. VAT) may be placed by the kitchen user without a second approval */
  autoApproveLimit: number;
  /** per-order authority of the shared demo token (MCP); registered agents have their own limits, see AgentView */
  agentAutoLimit: number;
  weeklyBudget: number;
  spentThisWeek: number;
  /** Optional credit limit of the customer account, set by the wholesaler. A hard cap on open order value:
   *  no approval can exceed it. Absent = no credit limit on this account. */
  creditLimit?: number;
  creditUsed: number;
  creditAvailable?: number;
}

/** A registered external agent and the authority granted to it. Its bearer token is never part of any view. */
export interface AgentView {
  id: string;
  name: string;
  /** the agent may place an order on its own up to this total (EUR excl. VAT) */
  perOrderLimit: number;
  /** ... and up to this much in total within 7 days (EUR excl. VAT) */
  weeklyLimit: number;
  /** what it has ordered on its own authority in the last 7 days */
  spentThisWeek: number;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  status: 'active' | 'expired' | 'revoked';
  statusLabel: string;
}

/** A customer account / kitchen profile. Each has its own menu, orders, limits and memory. */
export interface ProfileInfo {
  id: string;
  name: string;
  /** school = weekly lunch menu; event = one event with courses and a guest count; restaurant = weekly lunch menu */
  kind: 'school' | 'event' | 'restaurant' | 'cafe';
  description: string;
}

export interface Kitchen {
  name: string;
  kind: ProfileInfo['kind'];
  /** localized unit for portionsTotal: "annosta päivässä" / "vierasta" */
  portionLabel: string;
  portionsTotal: number;
  standardCount: number;
  groups: DietGroup[];
  portionsConfirmed: boolean;
  authority: Authority;
  /** things Aimo has learned and reuses (approved substitutions etc.) */
  memory: { id: string; text: string; at: string }[];
}

export type CourseRole = 'main' | 'drink' | 'dessert';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface MenuDay {
  /** unique key of this menu entry; pass it as `date` in confirm_recipe / skip_day (equals the date for weekly menus) */
  id: string;
  /** course label for event menus, e.g. "Alkuruoka" */
  label?: string;
  role?: CourseRole;
  roleProblem?: string;
  date: string; // YYYY-MM-DD
  weekday: Weekday;
  weekdayLabel: string; // "Maanantai"
  dishName: string; // as imported
  /** confirmed = linked to an approved kitchen recipe; suggested = Aimo proposes a recipe, needs confirmation;
   *  missing = no approved recipe found; skipped = the user removed the dish (nothing is ordered for this day);
   *  custom = the kitchen's own dish, named by the user: no recipe, no quantities, nothing ordered automatically */
  match: 'confirmed' | 'suggested' | 'missing' | 'skipped' | 'custom';
  recipeId?: string;
  recipeName?: string;
  suggestion?: { recipeId: string; recipeName: string; why: string };
  /** match 'custom': the dish name the user typed (1–60 characters) */
  customName?: string;
  /** match 'skipped': what `restore_day` brings back (a recipe, the kitchen's own dish or the imported dish) */
  removedDish?: string;
  /** the approved recipe of this entry's role that the imported dish name points to: exact = same name or alias,
   *  otherwise the closest by name (a suggestion only) */
  importRecipe?: { recipeId: string; exact: boolean };
  portions: number;
  importedPortions?: number; // if the file stated a portion count
  dietNotes?: string[]; // dietary info found in the file
}

export interface WeekMenu {
  /** week = one dish per weekday; event = several courses for one event date */
  kind: 'week' | 'event';
  weekStart: string;
  weekLabel: string; // "Viikko 47 · 16.–20.11."
  source: { filename: string; kind: 'xlsx' | 'pdf' | 'demo' | 'manual'; importedAt: string };
  days: MenuDay[];
  warnings: string[];
}

export interface RecipeSummary {
  id: string; name: string; ingredientCount: number; role: CourseRole;
  /** normalized names in fi/sv/en and the recipe's aliases: typing one of these exactly means this recipe */
  names?: string[];
  /** normalized hint words: a search also finds the recipe by these (never an automatic match) */
  hints?: string[];
}

export interface LineUse {
  date: string;
  weekdayLabel: string;
  recipeName: string;
  ingredient: string;
  groupLabel: string; // "Perusannokset" / "Vehnätön"
  amount: number;
  unit: 'kg' | 'L';
}

export interface PlanLine {
  id: string;
  product: ProductView;
  offer: Offer;
  ingredient: string; // "Makaroni"
  needed: number; // physical amount for the week
  unit: 'kg' | 'L';
  fromStock: number; // physical amount covered by known stock
  orderQty: number; // sales units to order (editable)
  orderedAmount: number; // orderQty * packSize
  lineTotal?: number; // EUR excl. VAT
  groupLabels: string[]; // who this product is for
  uses: LineUse[];
  checks: AllergenCheck[]; // checks against the requirements of the groups it serves
  status: 'ok' | 'warning' | 'blocked';
  why: string; // why this product was selected
  changed?: string; // what changed vs. the kitchen's usual product, if anything
  /** present when the quantity was set by hand: the quantity Aimo calculated (sales units); `reset_line_qty` restores it */
  calculatedQty?: number;
  /** present when the user switched this line's product (`swap_line`): the earlier product that `restore_product` brings back */
  swappedFrom?: string;
}

export type IssueKind =
  | 'allergen_fail' | 'allergen_unknown' | 'missing_recipe' | 'suggested_recipe'
  | 'unavailable' | 'cutoff' | 'no_price' | 'portions' | 'credit';

export interface Issue {
  id: string;
  kind: IssueKind;
  severity: 'block' | 'warn';
  title: string;
  detail: string;
  date?: string;
  recipeName?: string;
  ingredient?: string;
  groupLabel?: string;
  product?: ProductView; // the product that failed
  check?: AllergenCheck; // why it failed
  alternatives?: Alternative[]; // verified suggestions (first = recommended)
  /** recipe suggestion for missing_recipe / suggested_recipe */
  recipeOptions?: { recipeId: string; recipeName: string; why?: string }[];
  resolved: boolean;
  resolution?: string;
}

export interface Totals { net: number; vat: number; gross: number; lineCount: number }

export interface Plan {
  id: string;
  weekStart: string;
  weekLabel: string;
  createdAt: string;
  deliveryDate: string;
  deliveryLabel: string; // "ma 16.11."
  lines: PlanLine[];
  issues: Issue[];
  totals: Totals;
  /** true when no blocking issue remains */
  ready: boolean;
  orderId?: string;
  /** menu entries this order does not cover: removed dishes and the kitchen's own dishes (no recipe, nothing ordered).
   *  `date` is the entry id, `day` its localized label, `name` the dish. Informational, never blocking. */
  notCovered?: { date: string; day: string; name: string; kind: 'skipped' | 'custom' }[];
  /** lines the user removed from this proposal; `restore_line` brings one back at the calculated quantity */
  removedLines?: { id: string; name: string; ingredient: string }[];
}

/** An order card ("draft" in code) a user builds from search results: explicit products in sales units. An account
 *  can have several open cards, each with its own name and delivery date; one of them is selected. */
export interface DraftLine {
  product: ProductView;
  offer: Offer;
  qty: number; // sales units, a multiple of product.lotStep
  lineTotal?: number; // EUR excl. VAT
  checks: AllergenCheck[]; // requirements of the search the product was added from
}
export interface Draft {
  /** order card id: pass it as draftId in draft_* actions */
  id: string;
  /** the buyer's own name, or a numbered default ("Kortti 2"); becomes the order title */
  name: string;
  deliveryDate: string;
  deliveryLabel: string;
  /** the delivery date is before today: the card cannot be ordered until the date is changed */
  pastDate?: boolean;
  lines: DraftLine[];
  totals: Totals;
}

/** One ingredient of an ingredient search, as structured data so the UI need not read the card's free text. */
export interface IngredientGroup {
  /** the ingredient as named in the list, e.g. "Sokeri" */
  name: string;
  /** the stated amount, localized ("2 kg"); absent when none was given */
  amount?: string;
  /** found = verified options, the first one fits; choose = several product types match, the buyer picks (nothing
   *  is preselected); none = no verified, orderable product */
  status: 'found' | 'choose' | 'none';
  /** why a choice is needed or why nothing was found (localized) */
  reason?: string;
  /** products left out by the supplier-data check (localized), when there are options anyway */
  excluded?: string;
}

export type OrderStatus = 'pending_approval' | 'approved' | 'submitted' | 'rejected' | 'cancelled';

export interface OrderLine {
  productId: string;
  name: string;
  qty: number;
  unitLabel: string;
  packLabel: string;
  unitPrice: number;
  lineTotal: number;
  groupLabels: string[];
  checks: AllergenCheck[];
  why?: string;
  substituteFor?: string;
  substitution?: boolean;
  substitutionLabel?: string;
}

export interface OrderEvent { at: string; actor: string; text: string }

/** Original signed commitment, retained with the order even after quote cleanup. */
export interface QuoteProof {
  id: string;
  issuer: string;
  account: string;
  recipient: { id: string | null; name: string; identity: 'kitchen' | 'registered' | 'self_declared' };
  createdAt: string;
  expiresAt: string;
  observedAt: string;
  signed: string;
}

export interface Order {
  id: string; // "AIMO-2026-0012"
  status: OrderStatus;
  statusLabel: string;
  createdAt: string;
  createdBy: string; // "Keittiö (UI)" | "Agentti: <name>"
  source: 'ui' | 'mcp';
  title: string;
  deliveryDate: string;
  deliveryLabel: string;
  lines: OrderLine[];
  totals: Totals;
  approval: {
    required: boolean;
    reasons: string[]; // why human approval is needed (localized)
    decidedBy?: string;
    decidedAt?: string;
  };
  /** result of the pre-submission recheck (prices, availability, allergens) */
  recheck?: { at: string; ok: boolean; changes: string[] };
  /** what is real mock integration and what is simulated locally */
  integration: { prices: 'valio_mock'; availability: 'valio_mock'; submission: 'local_simulation'; note: string };
  confirmation?: string; // simulated supplier confirmation number
  quoteId?: string;
  quote?: QuoteProof; // absent on legacy orders without a retained signed quote
  signedConfirmation?: string;
  events: OrderEvent[];
}

/** hash = SHA-256 over the previous entry's hash and this entry: the log is tamper-evident. */
export interface AuditEntry { id: string; at: string; actor: string; action: string; text: string; orderId?: string; hash?: string }

export interface Attention {
  id: string;
  tone: 'block' | 'warn' | 'info';
  text: string;
  /** optional action the UI can trigger when tapped */
  action?: UiAction;
}

export interface Delivery { date: string; label: string; orderId: string; status: OrderStatus; statusLabel: string; lineCount: number; total: number }

export interface StockItem { productId: string; name: string; amount: number; unit: 'kg' | 'L' }

export interface DashboardState {
  /** the active account and all selectable accounts; send `profile=<id>` with every request */
  profile: ProfileInfo;
  profiles: ProfileInfo[];
  lang: Lang;
  now: string;
  kitchen: Kitchen;
  menu?: WeekMenu;
  plan?: Plan;
  /** the selected order card, present while it has lines */
  draft?: Draft;
  /** every open order card of the account (also empty ones), oldest first */
  drafts: Draft[];
  /** id of the selected order card: products are added to it */
  activeDraft?: string;
  orders: Order[];
  deliveries: Delivery[];
  attention: Attention[];
  stock: StockItem[];
  recipes: RecipeSummary[];
  audit: AuditEntry[];
  /** external agents registered for this account */
  agents: AgentView[];
  integration: {
    valioMock: { ok: boolean; label: string; checkedAt?: string };
    llm: { ok: boolean; label: string };
    ordering: { label: string }; // "Tilaus kirjataan paikalliseen simulaatioon"
    /** open = no approvers are configured (demo mode): anyone using the UI can approve. Otherwise approving,
     *  rejecting and changing authority need a signed-in approver (POST /api/login). */
    access: { open: boolean; label: string };
  };
  /** prompts to show as chips above the input */
  suggestions: string[];
  /** present while a plan edit can be undone: what the next `undo` would take back, and how many steps are stored */
  undo?: { label: string; steps: number };
}

// ---------- cards: structured results shown in the workspace instead of chat text ----------

/** One approved recipe offered for a menu day. The button next to it sends `confirm_recipe` for `recipeChoices.date`. */
export interface RecipeChoice {
  recipeId: string;
  recipeName: string;
  /** one sentence: why this recipe is offered */
  why: string;
  /** short facts: price estimate, open items */
  facts?: string[];
}

export type Card =
  | { type: 'note'; tone: 'info' | 'ok' | 'warn' | 'block'; title?: string; text: string;
      /** approved recipes the user can pick for one menu day (a recommendation, or the closest match to a requested dish) */
      recipeChoices?: { date: string; options: RecipeChoice[] } }
  | { type: 'menu'; menu: WeekMenu }
  | { type: 'portions'; kitchen: Kitchen }
  | { type: 'issue'; issue: Issue }
  | { type: 'plan'; plan: Plan }
  | { type: 'draft'; draft: Draft }
  | { type: 'comparison'; title: string; subtitle?: string; lineId?: string; current?: Alternative; items: Alternative[] }
  | { type: 'products'; title: string; subtitle?: string; items: Alternative[]; ingredient?: IngredientGroup }
  | { type: 'order'; order: Order }
  | { type: 'audit'; entries: AuditEntry[] };

// ---------- UI actions (POST /api/action) ----------

export type UiAction =
  | { type: 'confirm_recipe'; date: string; recipeId: string }
  | { type: 'set_course'; date: string; role: CourseRole }
  /** remove the dish of a menu entry: nothing is ordered for it; the earlier choice is kept for `restore_day`.
   *  Removing the last dish that is left removes the whole menu, as `clear_menu` does. */
  | { type: 'skip_day'; date: string }
  /** remove the whole menu and the edits of its shopping list. Orders, order drafts, portions and diet groups, the
   *  kitchen's memory and approved replacements, agents and limits stay. Undo brings the menu back exactly. */
  | { type: 'clear_menu' }
  /** bring back what a removed entry had before (`skip_day`); entries removed before this was stored are linked again
   *  the way the import links them */
  | { type: 'restore_day'; date: string }
  /** the kitchen's own dish for an entry, by name (1–60 characters): no recipe, no quantities, nothing ordered for it.
   *  A name that is exactly an approved recipe of the entry's role links that recipe instead. */
  | { type: 'set_custom_dish'; date: string; name: string }
  | { type: 'set_portions'; total?: number; groups?: { requirement: Requirement; count: number }[] }
  | { type: 'build_plan' }
  | { type: 'resolve_issue'; issueId: string; productId: string }
  /** leave the affected line out of the order instead of resolving it (nothing unverified is ordered) */
  | { type: 'skip_issue'; issueId: string }
  /** open a resolved allergen item again (an accepted alternative or a left-out line): the choice and the kitchen's memory
   *  of it are removed, and the item blocks the order until it is resolved again */
  | { type: 'reopen_issue'; issueId: string }
  /** demo control: set or clear (null) the account's credit limit */
  | { type: 'set_credit_limit'; limit: number | null }
  /** register an external agent for the account; the response carries its bearer token once (issuedToken) */
  | { type: 'agent_create'; name: string; perOrderLimit: number; weeklyLimit: number; validDays: number }
  | { type: 'agent_update'; agentId: string; perOrderLimit: number; weeklyLimit: number }
  | { type: 'agent_revoke'; agentId: string }
  | { type: 'swap_line'; lineId: string; productId: string }
  /** take back a product switch of a line: the earlier product (re-checked by the rules) comes back */
  | { type: 'restore_product'; lineId: string }
  | { type: 'set_line_qty'; lineId: string; qty: number }
  /** drop a hand-set quantity: the line goes back to the calculated quantity */
  | { type: 'reset_line_qty'; lineId: string }
  | { type: 'remove_line'; lineId: string }
  /** put a removed line back on the proposal, at the calculated quantity */
  | { type: 'restore_line'; lineId: string }
  | { type: 'find_cheaper'; lineId?: string }
  | { type: 'create_order' }
  /** take back the latest plan edit (menu days, portions, accepted alternatives, product switches, left-out items, line edits) */
  | { type: 'undo' }
  /** order card: set the quantity (sales units) of a product; adds the line, qty 0 removes it. `requirements`
   *  are the dietary requirements the product was searched with; the product must be verified for them.
   *  `draftId` absent = the selected card; without any card the first addition creates one. */
  | { type: 'draft_set'; productId: string; qty: number; requirements?: Requirement[]; draftId?: string }
  /** create an order from an order card (same checks as every other order); `draftId` absent = the selected card */
  | { type: 'draft_order'; draftId?: string }
  | { type: 'show_draft'; draftId?: string }
  /** a new order card, selected at once: name optional (numbered default), delivery date optional (the default day) */
  | { type: 'draft_create'; name?: string; deliveryDate?: string }
  /** rename an order card or change its delivery date (YYYY-MM-DD, today or later); an empty name = the default */
  | { type: 'draft_update'; draftId: string; name?: string; deliveryDate?: string }
  /** delete an order card and its lines; nothing is ordered */
  | { type: 'draft_delete'; draftId: string }
  /** make an order card the target for additions */
  | { type: 'draft_select'; draftId: string }
  | { type: 'approve_order'; orderId: string }
  | { type: 'reject_order'; orderId: string }
  | { type: 'cancel_order'; orderId: string }
  | { type: 'show_order'; orderId: string }
  | { type: 'show_audit' }
  | { type: 'show_plan' }
  | { type: 'show_menu' }
  | { type: 'load_demo_menu' }
  | { type: 'reset_demo' };

/** Response of POST /api/chat, POST /api/import and POST /api/action. */
export interface TurnResponse {
  reply: string; // one or two short sentences from Aimo
  cards: Card[];
  state: DashboardState;
  /** only in the answer to agent_create: the new agent's bearer token. It is not stored and cannot be read again. */
  issuedToken?: { agentId: string; name: string; token: string };
}

export interface AgentInfo {
  mcpUrl: string;
  /** the shared demo token (self-declared agent name). Absent when approvers are configured and the caller is not signed in. */
  token?: string;
  tokenNote: string;
  /** public key for verifying signed quotes and order confirmations (JWK Set) */
  jwksUrl: string;
  tools: { name: string; description: string }[];
  note: string;
}
