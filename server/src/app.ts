// Application layer: dashboard state, UI actions and the chat turn. The LLM picks a tool; the
// functions below (rules) do the work and produce structured cards.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIngredientRequest } from '../../shared/ingredientIntent.ts';
import type { Alternative, Attention, AuditEntry, Card, DashboardState, Draft, Lang, Plan, Requirement, TurnResponse, UiAction, Weekday } from '../../shared/types.ts';
import { agentsView, createAgent, revokeAgent, updateAgent } from './agents.ts';
import { REQUIREMENTS, checkAll, requirementLabel } from './allergens.ts';
import { approversConfigured } from './approvers.ts';
import { catalogSize, getProduct, localName, lotStep, productView, roundToLot } from './catalog.ts';
import { config } from './config.ts';
import { addDays, dayLabel, eur, num, tr, unitLabel, WEEKDAYS } from './i18n.ts';
import { type IngredientIdea, type ToolDef, llmStatus, llmTools, suggestIngredients } from './llm.ts';
import { importMenu, importMenuText } from './menuImport.ts';
import {
  type NewOrder, type Sourcing, approveOrder, authorityView, contentKey, createOrder, createOrderFromPlan, decideOrder, deliveriesView, findOrder,
  lotNote, needCandidates, orderView, ordersView, sourceNeed, sourcingLines,
} from './orders.ts';
import {
  UserError, buildPlan, clearMenu, confirmRecipe, findCheaper, kitchenView, menuView, removeLine, reopenIssue, resetLineQty, resolveIssue, restoreDay,
  restoreLine, restoreProduct, searchWithChecks, setCourse, setCustomDish, setLineQty, setPortions, skipDay, skipIssue, stockView, swapLine,
} from './planner.ts';
import { mainRecipes, recipeRole, recipeTerms, recipesForRole } from './recipes.ts';
import { ACTOR, PROFILES, S, audit, currentProfile, l3, pick, resetState, save } from './store.ts';
import type { L3, StoredDraft } from './store.ts';
import { fetchOffers, rateLimitText, toOffer, valioCooldown, valioStatus } from './valio.ts';
import { MENU_TOOLS, menuEditIntent, runMenuTool } from './menuChat.ts';
import { UNDOABLE, clearUndo, undoLabel, undoLast, undoView, withUndo } from './undo.ts';
import { randomBytes } from 'node:crypto';

export function auditView(lang: Lang, limit = 60, orderId?: string): AuditEntry[] {
  return S().audit.filter(a => !orderId || a.orderId === orderId).slice(-limit).reverse()
    .map(a => ({ id: a.id, at: a.at, actor: pick(lang, a.actor), action: a.action, text: pick(lang, a.text), orderId: a.orderId, hash: a.hash?.slice(0, 16) }));
}

function suggestions(lang: Lang, plan?: Plan): string[] {
  const st = S();
  const kind = currentProfile().kind;
  const out: string[] = [];
  if (kind === 'cafe') {
    // no menu and no portions: a café starts from what it needs today
    out.push(tr(lang, 'Tilaa 12 litraa laktoositonta maitoa ja 10 litraa kaurajuomaa maanantaiksi', 'Beställ 12 liter laktosfri mjölk och 10 liter havredryck till måndag', 'Order 12 litres of lactose-free milk and 10 litres of oat drink for Monday'));
    out.push(tr(lang, 'Etsi raaka-aineet: gluteeniton jauhoseos, sokeri, leivinjauhe', 'Sök ingredienser: glutenfri mjölmix, socker, bakpulver', 'Find ingredients: gluten-free flour mix, sugar, baking powder'));
    out.push(tr(lang, 'Tilaa 2 kg sokeria torstaiksi', 'Beställ 2 kg socker till torsdag', 'Order 2 kg of sugar for Thursday'));
    if (st.menu) out.push(tr(lang, 'Tee ensi viikon tilaus tästä ruokalistasta', 'Gör nästa veckas order utifrån matsedeln', 'Prepare next week’s order from this menu'));
    if (st.orders.length) out.push(tr(lang, 'Näytä tapahtumaloki', 'Visa händelseloggen', 'Show the activity log'));
    return out;
  }
  if (!st.menu) out.push(kind === 'event' ? tr(lang, 'Käytä esimerkkimenua', 'Använd exempelmenyn', 'Use the sample menu') : tr(lang, 'Käytä esimerkkiruokalistaa', 'Använd exempelmatsedeln', 'Use the sample menu'));
  else out.push(kind === 'event' ? tr(lang, 'Tee tilaus tästä juhlamenusta', 'Gör ordern utifrån festmenyn', 'Prepare the order from this event menu') : tr(lang, 'Tee ensi viikon tilaus tästä ruokalistasta', 'Gör nästa veckas order utifrån matsedeln', 'Prepare next week’s order from this menu'));
  if (!st.kitchen.portionsConfirmed) out.push(
    kind === 'event' ? tr(lang, 'Meillä on 120 vierasta, joista 8 gluteenitonta ja 4 maidotonta', 'Vi har 120 gäster, varav 8 glutenfria och 4 mjölkfria', 'We have 120 guests, including 8 gluten-free and 4 milk-free')
    : kind === 'restaurant' ? tr(lang, 'Meillä on 180 lounasta päivässä, joista 10 gluteenitonta ja 6 maidotonta', 'Vi har 180 luncher per dag, varav 10 glutenfria och 6 mjölkfria', 'We have 180 lunches per day, including 10 gluten-free and 6 milk-free')
    : tr(lang, 'Meillä on 350 lounasta päivässä, joista 20 gluteenitonta ja 8 vehnätöntä', 'Vi har 350 luncher per dag, varav 20 glutenfria och 8 vetefria', 'We have 350 lunches per day, including 20 gluten-free and 8 wheat-free'));
  if (plan?.lines.length) out.push(tr(lang, 'Etsi halvempi vaihtoehto muuttamatta ruokavaliovaatimuksia', 'Hitta ett billigare alternativ utan att ändra kostkraven', 'Find a cheaper alternative without changing our dietary requirements'));
  if (kind === 'event') out.push(tr(lang, 'Tilaa 70 alkoholitonta olutta lauantaiksi', 'Beställ 70 alkoholfria öl till lördag', 'Order 70 alcohol-free beers for Saturday'));
  out.push(tr(lang, 'Tilaa 1 000 litraa laktoositonta maitoa maanantaiksi', 'Beställ 1 000 liter laktosfri mjölk till måndag', 'Order 1,000 litres of lactose-free milk for Monday'));
  if (kind !== 'event') out.push(tr(lang, 'Tilaa 70 alkoholitonta olutta perjantaiksi', 'Beställ 70 alkoholfria öl till fredag', 'Order 70 alcohol-free beers for Friday'));
  if (st.orders.length) out.push(tr(lang, 'Näytä tapahtumaloki', 'Visa händelseloggen', 'Show the activity log'));
  return out;
}

function attention(lang: Lang, plan?: Plan, drafts: Draft[] = []): Attention[] {
  const st = S();
  const out: Attention[] = [];
  for (const o of st.orders.filter(o => o.status === 'pending_approval')) {
    out.push({ id: 'ord-' + o.id, tone: 'block', action: { type: 'show_order', orderId: o.id },
      text: tr(lang, `Tilaus ${o.id} odottaa hyväksyntääsi · ${eur(lang, o.net)} · ${pick(lang, o.createdBy)}`, `Order ${o.id} väntar på ditt godkännande · ${eur(lang, o.net)} · ${pick(lang, o.createdBy)}`, `Order ${o.id} is waiting for your approval · ${eur(lang, o.net)} · ${pick(lang, o.createdBy)}`) });
  }
  if (plan) {
    const open = plan.issues.filter(i => !i.resolved);
    for (const i of open.slice(0, 4)) out.push({ id: i.id, tone: i.severity === 'block' ? 'block' : 'warn', text: i.title, action: { type: 'show_plan' } });
    if (open.length > 4) out.push({ id: 'more', tone: 'warn', text: tr(lang, `+ ${open.length - 4} muuta avointa asiaa`, `+ ${open.length - 4} andra öppna frågor`, `+ ${open.length - 4} more open items`), action: { type: 'show_plan' } });
    if (plan.ready && !plan.orderId) out.push({ id: 'ready', tone: 'info', action: { type: 'show_plan' }, text: tr(lang, `Tilausehdotus on valmis: ${plan.totals.lineCount} riviä, ${eur(lang, plan.totals.net)}`, `Orderförslaget är klart: ${plan.totals.lineCount} rader, ${eur(lang, plan.totals.net)}`, `The order proposal is ready: ${plan.totals.lineCount} lines, ${eur(lang, plan.totals.net)}`) });
  }
  for (const d of drafts.filter(x => x.lines.length)) {
    out.push({ id: 'draft-' + d.id, tone: d.pastDate ? 'warn' : 'info', action: { type: 'show_draft', draftId: d.id },
      text: tr(lang, `${d.name} (tilausluonnos): rivejä ${d.lines.length}, ${eur(lang, d.totals.net)}`, `${d.name} (beställningsutkast): ${d.lines.length} rad(er), ${eur(lang, d.totals.net)}`, `${d.name} (order draft): ${d.lines.length} line(s), ${eur(lang, d.totals.net)}`)
        + (d.pastDate ? tr(lang, ' · toimituspäivä on mennyt', ' · leveransdagen har passerat', ' · the delivery date has passed') : '') });
  }
  const wait = valioCooldown();
  if (wait) out.push({ id: 'valio', tone: 'warn', text: `${pick(lang, rateLimitText(wait))} ${tr(lang, 'Sinä aikana tilauksia ei luoda eikä lähetetä.', 'Under tiden skapas eller skickas inga order.', 'Until then no orders are created or sent.')}` });
  else if (valioStatus.checkedAt && !valioStatus.ok) out.push({ id: 'valio', tone: 'warn', text: tr(lang, 'Valio Aimo -mockrajapinta ei vastaa. Hintoja ja saatavuutta ei voida tarkistaa, joten tilauksia ei lähetetä.', 'Valio Aimos mock-API svarar inte. Priser och tillgänglighet kan inte kontrolleras, så inga order skickas.', 'The Valio Aimo mock API is not responding. Prices and availability cannot be checked, so no orders are sent.') });
  return out;
}

export async function stateView(lang: Lang, planIn?: Plan): Promise<DashboardState> {
  const plan = planIn ?? (await buildPlan(lang));
  const drafts = await draftsView(lang);
  const activeDraft = drafts.length ? S().activeDraft : undefined;
  const draft = drafts.find(d => d.id === activeDraft && d.lines.length);
  const k = kitchenView(lang);
  k.authority = authorityView(lang);
  const info = (p: (typeof PROFILES)[number]) => ({ id: p.id, name: p.name, kind: p.kind, description: pick(lang, p.description) });
  return {
    profile: info(currentProfile()), profiles: PROFILES.map(info),
    lang, now: new Date().toISOString(), kitchen: k, menu: menuView(lang), plan, draft, drafts, activeDraft,
    orders: ordersView(lang), deliveries: deliveriesView(lang), attention: attention(lang, plan, drafts), stock: stockView(lang),
    recipes: (S().menu?.kind === 'event' ? mainRecipes() : recipesForRole('main')).map(r => ({ id: r.id, name: pick(lang, r.name), ingredientCount: r.ingredients.length, role: recipeRole(r), ...recipeTerms(r) })),
    audit: auditView(lang, 40),
    agents: agentsView(lang),
    integration: {
      valioMock: { ok: valioStatus.ok, checkedAt: valioStatus.checkedAt, label: valioStatus.ok
        ? tr(lang, `Hinnat ja saatavuus: Valio Aimon haasterajapinta (mock) · ${num(lang, catalogSize(), 0)} tuotetta`, `Priser och tillgänglighet: Valio Aimos utmanings-API (mock) · ${num(lang, catalogSize(), 0)} produkter`, `Prices and availability: Valio Aimo challenge API (mock) · ${num(lang, catalogSize(), 0)} products`)
        : valioCooldown() ? pick(lang, rateLimitText(valioCooldown()))
        : tr(lang, 'Valio Aimon haasterajapinta (mock) ei vastaa juuri nyt', 'Valio Aimos utmanings-API (mock) svarar inte just nu', 'The Valio Aimo challenge API (mock) is not responding right now') },
      llm: { ok: llmStatus.ok, label: llmStatus.ok || !llmStatus.checkedAt
        ? tr(lang, 'Tekoäly tulkitsee pyynnöt · säännöt päättävät allergeeneista ja valtuuksista', 'AI tolkar önskemålen · reglerna avgör allergener och befogenheter', 'AI interprets requests · rules decide allergens and authority')
        : tr(lang, 'Tekoäly ei vastaa – käytän varmistettuja peruskomentoja', 'AI svarar inte – jag använder säkra grundkommandon', 'AI is not responding – using safe built-in commands') },
      ordering: { label: tr(lang, 'Tilauksen lähetys: paikallinen simulaatio (haasterajapinnassa ei ole tilausrajapintaa)', 'Orderläggning: lokal simulering (utmanings-API:t saknar orderändpunkt)', 'Order submission: local simulation (the challenge API has no order endpoint)') },
      access: approversConfigured()
        ? { open: false, label: tr(lang, 'Hyväksyminen ja valtuuksien muuttaminen vaativat hyväksyjän kirjautumisen', 'Godkännande och ändring av befogenheter kräver att en godkännare loggar in', 'Approving and changing authority need a signed-in approver') }
        : { open: true, label: tr(lang, 'Avoin demotila: hyväksyjiä ei ole määritetty, joten kuka tahansa tämän sivun käyttäjä voi hyväksyä', 'Öppet demoläge: inga godkännare har angetts, så vem som helst som använder sidan kan godkänna', 'Open demo mode: no approvers are configured, so anyone using this page can approve') },
    },
    suggestions: suggestions(lang, plan),
    undo: undoView(lang),
  };
}

// ---------- order cards (products picked from search results; "drafts" in code) ----------

const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_DRAFTS = 10;
// Supplier checks yield to other requests; the card must stay unchanged until ordering finishes.
const orderingDrafts = new WeakSet<StoredDraft>();
function assertDraftIdle(card?: StoredDraft) {
  if (card && orderingDrafts.has(card)) throw new UserError(l3(
    'Tilausluonnoksen tilausta käsitellään. Odota sen valmistumista ennen muutoksia.',
    'Beställningsutkastets order behandlas. Vänta tills den är klar innan du ändrar något.',
    'This order draft is being ordered. Wait until it finishes before making changes.',
  ), 'card_busy');
}

/** an L3 text written once as a function of the language */
const inLangs = (f: (lang: Lang) => string): L3 => l3(f('fi'), f('sv'), f('en'));
/** today in Finland, YYYY-MM-DD */
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(new Date());
const newDraftId = () => 'd-' + randomBytes(5).toString('hex');

/** a new card's delivery day: the usual default (Monday of the menu week, or next Monday), never a day that has passed */
function defaultDraftDate(): string {
  let d = nextWeekday();
  while (d < today()) d = addDays(d, 7);
  return d;
}

/** The account's open order cards; while there are any, one of them is selected. An older state file has a single
 *  `draft` list: it becomes the first card. */
function openDrafts(): StoredDraft[] {
  const st = S();
  if (!st.drafts && !st.draft.length) return []; // a read of an empty account changes nothing
  let changed = !st.drafts;
  st.drafts ??= [{ id: newDraftId(), no: 1, deliveryDate: defaultDraftDate(), createdAt: new Date().toISOString(), lines: st.draft }];
  if (st.drafts.length && !st.drafts.some(d => d.id === st.activeDraft)) {
    st.activeDraft = st.drafts[st.drafts.length - 1].id;
    changed = true;
  }
  if (changed) save(); // persist migration immediately, including the new stable card id
  return st.drafts;
}

/** the card's name: the buyer's own, or "Kortti 2" in the user's language */
const draftName = (d: StoredDraft, lang: Lang) => d.name || tr(lang, `Luonnos ${d.no}`, `Utkast ${d.no}`, `Draft ${d.no}`);
/** the name inside a sentence */
const named = (d: StoredDraft, lang: Lang) => (lang === 'en' ? `“${draftName(d, lang)}”` : `”${draftName(d, lang)}”`);
const cleanName = (x: unknown) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

const selectedDraft = () => openDrafts().find(d => d.id === S().activeDraft);
/** the card an action names: it must exist */
function draftOf(id: unknown): StoredDraft {
  const d = openDrafts().find(x => x.id === id);
  if (!d) throw new UserError(l3('Tilausluonnosta ei löytynyt. Se on ehkä jo tilattu tai poistettu.', 'Beställningsutkastet hittades inte. Det har kanske redan beställts eller tagits bort.', 'Order draft not found. It may already have been ordered or deleted.'));
  return d;
}
/** the card an action is for: the one it names, or the selected one */
const targetDraft = (id: unknown) => (id === undefined || id === null || id === '' ? selectedDraft() : draftOf(id));

/** a delivery date the buyer chose: a real calendar day, today or later */
function checkDate(x: unknown): string {
  const s = String(x ?? '');
  const d = new Date(s + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new UserError(l3('Päivämäärä ei kelpaa. Valitse toimituspäivä kalenterista.', 'Datumet är ogiltigt. Välj leveransdag i kalendern.', 'That date is not valid. Pick the delivery date from the calendar.'));
  if (s < today()) throw new UserError(inLangs(l => tr(l, `Toimituspäivä ${dayLabel(l, s)} on jo mennyt. Valitse toimituspäiväksi tänään tai myöhempi päivä.`, `Leveransdagen ${dayLabel(l, s)} har redan passerat. Välj i dag eller en senare dag.`, `The delivery date ${dayLabel(l, s)} has already passed. Choose today or a later day.`)));
  return s;
}

/** A new order card, selected at once. A name and a date are optional. */
function createDraft(name: unknown, date: unknown, who: L3): StoredDraft {
  const st = S(), all = openDrafts();
  if (all.length >= MAX_DRAFTS) throw new UserError(l3(`Avoimia tilausluonnoksia on jo ${MAX_DRAFTS}. Tee tilaus tai poista luonnos ensin.`, `Det finns redan ${MAX_DRAFTS} öppna beställningsutkast. Beställ eller ta bort ett utkast först.`, `There are already ${MAX_DRAFTS} open order drafts. Place an order or delete a draft first.`));
  const card: StoredDraft = {
    id: newDraftId(), name: cleanName(name) || undefined, no: Math.max(0, ...all.map(d => d.no || 0)) + 1,
    deliveryDate: date === undefined || date === null || date === '' ? defaultDraftDate() : checkDate(date), createdAt: new Date().toISOString(), lines: [],
  };
  all.push(card);
  st.drafts = all;
  st.activeDraft = card.id;
  audit(who, 'draft_created', inLangs(l => tr(l, `Tilausluonnos ${named(card, l)} luotu, toimitus ${dayLabel(l, card.deliveryDate)}.`, `Beställningsutkastet ${named(card, l)} skapat, leverans ${dayLabel(l, card.deliveryDate)}.`, `Order draft ${named(card, l)} created, delivery ${dayLabel(l, card.deliveryDate)}.`)));
  return card;
}

/** a removed card is no longer the target: the newest remaining card is */
function removeDraft(card: StoredDraft) {
  const st = S(), all = openDrafts(), i = all.indexOf(card);
  if (i >= 0) all.splice(i, 1);
  if (st.activeDraft === card.id) st.activeDraft = all[all.length - 1]?.id;
}

async function draftView(card: StoredDraft, lang: Lang): Promise<Draft> {
  const offers = await fetchOffers(card.lines.map(l => l.productId), card.deliveryDate);
  const lines = card.lines.flatMap(l => {
    const p = getProduct(l.productId);
    if (!p) return [];
    const offer = toOffer(offers.get(p.id), lang, l.qty);
    return [{ product: productView(p, lang), offer, qty: l.qty, lineTotal: offer.price != null ? round2(l.qty * offer.price) : undefined, checks: checkAll(p, l.reqs, lang) }];
  });
  const net = round2(lines.reduce((a, l) => a + (l.lineTotal ?? 0), 0));
  const vat = round2(lines.reduce((a, l) => a + (l.lineTotal ?? 0) * ((l.offer.vatRate ?? 13.5) / 100), 0));
  return {
    id: card.id, name: draftName(card, lang), deliveryDate: card.deliveryDate, deliveryLabel: dayLabel(lang, card.deliveryDate),
    pastDate: card.deliveryDate < today() || undefined, lines, totals: { net, vat, gross: round2(net + vat), lineCount: lines.length },
  };
}
const draftsView = (lang: Lang) => Promise.all(openDrafts().map(d => draftView(d, lang)));
const draftCard = async (card: StoredDraft, lang: Lang): Promise<Card[]> => [{ type: 'draft', draft: await draftView(card, lang) }];

/** Set a line's quantity in sales units on an order card (0 removes it). Quantities follow the supplier's lot size, and a
 *  product that is not verified for the requirements it was searched with never enters a card. Without any card, the
 *  first addition creates one. */
function setDraftLine(cardId: unknown, productId: string, qty: number, requirements: unknown, lang: Lang, who: L3): { card?: StoredDraft; reply: string } {
  const p = getProduct(String(productId));
  if (!p || p.del) throw new UserError(l3('Tuotetta ei löytynyt valikoimasta.', 'Produkten hittades inte i sortimentet.', 'Product not found in the assortment.'));
  if (!Number.isFinite(qty) || qty < 0 || qty > 100000) throw new UserError(l3('Määrä ei kelpaa.', 'Ogiltig mängd.', 'Invalid quantity.'));
  const card = targetDraft(cardId);
  assertDraftIdle(card);
  const line = card?.lines.find(l => l.productId === p.id);
  if (Math.round(qty) === 0) {
    if (card && line) {
      card.lines.splice(card.lines.indexOf(line), 1);
      audit(who, 'draft_line_removed', inLangs(l => tr(l, `Poistettu tilausluonnoksesta ${named(card, l)}: ${localName(p, l)}`, `Borttagen från beställningsutkastet ${named(card, l)}: ${localName(p, l)}`, `Removed from order draft ${named(card, l)}: ${localName(p, l)}`)));
    }
    return { card, reply: tr(lang, 'Rivi poistettu luonnoksesta.', 'Raden togs bort från utkastet.', 'Line removed from the draft.') };
  }
  // a requirement once attached to a line is never dropped silently
  const reqs = [...new Set([...(line?.reqs ?? []), ...validReqs(requirements)])];
  const bad = (l: Lang) => checkAll(p, reqs, l).find(c => c.verdict !== 'ok')?.summary;
  if (bad('fi')) throw new UserError(l3(`En voi lisätä tuotetta ${p.name}. ${bad('fi')}`, `Jag kan inte lägga till ${localName(p, 'sv')}. ${bad('sv')}`, `I cannot add ${localName(p, 'en')}. ${bad('en')}`));
  if (!line && card && card.lines.length >= 40) throw new UserError(l3('Luonnoksessa on jo 40 riviä. Tee tilaus tai poista rivejä.', 'Utkastet har redan 40 rader. Gör beställningen eller ta bort rader.', 'The draft already has 40 lines. Create the order or remove lines.'));
  // only a product that passed every check above may create the card
  const to = card ?? createDraft(undefined, undefined, who);
  const stored = roundToLot(Math.round(qty), p);
  if (line) { line.qty = stored; line.reqs = reqs; } else to.lines.push({ productId: p.id, qty: stored, reqs });
  const what = (l: Lang) => `${localName(p, l)} × ${stored} ${unitLabel(l, p.su)}`;
  audit(who, 'draft_line_set', inLangs(l => tr(l, `Tilausluonnos ${named(to, l)}: ${what(l)}`, `Beställningsutkastet ${named(to, l)}: ${what(l)}`, `Order draft ${named(to, l)}: ${what(l)}`)));
  return { card: to, reply: tr(lang, `Luonnoksessa ${named(to, lang)}: ${what(lang)}.`, `I utkastet ${named(to, lang)}: ${what(lang)}.`, `In the draft ${named(to, lang)}: ${what(lang)}.`) + (stored !== Math.round(qty) ? ' ' + pick(lang, lotNote(p, stored)) : '') };
}

// ---------- cards ----------

function planCards(plan: Plan | undefined, lang: Lang, focusIssue?: string): Card[] {
  if (!plan) return [];
  const cards: Card[] = [];
  const focus = focusIssue ? plan.issues.find(i => i.id === focusIssue) : undefined;
  if (focus?.resolved) cards.push({ type: 'issue', issue: focus });
  for (const i of plan.issues.filter(i => !i.resolved && i.severity === 'block').slice(0, 6)) cards.push({ type: 'issue', issue: i });
  for (const i of plan.issues.filter(i => !i.resolved && i.severity === 'warn').slice(0, 2)) cards.push({ type: 'issue', issue: i });
  cards.push({ type: 'plan', plan });
  return cards;
}

function planReply(plan: Plan | undefined, lang: Lang): string {
  if (!plan) return tr(lang, 'Tarvitsen ensin ensi viikon ruokalistan. Pudota Excel- tai PDF-tiedosto tähän tai kokeile esimerkkilistaa.', 'Jag behöver först nästa veckas matsedel. Släpp en Excel- eller PDF-fil här eller prova exempellistan.', 'I need next week’s menu first. Drop an Excel or PDF file here, or try the sample menu.');
  const open = plan.issues.filter(i => !i.resolved && i.severity === 'block');
  const allergen = open.filter(i => i.kind === 'allergen_fail' || i.kind === 'allergen_unknown').length;
  if (open.length) {
    const first = open[0];
    if (first.kind === 'portions') return S().menu?.kind === 'event'
      ? tr(lang, 'Ostoslista on luonnosteltu, mutta tarvitsen vielä annosmäärät – montako vierasta ja mitkä erityisruokavaliot?', 'Inköpslistan är utkastad, men jag behöver portionsantalet – hur många gäster och vilka specialkoster?', 'The shopping list is drafted, but I still need the portions – how many guests, and which special diets?')
      : tr(lang, 'Ostoslista on luonnosteltu, mutta tarvitsen vielä annosmäärät – montako lounasta päivässä ja mitkä erityisruokavaliot?', 'Inköpslistan är utkastad, men jag behöver portionsantalet – hur många luncher per dag och vilka specialkoster?', 'The shopping list is drafted, but I still need the portions – how many lunches a day, and which special diets?');
    return allergen
      ? tr(lang, `Ostoslista on valmis ${eur(lang, plan.totals.net)} arvosta, mutta pysäytin ${allergen} tuotetta: ne eivät läpäise erityisruokavalion tarkistusta. Ehdotan tarkistetut vaihtoehdot alla.`, `Inköpslistan är klar för ${eur(lang, plan.totals.net)}, men jag stoppade ${allergen} produkter: de klarar inte specialkostkontrollen. Jag föreslår verifierade alternativ nedan.`, `The shopping list is ready at ${eur(lang, plan.totals.net)}, but I stopped ${allergen} products: they do not pass the special-diet check. Verified alternatives are suggested below.`)
      : tr(lang, `Ostoslista on lähes valmis. ${open.length} asiaa odottaa vastaustasi ennen tilausta.`, `Inköpslistan är nästan klar. ${open.length} saker väntar på ditt svar före beställning.`, `The shopping list is nearly ready. ${open.length} items need your answer before ordering.`);
  }
  return tr(lang, `Tilausehdotus on valmis: ${plan.totals.lineCount} tuotetta, ${eur(lang, plan.totals.net)} (alv 0 %), toimitus ${plan.deliveryLabel.replace(/\.$/, '')}. Kaikki erityisruokavaliotuotteet on tarkistettu toimittajan tiedoista.`, `Orderförslaget är klart: ${plan.totals.lineCount} produkter, ${eur(lang, plan.totals.net)} (moms 0 %), leverans ${plan.deliveryLabel.replace(/\.$/, '')}. Alla specialkostprodukter är kontrollerade mot leverantörens data.`, `The order proposal is ready: ${plan.totals.lineCount} products, ${eur(lang, plan.totals.net)} (excl. VAT), delivery ${plan.deliveryLabel}. Every special-diet product is verified from supplier data.`);
}

/** The answer when the menu went away (`clear_menu`, or the last dish was removed): what is kept and the way back. */
const MENU_GONE = (lang: Lang, lastDish: boolean) =>
  (lastDish
    ? tr(lang, 'Poistit viimeisen ruokalajin, joten poistin koko ruokalistan.', 'Du tog bort den sista rätten, så jag tog bort hela matsedeln.', 'You removed the last dish, so I removed the whole menu.')
    : tr(lang, 'Poistin ruokalistan ja sen ostoslistan.', 'Jag tog bort matsedeln och dess inköpslista.', 'I removed the menu and its shopping list.'))
  + ' ' + tr(lang, 'Tilaukset, tilausluonnokset ja annosmäärät säilyvät. Voit kumota poiston.', 'Order, beställningsutkast och portioner finns kvar. Du kan ångra borttagningen.', 'Orders, order drafts and portions are kept. You can undo the removal.');

function menuReply(lang: Lang): string {
  const m = S().menu!;
  const ask = m.days.filter(d => d.match === 'suggested' || d.match === 'missing').length;
  const ok = m.days.filter(d => d.match === 'confirmed').length;
  const base = m.kind === 'event'
    ? tr(lang, `Luin juhlamenun: ${m.days.length} ruokalajia, joista ${ok} löytyi hyväksytyistä resepteistä.`, `Jag läste festmenyn: ${m.days.length} rätter, varav ${ok} fanns bland godkända recept.`, `I read the event menu: ${m.days.length} courses, ${ok} of them matched approved recipes.`)
    : tr(lang, `Luin ruokalistan: ${m.days.length} päivää, ${ok} ruokalajia löytyi hyväksytyistä resepteistä.`, `Jag läste matsedeln: ${m.days.length} dagar, ${ok} rätter fanns bland godkända recept.`, `I read the menu: ${m.days.length} days, ${ok} dishes matched approved recipes.`);
  const q: string[] = [];
  if (ask) q.push(tr(lang, `${ask} ruokalajin resepti pitää vahvistaa`, `receptet för ${ask} rätt behöver bekräftas`, `${ask} dish needs its recipe confirmed`));
  if (!S().kitchen.portionsConfirmed) q.push(tr(lang, 'tarvitsen annosmäärät ja erityisruokavaliot', 'jag behöver portionsantal och specialkoster', 'I need the portions and special diets'));
  return q.length ? `${base} ${tr(lang, 'Kaksi asiaa vielä', 'Två saker till', 'Before I order')}: ${q.join(tr(lang, ' ja ', ' och ', ' and '))}.`.replace(q.length === 1 ? /Kaksi asiaa vielä|Två saker till/ : /^$/, tr(lang, 'Yksi asia vielä', 'En sak till', 'Before I order')) : `${base} ${tr(lang, 'Lasken ostoslistan.', 'Jag räknar inköpslistan.', 'Calculating the shopping list.')}`;
}

async function respond(lang: Lang, reply: string, cards: Card[], plan?: Plan): Promise<TurnResponse> {
  save();
  return { reply, cards, state: await stateView(lang, plan) };
}

// ---------- import ----------

export async function handleImport(buf: Buffer, filename: string, lang: Lang): Promise<TurnResponse> {
  await importMenu(buf, filename);
  clearUndo(); // a new menu is a new starting point
  const plan = await buildPlan(lang);
  const cards: Card[] = [{ type: 'menu', menu: menuView(lang)! }, ...planCards(plan, lang).filter(c => c.type === 'issue' && (c.issue.kind === 'suggested_recipe' || c.issue.kind === 'missing_recipe' || c.issue.kind === 'portions'))];
  return respond(lang, menuReply(lang), cards, plan);
}

export async function loadDemoMenu(lang: Lang): Promise<TurnResponse> {
  const file = currentProfile().demoFile;
  const res = await handleImport(readFileSync(resolve(config.demoDir, file)), file, lang);
  S().menu!.source.kind = 'demo';
  save();
  res.state = await stateView(lang);
  return res;
}

// ---------- UI actions ----------

/** Decisions and changes of authority: with approvers configured they need a signed-in approver. */
const APPROVER_ONLY: UiAction['type'][] = ['approve_order', 'reject_order', 'cancel_order', 'set_credit_limit', 'agent_create', 'agent_update', 'agent_revoke', 'reset_demo'];

/** Every plan edit goes through here: the undo stack is filled before the change, and emptied when an order is created from the plan. */
export async function handleAction(a: UiAction, lang: Lang, approver?: string): Promise<TurnResponse> {
  const edits = !!a && typeof a === 'object' && UNDOABLE.includes(a.type);
  const res = edits ? await withUndo(() => undoLabel(a), () => runAction(a, lang, approver)) : await runAction(a, lang, approver);
  if (a.type === 'create_order') clearUndo();
  res.state.undo = undoView(lang);
  return res;
}

/** `approver`: name of the signed-in approver of this request (see approvers.ts); undefined when nobody is signed in. */
async function runAction(a: UiAction, lang: Lang, approver?: string): Promise<TurnResponse> {
  if (!a || typeof a !== 'object' || typeof (a as { type?: unknown }).type !== 'string') throw new UserError(l3('Toiminto puuttuu.', 'Åtgärden saknas.', 'No action given.'));
  const anonymous = approversConfigured() && !approver;
  if (anonymous && APPROVER_ONLY.includes(a.type)) throw new UserError(l3('Tämä vaatii hyväksyjän kirjautumisen (nimi ja PIN-koodi).', 'Det här kräver att en godkännare loggar in (namn och PIN-kod).', 'This needs a signed-in approver (name and PIN).'), 'approver_required');
  // open demo mode: decisions are logged as the kitchen manager, as before
  const who = approver ? ACTOR.person(approver) : ACTOR.kitchen;
  // with approvers configured, an order nobody signed in for is never sent on the kitchen user's own authority
  const unsigned = anonymous ? l3('Tilauksen tekijä ei ole kirjautunut – kirjautunut hyväksyjä vahvistaa lähetyksen.', 'Den som gjorde ordern är inte inloggad – en inloggad godkännare bekräftar sändningen.', 'The order was made without signing in – a signed-in approver confirms sending.') : undefined;
  switch (a.type) {
    case 'set_course': {
      setCourse(a.date, a.role);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, 'Rooli valittu. Tarkista resepti.', 'Rollen vald. Kontrollera receptet.', 'Role selected. Check the recipe.'), [{ type: 'menu', menu: menuView(lang)! }, ...planCards(plan, lang)], plan);
    }
    case 'confirm_recipe':
    case 'skip_day':
    case 'restore_day':
    case 'set_custom_dish': {
      let reply: string;
      if (a.type === 'confirm_recipe') {
        confirmRecipe(a.date, a.recipeId);
        reply = tr(lang, 'Selvä, käytän tätä reseptiä.', 'Okej, jag använder det receptet.', 'Got it, I will use that recipe.');
      } else if (a.type === 'skip_day') {
        const event = S().menu?.kind === 'event';
        reply = skipDay(a.date)
          ? MENU_GONE(lang, true)
          : event
            ? tr(lang, 'Selvä, poistin ruokalajin: sille ei tilata mitään. Voit palauttaa sen menun lopusta.', 'Okej, jag tog bort rätten: inget beställs för den. Du kan återställa den längst ner i menyn.', 'Got it, I removed the dish: nothing will be ordered for it. You can restore it at the end of the menu.')
            : tr(lang, 'Selvä, poistin ruokalajin: tälle päivälle ei tilata mitään. Voit palauttaa sen ruokalistan lopusta.', 'Okej, jag tog bort rätten: inget beställs för dagen. Du kan återställa den längst ner i matsedeln.', 'Got it, I removed the dish: nothing will be ordered for that day. You can restore it at the end of the menu.');
      } else if (a.type === 'restore_day') {
        const what = restoreDay(a.date);
        reply = tr(lang, `Palautin ruokalajin: ${what.fi}.`, `Jag återställde rätten: ${what.sv}.`, `I restored the dish: ${what.en}.`);
      } else {
        const recipe = setCustomDish(a.date, a.name);
        reply = recipe
          ? tr(lang, `Nimi vastaa hyväksyttyä reseptiä ${recipe.name.fi}, joten käytän sitä.`, `Namnet motsvarar det godkända receptet ${recipe.name.sv}, så jag använder det.`, `The name matches the approved recipe ${recipe.name.en}, so I am using it.`)
          : S().menu?.kind === 'event'
            ? tr(lang, 'Merkitsin oman ruokalajin. Sille ei ole reseptiä, joten en laske sille määriä enkä tilaa sille mitään automaattisesti. Tuotteet voit hakea tukusta ruokalajin kortissa.', 'Jag noterade din egen rätt. Den har inget recept, så jag räknar inga mängder och beställer inget automatiskt för den. Produkter kan du söka i grossistens sortiment på rättens kort.', 'I noted your own dish. It has no recipe, so I calculate no amounts and order nothing automatically for it. You can find products from the wholesaler on the dish’s card.')
            : tr(lang, 'Merkitsin oman ruokalajin. Sille ei ole reseptiä, joten en laske sille määriä enkä tilaa tälle päivälle mitään automaattisesti. Tuotteet voit hakea tukusta päivän kortissa.', 'Jag noterade din egen rätt. Den har inget recept, så jag räknar inga mängder och beställer inget automatiskt för dagen. Produkter kan du söka i grossistens sortiment på dagens kort.', 'I noted your own dish. It has no recipe, so I calculate no amounts and order nothing automatically for that day. You can find products from the wholesaler on the day’s card.');
      }
      const plan = await buildPlan(lang);
      const menu = menuView(lang);
      // the last dish took the whole menu with it: nothing of it is shown any more
      if (!menu) return respond(lang, reply, [], plan);
      return respond(lang, `${reply} ${planReply(plan, lang)}`, [{ type: 'menu', menu }, ...planCards(plan, lang)], plan);
    }
    case 'clear_menu': {
      clearMenu(who);
      return respond(lang, MENU_GONE(lang, false), [], await buildPlan(lang));
    }
    case 'set_portions': {
      const st = S();
      const hadLineEdits = st.edits.removed.length > 0 || Object.keys(st.edits.qty).length > 0;
      setPortions(a.total, a.groups);
      const plan = await buildPlan(lang);
      // the quantities are calculated again from the new portions: lines the user removed or set by hand follow
      const reset = hadLineEdits ? ' ' + tr(lang, 'Poistamasi rivit ja käsin muuttamasi määrät palautettiin laskettuihin, koska annokset muuttuivat. Voit kumota muutoksen.', 'Rader du tagit bort och mängder du ändrat för hand återställdes till de beräknade, eftersom portionerna ändrades. Du kan ångra ändringen.', 'Lines you removed and quantities you set by hand went back to the calculated ones, because the portions changed. You can undo the change.') : '';
      return respond(lang, portionsReply(lang) + reset + ' ' + planReply(plan, lang), [{ type: 'portions', kitchen: kitchenView(lang) }, ...planCards(plan, lang)], plan);
    }
    case 'build_plan':
    case 'show_plan': {
      const plan = await buildPlan(lang);
      return respond(lang, planReply(plan, lang), planCards(plan, lang), plan);
    }
    case 'resolve_issue': {
      const before = await buildPlan(lang);
      const what = resolveIssue(a.issueId, a.productId, lang, before);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, `Tehty – ${what}. Tarkistin tuotteen uudelleen ja muistan valinnan jatkossa.`, `Klart – ${what}. Jag kontrollerade produkten på nytt och minns valet framöver.`, `Done – ${what}. I re-checked the product and will remember this choice.`) + ' ' + (plan?.ready ? planReply(plan, lang) : ''), planCards(plan, lang, a.issueId), plan);
    }
    case 'reopen_issue': {
      const what = reopenIssue(a.issueId, lang);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, `Avasin valinnan uudelleen: ${what}. Asia estää taas tilauksen, kunnes valitset tarkistetun tuotteen tai jätät sen pois.`, `Jag öppnade valet igen: ${what}. Ärendet stoppar ordern igen tills du väljer en verifierad produkt eller lämnar den utanför.`, `I opened the choice again: ${what}. It blocks the order again until you pick a verified product or leave it out.`), planCards(plan, lang, a.issueId), plan);
    }
    case 'skip_issue': {
      const what = skipIssue(a.issueId, lang);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, `Selvä, jätin pois: ${what}. Mitään varmistamatonta ei tilata, ja muu tilaus etenee.`, `Okej, jag utelämnade: ${what}. Inget overifierat beställs och resten av ordern går vidare.`, `Okay, left out: ${what}. Nothing unverified is ordered and the rest of the order proceeds.`) + ' ' + (plan?.ready ? planReply(plan, lang) : ''), planCards(plan, lang, a.issueId), plan);
    }
    case 'set_credit_limit': {
      const st = S();
      const limit = a.limit == null ? undefined : Number(a.limit);
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0 || limit > 10_000_000)) throw new UserError(l3('Luottorajan pitää olla 0–10 000 000 €.', 'Kreditgränsen ska vara 0–10 000 000 €.', 'The credit limit must be between €0 and €10,000,000.'));
      st.kitchen.authority.creditLimit = limit;
      audit(who, 'set_credit_limit', limit === undefined ? l3('Tilin luottoraja poistettu (demoasetus).', 'Kontots kreditgräns borttagen (demoinställning).', 'Account credit limit removed (demo setting).') : l3(`Tilin luottorajaksi asetettu ${eur('fi', limit)} (demoasetus).`, `Kontots kreditgräns satt till ${eur('sv', limit)} (demoinställning).`, `Account credit limit set to ${eur('en', limit)} (demo setting).`));
      const plan = await buildPlan(lang);
      return respond(lang, limit === undefined ? tr(lang, 'Tilillä ei ole enää luottorajaa.', 'Kontot har inte längre någon kreditgräns.', 'The account no longer has a credit limit.') : tr(lang, `Luottoraja on nyt ${eur(lang, limit)}. Se on katto, jota mikään hyväksyntä ei ylitä.`, `Kreditgränsen är nu ${eur(lang, limit)}. Det är ett tak som inget godkännande kan överskrida.`, `The credit limit is now ${eur(lang, limit)}. It is a cap no approval can exceed.`), [], plan);
    }
    case 'agent_create': {
      const { agent, token } = createAgent(a.name, a.perOrderLimit, a.weeklyLimit, a.validDays, who);
      const res = await respond(lang, tr(lang, `Agentti ${agent.name} on rekisteröity. Kopioi sen tunnus nyt: sitä ei näytetä uudelleen.`, `Agenten ${agent.name} är registrerad. Kopiera dess token nu: den visas inte igen.`, `Agent ${agent.name} is registered. Copy its token now: it is not shown again.`), []);
      return { ...res, issuedToken: { agentId: agent.id, name: agent.name, token } };
    }
    case 'agent_update': {
      const agent = updateAgent(a.agentId, a.perOrderLimit, a.weeklyLimit, who);
      return respond(lang, tr(lang, `Agentin ${agent.name} rajat on päivitetty.`, `Gränserna för agenten ${agent.name} är uppdaterade.`, `The limits of agent ${agent.name} are updated.`), []);
    }
    case 'agent_revoke': {
      const agent = revokeAgent(a.agentId, who);
      return respond(lang, tr(lang, `Agentin ${agent.name} valtuus on peruttu. Sen tunnus ei enää kelpaa.`, `Befogenheten för agenten ${agent.name} är återkallad. Dess token gäller inte längre.`, `The authorisation of agent ${agent.name} is revoked. Its token no longer works.`), []);
    }
    case 'swap_line': {
      const before = await buildPlan(lang);
      const what = swapLine(a.lineId, a.productId, lang, before);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, `Vaihdettu – ${what}. Ruokavaliovaatimukset tarkistettiin uudelleen.`, `Bytt – ${what}. Kostkraven kontrollerades på nytt.`, `Switched – ${what}. Dietary requirements were re-checked.`), planCards(plan, lang), plan);
    }
    case 'set_line_qty': {
      const stored = setLineQty(a.lineId, a.qty);
      const p = getProduct(a.lineId);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, 'Määrä päivitetty.', 'Mängden uppdaterad.', 'Quantity updated.') + (p && stored !== Math.round(a.qty) ? ' ' + pick(lang, lotNote(p, stored)) : ''), plan ? [{ type: 'plan', plan }] : [], plan);
    }
    case 'draft_set': {
      const { card, reply } = setDraftLine(a.draftId, a.productId, Number(a.qty), a.requirements, lang, who);
      return respond(lang, reply, card ? await draftCard(card, lang) : []);
    }
    case 'show_draft': {
      const card = targetDraft(a.draftId);
      if (card) S().activeDraft = card.id;
      return respond(lang, card ? tr(lang, `Tässä tilausluonnos ${named(card, lang)}.`, `Här är beställningsutkastet ${named(card, lang)}.`, `Here is the order draft ${named(card, lang)}.`) : tr(lang, 'Tilausluonnoksia ei vielä ole. Hae tuote ja lisää se: ensimmäinen lisäys luo luonnoksen.', 'Det finns inga beställningsutkast ännu. Sök en produkt och lägg till den: det första tillägget skapar ett utkast.', 'There are no order drafts yet. Search for a product and add it: the first addition creates a draft.'), card ? await draftCard(card, lang) : []);
    }
    case 'draft_create': {
      const card = createDraft(a.name, a.deliveryDate, who);
      return respond(lang, tr(lang, `Loin tilausluonnoksen ${named(card, lang)}, toimitus ${dayLabel(lang, card.deliveryDate)}. Uudet lisäykset tulevat siihen.`, `Jag skapade beställningsutkastet ${named(card, lang)}, leverans ${dayLabel(lang, card.deliveryDate)}. Nya tillägg hamnar i det.`, `I created the order draft ${named(card, lang)}, delivery ${dayLabel(lang, card.deliveryDate)}. New additions go to it.`), await draftCard(card, lang));
    }
    case 'draft_update': {
      const card = draftOf(a.draftId);
      assertDraftIdle(card);
      // check everything first: a refused change leaves the card as it was
      const name = a.name === undefined ? card.name : cleanName(a.name) || undefined;
      const date = a.deliveryDate === undefined || a.deliveryDate === card.deliveryDate ? card.deliveryDate : checkDate(a.deliveryDate);
      const before = { ...card };
      card.name = name;
      card.deliveryDate = date;
      const changes = (l: Lang) => [
        before.name !== name ? tr(l, `nimi ${named(before, l)} → ${named(card, l)}`, `namn ${named(before, l)} → ${named(card, l)}`, `name ${named(before, l)} → ${named(card, l)}`) : '',
        before.deliveryDate !== date ? tr(l, `toimitus ${dayLabel(l, before.deliveryDate)} → ${dayLabel(l, date)}`, `leverans ${dayLabel(l, before.deliveryDate)} → ${dayLabel(l, date)}`, `delivery ${dayLabel(l, before.deliveryDate)} → ${dayLabel(l, date)}`) : '',
      ].filter(Boolean).join(', ');
      if (!changes(lang)) return respond(lang, tr(lang, 'Luonnos on ennallaan.', 'Utkastet är oförändrat.', 'The draft is unchanged.'), await draftCard(card, lang));
      audit(who, 'draft_updated', inLangs(l => tr(l, `Tilausluonnosta muutettu: ${changes(l)}.`, `Beställningsutkastet ändrat: ${changes(l)}.`, `Order draft changed: ${changes(l)}.`)));
      return respond(lang, tr(lang, `Luonnos päivitetty: ${changes(lang)}.`, `Utkastet uppdaterat: ${changes(lang)}.`, `Draft updated: ${changes(lang)}.`), await draftCard(card, lang));
    }
    case 'draft_delete': {
      const card = draftOf(a.draftId);
      assertDraftIdle(card);
      removeDraft(card);
      const n = card.lines.length;
      audit(who, 'draft_deleted', inLangs(l => tr(l, `Tilausluonnos ${named(card, l)} poistettu (rivejä ${n}). Mitään ei tilattu.`, `Beställningsutkastet ${named(card, l)} borttaget (${n} rad(er)). Inget beställdes.`, `Order draft ${named(card, l)} deleted (${n} line(s)). Nothing was ordered.`)));
      return respond(lang, tr(lang, `Poistin luonnoksen ${named(card, lang)}. Mitään ei tilattu.`, `Jag tog bort utkastet ${named(card, lang)}. Inget beställdes.`, `I deleted the draft ${named(card, lang)}. Nothing was ordered.`), []);
    }
    case 'draft_select': {
      const card = draftOf(a.draftId);
      S().activeDraft = card.id;
      return respond(lang, tr(lang, `Lisäykset tulevat nyt luonnokseen ${named(card, lang)}.`, `Tillägg hamnar nu i utkastet ${named(card, lang)}.`, `Additions now go to the draft ${named(card, lang)}.`), []);
    }
    case 'draft_order': {
      const card = targetDraft(a.draftId);
      assertDraftIdle(card);
      if (!card?.lines.length) throw new UserError(l3('Tilausluonnos on tyhjä.', 'Beställningsutkastet är tomt.', 'The order draft is empty.'));
      const date = card.deliveryDate;
      // nothing is ordered for a day that has passed: the buyer picks a new one
      if (date < today()) throw new UserError(inLangs(l => tr(l, `Toimituspäivä ${dayLabel(l, date)} on jo mennyt, joten sille ei voi tilata. Vaihda luonnokselle uusi toimituspäivä.`, `Leveransdagen ${dayLabel(l, date)} har redan passerat, så det går inte att beställa till den. Byt leveransdag på utkastet.`, `The delivery date ${dayLabel(l, date)} has already passed, so nothing can be ordered for it. Change the draft’s delivery date.`)));
      const lines: NewOrder['lines'] = card.lines.map(l => ({ productId: l.productId, qty: l.qty, reqs: l.reqs, groupIds: [] }));
      orderingDrafts.add(card);
      try {
        // In-process purchasing agent: the same signed quote and verification path as every order.
        const { order, duplicate } = await createOrder({
          source: 'ui', actor: who, forceApproval: unsigned, deliveryDate: date, lines, idempotencyKey: 'draft-' + contentKey(lines, date),
          title: inLangs(l => draftName(card, l)),
        });
        if (!duplicate) removeDraft(card);
        return await respond(lang, orderReply(order.id, duplicate, lang), [{ type: 'order', order: orderView(order, lang) }]);
      } finally { orderingDrafts.delete(card); }
    }
    case 'remove_line': {
      removeLine(a.lineId);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, 'Rivi poistettu ehdotuksesta. Sen voi palauttaa ostoslistan lopusta.', 'Raden togs bort från förslaget. Den kan återställas längst ner i inköpslistan.', 'Line removed from the proposal. It can be restored at the end of the shopping list.'), plan ? [{ type: 'plan', plan }] : [], plan);
    }
    case 'restore_line':
    case 'reset_line_qty':
    case 'restore_product': {
      if (a.type === 'restore_line') restoreLine(a.lineId); else if (a.type === 'reset_line_qty') resetLineQty(a.lineId); else restoreProduct(a.lineId);
      const plan = await buildPlan(lang);
      const reply = a.type === 'restore_line'
        ? tr(lang, 'Rivi palautettu ostoslistalle laskettuun määrään.', 'Raden är tillbaka i inköpslistan med beräknad mängd.', 'The line is back on the shopping list at the calculated quantity.')
        : a.type === 'reset_line_qty'
          ? tr(lang, 'Rivi palautettu laskettuun määrään.', 'Raden har den beräknade mängden igen.', 'The line is back at the calculated quantity.')
          : tr(lang, 'Aiempi tuote palautettu. Ruokavaliovaatimukset tarkistettiin uudelleen.', 'Den tidigare produkten är tillbaka. Kostkraven kontrollerades på nytt.', 'The earlier product is back. Dietary requirements were re-checked.');
      return respond(lang, reply, plan ? [{ type: 'plan', plan }] : [], plan);
    }
    case 'find_cheaper': return cheaper(lang, a.lineId);
    case 'undo': {
      const what = undoLast(who);
      const plan = await buildPlan(lang);
      return respond(lang, tr(lang, `Kumottu: ${pick(lang, what)}.`, `Ångrat: ${pick(lang, what)}.`, `Undone: ${pick(lang, what)}.`) + ' ' + planReply(plan, lang), S().menu ? [{ type: 'menu', menu: menuView(lang)! }, ...planCards(plan, lang)] : planCards(plan, lang), plan);
    }
    case 'create_order': {
      const plan = await buildPlan(lang);
      if (!plan) throw new UserError(l3('Ei tilausehdotusta. Tuo ensin ruokalista.', 'Inget orderförslag. Importera först en matsedel.', 'No proposal yet. Import a menu first.'));
      const { order, duplicate } = await createOrderFromPlan(plan, who, unsigned);
      const after = await buildPlan(lang);
      return respond(lang, orderReply(order.id, duplicate, lang), [{ type: 'order', order: orderView(order, lang) }], after);
    }
    case 'approve_order': {
      const o = await approveOrder(a.orderId, who);
      const reply = o.status === 'submitted'
        ? tr(lang, `Tilaus ${o.id} on hyväksytty ja kirjattu (simulaatio), vahvistus ${o.confirmation}. Tarkistin hinnat, saatavuuden ja allergeenit vielä kerran ennen lähetystä.`, `Order ${o.id} är godkänd och registrerad (simulering), bekräftelse ${o.confirmation}. Jag kontrollerade priser, tillgänglighet och allergener en gång till före sändning.`, `Order ${o.id} is approved and recorded (simulation), confirmation ${o.confirmation}. I re-checked prices, availability and allergens once more before sending.`)
        : o.recheck?.repriced
        ? tr(lang, `En lähettänyt tilausta ${o.id}: hinta oli muuttunut. Uusi yhteissumma on ${eur(lang, o.net)} (alv 0 %). Hyväksy uudelleen, jos uusi hinta käy.`, `Jag skickade inte order ${o.id}: priset hade ändrats. Den nya totalsumman är ${eur(lang, o.net)} (moms 0 %). Godkänn igen om det nya priset går bra.`, `I did not send order ${o.id}: a price had changed. The new total is ${eur(lang, o.net)} (excl. VAT). Approve again if the new price is acceptable.`)
        : tr(lang, `En lähettänyt tilausta ${o.id}: uusintatarkistus löysi esteen. Katso muutokset tilauksesta.`, `Jag skickade inte order ${o.id}: den nya kontrollen hittade ett hinder. Se ändringarna på ordern.`, `I did not send order ${o.id}: the re-check found a blocker. See the changes on the order.`);
      return respond(lang, reply, [{ type: 'order', order: orderView(o, lang) }]);
    }
    case 'reject_order':
    case 'cancel_order': {
      const o = decideOrder(a.orderId, a.type === 'reject_order' ? 'rejected' : 'cancelled', who);
      return respond(lang, tr(lang, `Tilaus ${o.id} on ${a.type === 'reject_order' ? 'hylätty' : 'peruttu'}. Mitään ei lähetetty.`, `Order ${o.id} är ${a.type === 'reject_order' ? 'avvisad' : 'avbruten'}. Inget skickades.`, `Order ${o.id} was ${a.type === 'reject_order' ? 'rejected' : 'cancelled'}. Nothing was sent.`), [{ type: 'order', order: orderView(o, lang) }]);
    }
    case 'show_order': {
      const o = findOrder(a.orderId);
      if (!o) throw new UserError(l3('Tilausta ei löytynyt.', 'Ordern hittades inte.', 'Order not found.'));
      return respond(lang, o.status === 'pending_approval' ? tr(lang, `Tilaus ${o.id} odottaa päätöstäsi.`, `Order ${o.id} väntar på ditt beslut.`, `Order ${o.id} is waiting for your decision.`) : tr(lang, `Tässä tilaus ${o.id}.`, `Här är order ${o.id}.`, `Here is order ${o.id}.`), [{ type: 'order', order: orderView(o, lang) }]);
    }
    case 'show_audit': return respond(lang, tr(lang, 'Tässä viimeisimmät tapahtumat. Jokainen merkintä on ketjutettu tiivisteellä, joten lokia ei voi muuttaa huomaamatta.', 'Här är de senaste händelserna. Varje post är kedjad med en hash, så loggen kan inte ändras obemärkt.', 'Here are the latest events. Each entry is hash-chained, so the log cannot be changed unnoticed.'), [{ type: 'audit', entries: auditView(lang, 40) }]);
    case 'show_menu': {
      const m = menuView(lang);
      return respond(lang, m ? tr(lang, 'Tässä viikon ruokalista.', 'Här är veckans matsedel.', 'Here is the week’s menu.') : planReply(undefined, lang), m ? [{ type: 'menu', menu: m }] : []);
    }
    case 'load_demo_menu': return loadDemoMenu(lang);
    case 'reset_demo': {
      resetState();
      audit(who, 'reset', l3('Demo nollattu.', 'Demon återställd.', 'Demo reset.'));
      return respond(lang, tr(lang, 'Aloitetaan alusta. Pudota ruokalista tähän, niin hoidan loput.', 'Vi börjar om. Släpp matsedeln här så sköter jag resten.', 'Starting fresh. Drop the menu here and I will handle the rest.'), []);
    }
    default:
      throw new UserError(l3('Tuntematon toiminto.', 'Okänd åtgärd.', 'Unknown action.'));
  }
}

function portionsReply(lang: Lang): string {
  const k = kitchenView(lang);
  const g = k.groups.map(x => `${x.count} ${x.label.toLowerCase()}`).join(', ');
  const ids = k.groups.map(x => x.id);
  const sep = ids.includes('milk_free') || ids.includes('lactose_free')
    ? tr(lang, 'Laktoositon ja maidoton tarkistetaan erikseen.', 'Laktosfritt och mjölkfritt kontrolleras var för sig.', 'Lactose-free and milk-free are checked separately.')
    : tr(lang, 'Gluteeniton ja vehnätön tarkistetaan erikseen.', 'Glutenfritt och vetefritt kontrolleras var för sig.', 'Gluten-free and wheat-free are checked separately.');
  return tr(lang, `Kirjasin ${k.portionsTotal} ${k.portionLabel}${g ? ` (${g}; perusannoksia ${k.standardCount})` : ''}. ${sep}`, `Jag noterade ${k.portionsTotal} ${k.portionLabel}${g ? ` (${g}; standardportioner ${k.standardCount})` : ''}. ${sep}`, `Noted ${k.portionsTotal} ${k.portionLabel}${g ? ` (${g}; ${k.standardCount} standard)` : ''}. ${sep}`);
}

function orderReply(id: string, duplicate: boolean, lang: Lang): string {
  const o = findOrder(id)!;
  if (duplicate) return tr(lang, `Sama tilaus on jo olemassa (${o.id}), joten en luonut uutta.`, `Samma order finns redan (${o.id}), så jag skapade ingen ny.`, `The same order already exists (${o.id}), so I did not create another.`);
  return o.status === 'submitted'
    ? tr(lang, `Tilaus ${o.id} oli valtuutesi sisällä ja kirjattiin heti (simulaatio), vahvistus ${o.confirmation}.`, `Order ${o.id} låg inom din befogenhet och registrerades direkt (simulering), bekräftelse ${o.confirmation}.`, `Order ${o.id} was within your authority and recorded right away (simulation), confirmation ${o.confirmation}.`)
    : tr(lang, `Tilaus ${o.id} on valmis hyväksyttäväksi: ${eur(lang, o.net)} (alv 0 %). Tarkista ja hyväksy, niin lähetän sen.`, `Order ${o.id} är klar för godkännande: ${eur(lang, o.net)} (moms 0 %). Granska och godkänn så skickar jag den.`, `Order ${o.id} is ready for approval: ${eur(lang, o.net)} (excl. VAT). Review and approve, and I will send it.`);
}

async function cheaper(lang: Lang, lineId?: string): Promise<TurnResponse> {
  const plan = await buildPlan(lang);
  if (!plan?.lines.length) return respond(lang, planReply(plan, lang), [], plan);
  const cards = await findCheaper(lang, plan, lineId);
  if (!cards.length) return respond(lang, tr(lang, 'En löytänyt halvempaa vaihtoehtoa, joka täyttäisi samat ruokavaliovaatimukset ja olisi saatavilla. Nykyiset valinnat pysyvät.', 'Jag hittade inget billigare alternativ som uppfyller samma kostkrav och finns tillgängligt. Nuvarande val står kvar.', 'I found no cheaper option that meets the same dietary requirements and is available. The current choices stay.'), [], plan);
  return respond(lang, tr(lang, `Löysin ${cards.length} säästökohdetta. Jokainen vaihtoehto on tarkistettu samoilla ruokavaliovaatimuksilla – vaihda halutessasi.`, `Jag hittade ${cards.length} möjliga besparingar. Varje alternativ är kontrollerat mot samma kostkrav – byt om du vill.`, `I found ${cards.length} possible savings. Each option was checked against the same dietary requirements – switch if you like.`), cards, plan);
}

// ---------- chat ----------

const REQ_PROPS = Object.fromEntries(REQUIREMENTS.map(r => [r, { type: 'integer', description: `portions per day that must be ${r.replace('_', '-')}` }]));
const TOOLS: ToolDef[] = [
  { name: 'find_ingredients', description: 'Help find ingredients for a dish, never order or add to the draft. If the buyer listed ingredients, use their list. Otherwise propose a starting list for the buyer to check (not an approved recipe). Use for ingredient requests or making a dish. Only use quick_order instead when the buyer explicitly says ORDER and supplies their own complete list WITH amounts.', parameters: { type: 'object', properties: {} } },
  { name: 'set_portions', description: 'Record how many lunches are served per day and how many of them need each special diet. gluten_free and wheat_free are different diets; never merge them. lactose_free and milk_free are different too.', parameters: { type: 'object', properties: { total: { type: 'integer', description: 'total portions per day' }, ...REQ_PROPS } } },
  { name: 'prepare_week_order', description: 'Build or show next week’s shopping list / order proposal from the imported menu.', parameters: { type: 'object', properties: {} } },
  { name: 'find_cheaper', description: 'Look for cheaper alternatives for lines of the current order proposal without loosening any dietary requirement.', parameters: { type: 'object', properties: { ingredient: { type: 'string', description: 'optional ingredient the user mentioned, in Finnish' } } } },
  { name: 'quick_order', description: 'Order specific amounts of one or more product types as ONE order, e.g. "20 kg of rice, 10 litres of cooking cream and 70 alcohol-free beers for Friday" or "1000 litres of lactose-free milk for Monday". Put EVERY product the user mentions into items. Any customer may order any product in the assortment. Use this whenever the user states an amount to buy, also when they phrase it as a need or ask you to find an option ("I need 1,000 litres of lactose-free milk by Monday, find an option").', parameters: { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['product', 'amount', 'unit'], properties: { product: { type: 'string', description: 'Finnish catalog search words for the product type in BASE FORM, without diet words, e.g. "maitojuoma", "olut", "alkoholiton olut", "kaurajuoma", "ruokakerma", "makaroni"' }, amount: { type: 'number' }, unit: { type: 'string', enum: ['l', 'kg', 'kpl'], description: 'l = litres, kg = kilos, kpl = pieces (bottles, cans, packs) when the user gives a plain count' }, requirements: { type: 'array', items: { type: 'string', enum: REQUIREMENTS }, description: 'dietary requirements THIS product must meet' } } } }, weekday: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], description: 'requested delivery weekday' } } } },
  { name: 'search_products', description: 'Search the wholesaler catalog and show products with allergen checks, price and availability. Only for browsing without an amount to buy.', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'Finnish search words' }, requirements: { type: 'array', items: { type: 'string', enum: REQUIREMENTS } } } } },
  { name: 'show', description: 'Show something that already exists.', parameters: { type: 'object', required: ['what'], properties: { what: { type: 'string', enum: ['menu', 'plan', 'orders', 'audit'] } } } },
  { name: 'send_for_approval', description: 'Create the order from the current proposal and send it for approval.', parameters: { type: 'object', properties: {} } },
  { name: 'set_menu_text', description: 'The user typed the week menu directly in the message (weekdays with dishes). Pass the text verbatim.', parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  { name: 'load_sample_menu', description: 'Load the bundled sample school menu.', parameters: { type: 'object', properties: {} } },
];

TOOLS.push(...MENU_TOOLS);

const WEEKDAY_RE: [Weekday, RegExp][] = [['mon', /maanant|måndag|monday/], ['tue', /tiista|tisdag|tuesday/], ['wed', /keskiviik|onsdag|wednesday/], ['thu', /torsta|torsdag|thursday/], ['fri', /perjant|fredag|friday/], ['sat', /lauant|lördag|saturday/], ['sun', /sunnunt|söndag|sunday/]];
const DIET_RE: [Requirement, RegExp][] = [['lactose_free', /laktoosit|laktosfri|lactose/], ['milk_free', /maidot|mjölkfri|milk[- ]free|dairy[- ]free/], ['gluten_free', /gluteenit|glutenfri|gluten[- ]free/], ['wheat_free', /vehnät|vetefri|wheat[- ]free/], ['egg_free', /munaton|munattom|äggfri|egg[- ]free/], ['nut_free', /pähkinät|nötfri|nut[- ]free/], ['soy_free', /soijaton|soijattom|sojafri|soy[- ]free/], ['fish_free', /kalaton|kalattom|fiskfri|fish[- ]free/]];
const dietsIn = (text: string): Requirement[] => DIET_RE.filter(([, re]) => re.test(text)).map(([r]) => r);
const validReqs = (x: unknown): Requirement[] => (Array.isArray(x) ? x : []).filter((r): r is Requirement => (REQUIREMENTS as string[]).includes(r));

/** An order as a list of "amount [unit] product": "Tilaa 20 kg riisiä, 10 l ruokakermaa ja 70 alkoholitonta olutta perjantaiksi".
 *  Returns [] unless the whole message reads that way; other wordings are left to the older rules in fallbackIntent. */
function fallbackNeeds(m: string): Record<string, any>[] {
  const verb = m.match(/tilaa|order|beställ|tarvitsen|need|behöver/);
  if (!verb || /lounas|annos|ateria|portion|lunch|meal|vieras|gäst|guest/.test(m)) return [];
  const body = m.slice(verb.index! + verb[0].length).replace(/^\D+/, '').replace(/[.!?\s]+$/, '');
  const out: Record<string, any>[] = [];
  for (const part of body.split(/\s*[,;]\s+(?:(?:ja|sekä|och|samt|and)\s+)?(?=\d)|\s+(?:ja|sekä|och|samt|and|&)\s+(?=\d)/)) {
    const x = part.match(/^(\d[\d\s.,]*?)\s*(?:(litraa|litra|liter|litres?|l|kg|kiloa|kilo|kpl|st|pcs)(?=\s|$))?\s*([\p{L}].*)?$/u);
    if (!x || !x[3]) return [];
    const digits = x[1].trim();
    const amount = /^\d{1,3}(?:[ .,]\d{3})+$/.test(digits) ? Number(digits.replace(/[ .,]/g, '')) : Number(digits.replace(/\s/g, '').replace(',', '.'));
    const words = x[3].split(/\s+/).filter(w => !WEEKDAY_RE.some(([, re]) => re.test(w)) && !DIET_RE.some(([, re]) => re.test(w)) && !/^(for|till|by|på|on|to|of|ensi|next|nästa|free|kpl|st|pcs)$/.test(w));
    const text = words.join(' ').replace(/[^a-zåäö0-9 %-]/g, '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !text) return [];
    const unit = !x[2] || /kpl|st|pcs/.test(x[2]) ? 'kpl' : /kg|kilo/.test(x[2]) ? 'kg' : 'l';
    const product = unit === 'kpl' ? text : /kuohuker|vispgrädde|whipping cream/.test(text) ? 'kuohukerma' : /ruokaker|matlagningsgrädde|cooking cream/.test(text) ? 'ruokakerma' : /kaura|havre|oat/.test(text) ? 'kaurajuoma' : /maito|maido|mjölk|milk/.test(text) ? 'maitojuoma' : text;
    out.push({ product, amount, unit, requirements: dietsIn(x[3]) });
  }
  return out;
}

/** Explicit lists work without a model. A colon or a delimited list after the ingredient word is required;
 *  a dish alone is never mistaken for a buyer-confirmed list. */
function ingredientList(message: string): IngredientIdea[] | undefined {
  const m = message.toLowerCase();
  const tail = m.includes(':') ? m.slice(m.lastIndexOf(':') + 1) : m.split(/raaka[ -]?aine\w*|aineks\w*|ingredien\w*|råvar\w*/i)[1];
  if (!tail?.trim() || (!m.includes(':') && !/[,;\n]/.test(tail))) return undefined;
  const parts = tail.trim().replace(/[.!?]+$/, '').split(/[,;](?!\d)\s*(?:(?:ja|och|and)\s+)?|\n+|\s+(?:ja|sekä|och|and|&)\s+/).filter(Boolean);
  if (!parts.length || parts.length > 12) return undefined;
  const out: IngredientIdea[] = [];
  for (const part of parts) {
    const parsed = fallbackNeeds('tilaa ' + part);
    if (/^\s*\d/.test(part)) {
      if (parsed.length !== 1) return undefined;
      const n = parsed[0];
      out.push({ name: n.product, query: n.product, amount: n.amount, unit: n.unit === 'l' ? 'L' : n.unit === 'kg' ? 'kg' : 'pcs' });
    } else {
      const words = part.split(/\s+/).filter(w => !DIET_RE.some(([, re]) => re.test(w)) && !WEEKDAY_RE.some(([, re]) => re.test(w)));
      const query = words.join(' ').trim();
      if (!query || query.length > 100) return undefined;
      out.push({ name: query, query });
    }
  }
  return out;
}

async function findIngredients(message: string, lang: Lang, listed = ingredientList(message)): Promise<TurnResponse> {
  const reqs = dietsIn(message.toLowerCase());
  const suggested = !listed;
  const ideas = listed ?? (message.includes(':') ? undefined : await suggestIngredients(message, lang, /\d+\s*(?:annos|heng|henkil|portion|serving|people|person|gäst)/i.test(message)));
  if (!ideas?.length) return respond(lang, tr(lang, 'En saanut luotettavaa raaka-aine-ehdotusta. Luettele tarvitsemasi raaka-aineet, esimerkiksi ”Raaka-aineet: jauhoseos, sokeri, kuohukerma”. Tarkistan tuotteet vaatimuksillasi. Mitään ei tilattu eikä lisätty tilausluonnokseen.', 'Jag kunde inte få fram ett tillförlitligt ingrediensförslag. Lista ingredienserna, till exempel ”Ingredienser: mjölmix, socker, vispgrädde”. Jag kontrollerar produkterna mot dina krav. Inget beställdes eller lades till i ett beställningsutkast.', 'I could not get a reliable ingredient suggestion. List the ingredients, for example “Ingredients: flour mix, sugar, whipping cream”. I will check products against your requirements. Nothing was ordered or added to an order draft.'), []);
  const disclaimer = suggested
    ? tr(lang, 'Ehdotus lähtölistaksi — ei keittiön hyväksytty resepti eikä taattu täydellinen lista. Tarkista raaka-aineet ja mahdolliset määräarviot. Ruokavaliot tarkistetaan jokaisesta tuotteesta erikseen toimittajan tiedoista.', 'Förslag till startlista — inte kökets godkända recept eller en garanterat komplett lista. Kontrollera ingredienser och eventuella mängduppskattningar. Kostkrav kontrolleras separat för varje produkt mot leverantörsdata.', 'Suggested starting list — not an approved kitchen recipe or a guaranteed complete list. Check the ingredients and any estimated amounts. Dietary requirements are checked separately for every product against supplier data.')
    : tr(lang, 'Etsin tuotteet omasta raaka-ainelistastasi. Valitse tuotteet ja myyntiyksiköiden määrät itse; mitään ei lisätty tilausluonnokseen eikä tilattu.', 'Jag söker produkter från din egen ingredienslista. Välj själv produkter och antal försäljningsenheter; inget lades till i ett beställningsutkast eller beställdes.', 'I am finding products for your own ingredient list. Choose products and sales-unit quantities yourself; nothing was added to an order draft or ordered.');
  const cards: Card[] = [{ type: 'note', tone: suggested ? 'warn' : 'info', title: tr(lang, suggested ? 'Raaka-aine-ehdotus' : 'Oma raaka-ainelistasi', suggested ? 'Ingrediensförslag' : 'Din ingredienslista', suggested ? 'Ingredient suggestion' : 'Your ingredient list'), text: suggested
    ? tr(lang, 'Lista on Aimon ehdotus, ei keittiösi resepti. Mitään ei ole tilattu eikä lisätty tilausluonnokseen.', 'Listan är Aimos förslag, inte ditt köks recept. Inget har beställts eller lagts till i ett beställningsutkast.', 'The list is Aimo’s suggestion, not your kitchen’s recipe. Nothing has been ordered or added to an order draft.')
    : tr(lang, 'Mitään ei ole tilattu eikä lisätty tilausluonnokseen.', 'Inget har beställts eller lagts till i ett beställningsutkast.', 'Nothing has been ordered or added to an order draft.') }];
  const date = nextWeekday(WEEKDAY_RE.find(([, re]) => re.test(message.toLowerCase()))?.[0]);
  for (const idea of ideas) {
    let items: Alternative[];
    let reason: string | undefined;
    let excluded: Sourcing['excluded'];
    if (idea.amount && idea.unit) {
      const s = await sourceNeed(idea.query, idea.amount, idea.unit, reqs, date, lang);
      items = s.options.slice(0, 3); reason = s.selectionRequired; excluded = s.excluded;
    } else {
      const matched = needCandidates(idea.query, reqs, lang);
      excluded = matched.excluded; reason = matched.selectionRequired;
      const offers = await fetchOffers(matched.products.map(p => p.id), date);
      const candidates = matched.products.map(p => ({ product: productView(p, lang), checks: checkAll(p, reqs, lang), suitable: true, offer: toOffer(offers.get(p.id), lang) }));
      // Verified and orderable first; keep unavailable verified products visible with their supplier reason.
      candidates.sort((a, b) => Number(!['available', 'unknown_qty'].includes(a.offer.availability)) - Number(!['available', 'unknown_qty'].includes(b.offer.availability)));
      items = candidates.slice(0, 3);
    }
    const dropped = excluded.failed + excluded.unknown;
    const missing = excluded.examples.slice(0, 1).map(e => `${e.name}: ${e.reason}`).join('')
      + (dropped > 1 ? ' ' + tr(lang, `Lisäksi ${dropped - 1} muuta tuotetta jäi pois tarkistuksessa.`, `Dessutom föll ${dropped - 1} andra produkter bort i kontrollen.`, `${dropped - 1} more products were left out by the check.`) : '');
    const none = tr(lang, 'Ei tarkistettua, tilattavaa tuotetta tällä haulla. Tarkenna hakua tai valitse myyntiyksiköittäin tuotehausta.', 'Ingen verifierad, beställningsbar produkt hittades. Precisera sökningen eller välj försäljningsenheter i produktsökningen.', 'No verified, orderable product found. Refine the search or choose sales units in product search.');
    const subtitle = [reason, reqs.map(r => requirementLabel(lang, r)).join(', '), missing || (!items.length ? none : '')].filter(Boolean).join(' ');
    const amount = idea.amount && idea.unit ? `${num(lang, idea.amount, 2)} ${idea.unit === 'pcs' ? tr(lang, 'kpl', 'st', 'pcs') : idea.unit}` : '';
    // the same facts as structured data: the UI shows one compact row per ingredient without reading the free text,
    // and an ambiguous ingredient (selection required) never gets a preselected product
    const status = !items.length ? 'none' : reason ? 'choose' : 'found';
    cards.push({ type: 'products', title: (amount ? amount + ' · ' : '') + idea.name, subtitle, items, ingredient: {
      name: idea.name, amount: amount || undefined, status,
      reason: status === 'none' ? [reason, missing || none].filter(Boolean).join(' ') : status === 'choose' ? reason : undefined,
      excluded: status !== 'none' && missing ? missing : undefined,
    } });
  }
  const noAmounts = listed && /\btilaa\b|\border\b|beställ/i.test(message) && listed.some(i => !i.amount);
  return respond(lang, [disclaimer, noAmounts ? tr(lang, 'Ilman määriä en voi valmistella tilausta, joten näytän vaihtoehdot.', 'Utan mängder kan jag inte förbereda en order, så jag visar alternativen.', 'Without quantities I cannot prepare an order, so I am showing options.') : '', tr(lang, 'Lisää haluamasi tarkistetut tuotteet valittuun tilausluonnokseen alla olevilla painikkeilla.', 'Lägg till önskade verifierade produkter i det valda beställningsutkastet med knapparna nedan.', 'Use the buttons below to add your chosen verified products to the selected order draft.')].filter(Boolean).join(' '), cards);
}

function fallbackIntent(msg: string): { name: string; args: Record<string, any> } | undefined {
  const m = msg.toLowerCase();
  const n = (re: RegExp) => { const x = m.match(re); return x ? Number(x[1].replace(/[\s.,]/g, '')) : undefined; };
  const many = fallbackNeeds(m);
  if (many.length) return { name: 'quick_order', args: { items: many, weekday: WEEKDAY_RE.find(([, re]) => re.test(m))?.[0] } };
  const qty = m.match(/(\d[\d\s.,]*)\s*(litraa|litra|liter|litres?|l\b|kg|kilo)/);
  if (qty && /tilaa|order|beställ|tarvitsen|need|behöver/.test(m)) {
    const reqs: Requirement[] = [];
    if (/laktoosit|laktosfri|lactose/.test(m)) reqs.push('lactose_free');
    if (/maidot|mjölkfri|milk[- ]free|dairy[- ]free/.test(m)) reqs.push('milk_free');
    if (/gluteenit|glutenfri|gluten[- ]free/.test(m)) reqs.push('gluten_free');
    if (/vehnät|vetefri|wheat[- ]free/.test(m)) reqs.push('wheat_free');
    const product = /kerma|grädde|cream/.test(m) ? 'ruokakerma' : /kaura|havre|oat/.test(m) ? 'kaurajuoma' : /maito|maido|mjölk|milk/.test(m) ? 'maitojuoma' : m.replace(/[^a-zåäö ]/g, ' ').split(' ').filter(w => w.length > 4).slice(-1)[0] ?? '';
    const wd = ([['mon', /maanant|måndag|monday/], ['tue', /tiista|tisdag|tuesday/], ['wed', /keskiviik|onsdag|wednesday/], ['thu', /torsta|torsdag|thursday/], ['fri', /perjant|fredag|friday/]] as const).find(([, re]) => re.test(m))?.[0];
    return { name: 'quick_order', args: { product, amount: Number(qty[1].replace(/[\s.]/g, '').replace(',', '.')), unit: /kg|kilo/.test(qty[2]) ? 'kg' : 'l', requirements: reqs, weekday: wd } };
  }
  const pcs = m.match(/(?:tilaa|order|beställ)\s+(\d[\d\s]*)\s+(?:kpl\s+|st\s+|pcs\s+)?([a-zåäö][a-zåäö -]{2,40}?)(?:\s+(?:maanantaiksi|tiistaiksi|keskiviikoksi|torstaiksi|perjantaiksi|lauantaiksi|sunnuntaiksi|for|till|by)\b|[.!?]|$)/);
  if (pcs) {
    const wd = ([['mon', /maanant|måndag|monday/], ['tue', /tiista|tisdag|tuesday/], ['wed', /keskiviik|onsdag|wednesday/], ['thu', /torsta|torsdag|thursday/], ['fri', /perjant|fredag|friday/], ['sat', /lauant|lördag|saturday/], ['sun', /sunnunt|söndag|sunday/]] as const).find(([, re]) => re.test(m))?.[0];
    return { name: 'quick_order', args: { product: pcs[2].trim(), amount: Number(pcs[1].replace(/\s/g, '')), unit: 'kpl', requirements: [], weekday: wd } };
  }
  const total = n(/(\d[\d\s]*)\s*(lounas|annos|ateria|portion|lunch|meal|vieras|gäst|guest)/);
  if (total) return { name: 'set_portions', args: { total, gluten_free: n(/(\d+)\s*(gluteenit|glutenfri|gluten)/), wheat_free: n(/(\d+)\s*(vehnät|vetefri|wheat)/), lactose_free: n(/(\d+)\s*(laktoosit|laktosfri|lactose)/), milk_free: n(/(\d+)\s*(maidot|mjölkfri|milk)/) } };
  if (/halvem|edullisem|billigare|cheaper/.test(m)) return { name: 'find_cheaper', args: {} };
  const menuEdit = menuEditIntent(msg);
  if (menuEdit) return menuEdit;
  if (/esimerkki|exempel|sample/.test(m)) return { name: 'load_sample_menu', args: {} };
  if (/loki|logg|\blog\b|tapahtum|audit/.test(m)) return { name: 'show', args: { what: 'audit' } };
  if (/hyväksy|godkänn|approval|lähetä tilaus/.test(m)) return { name: 'send_for_approval', args: {} };
  if (/tilaus|tilaa|order|beställ|ostoslista|inköp|shopping|ruokalista|matsedel|menu/.test(m)) return { name: 'prepare_week_order', args: {} };
  return undefined;
}

function nextWeekday(wd?: string): string {
  const base = S().menu?.weekStart;
  const idx = Math.max(0, WEEKDAYS.indexOf((wd ?? 'mon') as any));
  if (base && new Date(base + 'T23:59:00+02:00').getTime() > Date.now() - 86400000) return addDays(base, idx);
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12));
  const cur = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() + ((idx - cur + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

interface Need { product: string; amount: number; unit: 'kg' | 'L' | 'pcs'; reqs: Requirement[] }

/** One order from one or more needs ("20 kg rice, 10 l cream and 70 alcohol-free beers"). Every need is sourced with the same
 *  rules; a need without a verified, orderable product is reported and left out, it never blocks the others. */
async function quickOrder(args: Record<string, any>, lang: Lang, original: string): Promise<TurnResponse> {
  const raw: Record<string, any>[] = Array.isArray(args.items) && args.items.length ? args.items.slice(0, 12) : [args];
  const needs: Need[] = raw.map(n => {
    const rawUnit = String(n?.unit).toLowerCase();
    return { product: String(n?.product ?? '').trim(), amount: Number(n?.amount), unit: rawUnit === 'kg' ? 'kg' : rawUnit === 'l' ? 'L' : 'pcs', reqs: [...new Set([...validReqs(args.requirements), ...validReqs(n?.requirements)])] };
  });
  if (needs.some(n => !Number.isFinite(n.amount) || n.amount <= 0)) throw new UserError(l3('En saanut selvää määrästä. Kerro määrä litroina tai kiloina.', 'Jag förstod inte mängden. Ange mängden i liter eller kilo.', 'I could not read the amount. Give it in litres or kilos.'));
  const date = nextWeekday(args.weekday);
  const many = needs.length > 1;
  const unitOf = (n: Need) => (n.unit === 'pcs' ? tr(lang, 'kpl', 'st', 'pcs') : n.unit);
  const reqLabelOf = (n: Need) => n.reqs.map(r => requirementLabel(lang, r).toLowerCase()).join(', ');
  const label = (n: Need) => `${num(lang, n.amount, 2)} ${unitOf(n)} ${n.product}`;

  const found: { need: Need; s: Sourcing }[] = [], missing: { need: Need; s: Sourcing }[] = [];
  for (const need of needs) {
    const s = await sourceNeed(need.product, need.amount, need.unit, need.reqs, date, lang);
    (s.allocation.length ? found : missing).push({ need, s });
  }
  const notFound = ({ need, s }: { need: Need; s: Sourcing }) => {
    const ex = s.excluded.examples.map(e => `${e.name}: ${e.reason}`).join(' ');
    const reqLabel = reqLabelOf(need);
    const text = s.selectionRequired ? `${s.selectionRequired} ${ex}` : tr(lang, `En löytänyt tilattavaa tuotetta, joka täyttää vaatimukset${reqLabel ? ` (${reqLabel})` : ''}. ${ex}`, `Jag hittade ingen beställningsbar produkt som uppfyller kraven${reqLabel ? ` (${reqLabel})` : ''}. ${ex}`, `I found no orderable product that meets the requirements${reqLabel ? ` (${reqLabel})` : ''}. ${ex}`);
    return many ? `${label(need)}: ${text.trim()} ${tr(lang, 'Tätä ei tilattu.', 'Detta beställdes inte.', 'This was not ordered.')}` : text;
  };
  const selectionCards: Card[] = missing.filter(f => f.s.selectionRequired).map(({ need, s }) => ({ type: 'products', title: label(need), subtitle: s.selectionRequired, items: s.options }));
  if (!found.length) return respond(lang, missing.map(notFound).join(' '), selectionCards);

  const lines: NewOrder['lines'] = [];
  for (const f of found) for (const l of sourcingLines(f.s, f.need.reqs)) {
    const same = lines.find(x => x.productId === l.productId);
    if (same) { same.qty += l.qty; same.reqs = [...new Set([...same.reqs, ...l.reqs])]; } else lines.push(l);
  }
  const { order, duplicate } = await createOrder({
    source: 'ui', actor: ACTOR.aimo, deliveryDate: date, lines,
    title: l3(`Pikatilaus: ${original.slice(0, 80)}`, `Snabborder: ${original.slice(0, 80)}`, `Quick order: ${original.slice(0, 80)}`),
    idempotencyKey: 'quick-' + contentKey(lines, date),
    forceApproval: l3('Aimo valmisteli tilauksen pyynnöstäsi – vahvista ennen lähetystä.', 'Aimo förberedde ordern på din begäran – bekräfta före sändning.', 'Aimo prepared this order at your request – confirm before it is sent.'),
  });
  /** what happened to one need beyond "ordered as asked": split, shortfall, rounding up, products ruled out */
  const notes = ({ need, s }: { need: Need; s: Sourcing }) => {
    const u = unitOf(need), reqLabel = reqLabelOf(need);
    const excl = s.excluded.failed + s.excluded.unknown;
    const lot = s.allocation.find(a => a.lotRounded);
    return [
      s.allocation.length > 1 ? tr(lang, `Edullisimman tuotteen saatavuus ei riittänyt, joten jaoin määrän ${s.allocation.length} tuotteelle.`, `Den billigaste produkten räckte inte, så jag delade mängden på ${s.allocation.length} produkter.`, `The cheapest product could not cover it, so I split the amount across ${s.allocation.length} products.`) : '',
      s.shortfall > 0 ? tr(lang, `Huom: ${num(lang, s.shortfall, 0)} ${u} jää puuttumaan – sopivia tuotteita ei ole enempää saatavilla.`, `Obs: ${num(lang, s.shortfall, 0)} ${u} saknas – det finns inte fler lämpliga produkter tillgängliga.`, `Note: ${num(lang, s.shortfall, 0)} ${u} is still missing – no more suitable products are available.`) : '',
      s.covered > s.requested + 1e-6 ? (lot
        ? `${pick(lang, lotNote(lot.product, lot.qty))} ${tr(lang, `Saat ${num(lang, s.covered, 0)} ${u}.`, `Du får ${num(lang, s.covered, 0)} ${u}.`, `You get ${num(lang, s.covered, 0)} ${u}.`)}`
        : need.unit === 'pcs' ? tr(lang, `Tuote myydään ${s.allocation[0].product.n ?? 1} kpl:n erissä, joten saat ${num(lang, s.covered, 0)} ${u}.`, `Produkten säljs i förpackningar om ${s.allocation[0].product.n ?? 1}, så du får ${num(lang, s.covered, 0)} ${u}.`, `The product is sold in packs of ${s.allocation[0].product.n ?? 1}, so you get ${num(lang, s.covered, 0)} ${u}.`)
        : tr(lang, `Kokonaisina pakkauksina saat ${num(lang, s.covered, 1)} ${u}.`, `I hela förpackningar får du ${num(lang, s.covered, 1)} ${u}.`, `In whole packs you get ${num(lang, s.covered, 1)} ${u}.`)) : '',
      excl ? tr(lang, `Jätin pois ${excl} tuotetta, jotka eivät läpäisseet tarkistusta${reqLabel ? ` (${reqLabel})` : ''}.`, `Jag uteslöt ${excl} produkter som inte klarade kontrollen${reqLabel ? ` (${reqLabel})` : ''}.`, `I left out ${excl} products that did not pass the check${reqLabel ? ` (${reqLabel})` : ''}.`) : '',
    ].filter(Boolean);
  };
  const closing = duplicate ? tr(lang, 'Sama tilaus oli jo olemassa, joten en luonut uutta.', 'Samma order fanns redan, så jag skapade ingen ny.', 'The same order already existed, so I did not create a new one.') : tr(lang, 'Hyväksy, niin lähetän sen.', 'Godkänn så skickar jag den.', 'Approve it and I will send it.');
  if (!many) {
    const { need, s } = found[0];
    const u = unitOf(need), reqLabel = reqLabelOf(need);
    const head = tr(lang, `Valmistelin tilauksen: ${num(lang, s.covered, 0)} ${u} toimitukseen ${dayLabel(lang, date)}, ${eur(lang, order.net)} (alv 0 %).`, `Jag förberedde ordern: ${num(lang, s.covered, 0)} ${u} för leverans ${dayLabel(lang, date)}, ${eur(lang, order.net)} (moms 0 %).`, `I prepared the order: ${num(lang, s.covered, 0)} ${u} for delivery ${dayLabel(lang, date)}, ${eur(lang, order.net)} (excl. VAT).`);
    return respond(lang, [head, ...notes(found[0]), closing].join(' '), [
      { type: 'products', title: tr(lang, 'Vaihtoehdot: hinta, toimitusvarmuus ja vastuullisuus', 'Alternativ: pris, leveranssäkerhet och hållbarhet', 'Options: price, reliability and sustainability'), subtitle: reqLabel ? tr(lang, `Vain tuotteet, jotka on varmistettu: ${reqLabel}.`, `Endast produkter som verifierats: ${reqLabel}.`, `Only products verified as: ${reqLabel}.`) : undefined, items: s.options },
      { type: 'order', order: orderView(order, lang) },
    ]);
  }
  const head = tr(lang, `Valmistelin yhden tilauksen ${found.length} tarpeesta: ${order.lines.length} riviä toimitukseen ${dayLabel(lang, date)}, ${eur(lang, order.net)} (alv 0 %).`, `Jag förberedde en order för ${found.length} behov: ${order.lines.length} rader för leverans ${dayLabel(lang, date)}, ${eur(lang, order.net)} (moms 0 %).`, `I prepared one order for ${found.length} needs: ${order.lines.length} lines for delivery ${dayLabel(lang, date)}, ${eur(lang, order.net)} (excl. VAT).`);
  const perNeed = found.map(f => `${label(f.need)}: ${[tr(lang, `tilauksessa ${num(lang, f.s.covered, 0)} ${unitOf(f.need)}.`, `i ordern ${num(lang, f.s.covered, 0)} ${unitOf(f.need)}.`, `${num(lang, f.s.covered, 0)} ${unitOf(f.need)} in the order.`), ...notes(f)].join(' ')}`);
  const cards: Card[] = [...selectionCards, ...found.map(({ need, s }): Card => ({ type: 'products', title: label(need), items: s.options })), { type: 'order', order: orderView(order, lang) }];
  if (missing.length) cards.unshift({ type: 'note', tone: 'warn', title: tr(lang, 'Jäi tilaamatta', 'Beställdes inte', 'Not ordered'), text: missing.map(notFound).join(' ') });
  return respond(lang, [head, ...perNeed, ...missing.map(notFound), closing].join(' '), cards);
}

async function runTool(name: string, args: Record<string, any>, lang: Lang, original: string): Promise<TurnResponse> {
  switch (name) {
    case 'set_portions': {
      const gs = REQUIREMENTS.filter(r => Number.isFinite(Number(args[r])) && args[r] !== null && args[r] !== undefined).map(r => ({ requirement: r, count: Number(args[r]) }));
      return handleAction({ type: 'set_portions', total: args.total != null ? Number(args.total) : undefined, groups: gs.length ? gs : undefined }, lang);
    }
    case 'prepare_week_order': {
      if (!S().menu) return respond(lang, planReply(undefined, lang), []);
      const plan = await buildPlan(lang);
      return respond(lang, planReply(plan, lang), [{ type: 'menu', menu: menuView(lang)! }, ...planCards(plan, lang)], plan);
    }
    case 'find_cheaper': {
      const plan = await buildPlan(lang);
      const want = String(args.ingredient ?? '').toLowerCase();
      const line = want ? plan?.lines.find(l => l.ingredient.toLowerCase().includes(want) || l.product.name.toLowerCase().includes(want)) : undefined;
      return cheaper(lang, line?.id);
    }
    case 'quick_order': return quickOrder(args, lang, original);
    case 'find_ingredients': return findIngredients(original, lang);
    case 'search_products': {
      const reqs = (Array.isArray(args.requirements) ? args.requirements : []).filter((r: string): r is Requirement => (REQUIREMENTS as string[]).includes(r));
      const items = await searchWithChecks(String(args.query ?? ''), reqs, lang, nextWeekday('mon'));
      return respond(lang, items.length ? tr(lang, `Löysin ${items.length} tuotetta. Näytän jokaisesta, mitä toimittajan tiedot kertovat.`, `Jag hittade ${items.length} produkter. Jag visar vad leverantörens data säger om var och en.`, `I found ${items.length} products. Each shows what the supplier data says.`) : tr(lang, 'En löytänyt tuotteita tällä haulla.', 'Jag hittade inga produkter med den sökningen.', 'I found no products for that search.'), items.length ? [{ type: 'products', title: String(args.query), items }] : []);
    }
    case 'show': {
      if (args.what === 'audit') return handleAction({ type: 'show_audit' }, lang);
      if (args.what === 'menu') return handleAction({ type: 'show_menu' }, lang);
      if (args.what === 'orders') {
        const os = ordersView(lang).slice(0, 3);
        return respond(lang, os.length ? tr(lang, 'Tässä viimeisimmät tilaukset.', 'Här är de senaste orderna.', 'Here are the latest orders.') : tr(lang, 'Tilauksia ei vielä ole.', 'Det finns inga order ännu.', 'There are no orders yet.'), os.map(o => ({ type: 'order' as const, order: o })));
      }
      return handleAction({ type: 'show_plan' }, lang);
    }
    case 'send_for_approval': return handleAction({ type: 'create_order' }, lang);
    case 'set_menu_text': {
      await importMenuText(String(args.text ?? original));
      clearUndo();
      const plan = await buildPlan(lang);
      return respond(lang, menuReply(lang), [{ type: 'menu', menu: menuView(lang)! }, ...planCards(plan, lang).filter(c => c.type === 'issue')], plan);
    }
    case 'load_sample_menu': return loadDemoMenu(lang);
    case 'change_dish':
    case 'recommend_dish':
    case 'ingredient_alternatives': return runMenuTool(name, args, lang, original, { respond, planCards, planReply, dietsIn });
  }
  throw new UserError(l3('En osannut tehdä tätä.', 'Det kunde jag inte göra.', 'I could not do that.'));
}

export async function handleChat(message: string, lang: Lang): Promise<TurnResponse> {
  const msg = message.trim().slice(0, 2000);
  if (!msg) throw new UserError(l3('Kirjoita tai sano, mitä tarvitset.', 'Skriv eller säg vad du behöver.', 'Type or say what you need.'));
  if (/^(?:näytä tilausluonnos|visa beställningsutkastet|show (?:the )?order draft)[.!?\s]*$/i.test(msg)) return runAction({ type: 'show_draft' }, lang);
  // Ingredient requests cannot be turned into finished dishes or orders by a mistaken tool call.
  if (isIngredientRequest(msg)) {
    const list = ingredientList(msg);
    if (/\btilaa\b|\border\b|beställ/i.test(msg) && list?.length && list.every(i => i.amount && i.unit)) {
      return quickOrder({ items: list.map(i => ({ product: i.query, amount: i.amount, unit: i.unit, requirements: dietsIn(msg.toLowerCase()) })), weekday: WEEKDAY_RE.find(([, re]) => re.test(msg.toLowerCase()))?.[0] }, lang, msg);
    }
    return findIngredients(msg, lang, list);
  }
  const st = S();
  const context = `Account: ${st.kitchen.name} (${currentProfile().kind}).`+` Kitchen: ${st.kitchen.name}. Menu imported: ${st.menu ? 'yes' : 'no'}. Portions confirmed: ${st.kitchen.portionsConfirmed ? `yes (${st.kitchen.portionsTotal}/day)` : 'no'}. Orders: ${st.orders.length}. Today: ${new Date().toISOString().slice(0, 10)}.`;
  const system = `You are Aimo, the purchasing assistant of a Finnish school kitchen (wholesaler: Valio Aimo). Decide which ONE tool best fulfils the user's message and call it. Users write in Finnish, Swedish or English.
Rules: You never state whether a product is safe for a diet, never invent prices, quantities or recipes — the tools do that from supplier data. For ingredient help or making a dish, use find_ingredients; it can suggest a starting list, not an approved recipe. Never search for a finished dish when the user asked for its ingredients. Gluten-free and wheat-free are different requirements; lactose-free and milk-free are different requirements; pass exactly what the user said.
Never refuse or question an order because of who the customer is: any account may order any product in the assortment (a school ordering beer is fine). Spending limits are enforced by the tools, not by you.
If no tool fits (small talk or a general question), answer in at most two short sentences in ${lang === 'fi' ? 'Finnish' : lang === 'sv' ? 'Swedish' : 'English'} and say what you can help with.
${context}`;
  let call: { name: string; args: Record<string, any> } | undefined;
  let text = '';
  try {
    const r = await llmTools([{ role: 'system', content: system }, { role: 'user', content: msg }], TOOLS);
    call = r.calls[0];
    text = r.text;
  } catch {
    call = fallbackIntent(msg);
  }
  if (!call && !text) call = fallbackIntent(msg);
  if (!call) call = menuEditIntent(msg); // a model that answered with text only: the menu-edit phrasings are still ours
  if (call) {
    // the rules read diet words from the user's own message too, so a model slip cannot drop a requirement
    if (call.name === 'quick_order') {
      call.args.requirements = [...new Set([...validReqs(call.args.requirements), ...dietsIn(msg.toLowerCase().split(/[:\d]/)[0])])];
      const fb = fallbackIntent(msg);
      const fbArgs = fb?.name === 'quick_order' ? fb.args : {};
      const items: Record<string, any>[] | undefined = Array.isArray(call.args.items) && call.args.items.length ? call.args.items : undefined;
      const fbItems: Record<string, any>[] | undefined = Array.isArray(fbArgs.items) ? fbArgs.items : undefined;
      // several products: add each product's own diet words when both readings agree on the list, otherwise
      // every diet word of the message applies to every product (the safe side)
      if (items && fbItems?.length === items.length) items.forEach((it, i) => { if (it && typeof it === 'object') it.requirements = [...new Set([...validReqs(it?.requirements), ...fbItems[i].requirements, ...dietsIn(msg.toLowerCase().split(/[:\d]/)[0])])]; });
      else call.args.requirements = [...new Set([...validReqs(call.args.requirements), ...(fbItems ? fbItems.flatMap(i => i.requirements) : items && items.length > 1 ? dietsIn(msg.toLowerCase()) : validReqs(fbArgs.requirements))])];
    }
    return runTool(call.name, call.args, lang, msg);
  }
  return respond(lang, text || tr(lang, 'Voin lukea ruokalistan, laskea ostoslistan, tarkistaa allergeenit ja valmistella tilauksen. Mitä tehdään?', 'Jag kan läsa matsedeln, räkna inköpslistan, kontrollera allergener och förbereda ordern. Vad gör vi?', 'I can read the menu, calculate the shopping list, check allergens and prepare the order. What shall we do?'), []);
}
