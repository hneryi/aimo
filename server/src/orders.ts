// Orders, authority and approval. The AI (ours or an external agent) only proposes; these rules
// decide what may proceed automatically and what needs a human. Order submission itself is a
// LOCAL SIMULATION: the Valio Aimo challenge mock has no order endpoint.
import { createHash, randomBytes } from 'node:crypto';
import type { Alternative, Authority, Delivery, Lang, Order, OrderLine, Plan, PolicyRule, Requirement } from '../../shared/types.ts';
import { agentWeekSpend, findAgent } from './agents.ts';
import { allOk, checkAll, requirementLabel, worst } from './allergens.ts';
import { type CatalogProduct, getProduct, localName, lotStep, norm, packLabel, productView, roundToLot, searchProducts, catalogSize } from './catalog.ts';
import { config } from './config.ts';
import { dayLabel, eur, num, tr, unitLabel, weekLabel } from './i18n.ts';
import { UserError, alternativeTier, creditUsed, groupLabel, kitchenView, weekSpend } from './planner.ts';
import { ACTOR, type L3, S, type StoredAgent, type StoredOrder, type StoredOrderLine, type StoredQuote, audit, currentProfile, l3, nextOrderNumber, pick, save } from './store.ts';
import { type RawOffer, fetchOffers, rateLimitText, toOffer, valioCooldown } from './valio.ts';

import { ISSUER, signJws } from './signing.ts';

const round2 = (n: number) => Math.round(n * 100) / 100;
const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const signedLines = (lines: StoredOrderLine[]) => lines.map(l => ({ product_id: l.productId, gtin: getProduct(l.productId)?.gtin ?? null, quantity: l.qty, unit_price_excl_vat: l.unitPrice }));

/** Legacy submitted orders can still expose a confirmation; new ones retain the original signature. */
export function signedConfirmation(o: StoredOrder): string | undefined {
  if (o.status !== 'submitted') return undefined;
  return o.signedConfirmation ?? signJws({
    iss: ISSUER, type: 'aimo.order_confirmation.v1', jti: o.id, iat: epoch(o.approval.decidedAt ?? o.createdAt),
    order_id: o.id, confirmation: o.confirmation, quote_id: o.quoteId ?? null, account: currentProfile().id,
    created_by: pick('en', o.createdBy), agent_id: o.agentId ?? null, delivery_date: o.deliveryDate, currency: 'EUR',
    lines: signedLines(o.lines), total_excl_vat: o.net, vat: o.vat, total_incl_vat: round2(o.net + o.vat),
    approval_required: o.approval.required, approved_by: o.approval.decidedBy ? pick('en', o.approval.decidedBy) : null, approved_at: o.approval.decidedAt ?? null,
    submission: 'local_simulation', simulated: true,
  });
}

// ---------- authority / guardrails ----------

/** `agent`: the registered agent the rules are returned to; its own limits replace the shared demo limit. */
export function policyRules(lang: Lang, agent?: StoredAgent): PolicyRule[] {
  const a = S().kitchen.authority;
  const agentLimit = agent
    ? tr(lang, `Agentti ${agent.name} saa tilata itsenäisesti enintään ${eur(lang, agent.authority.perOrderLimit)} (alv 0 %) tilausta kohden ja enintään ${eur(lang, agent.authority.weeklyLimit)} seitsemän päivän aikana.`, `Agenten ${agent.name} får beställa självständigt upp till ${eur(lang, agent.authority.perOrderLimit)} (moms 0 %) per order och högst ${eur(lang, agent.authority.weeklyLimit)} under sju dagar.`, `The agent ${agent.name} may order on its own up to ${eur(lang, agent.authority.perOrderLimit)} (excl. VAT) per order and up to ${eur(lang, agent.authority.weeklyLimit)} within seven days.`)
    : tr(lang, `Ulkoinen agentti saa tilata itsenäisesti yhteisellä demotunnuksella enintään ${eur(lang, a.agentAutoLimit)} (alv 0 %) tilausta kohden; rekisteröity agentti oman tilauskohtaisen rajansa ja viikkorajansa sisällä.`, `En extern agent får beställa självständigt upp till ${eur(lang, a.agentAutoLimit)} (moms 0 %) per order med den delade demotoken; en registrerad agent inom sin egen gräns per order och sin veckogräns.`, `An external agent may order on its own up to ${eur(lang, a.agentAutoLimit)} (excl. VAT) per order with the shared demo token; a registered agent within its own per-order and weekly limits.`);
  const credit: PolicyRule[] = a.creditLimit != null ? [{ id: 'credit-limit', effect: 'never', text: tr(lang, `Tilin luottoraja ${eur(lang, a.creditLimit)} (avoimet tilaukset sis. alv) on tukkurin asettama katto: sitä ei ylitä Aimo, ulkoinen agentti eikä hyväksyjä.`, `Kontots kreditgräns ${eur(lang, a.creditLimit)} (öppna order inkl. moms) är ett tak satt av grossisten: varken Aimo, en extern agent eller en godkännare kan överskrida det.`, `The account’s credit limit of ${eur(lang, a.creditLimit)} (open orders incl. VAT) is a cap set by the wholesaler: neither Aimo, an external agent nor an approver can exceed it.`) }] : [];
  return [
    { id: 'agent-limit', effect: 'auto', text: agentLimit },
    { id: 'user-limit', effect: 'auto', text: tr(lang, `Keittiön käyttäjän tilaus enintään ${eur(lang, a.autoApproveLimit)} lähtee ilman toista hyväksyntää.`, `Kökets användare kan beställa upp till ${eur(lang, a.autoApproveLimit)} utan ett andra godkännande.`, `A kitchen user’s order up to ${eur(lang, a.autoApproveLimit)} goes out without a second approval.`) },
    { id: 'over-limit', effect: 'human', text: tr(lang, 'Rajan ylittävä tilaus tai viikkobudjetin ylitys vaatii ihmisen hyväksynnän.', 'En order över gränsen eller över veckobudgeten kräver mänskligt godkännande.', 'An order above the limit or over the weekly budget needs human approval.') },
    { id: 'substitution', effect: 'human', text: tr(lang, 'Korvaava tuote, jota keittiö ei ole aiemmin hyväksynyt, vaatii ihmisen hyväksynnän.', 'En ersättningsprodukt som köket inte tidigare godkänt kräver mänskligt godkännande.', 'A substitute the kitchen has not approved before needs human approval.') },
    { id: 'uncertain', effect: 'human', text: tr(lang, 'Umpeutunut tilausaika vaatii ihmisen hyväksynnän.', 'En passerad beställningstid kräver mänskligt godkännande.', 'A passed order cutoff needs human approval.') },
    { id: 'allergen', effect: 'never', text: tr(lang, 'Allergeenivaatimusta ei voi ohittaa: tuote, joka ei läpäise tarkistusta tai jonka tieto puuttuu, ei päädy tilaukseen – ei halvemman hinnan eikä hyväksynnän perusteella.', 'Ett allergenkrav kan inte kringgås: en produkt som inte klarar kontrollen eller saknar uppgifter hamnar inte i ordern – varken på grund av lägre pris eller ett godkännande.', 'An allergen requirement cannot be overridden: a product that fails the check or lacks data never enters an order – not for a lower price and not by approval.') },
    ...credit,
    { id: 'recheck', effect: 'never', text: tr(lang, 'Tilausta ei lähetetä tarkistamatta hintaa, saatavuutta ja allergeeneja uudelleen. Sama tilaus ei lähde kahdesti.', 'Ingen order skickas utan ny kontroll av pris, tillgänglighet och allergener. Samma order skickas inte två gånger.', 'No order is sent without re-checking price, availability and allergens. The same order is never sent twice.') },
  ];
}
export function authorityView(lang: Lang, agent?: StoredAgent): Authority {
  return { ...kitchenView(lang).authority, rules: policyRules(lang, agent) };
}

// ---------- views ----------

const STATUS: Record<StoredOrder['status'], L3> = {
  pending_approval: l3('Odottaa hyväksyntää', 'Väntar på godkännande', 'Waiting for approval'),
  approved: l3('Hyväksytty', 'Godkänd', 'Approved'),
  submitted: l3('Lähetetty (simulaatio)', 'Skickad (simulering)', 'Sent (simulation)'),
  rejected: l3('Hylätty', 'Avvisad', 'Rejected'),
  cancelled: l3('Peruttu', 'Avbruten', 'Cancelled'),
};
const INTEGRATION_NOTE = l3(
  'Hinnat ja saatavuus haettiin Valio Aimon haasterajapinnasta (mock) – oikea integraatio. Tilauksen lähetys on paikallinen simulaatio: haasterajapinnassa ei ole tilausrajapintaa, joten Valio Aimolle ei lähtenyt mitään.',
  'Priser och tillgänglighet hämtades från Valio Aimos utmanings-API (mock) – riktig integration. Själva beställningen är en lokal simulering: utmanings-API:t har ingen orderändpunkt, så inget skickades till Valio Aimo.',
  'Prices and availability came from the Valio Aimo challenge API (mock) – a real integration. Order submission is a local simulation: the challenge API has no order endpoint, so nothing was sent to Valio Aimo.');

export function orderView(o: StoredOrder, lang: Lang): Order {
  const lines: OrderLine[] = o.lines.map(l => {
    const p = getProduct(l.productId);
    return {
      productId: l.productId, name: p ? localName(p, lang) : l.productId, qty: l.qty, unitLabel: p ? unitLabel(lang, p.su) : '',
      packLabel: p ? packLabel(p, lang) : '', unitPrice: l.unitPrice, lineTotal: round2(l.qty * l.unitPrice),
      groupLabels: l.groupIds.map(g => groupLabel(lang, g)), checks: p ? checkAll(p, l.reqs, lang) : [], why: l.why ? pick(lang, l.why) : undefined,
      substituteFor: l.substituteFor, substitution: l.substitution,
      substitutionLabel: l.substituteFor ? tr(lang,
        `Korvaa tuotteen ${getProduct(l.substituteFor) ? localName(getProduct(l.substituteFor)!, lang) : l.substituteFor} (${l.substituteFor})`,
        `Ersätter ${getProduct(l.substituteFor) ? localName(getProduct(l.substituteFor)!, lang) : l.substituteFor} (${l.substituteFor})`,
        `Replaces ${getProduct(l.substituteFor) ? localName(getProduct(l.substituteFor)!, lang) : l.substituteFor} (${l.substituteFor})`) : undefined,
    };
  });
  return {
    id: o.id, status: o.status, statusLabel: pick(lang, STATUS[o.status]), createdAt: o.createdAt, createdBy: pick(lang, o.createdBy), source: o.source,
    title: pick(lang, o.title), deliveryDate: o.deliveryDate, deliveryLabel: dayLabel(lang, o.deliveryDate), lines,
    totals: { net: o.net, vat: o.vat, gross: round2(o.net + o.vat), lineCount: o.lines.length },
    approval: { required: o.approval.required, reasons: o.approval.reasons.map(r => pick(lang, r)), decidedBy: o.approval.decidedBy ? pick(lang, o.approval.decidedBy) : undefined, decidedAt: o.approval.decidedAt },
    recheck: o.recheck ? { at: o.recheck.at, ok: o.recheck.ok, changes: o.recheck.changes.map(c => pick(lang, c)) } : undefined,
    integration: { prices: 'valio_mock', availability: 'valio_mock', submission: 'local_simulation', note: pick(lang, INTEGRATION_NOTE) },
    quoteId: o.quoteId, quote: o.quote, signedConfirmation: signedConfirmation(o),
    confirmation: o.confirmation, events: o.events.map(e => ({ at: e.at, actor: pick(lang, e.actor), text: pick(lang, e.text) })),
  };
}
export const ordersView = (lang: Lang) => [...S().orders].reverse().map(o => orderView(o, lang));
export function deliveriesView(lang: Lang): Delivery[] {
  return S().orders.filter(o => o.status === 'submitted' || o.status === 'pending_approval' || o.status === 'approved')
    .map(o => ({ date: o.deliveryDate, label: dayLabel(lang, o.deliveryDate), orderId: o.id, status: o.status, statusLabel: pick(lang, STATUS[o.status]), lineCount: o.lines.length, total: o.net }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
export const findOrder = (id: string) => S().orders.find(o => o.id === id);

// ---------- creation ----------

export interface NewOrder {
  source: 'ui' | 'mcp'; actor: L3; title: L3; deliveryDate: string;
  lines: { productId: string; qty: number; reqs: Requirement[]; groupIds: string[]; why?: L3; substitution?: boolean; substituteFor?: string; quotedPrice?: number }[];
  idempotencyKey: string; fromPlan?: boolean; forceApproval?: L3; // agent explicitly asked for a human decision
  /** the quote this order is placed from; a quote produces at most one order */
  quoteId?: string;
  /** the registered agent placing the order: its own limits decide what goes through without a human */
  agentId?: string;
  /** MCP place_order must refuse, not create a pending order, when authority is insufficient. */
  requireAuthority?: boolean;
  lang?: Lang;
}

interface Verified {
  lines: StoredOrderLine[]; net: number; vat: number; reasons: L3[]; changes: L3[]; blockers: L3[]; notes: L3[];
  /** set when the mock rate-limited us: seconds until price and availability can be checked again */
  retryAfter?: number;
  /** when the prices and availability of the accepted lines were fetched from the mock (the oldest, ISO) */
  observedAt?: string;
}

const MOCK_DOWN = l3('Valio Aimo -mockrajapinta ei vastannut, joten hintaa ja saatavuutta ei voitu tarkistaa. Tilausta ei lähetetä vanhoilla tiedoilla.', 'Valio Aimos mock-API svarade inte, så pris och tillgänglighet kunde inte kontrolleras. Ordern skickas inte med gamla uppgifter.', 'The Valio Aimo mock API did not respond, so price and availability could not be checked. The order is not sent on stale data.');
/** Price and availability could not be fetched: the mock rate-limited us (its own error, with the wait) or did not answer. */
function supplierError(raw: RawOffer | undefined): { text: L3; retryAfter?: number } {
  if (!raw?.retryAt) return { text: MOCK_DOWN };
  const retryAfter = Math.max(1, valioCooldown(raw.retryAt));
  const t = rateLimitText(retryAfter);
  return { retryAfter, text: l3(`${t.fi} Mitään ei luoda eikä lähetetä vanhoilla tiedoilla.`, `${t.sv} Inget skapas eller skickas med gamla uppgifter.`, `${t.en} Nothing is created or sent on stale data.`) };
}
const rateLimited = (retryAfter?: number): [string?, Record<string, unknown>?] => (retryAfter ? ['supplier_rate_limited', { retry_after_seconds: retryAfter }] : []);

/** Fresh re-check against the mock API and the allergen rules. Used at creation and again right before submission.
 *  `agentId`: the registered agent the order belongs to; without it an MCP order is held to the shared demo limit. */
export async function verify(lines: NewOrder['lines'] | StoredOrderLine[], date: string, source: 'ui' | 'mcp', priorPrices?: Map<string, number>, excludeOrderId?: string, agentId?: string): Promise<Verified> {
  const offers = await fetchOffers(lines.map(l => l.productId), date, true);
  const out: Verified = { lines: [], net: 0, vat: 0, reasons: [], changes: [], blockers: [], notes: [] };
  let cutoff = 0, unknownQty = 0, subs = 0;
  for (const l of lines) {
    const p = getProduct(l.productId);
    const name = (lang: Lang) => (p ? localName(p, lang) : l.productId);
    if (!p || p.del) { out.blockers.push(l3(`Tuotetta ${l.productId} ei ole valikoimassa.`, `Produkten ${l.productId} finns inte i sortimentet.`, `Product ${l.productId} is not in the assortment.`)); continue; }
    if (!Number.isInteger(l.qty) || l.qty <= 0) { out.blockers.push(l3(`${name('fi')}: määrän pitää olla positiivinen kokonaisluku myyntiyksiköitä.`, `${name('sv')}: mängden ska vara ett positivt heltal försäljningsenheter.`, `${name('en')}: quantity must be a positive whole number of sales units.`)); continue; }
    // supplier lot size: only multiples of the lot can be ordered
    const step = lotStep(p);
    if (l.qty % step) {
      const up = roundToLot(l.qty, p), down = up - step;
      out.blockers.push(l3(
        `${name('fi')}: tuotetta myydään ${step} myyntiyksikön erissä, joten määrä ${l.qty} ei käy. ${down ? `Lähimmät sallitut määrät ovat ${down} ja ${up}` : `Pienin sallittu määrä on ${up}`}.`,
        `${name('sv')}: produkten säljs i partier om ${step} försäljningsenheter, så mängden ${l.qty} går inte. ${down ? `Närmaste tillåtna mängder är ${down} och ${up}` : `Minsta tillåtna mängd är ${up}`}.`,
        `${name('en')}: sold in lots of ${step} sales units, so a quantity of ${l.qty} is not allowed. ${down ? `The nearest allowed quantities are ${down} and ${up}` : `The smallest allowed quantity is ${up}`}.`));
      continue;
    }
    // allergens: every requirement must be verified ok — nothing can override this
    const bad = checkAll(p, l.reqs, 'fi').find(c => c.verdict !== 'ok');
    if (bad) {
      const s = (lang: Lang) => checkAll(p, l.reqs, lang).find(c => c.verdict !== 'ok')!.summary;
      out.blockers.push(l3(`${name('fi')}: ${s('fi')}`, `${name('sv')}: ${s('sv')}`, `${name('en')}: ${s('en')}`));
      continue;
    }
    const raw: RawOffer | undefined = offers.get(l.productId);
    if (!raw || raw.error) { const e = supplierError(raw); out.blockers.push(e.text); out.retryAfter = e.retryAfter; break; }
    if (raw.price == null) { out.blockers.push(l3(`${name('fi')}: hintaa ei saatu.`, `${name('sv')}: inget pris.`, `${name('en')}: no price returned.`)); continue; }
    if (!raw.hasAvailability) { out.blockers.push(l3(`${name('fi')}: ei saatavilla (${raw.salesBlock ? 'myyntiesto' : 'ei saatavuustietoa'}).`, `${name('sv')}: inte tillgänglig.`, `${name('en')}: not available (${raw.salesBlock ? 'sales block' : 'no availability data'}).`)); continue; }
    if (!raw.unknownQty && (raw.amount ?? 0) < l.qty) { out.blockers.push(l3(`${name('fi')}: vain ${raw.amount} saatavilla, tilauksessa ${l.qty}.`, `${name('sv')}: endast ${raw.amount} tillgängliga, ordern har ${l.qty}.`, `${name('en')}: only ${raw.amount} available, order has ${l.qty}.`)); continue; }
    const before = priorPrices?.get(l.productId) ?? (l as { quotedPrice?: number }).quotedPrice;
    if (before != null && Math.abs(before - raw.price) > 0.005) out.changes.push(l3(`${name('fi')}: hinta muuttui ${eur('fi', before)} → ${eur('fi', raw.price)}.`, `${name('sv')}: priset ändrades ${eur('sv', before)} → ${eur('sv', raw.price)}.`, `${name('en')}: price changed ${eur('en', before)} → ${eur('en', raw.price)}.`));
    if (raw.closingTime && new Date(raw.closingTime).getTime() < Date.now()) cutoff++;
    if (raw.unknownQty) unknownQty++;
    if (l.substitution) subs++;
    out.lines.push({ productId: l.productId, qty: l.qty, unitPrice: raw.price, groupIds: l.groupIds, reqs: l.reqs, why: l.why, substitution: l.substitution, substituteFor: l.substituteFor });
    if (!out.observedAt || raw.observedAt < out.observedAt) out.observedAt = raw.observedAt;
    out.net += l.qty * raw.price;
    out.vat += l.qty * raw.price * ((raw.vatRate ?? 13.5) / 100);
  }
  out.net = round2(out.net); out.vat = round2(out.vat);
  const a = S().kitchen.authority;
  // credit limit: a hard cap on open order value (incl. VAT). No approval can lift it.
  if (a.creditLimit != null && out.lines.length) {
    const used = creditUsed() - (excludeOrderId ? (S().orders.find(o => o.id === excludeOrderId && o.status === 'submitted')?.net ?? 0) : 0);
    const gross = out.net + out.vat;
    if (used + gross > a.creditLimit + 0.005) out.blockers.push(l3(
      `Tilin luottoraja ${eur('fi', a.creditLimit)} ylittyisi: käytössä ${eur('fi', used)}, tämä tilaus ${eur('fi', gross)} (sis. alv). Pienennä tilausta tai sovi tukkurin kanssa rajan nostosta.`,
      `Kontots kreditgräns ${eur('sv', a.creditLimit)} skulle överskridas: använt ${eur('sv', used)}, den här ordern ${eur('sv', gross)} (inkl. moms). Minska ordern eller kom överens med grossisten om en höjning.`,
      `The account’s credit limit of ${eur('en', a.creditLimit)} would be exceeded: ${eur('en', used)} in use, this order ${eur('en', gross)} (incl. VAT). Reduce the order or agree a higher limit with the wholesaler.`));
  }
  // a registered agent is held to its own limits; one that is no longer on the account gets nothing through on its own
  const agent = agentId ? findAgent(agentId) : undefined;
  const limit = agentId ? agent?.authority.perOrderLimit ?? 0 : source === 'mcp' ? a.agentAutoLimit : a.autoApproveLimit;
  if (out.net > limit) out.reasons.push(l3(`Summa ${eur('fi', out.net)} ylittää ${source === 'mcp' ? 'agentin' : 'käyttäjän'} tilausvaltuuden ${eur('fi', limit)}.`, `Summan ${eur('sv', out.net)} överstiger ${source === 'mcp' ? 'agentens' : 'användarens'} befogenhet ${eur('sv', limit)}.`, `Total ${eur('en', out.net)} exceeds the ${source === 'mcp' ? 'agent’s' : 'user’s'} ordering authority of ${eur('en', limit)}.`));
  if (agent) {
    const own = agentWeekSpend(agent.id);
    if (own + out.net > agent.authority.weeklyLimit + 0.005) out.reasons.push(l3(`Agentin viikkoraja ${eur('fi', agent.authority.weeklyLimit)} ylittyisi (itse tilattu 7 päivän aikana ${eur('fi', own)}).`, `Agentens veckogräns ${eur('sv', agent.authority.weeklyLimit)} skulle överskridas (beställt på egen hand under 7 dagar ${eur('sv', own)}).`, `The agent’s weekly limit of ${eur('en', agent.authority.weeklyLimit)} would be exceeded (ordered on its own in the last 7 days: ${eur('en', own)}).`));
  }
  const spent = weekSpend();
  if (spent + out.net > a.weeklyBudget) out.reasons.push(l3(`Viikkobudjetti ${eur('fi', a.weeklyBudget)} ylittyisi (käytetty ${eur('fi', spent)}).`, `Veckobudgeten ${eur('sv', a.weeklyBudget)} skulle överskridas (använt ${eur('sv', spent)}).`, `The weekly budget of ${eur('en', a.weeklyBudget)} would be exceeded (spent ${eur('en', spent)}).`));
  if (cutoff) {
    if (config.cutoffMode === 'enforce') out.blockers.push(l3(`${cutoff} tuotteen tilausaika on umpeutunut.`, `Beställningstiden har gått ut för ${cutoff} produkter.`, `The order cutoff has passed for ${cutoff} products.`));
    else out.reasons.push(l3(`${cutoff} tuotteen tilausaika on mock-datassa jo umpeutunut – oikeassa järjestelmässä toimitus siirtyisi.`, `Beställningstiden har redan gått ut för ${cutoff} produkter i mock-datan – i ett riktigt system skulle leveransen flyttas.`, `The order cutoff has already passed for ${cutoff} products in the mock data – in a real system the delivery would move.`));
  }
  // Terminal products are orderable without a stated stock figure. That is normal for the assortment, so it is
  // recorded on the order as a note instead of forcing a human decision.
  if (unknownQty) out.notes.push(l3(`${unknownQty} tuotteen saatavuusmäärää toimittaja ei ilmoita (terminaalituote) – tilattavissa, määrä varmistuu toimittajalta.`, `Leverantören anger inte tillgänglig mängd för ${unknownQty} produkter (terminalprodukt) – kan beställas, mängden bekräftas av leverantören.`, `The supplier does not state an available quantity for ${unknownQty} products (terminal product) – orderable, quantity is confirmed by the supplier.`));
  if (subs) out.reasons.push(l3(`${subs} korvaavaa tuotetta, joita keittiö ei ole aiemmin hyväksynyt.`, `${subs} ersättningsprodukter som köket inte tidigare godkänt.`, `${subs} substitute products the kitchen has not approved before.`));
  return out;
}

export function contentKey(lines: { productId: string; qty: number }[], date: string): string {
  return createHash('sha256').update(date + '|' + lines.map(l => `${l.productId}:${l.qty}`).sort().join(',')).digest('hex').slice(0, 24);
}

export interface CreateResult { order: StoredOrder; duplicate: boolean }

// Coalesce concurrent retries before preparing a quote, not only after the supplier re-check.
const creating = new Map<string, Promise<CreateResult>>();
export async function createOrder(n: NewOrder): Promise<CreateResult> {
  const key = JSON.stringify([currentProfile().id, n.source, n.agentId, n.idempotencyKey]);
  const pending = creating.get(key);
  if (pending) { await pending; return createOrder(n); }
  const work = createOrderOnce(n);
  creating.set(key, work);
  try { return await work; } finally { creating.delete(key); }
}

async function createOrderOnce(n: NewOrder): Promise<CreateResult> {
  const st = S();
  const duplicate = (): CreateResult | undefined => {
    const existingId = st.idempotency[n.idempotencyKey];
    const existing = existingId ? findOrder(existingId) : undefined;
    if (!existing || existing.source !== n.source || existing.agentId !== n.agentId || (!n.requireAuthority && (existing.status === 'rejected' || existing.status === 'cancelled'))) return undefined;
    audit(ACTOR.rules, 'duplicate_prevented', l3(`Sama tilaus on jo olemassa (${existing.id}) – uutta ei luotu.`, `Samma order finns redan (${existing.id}) – ingen ny skapades.`, `The same order already exists (${existing.id}) – no new order was created.`), existing.id);
    return { order: existing, duplicate: true };
  };
  // Check ownership even on retries. A UI quote is not a shared-demo MCP quote.
  if (n.quoteId) assertQuoteOwner(n.quoteId, n.agentId, n.source);
  const first = duplicate();
  if (first) return first;
  const quote = n.quoteId ? getQuote(n.quoteId, n.agentId, undefined, n.source)
    : (await prepareQuote({ source: n.source, actor: n.actor, agentId: n.agentId, agentName: n.source === 'ui' ? 'Aimo' : pick('en', n.actor), request: pick('en', n.title), deliveryDate: n.deliveryDate, lines: n.lines })).quote;
  // The stored quote, not caller-supplied lines or date, is the commitment being consumed.
  n = { ...n, quoteId: quote.id, deliveryDate: quote.deliveryDate, lines: quote.lines.map(l => ({ ...l, quotedPrice: l.unitPrice })) };
  const v = await verify(n.lines, n.deliveryDate, n.source, undefined, undefined, n.agentId);
  if (v.blockers.length) throw new UserError(l3('Tilausta ei voitu luoda: ' + v.blockers.map(b => b.fi).join(' '), 'Ordern kunde inte skapas: ' + v.blockers.map(b => b.sv).join(' '), 'The order could not be created: ' + v.blockers.map(b => b.en).join(' ')), ...rateLimited(v.retryAfter));
  // the re-check above waited for the mock API: a parallel request may have created the order meanwhile
  const second = duplicate();
  if (second) return second;
  getQuote(quote.id, n.agentId, undefined, n.source); // also re-check expiry after waiting for the supplier
  if (n.forceApproval) v.reasons.unshift(n.forceApproval);
  if (v.changes.length && (n.requireAuthority || !v.reasons.length)) {
    audit(ACTOR.rules, 'quote_price_changed', l3(`Hintavahvistuksen ${quote.id} hinta muuttui – tilausta ei luotu.`, `Priset i offert ${quote.id} ändrades – ingen order skapades.`, `Price changed since quote ${quote.id} – no order was created.`));
    throw new UserError(l3('Hinta muuttui hintavahvistuksen jälkeen. Pyydä uusi hintavahvistus.', 'Priset ändrades efter offerten. Begär en ny offert.', 'A price changed since the quote. Prepare a new quote.'), 'price_changed', { changes: v.changes.map(c => pick(n.lang ?? 'en', c)) });
  }
  if (n.requireAuthority && v.reasons.length) {
    audit(ACTOR.rules, 'agent_blocked', l3(`Agentin ${quote.agent} tilaus estettiin (${quote.id}): ${v.reasons.map(r => r.fi).join(' ')}`, `Agentens ${quote.agent} order stoppades (${quote.id}): ${v.reasons.map(r => r.sv).join(' ')}`, `Agent ${quote.agent} order blocked (${quote.id}): ${v.reasons.map(r => r.en).join(' ')}`));
    throw new UserError(l3('Tilaus ylittää agentin valtuuden. Pyydä ihmisen hyväksyntä.', 'Ordern överskrider agentens befogenhet. Begär mänskligt godkännande.', 'This order is outside the agent’s authority. Call request_approval to send it to a human.'), 'approval_required', { reasons: v.reasons.map(r => pick(n.lang ?? 'en', r)) });
  }
  const now = new Date().toISOString();
  const id = `AIMO-${now.slice(0, 4)}-${String(nextOrderNumber()).padStart(4, '0')}`;
  const order: StoredOrder = {
    id, status: 'pending_approval', createdAt: now, createdBy: n.actor, source: n.source, title: n.title, deliveryDate: n.deliveryDate,
    lines: v.lines, net: v.net, vat: v.vat, approval: { required: v.reasons.length > 0, reasons: v.reasons },
    recheck: { at: now, ok: true, changes: v.changes }, events: [], idempotencyKey: n.idempotencyKey, fromPlan: n.fromPlan,
    agentId: n.agentId, quoteId: quote.id, quote: quote.proof,
  };
  order.events.push({ at: now, actor: n.actor, text: l3(`Tilaus valmisteltu: ${v.lines.length} riviä, ${eur('fi', v.net)} (alv 0 %). Hinnat, saatavuus ja allergeenit tarkistettu.`, `Order förberedd: ${v.lines.length} rader, ${eur('sv', v.net)} (moms 0 %). Priser, tillgänglighet och allergener kontrollerade.`, `Order prepared: ${v.lines.length} lines, ${eur('en', v.net)} (excl. VAT). Prices, availability and allergens checked.`) });
  for (const note of v.notes) order.events.push({ at: now, actor: ACTOR.rules, text: note });
  st.orders.push(order);
  st.idempotency[n.idempotencyKey] = id;
  quote.orderId = id; // the quote is now used up, whatever happens to the order later
  audit(n.actor, 'order_created', l3(`Tilaus ${id} luotu: ${pick('fi', n.title)}, ${eur('fi', v.net)}.`, `Order ${id} skapad: ${pick('sv', n.title)}, ${eur('sv', v.net)}.`, `Order ${id} created: ${pick('en', n.title)}, ${eur('en', v.net)}.`), id);
  if (!order.approval.required) {
    order.approval.decidedBy = ACTOR.rules; order.approval.decidedAt = now;
    order.events.push({ at: now, actor: ACTOR.rules, text: l3('Tilaus on myönnetyn valtuuden sisällä – ei vaadi erillistä hyväksyntää.', 'Ordern ligger inom beviljad befogenhet – inget separat godkännande krävs.', 'The order is within the granted authority – no separate approval needed.') });
    audit(ACTOR.rules, 'auto_approved', l3(`Tilaus ${id} hyväksyttiin automaattisesti valtuuden sisällä (${eur('fi', v.net)}).`, `Order ${id} godkändes automatiskt inom befogenheten (${eur('sv', v.net)}).`, `Order ${id} auto-approved within authority (${eur('en', v.net)}).`), id);
    submit(order);
  } else {
    order.events.push({ at: now, actor: ACTOR.rules, text: l3('Vaatii ihmisen hyväksynnän: ' + v.reasons.map(r => r.fi).join(' '), 'Kräver mänskligt godkännande: ' + v.reasons.map(r => r.sv).join(' '), 'Needs human approval: ' + v.reasons.map(r => r.en).join(' ')) });
    audit(ACTOR.rules, 'approval_required', l3(`Tilaus ${id} odottaa hyväksyntää: ${v.reasons.map(r => r.fi).join(' ')}`, `Order ${id} väntar på godkännande: ${v.reasons.map(r => r.sv).join(' ')}`, `Order ${id} waits for approval: ${v.reasons.map(r => r.en).join(' ')}`), id);
  }
  save();
  return { order, duplicate: false };
}

function submit(o: StoredOrder) {
  const now = new Date().toISOString();
  o.status = 'submitted';
  o.confirmation = 'SIM-' + createHash('sha256').update(o.id + o.idempotencyKey).digest('hex').slice(0, 8).toUpperCase();
  o.signedConfirmation = signedConfirmation(o);
  o.events.push({ at: now, actor: ACTOR.aimo, text: l3(`Tilaus kirjattu paikalliseen simulaatioon, vahvistus ${o.confirmation}. Valio Aimolle ei lähetetty mitään.`, `Ordern registrerad i den lokala simuleringen, bekräftelse ${o.confirmation}. Inget skickades till Valio Aimo.`, `Order recorded in the local simulation, confirmation ${o.confirmation}. Nothing was sent to Valio Aimo.`) });
  audit(ACTOR.aimo, 'order_submitted', l3(`Tilaus ${o.id} lähetetty (paikallinen simulaatio), vahvistus ${o.confirmation}, ${eur('fi', o.net)}.`, `Order ${o.id} skickad (lokal simulering), bekräftelse ${o.confirmation}, ${eur('sv', o.net)}.`, `Order ${o.id} sent (local simulation), confirmation ${o.confirmation}, ${eur('en', o.net)}.`), o.id);
}

/** Human approval. Re-checks everything right before submission; a failed re-check keeps the order pending. */
export async function approveOrder(id: string, approver = ACTOR.kitchen): Promise<StoredOrder> {
  const o = findOrder(id);
  if (!o) throw new UserError(l3('Tilausta ei löytynyt.', 'Ordern hittades inte.', 'Order not found.'));
  if (o.status === 'submitted') return o; // idempotent: approving twice never sends twice
  if (o.status !== 'pending_approval') throw new UserError(l3('Tilaus ei odota hyväksyntää.', 'Ordern väntar inte på godkännande.', 'The order is not waiting for approval.'));
  const now = new Date().toISOString();
  const v = await verify(o.lines, o.deliveryDate, o.source, new Map(o.lines.map(l => [l.productId, l.unitPrice])), o.id, o.agentId);
  if (v.blockers.length) {
    o.recheck = { at: now, ok: false, changes: v.blockers };
    o.events.push({ at: now, actor: ACTOR.rules, text: l3('Uusintatarkistus esti lähetyksen: ' + v.blockers.map(b => b.fi).join(' '), 'Ny kontroll stoppade ordern: ' + v.blockers.map(b => b.sv).join(' '), 'Re-check blocked submission: ' + v.blockers.map(b => b.en).join(' ')) });
    audit(ACTOR.rules, 'recheck_blocked', l3(`Tilauksen ${o.id} lähetys estettiin uusintatarkistuksessa: ${v.blockers.map(b => b.fi).join(' ')}`, `Order ${o.id} stoppades vid ny kontroll: ${v.blockers.map(b => b.sv).join(' ')}`, `Order ${o.id} blocked at re-check: ${v.blockers.map(b => b.en).join(' ')}`), o.id);
    save();
    return o;
  }
  if (v.changes.length) {
    // The approver decided on the prices shown on the order. A price that moved since then is never sent with
    // the same click: the order takes the new prices, stays pending and needs one more approval at the price shown.
    o.lines = v.lines; o.net = v.net; o.vat = v.vat;
    const moved = { fi: v.changes.map(c => c.fi).join(' '), sv: v.changes.map(c => c.sv).join(' '), en: v.changes.map(c => c.en).join(' ') };
    o.recheck = { at: now, ok: false, repriced: true, changes: [...v.changes, l3(
      `Tilausta ei lähetetty. Uusi yhteissumma on ${eur('fi', v.net)} (alv 0 %). Hyväksy uudelleen, jos uusi hinta käy.`,
      `Ordern skickades inte. Den nya totalsumman är ${eur('sv', v.net)} (moms 0 %). Godkänn igen om det nya priset går bra.`,
      `The order was not sent. The new total is ${eur('en', v.net)} (excl. VAT). Approve again if the new price is acceptable.`)] };
    o.events.push({ at: now, actor: ACTOR.rules, text: l3(
      `Uusintatarkistus pysäytti lähetyksen hinnanmuutoksen takia: ${moved.fi} Uusi yhteissumma ${eur('fi', v.net)}. Tilaus odottaa uutta hyväksyntää.`,
      `Den nya kontrollen stoppade sändningen på grund av en prisändring: ${moved.sv} Ny totalsumma ${eur('sv', v.net)}. Ordern väntar på ett nytt godkännande.`,
      `The re-check stopped the sending because a price changed: ${moved.en} New total ${eur('en', v.net)}. The order waits for a new approval.`) });
    audit(ACTOR.rules, 'recheck_price_changed', l3(
      `Tilauksen ${o.id} lähetys pysäytettiin hinnanmuutoksen takia: ${moved.fi} Uusi yhteissumma ${eur('fi', v.net)}; odottaa uutta hyväksyntää.`,
      `Order ${o.id} stoppades på grund av en prisändring: ${moved.sv} Ny totalsumma ${eur('sv', v.net)}; väntar på nytt godkännande.`,
      `Order ${o.id} was not sent because a price changed: ${moved.en} New total ${eur('en', v.net)}; it waits for a new approval.`), o.id);
    save();
    return o;
  }
  o.recheck = { at: now, ok: true, changes: [] };
  o.approval.decidedBy = approver; o.approval.decidedAt = now;
  o.events.push({ at: now, actor: approver, text: l3('Hyväksytty. Hinnat, saatavuus ja allergeenit tarkistettiin uudelleen juuri ennen lähetystä – ei muutoksia.', 'Godkänd. Priser, tillgänglighet och allergener kontrollerades på nytt precis före sändning – inga ändringar.', 'Approved. Prices, availability and allergens were re-checked right before sending – no changes.') });
  audit(approver, 'order_approved', l3(`Tilaus ${o.id} hyväksytty (${eur('fi', o.net)}).`, `Order ${o.id} godkänd (${eur('sv', o.net)}).`, `Order ${o.id} approved (${eur('en', o.net)}).`), o.id);
  submit(o);
  save();
  return o;
}

export function decideOrder(id: string, status: 'rejected' | 'cancelled', actor = ACTOR.kitchen): StoredOrder {
  const o = findOrder(id);
  if (!o) throw new UserError(l3('Tilausta ei löytynyt.', 'Ordern hittades inte.', 'Order not found.'));
  if (o.status !== 'pending_approval') throw new UserError(l3('Vain hyväksyntää odottavan tilauksen voi hylätä tai perua.', 'Endast en order som väntar på godkännande kan avvisas eller avbrytas.', 'Only an order waiting for approval can be rejected or cancelled.'));
  const now = new Date().toISOString();
  o.status = status; o.approval.decidedBy = actor; o.approval.decidedAt = now;
  const t = status === 'rejected' ? l3('Tilaus hylätty – mitään ei lähetetty.', 'Ordern avvisad – inget skickades.', 'Order rejected – nothing was sent.') : l3('Tilaus peruttu – mitään ei lähetetty.', 'Ordern avbruten – inget skickades.', 'Order cancelled – nothing was sent.');
  o.events.push({ at: now, actor, text: t });
  audit(actor, 'order_' + status, l3(`Tilaus ${o.id}: ${t.fi}`, `Order ${o.id}: ${t.sv}`, `Order ${o.id}: ${t.en}`), o.id);
  save();
  return o;
}

/** `actor`: the signed-in approver, when there is one. `forceApproval`: a reason that keeps the order waiting for a human. */
export async function createOrderFromPlan(plan: Plan, actor = ACTOR.kitchen, forceApproval?: L3): Promise<CreateResult> {
  if (!plan.ready) throw new UserError(l3('Tilausehdotuksessa on vielä avoimia asioita. Ratkaise ne ensin – en lähetä tilausta, jossa on varmistamattomia tietoja.', 'Orderförslaget har fortfarande öppna frågor. Lös dem först – jag skickar ingen order med overifierade uppgifter.', 'The proposal still has open items. Resolve them first – I will not send an order with unverified information.'));
  const st = S();
  const lines = plan.lines.filter(l => l.orderQty > 0).map(l => ({
    productId: l.id, qty: l.orderQty, reqs: l.checks.map(c => c.requirement), quotedPrice: l.offer.price,
    groupIds: ['standard', ...st.kitchen.groups.map(g => g.requirement as string)].filter(g => l.groupLabels.includes(groupLabel('fi', g)) || l.groupLabels.includes(groupLabel('sv', g)) || l.groupLabels.includes(groupLabel('en', g))),
    why: l3(l.why, l.why, l.why),
  }));
  return createOrder({
    source: 'ui', actor, forceApproval, deliveryDate: plan.deliveryDate, lines, fromPlan: true,
    title: l3(`Viikkotilaus · ${weekLabel('fi', plan.weekStart)}`, `Veckoorder · ${weekLabel('sv', plan.weekStart)}`, `Weekly order · ${weekLabel('en', plan.weekStart)}`),
    idempotencyKey: 'plan-' + contentKey(lines, plan.deliveryDate),
  });
}

// ---------- sourcing a single need (chat quick order + MCP) ----------

export interface Sourcing {
  selectionRequired?: string;
  options: Alternative[];                       // named role winners, or ambiguous choices; verified only
  /** `lotRounded`: the quantity was raised to the next multiple of the supplier's lot size */
  allocation: { product: CatalogProduct; qty: number; unitPrice: number; amount: number; partial: boolean; lotRounded: boolean }[];
  unit: 'kg' | 'L' | 'pcs'; requested: number; covered: number; shortfall: number;
  excluded: { failed: number; unknown: number; examples: { name: string; reason: string }[] };
  net: number;
}

// Merchandising categories are not always product types. These two equivalences were reviewed against
// the catalog; apply them only to these explicit type words, never to arbitrary matches in the categories.
function typeKey(p: CatalogProduct, query: string): string {
  if (/\bjauhoseos\b/.test(query) && ['21310', '21320', '21370'].includes(p.cat)) return 'flour_mix';
  if (/\bolut\b/.test(query) && ['84966', '85001', '21405'].includes(p.cat)) return 'beer';
  return p.cat;
}

const UNASKED_VARIANTS = [
  { re: /alkoholit|alkoholfri|alcohol[ -]free|non[ -]alcohol|low[ -]alcohol/i, label: l3('alkoholittomia tai matala-alkoholisia', 'alkoholfria eller alkoholsvaga', 'alcohol-free or low-alcohol') },
  { re: /kofeiinit|koffeinfri|decaf|caffeine[ -]free/i, label: l3('kofeiinittomia', 'koffeinfria', 'decaffeinated') },
  { re: /keitetty|kypsä|kokt|cooked|ready[ -]to[ -]eat/i, label: l3('valmiiksi kypsennettyjä', 'färdiglagade', 'pre-cooked') },
];

/** Check every name match before restricting relevance. A name token is evidence of relevance, not a
 *  proof that it is the product's head noun: flavour words also stand alone. Different types need a person. */
export function needCandidates(query: string, reqs: Requirement[], lang: Lang, usable: (p: CatalogProduct) => boolean = () => true, onlyProductId?: string) {
  const canonical = query.toLowerCase().replace(/mansiko(?:ita|iden|ja)/g, 'mansikka').replace(/\bsokeria\b/g, 'sokeri').replace(/\bkananmun(?:aa|ia|at|ien)\b/g, 'kananmuna');
  const pool = onlyProductId ? [getProduct(onlyProductId)].filter((p): p is CatalogProduct => !!p && !p.del && usable(p)) : searchLoose(canonical, catalogSize(), usable);
  const checked = new Map(pool.map(p => [p.id, checkAll(p, reqs, lang)]));
  const isOk = (p: CatalogProduct) => worst(checked.get(p.id)!) === 'ok';
  // Use the same inflection tolerance as searchLoose, but prefer whole name words over substrings.
  let relevant = pool, matchedQuery = norm(canonical);
  if (!onlyProductId) {
    const words = new Map(pool.map(p => [p.id, [p.name, p.sv, p.en].filter((n): n is string => !!n).map(n => norm(n).split(' '))]));
    for (let cut = 0; cut <= 3; cut++) {
      const q = canonical.split(/\s+/).map(w => cut && w.length - cut >= 3 ? w.slice(0, -cut) : w).join(' ');
      const tokens = norm(q).split(' ').filter(t => t.length > 1);
      const whole = pool.filter(p => tokens.every(t => words.get(p.id)!.some(ws => ws.includes(t))));
      if (!whole.length) continue;
      // The last part of a Finnish or Swedish compound is its head: "kevytmaitojuoma" is a maitojuoma, while
      // "sokerikuorrute" is not sokeri. Compound heads join the match only when the catalog files all of them
      // under the one category of the whole-word matches; otherwise they may be another product ("tomusokeri").
      const heads = pool.filter(p => !whole.includes(p) && tokens.every(t => words.get(p.id)!.some(ws => ws.some(w => w.endsWith(t)))));
      relevant = new Set([...whole, ...heads].map(p => p.cat)).size === 1 ? [...whole, ...heads] : whole;
      matchedQuery = norm(q);
      break;
    }
  }
  const excluded: Sourcing['excluded'] = { failed: 0, unknown: 0, examples: [] };
  for (const p of relevant) {
    const checks = checked.get(p.id)!;
    const w = worst(checks);
    if (w !== 'ok') {
      excluded[w === 'fail' ? 'failed' : 'unknown']++;
      if (excluded.examples.length < 3) excluded.examples.push({ name: localName(p, lang), reason: checks.find(c => c.verdict !== 'ok')!.summary });
    }
  }
  // Measure ambiguity before removing unsafe products: a missing declaration must not turn a flavour
  // into the requested ingredient. Price/availability cannot resolve what the buyer meant either.
  const typeOf = (p: CatalogProduct) => typeKey(p, matchedQuery);
  const unasked = UNASKED_VARIANTS.filter(v => !v.re.test(canonical));
  const marker = (p: CatalogProduct) => unasked.find(v => v.re.test(`${p.name} ${p.en ?? ''} ${p.sv ?? ''}`));
  // What was asked for comes first. A variant nobody asked for (alcohol-free, decaffeinated, pre-cooked) is never
  // picked automatically, and it is offered for selection only when the main product type of the match has
  // nothing plain that passes the checks ("olut": every beer in the assortment is alcohol-free).
  const perType = new Map<string, number>();
  for (const p of relevant) perType.set(typeOf(p), (perType.get(typeOf(p)) ?? 0) + 1);
  const mainType = [...perType.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const plain = relevant.filter(p => !marker(p));
  // Marker words do not catch every variant (a "0,0 %" beer without the word "alkoholiton"). When most of the
  // main type is a variant nobody asked for, the few unmarked products are not trusted to be the plain one.
  const main = relevant.filter(p => typeOf(p) === mainType);
  const usePlain = main.filter(p => marker(p)).length * 2 <= main.length && plain.some(p => typeOf(p) === mainType && isOk(p));
  const candidates = onlyProductId || !usePlain ? relevant : plain;
  const types = new Set(candidates.map(typeOf));
  const variant = usePlain ? undefined : relevant.filter(isOk).map(marker).find(v => !!v);
  const selectionRequired = !onlyProductId && candidates.some(isOk) && (types.size > 1 || variant) ? (variant
    ? tr(lang, `Haussa ”${query}” on ${pick(lang, variant.label)} vaihtoehtoja, joita et pyytänyt. En valitse niitä puolestasi. Valitse tuote; mitään ei tilattu.`, `Sökningen ”${query}” ger ${pick(lang, variant.label)} alternativ som du inte bad om. Jag väljer dem inte åt dig. Välj produkt; inget beställdes.`, `“${query}” includes ${pick(lang, variant.label)} alternatives you did not request. I will not choose them for you. Choose a product; nothing was ordered.`)
    : tr(lang, `Haku ”${query}” osuu ${types.size} eri tuotetyyppiin. Valitse tarkoittamasi tuote; mitään ei tilattu.`, `Sökningen ”${query}” matchar ${types.size} olika produkttyper. Välj den avsedda produkten; inget beställdes.`, `“${query}” matches ${types.size} different product types. Choose the intended product; nothing was ordered.`)) : undefined;
  return { products: candidates.filter(isOk), excluded, selectionRequired, matchCount: relevant.length, typeCount: types.size };
}

/** Find verified products for "N litres/kg of X", rank them by price for the needed amount and build an
 *  allocation that respects stated availability (splitting across products when one cannot cover it all). */
export async function sourceNeed(query: string, amount: number, unit: 'kg' | 'L' | 'pcs', reqs: Requirement[], date: string, lang: Lang, onlyProductId?: string): Promise<Sourcing> {
  // content of one sales unit in the requested unit: litres/kilos from supplier pack data, or pieces (base units)
  const size = (p: CatalogProduct): number | undefined => (unit === 'pcs' ? p.n : p.per && p.per.u === unit ? p.per.v : undefined);
  const u = unit === 'pcs' ? tr(lang, 'kpl', 'st', 'pcs') : unit;
  const matched = needCandidates(query, reqs, lang, p => !!size(p), onlyProductId);
  const { excluded } = matched;
  let { selectionRequired } = matched;
  const ok = matched.products;
  const offers = await fetchOffers(ok.map(p => p.id), date);
  // without price and availability nothing can be ranked: say so instead of "no suitable product"
  const down = [...offers.values()].find(o => o.error);
  if (down) { const e = supplierError(down); throw new UserError(e.text, ...rateLimited(e.retryAfter)); }
  const cost = (p: CatalogProduct, price: number, needed: number) => roundToLot(Math.ceil(needed / size(p)! - 1e-9), p) * price;
  const rows = ok.map(p => ({ p, raw: offers.get(p.id) }))
    .filter(r => r.raw && r.raw.price != null && r.raw.hasAvailability && (r.raw.unknownQty || (r.raw.amount ?? 0) >= lotStep(r.p)))
    .map(r => ({ ...r, perUnit: r.raw!.price! / size(r.p)! }))
    .sort((a, b) => cost(a.p, a.raw!.price!, amount) - cost(b.p, b.raw!.price!, amount) || size(a.p)! - size(b.p)! || (b.p.rel ?? 0) - (a.p.rel ?? 0));
  // nothing orderable to choose from: report the need as not found, with the reasons, instead of asking for a choice
  if (!rows.length) selectionRequired = undefined;
  let left = amount;
  const allocation: Sourcing['allocation'] = [];
  const remaining = selectionRequired ? [] : [...rows];
  while (remaining.length && left > 1e-6 && allocation.length < 3) {
    remaining.sort((a, b) => cost(a.p, a.raw!.price!, left) - cost(b.p, b.raw!.price!, left) || size(a.p)! - size(b.p)! || (b.p.rel ?? 0) - (a.p.rel ?? 0));
    const r = remaining.shift()!;
    // whole sales units, raised to the supplier's lot size; never above the stated availability
    const units = Math.ceil(left / size(r.p)! - 1e-9);
    const step = lotStep(r.p);
    const want = roundToLot(units, r.p);
    const can = r.raw!.unknownQty ? want : Math.min(want, Math.floor((r.raw!.amount ?? 0) / step + 1e-9) * step);
    if (can <= 0) continue;
    allocation.push({ product: r.p, qty: can, unitPrice: r.raw!.price!, amount: can * size(r.p)!, partial: can < want, lotRounded: can > units });
    left -= can * size(r.p)!;
  }
  const roles = new Map<string, NonNullable<Alternative['roles']>>();
  const assign = (r: typeof rows[number] | undefined, role: NonNullable<Alternative['roles']>[number]) => {
    if (r) roles.set(r.p.id, [...(roles.get(r.p.id) ?? []), role]);
  };
  const sustainabilityRule = tr(lang,
    'Vastuullisin tässä vertailussa: tunnettu ympäristö-/vastuullisuusmerkki vaaditaan; sitten Suomen alkuperä etusijalla. Pienempi tuoteryhmän CO₂-keskiarvo ratkaisee vain saman ryhmän tasatilanteen, kun tieto on kaikilla; lopuksi hinta. Ei tuotteen elinkaariarvio.',
    'Mest hållbar i denna jämförelse: ett känt miljö-/ansvarsmärke krävs; sedan prioriteras finskt ursprung. Lägre CO₂-gruppmedel avgör bara inom samma grupp när alla har uppgiften; sist pris. Ingen livscykelanalys av produkten.',
    'Most sustainable in this comparison: a known environmental/responsibility label is required; then Finnish origin is preferred. Lower category-average CO₂ breaks ties only within one category when all have data; finally price. Not a product life-cycle assessment.');
  if (!selectionRequired) {
    assign(rows[0], { role: 'cheapest', label: tr(lang, 'Halvin', 'Billigast', 'Cheapest') });
    const reliable = rows.filter(r => r.p.rel != null && Number.isFinite(r.p.rel));
    reliable.sort((a, b) => b.p.rel! - a.p.rel!);
    assign(reliable[0], { role: 'most_reliable', label: tr(lang, 'Toimitusvarmin', 'Leveranssäkrast', 'Most reliable') });
    // Origin is a declared local-sourcing preference, not a claim about transport emissions.
    const environmental = new Set(['EU_ORGANIC_FARMING', 'SVANEN', 'RAINFOREST_ALLIANCE', 'EU_ECO_LABEL', 'MARINE_STEWARDSHIP_COUNCIL_LABEL', 'FAIR_TRADE_MARK', 'AQUACULTURE_STEWARDSHIP_COUNCIL', 'KRAV_MARK', 'OFFICIAL_ECO_LABEL_SUN', 'SOIL_ASSOCIATION_ORGANIC_SYMBOL', 'UTZ_CERTIFIED', 'DOLPHIN_SAFE']);
    let sustainable = rows.filter(r => r.p.labels?.some(id => environmental.has(id)));
    const finnish = sustainable.filter(r => r.p.origin?.toLowerCase() === 'fi');
    if (finnish.length) sustainable = finnish;
    if (new Set(sustainable.map(r => r.p.cat)).size === 1 && sustainable.every(r => r.p.co2 != null && Number.isFinite(r.p.co2))) {
      sustainable.sort((a, b) => a.p.co2! - b.p.co2!);
    }
    assign(sustainable[0], { role: 'most_sustainable', label: tr(lang, 'Vastuullisin', 'Mest hållbar', 'Most sustainable') });
  }
  // For an ambiguous search, show different categories rather than five near-identical flavours.
  const categories = new Set<string>();
  const representatives = rows.filter(r => { if (categories.has(r.p.cat)) return false; categories.add(r.p.cat); return true; });
  const shown = selectionRequired ? [...representatives, ...rows] : [...roles.keys()].map(id => rows.find(r => r.p.id === id)!);
  const unique = [...new Map(shown.map(r => [r.p.id, r])).values()].slice(0, 5);
  const options: Alternative[] = unique.map(r => {
    const want = roundToLot(Math.ceil(amount / size(r.p)! - 1e-9), r.p);
    const stockNote = r.raw!.unknownQty ? '' : (r.raw!.amount ?? 0) < want ? tr(lang, ` · riittää vain ${num(lang, (r.raw!.amount ?? 0) * size(r.p)!, 0)} ${u}`, ` · räcker bara till ${num(lang, (r.raw!.amount ?? 0) * size(r.p)!, 0)} ${u}`, ` · covers only ${num(lang, (r.raw!.amount ?? 0) * size(r.p)!, 0)} ${u}`) : '';
    const packNote = unit === 'pcs' && size(r.p)! > 1 ? ` · ${num(lang, size(r.p)!, 0)} ${u} / ${unitLabel(lang, r.p.su)}` : '';
    const deposit = r.p.dep ? tr(lang, ' · pantti lisätään', ' · pant tillkommer', ' · deposit added') : '';
    const sustainable = roles.get(r.p.id)?.some(r => r.role === 'most_sustainable');
    return {
      product: productView(r.p, lang), offer: toOffer(r.raw, lang, want), checks: checkAll(r.p, reqs, lang), suitable: true,
      roles: roles.get(r.p.id),
      basis: { costToCover: round2(cost(r.p, r.raw!.price!, amount)), salesUnits: want, coveredAmount: want * size(r.p)!, reliability: r.p.rel, packagingLabels: r.p.labels ?? [], countryOfOrigin: r.p.origin, co2PerKg: r.p.co2, sustainabilityRule: sustainable ? sustainabilityRule : undefined },
      note: `${eur(lang, cost(r.p, r.raw!.price!, amount))} / ${num(lang, want * size(r.p)!, 2)} ${u} · ${eur(lang, r.perUnit)}/${u}${packNote}${stockNote}${deposit}`,
    };
  });
  // what the allocated sales units really contain: whole packs and lots can make it more than was asked for
  const covered = allocation.reduce((a, l) => a + l.amount, 0);
  return { selectionRequired, options, allocation, unit, requested: amount, covered: round2(covered), shortfall: round2(Math.max(0, left)), excluded, net: round2(allocation.reduce((a, l) => a + l.qty * l.unitPrice, 0)) };
}

/** Informational replacements for an explicitly pinned need. Never adds an allocation. */
export async function needSubstitutes(originalId: string, query: string, amount: number, unit: Sourcing['unit'], reqs: Requirement[], date: string, lang: Lang): Promise<Alternative[]> {
  const original = getProduct(originalId);
  if (!original) return [];
  const size = (p: CatalogProduct) => unit === 'pcs' ? p.n : p.per?.u === unit ? p.per.v : undefined;
  const supplied = original.subs.map(getProduct).filter((p): p is CatalogProduct => !!p);
  const matched = needCandidates(query, reqs, lang, p => !!size(p)).products;
  const pool = [...new Map([...supplied, ...matched].map(p => [p.id, p])).values()]
    .filter(p => p.id !== originalId && !p.del && !!size(p) && allOk(checkAll(p, reqs, lang)));
  const offers = await fetchOffers(pool.map(p => p.id), date);
  const rows = pool.map(p => {
    const qty = roundToLot(Math.ceil(amount / size(p)! - 1e-9), p);
    const raw = offers.get(p.id);
    return { p, qty, raw, cost: qty * (raw?.price ?? Infinity) };
  }).filter(r => r.raw && !r.raw.error && r.raw.price != null && r.raw.hasAvailability && (r.raw.unknownQty || (r.raw.amount ?? 0) >= r.qty));
  const tier = (p: CatalogProduct) => original.subs.includes(p.id) ? 0 : p.cat === original.cat ? 1 : 2;
  rows.sort((a, b) => tier(a.p) - tier(b.p) || a.cost - b.cost);
  return rows.slice(0, 3).map(r => ({
    product: productView(r.p, lang), offer: toOffer(r.raw, lang, r.qty), checks: checkAll(r.p, reqs, lang), suitable: true,
    ...alternativeTier(r.p, original, lang),
    basis: { costToCover: round2(r.cost), salesUnits: r.qty, coveredAmount: r.qty * size(r.p)!, reliability: r.p.rel, packagingLabels: r.p.labels ?? [], countryOfOrigin: r.p.origin, co2PerKg: r.p.co2 },
    note: tr(lang, `Vain ehdotus puuttuvalle määrälle: ${r.qty} × ${unitLabel(lang, r.p.su)}, ${eur(lang, r.cost)}. Ei lisätty tilaukseen.`, `Endast förslag för den saknade mängden: ${r.qty} × ${unitLabel(lang, r.p.su)}, ${eur(lang, r.cost)}. Inte tillagt i ordern.`, `Suggestion for the shortfall only: ${r.qty} × ${unitLabel(lang, r.p.su)}, ${eur(lang, r.cost)}. Not added to the order.`),
  }));
}

/** Search that tolerates inflected Finnish words ("olutta" → "olut", "riisiä" → "riisi"). Word endings are trimmed
 *  step by step; a spelling that matches whole words of a usable product wins over a longer one that only matches
 *  inside other words ("olutta" inside "oluttaikinassa"). */
export function searchLoose(query: string, limit: number, usable: (p: CatalogProduct) => boolean = () => true): CatalogProduct[] {
  let loose: CatalogProduct[] = [];
  for (let cut = 0; cut <= 3; cut++) {
    const q = query.split(/\s+/).map(w => (cut && w.length - cut >= 3 ? w.slice(0, -cut) : w)).join(' ');
    const found = searchProducts(q, { limit: catalogSize() }).filter(usable);
    const tokens = norm(q).split(' ').filter(t => t.length > 1);
    if (found.some(p => tokens.every(t => ` ${p._s} `.includes(` ${t} `)))) return found.slice(0, limit);
    if (!loose.length) loose = found;
  }
  return loose.slice(0, limit);
}

export function sourcingLines(s: Sourcing, reqs: Requirement[]): NewOrder['lines'] {
  const add = (why: L3, note: L3 | undefined) => (note ? l3(`${why.fi} ${note.fi}`, `${why.sv} ${note.sv}`, `${why.en} ${note.en}`) : why);
  return s.allocation.map((a, i) => ({
    productId: a.product.id, qty: a.qty, reqs, groupIds: [], quotedPrice: a.unitPrice,
    why: add(i === 0
      ? l3(`Edullisin saatavilla oleva${reqs.length ? ', vaatimukset täyttävä' : ''} tuote tarpeen kattamiskustannuksen perusteella (${eur('fi', a.unitPrice * a.qty / a.amount)}/${s.unit === 'pcs' ? 'kpl' : s.unit})${a.partial ? ', saatavuus ei riitä koko määrään' : ''}.`, `Billigaste tillgängliga produkten${reqs.length ? ' som uppfyller kraven' : ''}, räknat på kostnaden att täcka behovet (${eur('sv', a.unitPrice * a.qty / a.amount)}/${s.unit === 'pcs' ? 'st' : s.unit})${a.partial ? ', tillgången räcker inte till hela mängden' : ''}.`, `Cheapest available product${reqs.length ? ' meeting the requirements' : ''} by cost to cover the need (${eur('en', a.unitPrice * a.qty / a.amount)}/${s.unit === 'pcs' ? 'pc' : s.unit})${a.partial ? ', availability does not cover the full amount' : ''}.`)
      : l3('Täydentää määrän, koska edullisemman tuotteen saatavuus ei riittänyt.', 'Kompletterar mängden eftersom den billigare produkten inte räckte.', 'Tops up the amount because the cheaper product’s availability was not enough.'),
    a.lotRounded ? lotNote(a.product, a.qty) : undefined),
  }));
}

/** Tells that a quantity was rounded up because the supplier sells the product in lots. */
export function lotNote(p: CatalogProduct, qty: number): L3 {
  const step = lotStep(p);
  return l3(`Tuotetta myydään ${step} myyntiyksikön erissä, joten määrä pyöristettiin ylöspäin: ${qty}.`, `Produkten säljs i partier om ${step} försäljningsenheter, så mängden avrundades uppåt till ${qty}.`, `Sold in lots of ${step} sales units, so the quantity was rounded up to ${qty}.`);
}

// ---------- shared quote preparation (MCP transport and in-process kitchen agent) ----------

export async function prepareQuote(n: {
  source: NewOrder['source']; actor: L3; agentName: string; agentId?: string; request: string;
  deliveryDate: string; lines: NewOrder['lines']; shortfall?: StoredQuote['shortfall']; lang?: Lang;
}): Promise<{ quote: StoredQuote; verified: Verified }> {
  if (!n.lines.length) throw new UserError(l3('Tilauksessa ei ole rivejä.', 'Ordern har inga rader.', 'The order has no lines.'));
  const v = await verify(n.lines, n.deliveryDate, n.source, undefined, undefined, n.agentId);
  if (v.blockers.length) throw new UserError(l3(v.blockers.map(b => b.fi).join(' '), v.blockers.map(b => b.sv).join(' '), v.blockers.map(b => b.en).join(' ')), v.retryAfter ? 'supplier_rate_limited' : 'rejected_by_rules', { blockers: v.blockers.map(b => pick(n.lang ?? 'en', b)), retry_after_seconds: v.retryAfter });
  const now = Date.now();
  const body = { agent: n.agentName, request: n.request, deliveryDate: n.deliveryDate, lines: v.lines, net: v.net, vat: v.vat, shortfall: n.shortfall };
  const q: StoredQuote = {
    id: 'Q-' + randomBytes(5).toString('hex').toUpperCase(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(),
    ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), agentId: n.agentId, source: n.source,
  };
  const recipient = { id: n.source === 'ui' ? 'kitchen' : n.agentId ?? null, name: n.agentName, identity: n.source === 'ui' ? 'kitchen' as const : n.agentId ? 'registered' as const : 'self_declared' as const };
  const account = currentProfile().id;
  const signed = signJws({
    iss: ISSUER, type: 'aimo.quote.v1', jti: q.id, sub: n.agentName, iat: epoch(q.createdAt), exp: epoch(q.expiresAt),
    agent: recipient, account, delivery_date: q.deliveryDate, currency: 'EUR',
    lines: signedLines(q.lines), total_excl_vat: q.net, vat: q.vat, total_incl_vat: round2(q.net + q.vat),
    price_and_availability: { source: 'valio_mock', fetched_at: v.observedAt }, single_use: true, content_sha256: q.hash,
  });
  q.proof = { id: q.id, issuer: ISSUER, account, recipient, createdAt: q.createdAt, expiresAt: q.expiresAt, observedAt: v.observedAt!, signed };
  const st = S();
  st.quotes = st.quotes.filter(q => new Date(q.expiresAt).getTime() > now - 3600_000).slice(-49);
  st.quotes.push(q);
  audit(n.actor, 'quote_prepared', l3(`Hintavahvistus ${q.id} annettu: ${q.request}, ${q.net.toFixed(2)} €.`, `Offert ${q.id} utfärdad: ${q.request}, ${q.net.toFixed(2)} €.`, `Quote ${q.id} issued: ${q.request}, EUR ${q.net.toFixed(2)}.`));
  return { quote: q, verified: v };
}
/** A quote is single-use: once an order was created from it, it stays used up, also when that order was
 *  rejected or cancelled. A new attempt needs a new quote with fresh prices. */
function assertQuoteUnused(q: StoredQuote) {
  if (!q.orderId) return;
  audit(ACTOR.rules, 'quote_reuse_blocked', l3(`Tarjous ${q.id} on jo käytetty tilaukseen ${q.orderId} – toista tilausta ei luotu.`, `Offert ${q.id} har redan använts för order ${q.orderId} – ingen andra order skapades.`, `Quote ${q.id} was already used for order ${q.orderId} – no second order was created.`), q.orderId);
  throw new UserError(l3(`Tarjous on jo käytetty tilaukseen ${q.orderId}. Yhdestä tarjouksesta syntyy vain yksi tilaus – pyydä uusi tarjous.`, `Offerten har redan använts för order ${q.orderId}. En offert ger bara en order – begär en ny offert.`, `The quote was already used for order ${q.orderId}. A quote produces one order only – prepare a new quote.`), 'quote_already_used', { order_id: q.orderId, order_status: findOrder(q.orderId)?.status });
}
/** Missing source on legacy quotes means MCP. UI ownership is always explicit, even without an agentId. */
function assertQuoteOwner(id: string, agentId: string | undefined, source: 'ui' | 'mcp'): StoredQuote {
  const q = S().quotes.find(x => x.id === id && x.agentId === agentId && (x.source ?? 'mcp') === source);
  if (!q) {
    audit(ACTOR.rules, 'quote_access_denied', l3('Hintavahvistusta ei löytynyt kutsujan omista hintavahvistuksista.', 'Offerten hittades inte bland anroparens egna offerter.', 'The quote was not found among the caller’s own quotes.'));
    throw new UserError(l3('Tarjousta ei löytynyt.', 'Offerten hittades inte.', 'Quote not found.'));
  }
  return q;
}

/** The call that created the quote's order may repeat its own key; all other reuse is refused. */
export function getQuote(id: string, agentId: string | undefined, idempotencyKey?: string, source: 'ui' | 'mcp' = 'mcp'): StoredQuote {
  const st = S();
  const q = assertQuoteOwner(id, agentId, source);
  if (!(idempotencyKey && q.orderId && st.idempotency[idempotencyKey] === q.orderId)) assertQuoteUnused(q);
  if (new Date(q.expiresAt).getTime() < Date.now()) throw new UserError(l3('Tarjous on vanhentunut – pyydä uusi.', 'Offerten har gått ut – begär en ny.', 'The quote has expired – prepare a new one.'));
  return q;
}
export { requirementLabel, allOk };
