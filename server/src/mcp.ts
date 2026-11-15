// MCP interface for EXTERNAL purchasing agents (Model Context Protocol, Streamable HTTP).
// An agent can search products, read prices/availability, check allergens, prepare a fixed-price
// quote, place an order within its authority, ask a human for approval and follow the order —
// without our UI. The same rules as the UI apply: the agent proposes, the rules decide.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Alternative, Lang, Requirement } from '../../shared/types.ts';
import { agentStatus, agentWeekSpend, tokenHash } from './agents.ts';
import { REQUIREMENTS, checkAll } from './allergens.ts';
import { auditView } from './app.ts';
import { type CatalogProduct, getProduct, localName, lotStep, productView, searchProducts } from './catalog.ts';
import { parseLang } from './i18n.ts';
import { type NewOrder, authorityView, createOrder, findOrder, getQuote, orderView, ordersView, policyRules, prepareQuote, sourceNeed, needSubstitutes, sourcingLines } from './orders.ts';
import { UserError, weekSpend } from './planner.ts';
import { signatureInfo } from './signing.ts';
import { ACTOR, PROFILES, S, type StoredAgent, agentByTokenHash, agentToken, currentProfile, l3, pick, runAs } from './store.ts';
import { fetchOffers, toOffer } from './valio.ts';

const PROVENANCE = {
  catalog: 'Valio Aimo Junction 2026 challenge product catalog (synthetic). Allergen verdicts are computed by deterministic rules from supplier-declared allergens, the supplier ingredient list and regulated claims; missing data yields "unknown", never "ok".',
  prices_and_availability: 'Valio Aimo challenge mock API (POST /api/price, POST /api/availability), fetched live; each offer carries observedAt.',
  order_submission: 'LOCAL SIMULATION. The challenge mock API has no order endpoint; nothing is sent to Valio Aimo.',
  signatures: 'signed_quote and signed_confirmation are signed by this Aimo server (EdDSA). A valid signature proves that this server issued exactly that content and that it was not altered. It does not prove that the Valio Aimo mock data behind the figures is correct: the mock does not sign its answers.',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const reqSchema = z.array(z.enum(REQUIREMENTS as [Requirement, ...Requirement[]])).optional()
  .describe('Dietary requirements every product must be VERIFIED for. gluten_free and wheat_free are independent (a gluten-free product may contain gluten-free wheat starch); lactose_free and milk_free are independent.');
const langSchema = z.enum(['fi', 'sv', 'en']).optional().describe('Language of human-readable explanations (default en).');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Requested delivery date, YYYY-MM-DD.');

function describe(p: CatalogProduct, reqs: Requirement[], lang: Lang, raw?: Parameters<typeof toOffer>[0], qty = 0) {
  const v = productView(p, lang);
  const checks = checkAll(p, reqs, lang);
  const offer = raw === undefined ? undefined : toOffer(raw, lang, qty);
  return {
    product_id: p.id, name: localName(p, lang), brand: v.brand, vendor: v.vendor, gtin: p.gtin,
    sales_unit: p.su, pack: v.packSize ? { amount: v.packSize.value, unit: v.packSize.unit } : null, order_multiple: lotStep(p),
    ingredients: v.ingredients ?? null, declared_allergens: v.declared, claims: v.claims,
    supplier_data_updated: v.dataUpdated ?? null,
    packaging_labels: v.packagingLabels, country_of_origin: v.countryOfOrigin ?? null,
    packaging_label_note: v.packagingLabelNote,
    delivery_reliability_history: p.rel ?? null, co2_kg_per_kg_category_average: p.co2 ?? null,
    requirement_checks: checks.map(c => ({ requirement: c.requirement, verdict: c.verdict, summary: c.summary, evidence: c.evidence })),
    suitable: checks.every(c => c.verdict === 'ok'),
    offer: offer && {
      price_eur_excl_vat_per_sales_unit: offer.price ?? null, price_eur_incl_vat: offer.priceWithTax ?? null, vat_rate: offer.vatRate ?? null,
      comparison_price: offer.comparisonPrice ?? null, comparison_unit: offer.comparisonUnit ?? null,
      availability: offer.availability, available_sales_units: offer.availableAmount ?? null, available_date: offer.availableDate ?? null,
      order_cutoff: offer.closingTime ?? null, cutoff_passed: offer.cutoffPassed ?? null, note: offer.availabilityLabel,
      source: 'valio_mock', observed_at: offer.observedAt, error: offer.error ?? null,
    },
  };
}

function rankedOption(o: Alternative) {
  return {
    product_id: o.product.id, name: o.product.name, note: o.note, availability: o.offer.availability,
    roles: o.roles ?? [],
    basis: o.basis && {
      cost_to_cover_eur_excl_vat: o.basis.costToCover, sales_units: o.basis.salesUnits, covered_amount: o.basis.coveredAmount,
      delivery_reliability_history: o.basis.reliability ?? null, packaging_labels: o.basis.packagingLabels,
      country_of_origin: o.basis.countryOfOrigin ?? null, co2_kg_per_kg_category_average: o.basis.co2PerKg ?? null,
      sustainability_rule: o.basis.sustainabilityRule,
    },
    tier: o.tier, tier_label: o.tierLabel,
    delivery_reliability_history: o.product.deliveryReliability ?? null,
    packaging_labels: o.product.packagingLabels, country_of_origin: o.product.countryOfOrigin ?? null,
    packaging_label_note: o.product.packagingLabelNote,
    requirement_checks: o.checks.map(c => ({ requirement: c.requirement, verdict: c.verdict, summary: c.summary })),
    suitable: o.suitable,
  };
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> });
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message, ...extra }, null, 2) }] });

async function guard<T>(lang: Lang, fn: () => Promise<T>) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof UserError) return fail(e.code ?? 'rejected_by_rules', pick(lang, e.text), e.extra);
    return fail('internal_error', String((e as Error).message));
  }
}

export const MCP_TOOLS = [
  { name: 'get_authority', description: 'What this agent may decide alone, what needs human approval and what is never allowed; its own authorisation (limits, remaining weekly allowance, expiry), whether its identity is registered or self-declared, and the account’s budget.' },
  { name: 'search_products', description: 'Search the catalog. Returns products with pack size, ingredient list, declared allergens, per-requirement verdicts with evidence, live price and availability.' },
  { name: 'get_price_availability', description: 'Fresh price and availability for specific product ids and a delivery date (Valio Aimo challenge mock API).' },
  { name: 'check_allergens', description: 'Explain, with evidence from supplier data, whether a product meets given dietary requirements (ok / fail / unknown).' },
  { name: 'prepare_order', description: 'Build ONE fixed-price quote for a whole order: explicit items, needs such as "1000 L lactose-free milk" (each sourced, ranked and split across products if availability is partial), or both together. A quote can be turned into one order only. The quote is also returned signed (signed_quote, JWS with EdDSA).' },
  { name: 'place_order', description: 'Place a quoted order. Succeeds only inside the agent’s granted authority; otherwise returns approval_required.' },
  { name: 'request_approval', description: 'Send a quoted order to a human for approval. It appears in the kitchen UI; poll get_order_status.' },
  { name: 'get_order_status', description: 'Status, approval decision, re-check result, confirmation and event history of an order. A submitted order carries a signed confirmation (signed_confirmation, JWS with EdDSA).' },
  { name: 'list_orders', description: 'Recent orders with status and totals.' },
  { name: 'get_audit_log', description: 'Human-readable, hash-chained record of actions and approvals (optionally for one order).' },
];
const desc = (name: string) => MCP_TOOLS.find(t => t.name === name)!.description;

/** `agent`: the registered agent the token belongs to; undefined for the shared demo token (self-declared name). */
function buildServer(agentName: string, agent?: StoredAgent): McpServer {
  const server = new McpServer({ name: 'aimo-purchasing', version: '1.0.0' }, {
    instructions: 'Aimo exposes a food-service wholesaler assortment (Valio Aimo challenge data) to purchasing agents. Typical flow: get_authority → search_products (with requirements) → prepare_order → place_order if within authority, otherwise request_approval → get_order_status. Products whose requirement verdict is "fail" or "unknown" can never be ordered for that requirement. Prices are fixed per quote; quotes expire after 15 minutes and produce at most one order. Order quantities are whole sales units in multiples of order_multiple.',
  });
  const actor = agent ? ACTOR.registeredAgent(agentName) : ACTOR.agent(agentName);
  const identity = agent ? 'registered' : 'self_declared';
  // idempotency keys of a registered agent are its own: another agent's key never returns this agent's order
  const idem = (key: string) => `mcp-${agent ? agent.id + '-' : ''}${key}`;

  server.registerTool('get_authority', { description: desc('get_authority'), inputSchema: { lang: langSchema } }, async ({ lang }) => {
    const L = parseLang(lang ?? 'en');
    const a = authorityView(L, agent);
    const own = agent ? agentWeekSpend(agent.id) : 0;
    const account = { id: currentProfile().id, name: currentProfile().name, kind: currentProfile().kind };
    return ok({
      agent: agentName, identity,
      identity_note: agent
        ? 'Registered agent: the name and the account come from the bearer token. X-Agent-Name is ignored and another account in X-Aimo-Account is refused.'
        : 'Shared demo token: the agent name is self-declared (X-Agent-Name) and not verified, and the account is chosen with X-Aimo-Account.',
      // what this agent may decide alone; the account-wide budget and credit limit below apply on top of it
      authorization: agent
        ? { agent_id: agent.id, per_order_limit_excl_vat: agent.authority.perOrderLimit, weekly_limit_excl_vat: agent.authority.weeklyLimit, ordered_alone_last_7_days: own, weekly_remaining: Math.max(0, round2(agent.authority.weeklyLimit - own)), expires_at: agent.expiresAt }
        : { agent_id: null, per_order_limit_excl_vat: a.agentAutoLimit, weekly_limit_excl_vat: null, ordered_alone_last_7_days: null, weekly_remaining: null, expires_at: null },
      account,
      available_accounts: agent ? [{ id: account.id, name: account.name }] : PROFILES.map(p => ({ id: p.id, name: p.name })),
      account_selection: agent ? 'Fixed by the bearer token.' : 'HTTP header X-Aimo-Account: <id> (default: school)',
      currency: 'EUR',
      credit_limit_incl_vat: a.creditLimit ?? null, credit_used: a.creditUsed, credit_available: a.creditAvailable ?? null,
      per_order_limit_excl_vat: agent ? agent.authority.perOrderLimit : a.agentAutoLimit, weekly_budget: a.weeklyBudget, spent_this_week: a.spentThisWeek, remaining_this_week: Math.max(0, Math.round((a.weeklyBudget - weekSpend()) * 100) / 100),
      rules: policyRules(L, agent), supported_requirements: REQUIREMENTS, signing: signatureInfo(), provenance: PROVENANCE,
    });
  });

  server.registerTool('search_products', {
    description: desc('search_products'),
    inputSchema: { query: z.string().min(2).describe('Search words; the catalog is Finnish (e.g. "laktoositon maitojuoma"), Swedish and English names also match.'), requirements: reqSchema, delivery_date: dateSchema.optional(), only_suitable: z.boolean().optional().describe('Return only products verified for all requirements.'), limit: z.number().int().min(1).max(20).optional(), lang: langSchema },
  }, async ({ query, requirements, delivery_date, only_suitable, limit, lang }) => guard(parseLang(lang ?? 'en'), async () => {
    const L = parseLang(lang ?? 'en');
    const reqs = requirements ?? [];
    let found = searchProducts(query, { limit: 40 });
    if (only_suitable) found = found.filter(p => checkAll(p, reqs, L).every(c => c.verdict === 'ok'));
    found = found.slice(0, limit ?? 8);
    const date = delivery_date ?? nextMonday();
    const offers = await fetchOffers(found.map(p => p.id), date);
    return ok({ query, requirements: reqs, delivery_date: date, count: found.length, products: found.map(p => describe(p, reqs, L, offers.get(p.id) ?? null as any)), provenance: PROVENANCE });
  }));

  server.registerTool('get_price_availability', {
    description: desc('get_price_availability'),
    inputSchema: { product_ids: z.array(z.string()).min(1).max(30), delivery_date: dateSchema, lang: langSchema },
  }, async ({ product_ids, delivery_date, lang }) => guard(parseLang(lang ?? 'en'), async () => {
    const L = parseLang(lang ?? 'en');
    const offers = await fetchOffers(product_ids, delivery_date, true);
    return ok({ delivery_date, offers: product_ids.map(id => { const p = getProduct(id); return p ? describe(p, [], L, offers.get(id) ?? null as any) : { product_id: id, error: 'unknown_product' }; }), provenance: PROVENANCE });
  }));

  server.registerTool('check_allergens', {
    description: desc('check_allergens'),
    inputSchema: { product_id: z.string(), requirements: reqSchema, lang: langSchema },
  }, async ({ product_id, requirements, lang }) => {
    const L = parseLang(lang ?? 'en');
    const p = getProduct(product_id);
    if (!p) return fail('unknown_product', `No product ${product_id}`);
    return ok({ ...describe(p, requirements ?? REQUIREMENTS, L), provenance: PROVENANCE.catalog });
  });

  const substituteSchema = z.string().optional().describe('Product id being replaced. Must exist and differ from the selected product. A replacement not previously accepted by this account requires human approval.');
  const needSchema = z.object({ substitute_for: substituteSchema, query: z.string().describe('product type in catalog words, e.g. "laktoositon maitojuoma", "alkoholiton olut"'), amount: z.number().positive(), unit: z.enum(['L', 'kg', 'pcs']).describe('L, kg, or pcs = pieces (bottles, cans, packs)'), product_id: z.string().optional().describe('restrict to one product; shortfall is then reported instead of substituted') });
  server.registerTool('prepare_order', {
    description: desc('prepare_order'),
    inputSchema: {
      delivery_date: dateSchema, requirements: reqSchema,
      items: z.array(z.object({ product_id: z.string(), substitute_for: substituteSchema, quantity: z.number().int().positive().describe('sales units; must be a multiple of the product’s order_multiple') })).optional().describe('Explicit products. Can be combined with needs in the same quote.'),
      needs: z.array(needSchema).min(1).max(20).optional().describe('Several needs for one order. Each is sourced on its own; a need without a suitable product is reported in fulfilment_by_need and does not stop the others.'),
      need: needSchema.optional().describe('A single need; same as needs with one entry.'),
      lang: langSchema,
    },
  }, async ({ delivery_date, requirements, items, needs, need, lang }) => guard(parseLang(lang ?? 'en'), async () => {
    const L = parseLang(lang ?? 'en');
    const reqs = requirements ?? [];
    const wanted = [...(need ? [need] : []), ...(needs ?? [])];
    if (!wanted.length && !items?.length) return fail('invalid_request', 'Provide items, need or needs.');
    const invalidSubstitute = () => new UserError(l3('Korvattavan tuotteen on oltava olemassa ja eri tuote; yhdellä rivillä voi korvata vain yhden tuotteen.', 'Produkten som ersätts måste finnas och vara en annan produkt; en rad kan ersätta endast en produkt.', 'The replaced product must exist and differ from the selected product; a line can replace only one product.'), 'invalid_request');
    for (const n of [...wanted, ...(items ?? [])]) {
      if (n.substitute_for !== undefined && (!getProduct(n.substitute_for) || n.substitute_for === n.product_id)) throw invalidSubstitute();
    }
    // every need is sourced with the same rules; one without a verified, orderable product does not block the rest
    const sourced: { need: (typeof wanted)[number]; s: Awaited<ReturnType<typeof sourceNeed>>; substitutes?: Alternative[] }[] = [];
    for (const n of wanted) {
      const s = await sourceNeed(n.query, n.amount, n.unit, reqs, delivery_date, L, n.product_id);
      const substitutes = n.product_id && s.shortfall > 0 ? await needSubstitutes(n.product_id, n.query, s.shortfall, n.unit, reqs, delivery_date, L) : undefined;
      sourced.push({ need: n, s, substitutes });
    }
    const lines: NewOrder['lines'] = [];
    const add = (l: (typeof lines)[number], substituteFor?: string) => {
      if (substituteFor !== undefined) {
        if (substituteFor === l.productId) throw invalidSubstitute();
        const st = S();
        const accepted = Object.values(st.overrides).includes(l.productId) || Object.values(st.swaps).includes(l.productId)
          || st.orders.some(o => o.status === 'submitted' && o.lines.some(x => x.productId === l.productId));
        l.substituteFor = substituteFor;
        l.substitution = !accepted;
      }
      const same = lines.find(x => x.productId === l.productId);
      if (same) {
        if (same.substituteFor && l.substituteFor && same.substituteFor !== l.substituteFor) throw invalidSubstitute();
        same.qty += l.qty;
        same.substituteFor ??= l.substituteFor;
        same.substitution ||= l.substitution;
      } else lines.push(l);
    };
    for (const { need: n, s } of sourced) for (const l of sourcingLines(s, reqs)) add(l, n.substitute_for);
    for (const i of items ?? []) add({ productId: i.product_id, qty: i.quantity, reqs, groupIds: [] }, i.substitute_for);
    const byNeed = sourced.map(({ need: n, s, substitutes }) => ({
      query: n.query, status: s.selectionRequired ? 'selection_required' : !s.allocation.length ? 'not_found' : s.shortfall > 0 ? 'partial' : 'covered',
      selection_reason: s.selectionRequired,
      requested: s.requested, covered: s.covered, shortfall: s.shortfall, unit: s.unit, split_across_products: s.allocation.length,
      lines: s.allocation.map(a => ({ product_id: a.product.id, quantity: a.qty })),
      ranked_options: s.options.map(rankedOption),
      substitute_options: substitutes?.map(o => ({ ...rankedOption(o), substitute_for: n.product_id })),
      excluded_by_rules: s.excluded,
    }));
    if (!lines.length) return fail(sourced.some(x => x.s.selectionRequired) ? 'selection_required' : 'no_suitable_product', 'No lines allocated. Inspect fulfilment_by_need and select explicit products or refine the query.', { excluded: sourced[0].s.excluded, fulfilment_by_need: byNeed });
    const request = [...wanted.map(n => `${n.amount} ${n.unit} ${n.query}`), ...(items?.length ? [`${items.length} items`] : [])].join(' + ');
    const short = sourced.filter(x => x.s.allocation.length && x.s.shortfall > 0).map(x => ({ amount: x.s.shortfall, unit: x.s.unit as string }));
    const { quote: q, verified: v } = await prepareQuote({ source: 'mcp', actor, agentName, agentId: agent?.id, request, deliveryDate: delivery_date, lines, shortfall: short.length ? short : undefined, lang: L });
    const single = sourced.length === 1 ? byNeed[0] : undefined; // one need: the summary fields at the top level, as before
    return ok({
      quote_id: q.id, expires_at: q.expiresAt, content_sha256: q.hash, signed_quote: q.proof!.signed, signature: signatureInfo(), delivery_date, requirements: reqs, currency: 'EUR',
      lines: v.lines.map(l => { const p = getProduct(l.productId)!; return { product_id: l.productId, name: localName(p, L), quantity: l.qty, sales_unit: p.su, pack: p.per ? { amount: p.per.v, unit: p.per.u } : null, order_multiple: lotStep(p), unit_price_excl_vat: l.unitPrice, line_total_excl_vat: Math.round(l.qty * l.unitPrice * 100) / 100, why: l.why ? pick(L, l.why) : undefined, substitute_for: l.substituteFor, substitution: l.substitution, requirement_checks: checkAll(p, l.reqs, L).map(c => ({ requirement: c.requirement, verdict: c.verdict, summary: c.summary })) }; }),
      total_excl_vat: v.net, vat: v.vat, total_incl_vat: Math.round((v.net + v.vat) * 100) / 100,
      fulfilment: single && { requested: single.requested, covered: single.covered, shortfall: single.shortfall, unit: single.unit, split_across_products: single.split_across_products },
      ranked_options: single?.ranked_options,
      substitute_options: single?.substitute_options,
      excluded_by_rules: single?.excluded_by_rules,
      fulfilment_by_need: byNeed.length ? byNeed : undefined,
      within_agent_authority: v.reasons.length === 0,
      approval_required_because: v.reasons.map(r => pick(L, r)),
      notes: v.notes.map(n => pick(L, n)),
      next_step: v.reasons.length === 0 ? 'place_order' : 'request_approval',
      single_use: true,
      provenance: PROVENANCE,
    });
  }));

  server.registerTool('place_order', {
    description: desc('place_order'),
    inputSchema: { quote_id: z.string(), idempotency_key: z.string().min(8).describe('Unique per intended order; repeating it never creates a second order. A quote that already produced an order is refused with quote_already_used.'), lang: langSchema },
  }, async ({ quote_id, idempotency_key, lang }) => guard(parseLang(lang ?? 'en'), async () => {
    const L = parseLang(lang ?? 'en');
    const existing = findOrder(S().idempotency[idem(idempotency_key)] ?? '');
    if (existing) return ok({ duplicate: true, order: summary(existing.id, L) });
    const q = getQuote(quote_id, agent?.id);
    const { order, duplicate } = await createOrder({ source: 'mcp', actor, agentId: agent?.id, requireAuthority: true, lang: L, deliveryDate: q.deliveryDate, quoteId: q.id, lines: [], idempotencyKey: idem(idempotency_key), title: l3(`Agentin tilaus: ${q.request}`, `Agentens order: ${q.request}`, `Agent order: ${q.request}`) });
    return ok({ duplicate, order: summary(order.id, L) });
  }));

  server.registerTool('request_approval', {
    description: desc('request_approval'),
    inputSchema: { quote_id: z.string(), idempotency_key: z.string().min(8), note: z.string().max(400).optional().describe('Why the agent proposes this order; shown to the approver.'), lang: langSchema },
  }, async ({ quote_id, idempotency_key, note, lang }) => guard(parseLang(lang ?? 'en'), async () => {
    const L = parseLang(lang ?? 'en');
    const q = getQuote(quote_id, agent?.id, idem(idempotency_key));
    const n = note ? ` “${note}”` : '';
    const { order, duplicate } = await createOrder({
      source: 'mcp', actor, agentId: agent?.id, deliveryDate: q.deliveryDate, quoteId: q.id, lines: q.lines.map(l => ({ ...l, quotedPrice: l.unitPrice })), idempotencyKey: idem(idempotency_key),
      title: l3(`Agentin tilaus: ${q.request}`, `Agentens order: ${q.request}`, `Agent order: ${q.request}`),
      forceApproval: l3(`Ulkoinen agentti (${agentName}) pyytää hyväksyntääsi.${n}`, `Den externa agenten (${agentName}) ber om ditt godkännande.${n}`, `The external agent (${agentName}) asks for your approval.${n}`),
    });
    return ok({ duplicate, order: summary(order.id, L), next_step: 'A human decides in the Aimo UI. Poll get_order_status.' });
  }));

  server.registerTool('get_order_status', { description: desc('get_order_status'), inputSchema: { order_id: z.string(), lang: langSchema } }, async ({ order_id, lang }) => {
    const L = parseLang(lang ?? 'en');
    return findOrder(order_id) ? ok({ order: summary(order_id, L, true) }) : fail('unknown_order', `No order ${order_id}`);
  });

  server.registerTool('list_orders', { description: desc('list_orders'), inputSchema: { lang: langSchema } }, async ({ lang }) => {
    const L = parseLang(lang ?? 'en');
    return ok({ orders: ordersView(L).slice(0, 15).map(o => ({ order_id: o.id, status: o.status, title: o.title, created_by: o.createdBy, delivery_date: o.deliveryDate, total_excl_vat: o.totals.net, approval_required: o.approval.required })) });
  });

  server.registerTool('get_audit_log', { description: desc('get_audit_log'), inputSchema: { order_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), lang: langSchema } }, async ({ order_id, limit, lang }) => {
    const L = parseLang(lang ?? 'en');
    return ok({ hash_chain: 'sha256(previous_hash + entry); hashes shown truncated to 16 hex chars', entries: auditView(L, limit ?? 30, order_id) });
  });

  return server;
}

function summary(id: string, lang: Lang, full = false) {
  const stored = findOrder(id)!;
  const o = orderView(stored, lang);
  return {
    order_id: o.id, status: o.status, status_label: o.statusLabel, title: o.title, created_by: o.createdBy, delivery_date: o.deliveryDate,
    total_excl_vat: o.totals.net, vat: o.totals.vat, total_incl_vat: o.totals.gross,
    approval: o.approval, recheck: o.recheck, confirmation: o.confirmation ?? null, quote_id: o.quoteId ?? null, signed_quote: o.quote?.signed ?? null, signed_confirmation: o.signedConfirmation ?? null, integration: o.integration,
    lines: o.lines.map(l => ({ product_id: l.productId, name: l.name, quantity: l.qty, unit_price_excl_vat: l.unitPrice, line_total_excl_vat: l.lineTotal, why: l.why, substitute_for: l.substituteFor, substitution: l.substitution, substitution_note: l.substitutionLabel })),
    events: full ? o.events : undefined,
  };
}

function nextMonday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12));
  d.setUTCDate(d.getUTCDate() + (7 - ((d.getUTCDay() + 6) % 7)));
  return d.toISOString().slice(0, 10);
}

/** Express handler: stateless Streamable HTTP, bearer-token protected.
 *  A registered agent's token decides both its name and its account. The shared demo token keeps the earlier
 *  behaviour: the account comes from X-Aimo-Account and the name from X-Agent-Name (self-declared). */
export async function handleMcp(req: Request, res: Response) {
  const deny = (status: number, message: string) => { res.status(status).json({ jsonrpc: '2.0', error: { code: status === 405 ? -32000 : -32001, message }, id: null }); };
  const auth = String(req.headers.authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // tokens are compared as SHA-256 hashes, which is also all that is stored of a registered agent's token
  const shared = !!token && tokenHash(token) === tokenHash(agentToken());
  const own = shared ? undefined : agentByTokenHash(tokenHash(token));
  const status = own && agentStatus(own.agent);
  if ((!shared && !own) || (status && status !== 'active')) {
    res.set('WWW-Authenticate', 'Bearer');
    deny(401, status === 'revoked' ? 'Unauthorized: this agent token has been revoked' : status === 'expired' ? 'Unauthorized: this agent token has expired' : 'Unauthorized: send Authorization: Bearer <agent token>');
    return;
  }
  if (req.method !== 'POST') { deny(405, 'Method not allowed (stateless server: use POST)'); return; }
  const asked = req.headers['x-aimo-account'] ?? req.query.account ?? req.query.profile ?? req.body?.profile ?? req.headers['x-aimo-profile'];
  if (own && asked !== undefined && asked !== own.account) { deny(403, `Forbidden: this agent token is authorised for the account "${own.account}" only`); return; }
  const agentName = own ? own.agent.name : String(req.headers['x-agent-name'] ?? 'purchasing-agent').replace(/[^\w .-]/g, '').slice(0, 40) || 'purchasing-agent';
  await runAs(own ? own.account : asked, async () => {
    const server = buildServer(agentName, own?.agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
}
