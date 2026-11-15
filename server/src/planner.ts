// Turns the confirmed week menu into a shopping plan: recipe quantities per diet group, stock,
// package sizes, live mock prices/availability and allergen checks. All decisions here are rules,
// not AI output.
import type {
  Alternative, AllergenCheck, DietGroup, Issue, Kitchen, Lang, LineUse, MenuDay, Plan, PlanLine,
  Requirement, StockItem, WeekMenu, Card, CourseRole,
} from '../../shared/types.ts';
import { REQUIREMENTS, allOk, checkAll, requirementLabel, worst } from './allergens.ts';
import { type CatalogProduct, getProduct, localName, lotStep, norm, productView, roundToLot, sameCategory, searchProducts } from './catalog.ts';
import { addDays, dayLabel, eur, num, tr, weekLabel, weekdayLabel, weekdayOf } from './i18n.ts';
import {
  type Recipe, type RecipeIngredient, dayRole, importRecipe, matchRecipe, recipeById, recipeName, recipeRole, recipesForRole, relinkAsImported, sideRecipe,
} from './recipes.ts';
import { ACTOR, type DayChoice, type L3, S, type StoredDay, audit, currentProfile, l3, pick, save } from './store.ts';
import { fetchOffers, toOffer } from './valio.ts';

export class UserError extends Error {
  /** `code` and `extra` are passed to external agents as the machine-readable error (default: rejected_by_rules) */
  constructor(public text: L3, public code?: string, public extra?: Record<string, unknown>) { super(text.en); }
}

// ---------- kitchen & groups ----------

export interface Group { id: string; reqs: Requirement[]; count: number }
const STANDARD = l3('Perusannokset', 'Standardportioner', 'Standard portions');

export function groups(): Group[] {
  const k = S().kitchen;
  const special = k.groups.filter(g => g.count > 0).map(g => ({ id: g.requirement, reqs: [g.requirement], count: g.count }));
  const std = Math.max(0, k.portionsTotal - special.reduce((a, g) => a + g.count, 0));
  return [{ id: 'standard', reqs: [], count: std }, ...special];
}
export function groupLabel(lang: Lang, id: string): string {
  return id === 'standard' ? pick(lang, STANDARD) : requirementLabel(lang, id as Requirement);
}

export function weekSpend(): number {
  // submitted orders count against the weekly budget
  return S().orders.filter(o => o.status === 'submitted').reduce((a, o) => a + o.net, 0);
}

/** open order value that counts against the account's credit limit (orders sent and not yet invoiced/paid) */
export function creditUsed(): number {
  return S().orders.filter(o => o.status === 'submitted').reduce((a, o) => a + o.net + o.vat, 0);
}
export function portionLabel(lang: Lang): string {
  return currentProfile().kind === 'event' ? tr(lang, 'vierasta', 'gäster', 'guests') : tr(lang, 'annosta päivässä', 'portioner per dag', 'portions a day');
}
export function menuTitle(lang: Lang): string {
  const m = S().menu;
  if (!m) return '';
  if (m.kind === 'event') return `${tr(lang, 'Tapahtuma', 'Evenemang', 'Event')} · ${dayLabel(lang, m.days[0]?.date ?? m.weekStart)}`;
  return weekLabel(lang, m.weekStart);
}

export function kitchenView(lang: Lang): Kitchen {
  const k = S().kitchen;
  const gs = groups();
  const dg: DietGroup[] = gs.filter(g => g.id !== 'standard').map(g => ({ id: g.id, label: groupLabel(lang, g.id), requirements: g.reqs, count: g.count }));
  return {
    name: k.name, kind: currentProfile().kind, portionLabel: portionLabel(lang),
    portionsTotal: k.portionsTotal, standardCount: gs[0].count, groups: dg, portionsConfirmed: k.portionsConfirmed,
    authority: { ...k.authority, spentThisWeek: round2(weekSpend()), creditUsed: round2(creditUsed()), creditAvailable: k.authority.creditLimit != null ? round2(Math.max(0, k.authority.creditLimit - creditUsed())) : undefined },
    memory: k.memory.map(m => ({ id: m.id, text: pick(lang, m.text), at: m.at })),
  };
}

export function setPortions(total?: number, gs?: { requirement: Requirement; count: number }[], actor = ACTOR.kitchen) {
  const k = S().kitchen;
  // validate on a copy first: a rejected change must leave the confirmed portions untouched
  let nextTotal = k.portionsTotal;
  let nextGroups = k.groups.map(g => ({ ...g }));
  if (total !== undefined) {
    if (!Number.isFinite(total) || total < 1 || total > 20000) throw new UserError(l3('Annosmäärän pitää olla 1–20 000.', 'Antalet portioner ska vara 1–20 000.', 'Portions must be between 1 and 20,000.'));
    nextTotal = Math.round(total);
  }
  if (gs) {
    if (!Array.isArray(gs)) throw new UserError(l3('Ruokavalioryhmät eivät kelpaa.', 'Kostgrupperna är ogiltiga.', 'The diet groups are not valid.'));
    for (const g of gs) {
      if (!g || !(REQUIREMENTS as string[]).includes(g.requirement)) throw new UserError(l3(`Tuntematon ruokavalio: ${String(g?.requirement)}.`, `Okänd kost: ${String(g?.requirement)}.`, `Unknown dietary requirement: ${String(g?.requirement)}.`));
      if (!Number.isFinite(g.count) || g.count < 0 || g.count > 20000) throw new UserError(l3('Annosmäärä ei kelpaa.', 'Ogiltigt antal portioner.', 'Invalid portion count.'));
      const ex = nextGroups.find(x => x.requirement === g.requirement);
      if (ex) ex.count = Math.round(g.count); else nextGroups.push({ requirement: g.requirement, count: Math.round(g.count) });
    }
    nextGroups = nextGroups.filter(g => g.count > 0);
  }
  const special = nextGroups.reduce((a, g) => a + g.count, 0);
  if (special > nextTotal) throw new UserError(l3('Erityisruokavalioannoksia on enemmän kuin annoksia yhteensä.', 'Specialkostportionerna är fler än portionerna totalt.', 'Special-diet portions exceed the total portions.'));
  k.portionsTotal = nextTotal;
  k.groups = nextGroups;
  k.portionsConfirmed = true;
  S().edits = { qty: {}, removed: [] };
  const desc = (lang: Lang) => `${k.portionsTotal} ${portionLabel(lang)}` + k.groups.map(g => ` · ${g.count} ${requirementLabel(lang, g.requirement).toLowerCase()}`).join('');
  audit(actor, 'set_portions', l3(`Annosmäärät vahvistettu: ${desc('fi')}`, `Portioner bekräftade: ${desc('sv')}`, `Portions confirmed: ${desc('en')}`));
}

// ---------- menu view ----------

const validRecipeForDay = (day: { role?: CourseRole; label?: string }, id?: string) => {
  const role = dayRole(S().menu?.kind, day), recipe = recipeById(id);
  return !!role && !!recipe && !recipe.side && recipeRole(recipe) === role;
};
// a removed entry and the kitchen's own dish link no recipe, so they need no role either
const invalidEntry = (day: { role?: CourseRole; label?: string; match: string; recipeId?: string; suggestion?: { recipeId: string } }) =>
  (day.match === 'confirmed' && !validRecipeForDay(day, day.recipeId)) ||
  (day.match === 'suggested' && !validRecipeForDay(day, day.suggestion?.recipeId)) ||
  (S().menu?.kind === 'event' && !dayRole('event', day) && day.match !== 'skipped' && day.match !== 'custom');
const roleProblem = (lang: Lang, day: { role?: CourseRole; label?: string; recipeId?: string; suggestion?: { recipeId: string } }) => {
  const id = day.recipeId ?? day.suggestion?.recipeId;
  const name = recipeName(lang, id) ?? id;
  if (!name) return tr(lang, 'Valitse ensin ruokalajin rooli.', 'Välj först rättens roll.', 'Choose the course role first.');
  if (!dayRole(S().menu?.kind, day)) return tr(lang, `Resepti ${name} on tallessa, mutta ruokalajin rooli puuttuu. Valitse rooli ja tarkista resepti.`, `Receptet ${name} finns kvar, men rättens roll saknas. Välj roll och kontrollera receptet.`, `Recipe ${name} is retained, but the course role is missing. Choose a role and check the recipe.`);
  if (validRecipeForDay(day, id)) return tr(lang, `Resepti ${name} vaatii vahvistuksen. Valitse resepti, jos haluat käyttää sitä.`, `Receptet ${name} kräver bekräftelse. Välj receptet om du vill använda det.`, `Recipe ${name} needs confirmation. Select it if you want to use it.`);
  return tr(lang, `Resepti ${name} ei sovi rivin rooliin. Valitse sopiva resepti.`, `Receptet ${name} passar inte rättens roll. Välj ett lämpligt recept.`, `Recipe ${name} does not match this course role. Choose a suitable recipe.`);
};

export function menuView(lang: Lang): WeekMenu | undefined {
  const m = S().menu;
  if (!m) return undefined;
  const total = S().kitchen.portionsTotal;
  const days: MenuDay[] = m.days.map(d => ({
    id: d.id ?? d.date, label: d.label, date: d.date, weekday: weekdayOf(d.date), weekdayLabel: weekdayLabel(lang, weekdayOf(d.date)), dishName: d.dishName,
    role: dayRole(m.kind, d), roleProblem: invalidEntry(d) || (d.match === 'missing' && !!d.recipeId) ? roleProblem(lang, d) : undefined,
    match: invalidEntry(d) ? 'missing' : d.match, recipeId: d.recipeId, recipeName: recipeName(lang, d.recipeId),
    suggestion: !invalidEntry(d) && d.suggestion ? { recipeId: d.suggestion.recipeId, recipeName: recipeName(lang, d.suggestion.recipeId)!, why: pick(lang, d.suggestion.why) } : undefined,
    portions: d.importedPortions ?? total, importedPortions: d.importedPortions, dietNotes: d.dietNotes,
    customName: d.match === 'custom' ? d.customName : undefined,
    removedDish: d.match === 'skipped' ? choiceName(lang, d, d.removed) : undefined,
    importRecipe: importRecipe(m.kind, d),
  }));
  return { kind: m.kind ?? 'week', weekStart: m.weekStart, weekLabel: menuTitle(lang), source: m.source, days, warnings: m.warnings.map(w => pick(lang, w)) };
}

const findDay = (key: string) => S().menu?.days.find(x => (x.id ?? x.date) === key) ?? S().menu?.days.find(x => x.date === key);
const dayName = (lang: Lang, d: { date: string; label?: string }) => d.label ?? dayLabel(lang, d.date);
/** The dish a choice stands for: the linked recipe, the kitchen's own dish, or the imported dish name. A removed entry
 *  from an older state file has no stored choice: restoring links the imported dish again. */
function choiceName(lang: Lang, d: StoredDay, c: DayChoice | undefined = d.match === 'skipped' ? d.removed : d as DayChoice): string {
  if (c?.match === 'custom' && c.customName) return c.customName;
  if (c?.match === 'confirmed') return recipeName(lang, c.recipeId) ?? d.dishName;
  return d.dishName;
}
/** an event menu's rows are courses, not days: texts about one row say so */
const isEventMenu = () => S().menu?.kind === 'event';
const dayNotFound = () => isEventMenu()
  ? new UserError(l3('Ruokalajia ei löytynyt.', 'Rätten hittades inte.', 'Dish not found.'))
  : new UserError(l3('Päivää ei löytynyt.', 'Dagen hittades inte.', 'Day not found.'));

export function confirmRecipe(date: string, recipeId: string) {
  const d = findDay(date);
  const r = recipeById(recipeId);
  if (!d || !r || r.side) throw new UserError(l3('Päivää tai reseptiä ei löytynyt.', 'Dagen eller receptet hittades inte.', 'Day or recipe not found.'));
  if (!validRecipeForDay(d, r.id)) throw new UserError(l3('Resepti ei sovi ruokalajin rooliin tai rooli puuttuu.', 'Receptet passar inte rättens roll eller rollen saknas.', 'The recipe does not match the course role or the role is missing.'));
  // a new choice replaces the kitchen's own dish and a removal (and what that removal would have restored)
  d.match = 'confirmed'; d.recipeId = r.id; d.suggestion = undefined; d.customName = undefined; d.removed = undefined;
  audit(ACTOR.kitchen, 'confirm_recipe', l3(`${dayName('fi', d)}: ”${d.dishName}” yhdistetty reseptiin ${r.name.fi}`, `${dayName('sv', d)}: ”${d.dishName}” kopplad till receptet ${r.name.sv}`, `${dayName('en', d)}: “${d.dishName}” linked to recipe ${r.name.en}`));
}

export const CUSTOM_DISH_MAX = 60;
/** A dish name as typed, tidied: control characters and repeated spaces removed. */
export const cleanDishName = (x: unknown) => String(x ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** The kitchen's own dish for an entry: a name only. No recipe is linked, so nothing is calculated or ordered for it.
 *  A name that is exactly an approved recipe of the entry's role (any language, or an alias) links that recipe instead,
 *  through the same checks as choosing it; that recipe is returned. */
export function setCustomDish(date: string, name: unknown): Recipe | undefined {
  const d = findDay(date);
  if (!d) throw dayNotFound();
  const clean = cleanDishName(name);
  if (!clean) throw new UserError(l3('Kirjoita ruokalajin nimi.', 'Skriv rättens namn.', 'Type the name of the dish.'));
  if (clean.length > CUSTOM_DISH_MAX) throw new UserError(l3(`Nimi on liian pitkä: enintään ${CUSTOM_DISH_MAX} merkkiä.`, `Namnet är för långt: högst ${CUSTOM_DISH_MAX} tecken.`, `The name is too long: at most ${CUSTOM_DISH_MAX} characters.`));
  const role = dayRole(S().menu?.kind, d);
  const same = role ? matchRecipe(clean, recipesForRole(role)) : undefined;
  if (same?.confidence === 'exact' && same.recipe) {
    confirmRecipe(date, same.recipe.id);
    return same.recipe;
  }
  if (d.match === 'custom' && d.customName === clean) return undefined;
  d.match = 'custom'; d.customName = clean; d.recipeId = undefined; d.suggestion = undefined; d.removed = undefined;
  audit(ACTOR.kitchen, 'set_custom_dish', l3(
    `${dayName('fi', d)}: oma ruokalaji ”${clean}” (tuodussa listassa ”${d.dishName}”) – ei reseptiä, sille ei tilata mitään automaattisesti`,
    `${dayName('sv', d)}: egen rätt ”${clean}” (i den importerade listan ”${d.dishName}”) – inget recept, inget beställs automatiskt för den`,
    `${dayName('en', d)}: own dish “${clean}” (imported as “${d.dishName}”) – no recipe, nothing is ordered for it automatically`));
  return undefined;
}
export function setCourse(date: string, role: CourseRole) {
  const d = findDay(date);
  if (!d || S().menu?.kind !== 'event' || !['main', 'drink', 'dessert'].includes(role)) throw new UserError(l3('Ruokalajin rooli ei kelpaa.', 'Rättens roll är ogiltig.', 'Invalid course role.'));
  if (dayRole('event', d)) throw new UserError(l3('Roolia ei voi vaihtaa tässä.', 'Rollen kan inte ändras här.', 'The role cannot be changed here.'));
  d.role = role;
  if (d.match === 'confirmed' || d.match === 'suggested') d.match = 'missing';
  audit(ACTOR.kitchen, 'set_course', l3('Ruokalajin rooli valittu.', 'Rättens roll vald.', 'Course role selected.'));
}
/** Remove the dish of an entry: nothing is ordered for it. The choice it had is kept, so `restoreDay` brings it back.
 *  When no dish is left, the whole menu goes (`clearMenu`); returns true then. Undo brings back the menu as it was. */
export function skipDay(date: string): boolean {
  const d = findDay(date);
  if (!d) throw dayNotFound();
  if (d.match === 'skipped') return false; // already removed: what a restore brings back stays as it was
  const was: DayChoice = { match: d.match };
  if (d.recipeId) was.recipeId = d.recipeId;
  if (d.suggestion) was.suggestion = d.suggestion;
  if (d.customName) was.customName = d.customName;
  const name = (lang: Lang) => choiceName(lang, d, was);
  d.match = 'skipped'; d.recipeId = undefined; d.suggestion = undefined; d.customName = undefined; d.removed = was;
  audit(ACTOR.kitchen, 'skip_day', isEventMenu()
    ? l3(`${dayName('fi', d)}: ruokalaji ”${name('fi')}” poistettu, sille ei tilata mitään`, `${dayName('sv', d)}: rätten ”${name('sv')}” borttagen, inget beställs för den`, `${dayName('en', d)}: dish “${name('en')}” removed, nothing is ordered for it`)
    : l3(`${dayName('fi', d)}: ruokalaji ”${name('fi')}” poistettu, tälle päivälle ei tilata mitään`, `${dayName('sv', d)}: rätten ”${name('sv')}” borttagen, inget beställs för dagen`, `${dayName('en', d)}: dish “${name('en')}” removed, nothing is ordered for this day`));
  if (!S().menu!.days.every(x => x.match === 'skipped')) return false;
  clearMenu(ACTOR.kitchen, true);
  return true;
}

/** Remove the whole menu and the edits of its shopping list (line edits, left-out items: an import resets them too).
 *  Orders, order drafts, portions and diet groups, the kitchen's memory and approved replacements, agents and limits
 *  stay. The undo step of the action holds the whole menu, so undo brings it back exactly. */
export function clearMenu(actor: L3 = ACTOR.kitchen, lastDish = false) {
  const st = S();
  const m = st.menu;
  if (!m) throw new UserError(l3('Ruokalistaa ei ole, joten poistettavaa ei ole.', 'Det finns ingen matsedel att ta bort.', 'There is no menu to remove.'));
  const title = l3(menuTitle('fi'), menuTitle('sv'), menuTitle('en'));
  const n = m.days.length;
  st.menu = undefined;
  st.edits = { qty: {}, removed: [] };
  st.skipped = [];
  const why = lastDish ? l3('Viimeinenkin ruokalaji poistettiin, joten ruokalista poistettiin', 'Den sista rätten togs bort, så matsedeln togs bort', 'The last dish was removed, so the menu was removed') : l3('Ruokalista poistettu', 'Matsedeln borttagen', 'Menu removed');
  audit(actor, 'clear_menu', l3(
    `${why.fi}: ${title.fi} (${n} ruokalajia). Tilaukset, tilausluonnokset, annosmäärät ja keittiön muisti säilyivät.`,
    `${why.sv}: ${title.sv} (${n} rätter). Order, beställningsutkast, portioner och kökets minne finns kvar.`,
    `${why.en}: ${title.en} (${n} dishes). Orders, order drafts, portions and the kitchen’s memory were kept.`));
}

/** Bring back what a removed entry had. An entry removed before the choice was stored is linked again the way the
 *  import links it, with the same role rules. Returns the dish that came back. */
export function restoreDay(date: string): L3 {
  const d = findDay(date);
  if (!d) throw dayNotFound();
  if (d.match !== 'skipped') throw new UserError(l3('Ruokalajia ei ole poistettu, joten palautettavaa ei ole.', 'Rätten är inte borttagen, så det finns inget att återställa.', 'The dish has not been removed, so there is nothing to restore.'));
  const was = d.removed;
  if (was) { d.match = was.match; d.recipeId = was.recipeId; d.suggestion = was.suggestion; d.customName = was.customName; d.removed = undefined; }
  else relinkAsImported(d, S().menu?.kind === 'event');
  const name = l3(choiceName('fi', d), choiceName('sv', d), choiceName('en', d));
  audit(ACTOR.kitchen, 'restore_day', l3(`${dayName('fi', d)}: ruokalaji ”${name.fi}” palautettu`, `${dayName('sv', d)}: rätten ”${name.sv}” återställd`, `${dayName('en', d)}: dish “${name.en}” restored`));
  return name;
}

// ---------- alternatives ----------

function physicalUnit(ing: { unit: 'g' | 'ml' }): 'kg' | 'L' { return ing.unit === 'ml' ? 'L' : 'kg'; }

function packsFor(amount: number, p: CatalogProduct): number {
  return roundToLot(Math.max(1, Math.ceil(amount / p.per!.v - 1e-9)), p);
}

async function toAlternative(p: CatalogProduct, reqs: Requirement[], lang: Lang, date: string, qty = 0, note?: string): Promise<Alternative> {
  const offers = await fetchOffers([p.id], date);
  const checks = checkAll(p, reqs, lang);
  return { product: productView(p, lang), offer: toOffer(offers.get(p.id), lang, qty), checks, suitable: allOk(checks), note };
}

function candidates(search: string, unit: 'kg' | 'L', like?: CatalogProduct): CatalogProduct[] {
  const seen = new Set<string>();
  const out: CatalogProduct[] = [];
  const push = (p: CatalogProduct) => { if (!seen.has(p.id) && p.per && p.per.u === unit && !p.del) { seen.add(p.id); out.push(p); } };
  searchProducts(search, { limit: 40, needPack: true }).forEach(push);
  if (like) {
    const toks = norm(search).split(' ');
    sameCategory(like.cat).filter(p => toks.some(t => p._s!.includes(t))).slice(0, 60).forEach(push);
  }
  return out;
}

export function alternativeTier(p: CatalogProduct, like: CatalogProduct | undefined, lang: Lang): Pick<Alternative, 'tier' | 'tierLabel'> {
  if (like?.subs.includes(p.id)) return { tier: 'supplier_substitute', tierLabel: tr(lang, 'Toimittajan ilmoittama korvaava', 'Ersättare angiven av leverantören', 'Supplier-declared substitute') };
  if (like?.cat === p.cat) return { tier: 'same_category', tierLabel: tr(lang, 'Sama tuoteryhmä', 'Samma produktgrupp', 'Same category') };
  return { tier: 'other_verified', tierLabel: tr(lang, 'Muu tarkistettu', 'Annat verifierat alternativ', 'Other verified alternative') };
}

/** Verified, orderable alternatives: supplier substitutes first, then same category, then covering cost. */
export async function findAlternatives(search: string, reqs: Requirement[], unit: 'kg' | 'L', amount: number, lang: Lang, date: string, exclude: string[], like?: CatalogProduct, max = 3): Promise<Alternative[]> {
  const valid = (p: CatalogProduct) => !p.del && p.per?.u === unit && !exclude.includes(p.id) && allOk(checkAll(p, reqs, lang));
  const supplied = (like?.subs ?? []).map(getProduct).filter((p): p is CatalogProduct => !!p && valid(p));
  const ordinary = candidates(search, unit, like).filter(valid).slice(0, 14);
  const pool = [...new Map([...supplied, ...ordinary].map(p => [p.id, p])).values()];
  if (!pool.length) return [];
  const offers = await fetchOffers(pool.map(p => p.id), date);
  const rows = pool.map(p => {
    const raw = offers.get(p.id);
    const qty = packsFor(amount, p);
    return { p, raw, qty, cost: raw?.price != null ? qty * raw.price : Infinity };
  }).filter(r => r.raw && r.raw.price != null && r.raw.hasAvailability && (r.raw.unknownQty || (r.raw.amount ?? 0) >= r.qty));
  const same = (p: CatalogProduct) => like?.subs.includes(p.id) ? 0 : like && p.cat === like.cat ? 1 : 2;
  rows.sort((a, b) => same(a.p) - same(b.p) || a.cost - b.cost);
  return rows.slice(0, max).map((r, i) => ({
    product: productView(r.p, lang), offer: toOffer(r.raw, lang, r.qty), checks: checkAll(r.p, reqs, lang), suitable: true,
    ...alternativeTier(r.p, like, lang),
    note: tr(lang,
      `${i === 0 ? 'Suositus · ' : ''}tarvitaan ${r.qty} × ${num(lang, r.p.per!.v, 2)} ${r.p.per!.u} = ${eur(lang, r.cost)}`,
      `${i === 0 ? 'Rekommenderas · ' : ''}behov ${r.qty} × ${num(lang, r.p.per!.v, 2)} ${r.p.per!.u} = ${eur(lang, r.cost)}`,
      `${i === 0 ? 'Recommended · ' : ''}need ${r.qty} × ${num(lang, r.p.per!.v, 2)} ${r.p.per!.u} = ${eur(lang, r.cost)}`),
  }));
}

// ---------- plan ----------

interface Demand {
  productId: string; ing: RecipeIngredient; needed: number; unit: 'kg' | 'L';
  uses: { date: string; recipe: Recipe; ing: RecipeIngredient; groupId: string; amount: number }[];
  groupIds: Set<string>; reqs: Set<Requirement>; why: L3; changed?: L3;
  /** products the user switched away from (`swap_line`) that this line now replaces */
  swappedFrom: Set<string>;
}
interface Pending { key: string; ing: RecipeIngredient; group: Group; failedId: string; amount: number; recipes: Set<string>; dates: Set<string> }

const WHY = {
  usual: l3('Keittiön vakiotuote hyväksytyssä reseptissä.', 'Kökets standardprodukt i det godkända receptet.', 'The kitchen’s usual product in the approved recipe.'),
  usualOk: l3('Vakiotuote sopii myös erityisruokavalioon – tarkistettu toimittajan tiedoista.', 'Standardprodukten passar även specialkosten – kontrollerat mot leverantörens data.', 'The usual product also suits the special diet – verified from supplier data.'),
  special: l3('Keittiön erityisruokavaliotuote – tarkistettu toimittajan tiedoista.', 'Kökets specialkostprodukt – kontrollerad mot leverantörens data.', 'The kitchen’s special-diet product – verified from supplier data.'),
  approved: l3('Hyväksymäsi korvaava tuote – tarkistettu uudelleen toimittajan tiedoista.', 'Ersättningsprodukt som du godkänt – kontrollerad på nytt mot leverantörens data.', 'Replacement you approved – re-verified from supplier data.'),
};

function choose(ing: RecipeIngredient, g: Group): { id: string; why: L3; changed?: L3; swappedFrom?: string } | { failedId: string } {
  const st = S();
  const pass = (id?: string) => { const p = id ? getProduct(id) : undefined; return !!p && !!p.per && allOk(checkAll(p, g.reqs, 'fi')); };
  let pickd: { id: string; why: L3; changed?: L3 } | undefined;
  if (!g.reqs.length) pickd = { id: ing.product, why: WHY.usual };
  else {
    const ov = st.overrides[`${ing.key}|${g.id}`];
    if (pass(ov)) {
      const from = getProduct(ing.special ?? ing.product)!, to = getProduct(ov)!;
      pickd = { id: ov, why: WHY.approved, changed: l3(`Vaihdettu: ${from.name} → ${to.name}`, `Bytt: ${localName(from, 'sv')} → ${localName(to, 'sv')}`, `Changed: ${localName(from, 'en')} → ${localName(to, 'en')}`) };
    } else if (pass(ing.product)) pickd = { id: ing.product, why: WHY.usualOk };
    else if (pass(ing.special)) pickd = { id: ing.special!, why: WHY.special };
  }
  if (!pickd) return { failedId: ing.special ?? ing.product };
  const sw = st.swaps[pickd.id];
  if (sw && pass(sw)) {
    const from = getProduct(pickd.id)!, to = getProduct(sw)!;
    return { id: sw, why: WHY.approved, changed: l3(`Vaihdettu: ${from.name} → ${to.name}`, `Bytt: ${localName(from, 'sv')} → ${localName(to, 'sv')}`, `Changed: ${localName(from, 'en')} → ${localName(to, 'en')}`), swappedFrom: pickd.id };
  }
  return pickd;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function buildPlan(lang: Lang): Promise<Plan | undefined> {
  const st = S();
  const menu = st.menu;
  if (!menu) return undefined;
  const gs = groups().filter(g => g.count > 0);
  const total = st.kitchen.portionsTotal;
  const isEvent = menu.kind === 'event';
  // weekly kitchens: one delivery on Monday; events: the day before the event
  const deliveryDate = isEvent ? addDays(menu.days[0]?.date ?? menu.weekStart, -1) : menu.weekStart;
  const demand = new Map<string, Demand>();
  const pending = new Map<string, Pending>();
  const skippedNow = new Map<string, Pending>();
  const withSides = currentProfile().dailySides && !isEvent;
  const side = sideRecipe();

  for (const day of menu.days) {
    if (day.match !== 'confirmed' || invalidEntry(day)) continue;
    const main = recipeById(day.recipeId);
    if (!main) continue;
    const scale = (day.importedPortions ?? total) / total;
    for (const recipe of withSides ? [main, side] : [main]) for (const ing of recipe.ingredients) for (const g of gs) {
      const amount = (ing.amount * g.count * scale) / 1000;
      const c = choose(ing, g);
      if ('failedId' in c) {
        const key = `${ing.key}|${g.id}`;
        const bucket = st.skipped.includes(key) ? skippedNow : pending;
        const p = bucket.get(key) ?? { key, ing, group: g, failedId: c.failedId, amount: 0, recipes: new Set<string>(), dates: new Set<string>() };
        p.amount += amount; p.recipes.add(recipe.id); p.dates.add(day.date);
        bucket.set(key, p);
        continue;
      }
      const d = demand.get(c.id) ?? { productId: c.id, ing, needed: 0, unit: physicalUnit(ing), uses: [], groupIds: new Set<string>(), reqs: new Set<Requirement>(), why: c.why, changed: c.changed, swappedFrom: new Set<string>() };
      d.needed += amount; d.groupIds.add(g.id); g.reqs.forEach(r => d.reqs.add(r));
      if (c.swappedFrom) d.swappedFrom.add(c.swappedFrom);
      if (g.reqs.length) { d.why = c.why; d.changed = c.changed ?? d.changed; }
      d.uses.push({ date: day.date, recipe, ing, groupId: g.id, amount });
      demand.set(c.id, d);
    }
  }

  const ids = [...demand.keys()].filter(id => !st.edits.removed.includes(id));
  const offers = await fetchOffers(ids, deliveryDate);
  const issues: Issue[] = [];

  // --- menu questions ---
  for (const day of menu.days) {
    if (day.match === 'suggested' && day.suggestion && !invalidEntry(day)) {
      issues.push({
        id: `rc|${day.id ?? day.date}`, kind: 'suggested_recipe', severity: 'block', date: day.id ?? day.date, resolved: false,
        title: tr(lang, `${dayName(lang, day)}: käytetäänkö reseptiä ${recipeName(lang, day.suggestion.recipeId)}?`, `${dayName(lang, day)}: ska receptet ${recipeName(lang, day.suggestion.recipeId)} användas?`, `${dayName(lang, day)}: use the recipe ${recipeName(lang, day.suggestion.recipeId)}?`),
        detail: tr(lang, `Ruokalistassa lukee ”${day.dishName}”. ${pick(lang, day.suggestion.why)} En arvaa reseptiä puolestasi – vahvista tai valitse toinen.`, `I matsedeln står ”${day.dishName}”. ${pick(lang, day.suggestion.why)} Jag gissar inte receptet åt dig – bekräfta eller välj ett annat.`, `The menu says “${day.dishName}”. ${pick(lang, day.suggestion.why)} I won’t guess the recipe for you – confirm or pick another.`),
        recipeOptions: [{ recipeId: day.suggestion.recipeId, recipeName: recipeName(lang, day.suggestion.recipeId)!, why: pick(lang, day.suggestion.why) }],
      });
    } else if (day.match === 'missing' || invalidEntry(day)) {
      issues.push({
        id: `rc|${day.id ?? day.date}`, kind: 'missing_recipe', severity: 'block', date: day.id ?? day.date, resolved: false,
        title: invalidEntry(day) || day.recipeId
          ? tr(lang, `${dayName(lang, day)}: tarkista ruokalajin rooli ja resepti`, `${dayName(lang, day)}: kontrollera rättens roll och recept`, `${dayName(lang, day)}: check the course role and recipe`)
          : tr(lang, `${dayName(lang, day)}: ruokalajille ”${day.dishName}” ei löydy hyväksyttyä reseptiä`, `${dayName(lang, day)}: inget godkänt recept för ”${day.dishName}”`, `${dayName(lang, day)}: no approved recipe for “${day.dishName}”`),
        detail: invalidEntry(day) || !!day.recipeId ? roleProblem(lang, day) : tr(lang, 'Pelkkä nimi ei kerro ainesosia tai allergeeneja. Valitse hyväksytty resepti, hae tuotteet tukusta omalle ruokalajille tai poista ruokalaji – kahdessa jälkimmäisessä Aimo ei laske sille määriä eikä tilaa mitään automaattisesti. Muu tilaus etenee normaalisti.', 'Enbart namnet avslöjar inte ingredienser eller allergener. Välj ett godkänt recept, sök produkter i grossistens sortiment för en egen rätt eller ta bort rätten – i de två senare fallen räknar Aimo inga mängder och beställer inget automatiskt. Resten av ordern går vidare som vanligt.', 'A dish name alone does not reveal ingredients or allergens. Pick an approved recipe, find products from the wholesaler for your own dish or remove the dish – in the last two cases Aimo calculates no amounts and orders nothing automatically. The rest of the order proceeds as usual.'),
        recipeOptions: [],
      });
    }
  }
  if (!st.kitchen.portionsConfirmed) {
    issues.push({
      id: 'portions', kind: 'portions', severity: 'block', resolved: false,
      title: tr(lang, 'Vahvista annosmäärät', 'Bekräfta antalet portioner', 'Confirm the portions'),
      detail: isEvent
        ? tr(lang, `Lasken nyt ${total} vieraalle ilman erityisruokavalioita. Kerro oikeat määrät, esim. ”120 vierasta, joista 8 gluteenitonta ja 4 maidotonta”.`, `Jag räknar nu med ${total} gäster utan specialkost. Berätta de rätta mängderna, t.ex. ”120 gäster, varav 8 glutenfria och 4 mjölkfria”.`, `I am currently assuming ${total} guests with no special diets. Tell me the real numbers, e.g. “120 guests, including 8 gluten-free and 4 milk-free”.`)
        : tr(lang, `Lasken nyt ${total} annoksella päivässä ilman erityisruokavalioita. Kerro oikeat määrät, esim. ”350 lounasta, joista 20 gluteenitonta ja 8 vehnätöntä”.`, `Jag räknar nu med ${total} portioner per dag utan specialkost. Berätta de rätta mängderna, t.ex. ”350 luncher, varav 20 glutenfria och 8 vetefria”.`, `I am currently assuming ${total} portions a day with no special diets. Tell me the real numbers, e.g. “350 lunches, including 20 gluten-free and 8 wheat-free”.`),
    });
  }

  // --- allergen issues ---
  for (const p of pending.values()) {
    const failed = getProduct(p.failedId)!;
    const checks = checkAll(failed, p.group.reqs, lang);
    const bad = checks.find(c => c.verdict === 'fail') ?? checks.find(c => c.verdict === 'unknown')!;
    const unit = physicalUnit(p.ing);
    const alternatives = await findAlternatives(p.ing.search, p.group.reqs, unit, p.amount, lang, deliveryDate, [p.failedId, p.ing.product], failed);
    const gl = `${groupLabel(lang, p.group.id)} · ${p.group.count} ${tr(lang, 'annosta', 'portioner', 'portions')}`;
    const recipes = [...p.recipes].map(id => recipeName(lang, id)).join(', ');
    issues.push({
      id: `al|${p.key}`, kind: bad.verdict === 'fail' ? 'allergen_fail' : 'allergen_unknown', severity: 'block', resolved: false,
      title: bad.verdict === 'fail'
        ? tr(lang, `${pick(lang, p.ing.name)}: ${localName(failed, lang)} ei sovi ruokavalioon ${bad.requirementLabel.toLowerCase()}`, `${pick(lang, p.ing.name)}: ${localName(failed, lang)} passar inte kosten ${bad.requirementLabel.toLowerCase()}`, `${pick(lang, p.ing.name)}: ${localName(failed, lang)} is not suitable for ${bad.requirementLabel.toLowerCase()}`)
        : tr(lang, `${pick(lang, p.ing.name)}: tieto puuttuu tuotteesta ${localName(failed, lang)} (${bad.requirementLabel.toLowerCase()})`, `${pick(lang, p.ing.name)}: uppgift saknas om ${localName(failed, lang)} (${bad.requirementLabel.toLowerCase()})`, `${pick(lang, p.ing.name)}: information missing for ${localName(failed, lang)} (${bad.requirementLabel.toLowerCase()})`),
      detail: tr(lang,
        `Tarvitaan ${num(lang, p.amount, 2)} ${unit} (${recipes}). ${alternatives.length ? 'Löysin tarkistetun vaihtoehdon – vahvista, niin muistan sen jatkossa.' : 'En löytänyt tarkistettua vaihtoehtoa valikoimasta. Hae toinen tuote tai jätä rivi pois.'}`,
        `Behov ${num(lang, p.amount, 2)} ${unit} (${recipes}). ${alternatives.length ? 'Jag hittade ett verifierat alternativ – bekräfta så minns jag det framöver.' : 'Jag hittade inget verifierat alternativ i sortimentet. Sök en annan produkt eller lämna raden.'}`,
        `Needed: ${num(lang, p.amount, 2)} ${unit} (${recipes}). ${alternatives.length ? 'I found a verified alternative – confirm it and I will remember it.' : 'I found no verified alternative in the assortment. Search for another product or leave the line out.'}`),
      ingredient: pick(lang, p.ing.name), groupLabel: gl, recipeName: recipes, product: productView(failed, lang), check: bad, alternatives,
    });
  }
  // lines the user chose to leave out: nothing is ordered for that group, and it stays visible
  for (const p of skippedNow.values()) {
    issues.push({
      id: `al|${p.key}`, kind: 'allergen_fail', severity: 'warn', resolved: true,
      title: `${pick(lang, p.ing.name)} · ${groupLabel(lang, p.group.id)}`, detail: '', ingredient: pick(lang, p.ing.name), groupLabel: groupLabel(lang, p.group.id),
      resolution: tr(lang, `Jätetty pois tilauksesta: ${pick(lang, p.ing.name)} (${groupLabel(lang, p.group.id).toLowerCase()}, ${num(lang, p.amount, 2)} ${physicalUnit(p.ing)}). Mitään varmistamatonta ei tilata – hoida tämä erikseen.`, `Utelämnad ur ordern: ${pick(lang, p.ing.name)} (${groupLabel(lang, p.group.id).toLowerCase()}, ${num(lang, p.amount, 2)} ${physicalUnit(p.ing)}). Inget overifierat beställs – sköt detta separat.`, `Left out of the order: ${pick(lang, p.ing.name)} (${groupLabel(lang, p.group.id).toLowerCase()}, ${num(lang, p.amount, 2)} ${physicalUnit(p.ing)}). Nothing unverified is ordered – handle this separately.`),
    });
  }
  // resolved allergen issues stay visible as confirmations
  for (const [key, pid] of Object.entries(st.overrides)) {
    const [ingKey, gid] = key.split('|');
    const g = gs.find(x => x.id === gid);
    const d = demand.get(pid);
    if (!g || !d || !d.groupIds.has(gid) || d.ing.key !== ingKey) continue;
    const np = getProduct(pid)!;
    issues.push({
      id: `al|${key}`, kind: 'allergen_fail', severity: 'block', resolved: true,
      title: tr(lang, `${pick(lang, d.ing.name)} · ${groupLabel(lang, gid)}`, `${pick(lang, d.ing.name)} · ${groupLabel(lang, gid)}`, `${pick(lang, d.ing.name)} · ${groupLabel(lang, gid)}`),
      detail: '', ingredient: pick(lang, d.ing.name), groupLabel: groupLabel(lang, gid),
      resolution: tr(lang, `Käytetään tuotetta ${localName(np, lang)} – tarkistettu ja tallennettu keittiön muistiin.`, `Produkten ${localName(np, lang)} används – verifierad och sparad i kökets minne.`, `Using ${localName(np, lang)} – verified and saved to the kitchen’s memory.`),
    });
  }

  // --- lines ---
  const lines: PlanLine[] = [];
  let cutoff = 0;
  for (const id of ids) {
    const d = demand.get(id)!;
    const p = getProduct(id)!;
    const stock = st.stock.find(s => s.productId === id)?.amount ?? 0;
    const fromStock = Math.min(stock, d.needed);
    const toOrder = d.needed - fromStock;
    // whole packs first, then up to the next quantity the supplier's lot size allows
    const packs = toOrder > 1e-6 ? Math.ceil(toOrder / p.per!.v - 1e-9) : 0;
    const handSet = st.edits.qty[id];
    const wanted = handSet ?? packs;
    const qty = roundToLot(wanted, p);
    const lotNote = qty === wanted ? '' : ' ' + tr(lang, `Tuotetta myydään ${lotStep(p)} myyntiyksikön erissä, joten määrä ${wanted} pyöristettiin ylöspäin: ${qty}.`, `Produkten säljs i partier om ${lotStep(p)} försäljningsenheter, så mängden ${wanted} avrundades uppåt till ${qty}.`, `The product is sold in lots of ${lotStep(p)} sales units, so the quantity ${wanted} was rounded up to ${qty}.`);
    const raw = offers.get(id);
    const offer = toOffer(raw, lang, qty);
    const reqs = [...d.reqs];
    const checks: AllergenCheck[] = checkAll(p, reqs, lang);
    const uses: LineUse[] = d.uses.map(u => ({ date: u.date, weekdayLabel: weekdayLabel(lang, weekdayOf(u.date)), recipeName: pick(lang, u.recipe.name), ingredient: pick(lang, u.ing.name), groupLabel: groupLabel(lang, u.groupId), amount: round3(u.amount), unit: d.unit }));
    let status: PlanLine['status'] = 'ok';
    if (qty > 0) {
      if (offer.price == null) {
        status = 'blocked';
        issues.push({ id: `pr|${id}`, kind: 'no_price', severity: 'block', resolved: false, product: productView(p, lang), ingredient: pick(lang, d.ing.name),
          title: tr(lang, `${localName(p, lang)}: hintaa ei saatu`, `${localName(p, lang)}: inget pris`, `${localName(p, lang)}: no price`),
          detail: tr(lang, 'Valio Aimo -mockrajapinta ei palauttanut hintaa. En arvaa hintaa – yritä hetken päästä uudelleen tai vaihda tuote.', 'Valio Aimos mock-API gav inget pris. Jag gissar inte priset – försök igen om en stund eller byt produkt.', 'The Valio Aimo mock API returned no price. I will not guess – retry shortly or switch the product.'),
          alternatives: await findAlternatives(d.ing.search, reqs, d.unit, toOrder, lang, deliveryDate, [id], p) });
      } else if (offer.availability === 'no_data' || offer.availability === 'unavailable' || offer.availability === 'limited') {
        status = 'blocked';
        issues.push({ id: `av|${id}`, kind: 'unavailable', severity: 'block', resolved: false, product: productView(p, lang), ingredient: pick(lang, d.ing.name),
          title: tr(lang, `${localName(p, lang)}: ${offer.availabilityLabel.toLowerCase()}`, `${localName(p, lang)}: ${offer.availabilityLabel.toLowerCase()}`, `${localName(p, lang)}: ${offer.availabilityLabel.toLowerCase()}`),
          detail: tr(lang, `Tarvitaan ${qty} ${productView(p, lang).unitLabel}. Valitse tarkistettu korvaava tuote tai muuta määrää.`, `Behov ${qty} ${productView(p, lang).unitLabel}. Välj en verifierad ersättare eller ändra mängden.`, `Need ${qty} ${productView(p, lang).unitLabel}. Choose a verified replacement or change the quantity.`),
          alternatives: await findAlternatives(d.ing.search, reqs, d.unit, toOrder, lang, deliveryDate, [id], p) });
      } else if (offer.cutoffPassed) { status = 'warning'; cutoff++; }
    }
    if (!allOk(checks)) status = 'blocked'; // cannot happen by construction, but never trust construction with allergens
    lines.push({
      id, product: productView(p, lang), offer, ingredient: pick(lang, d.ing.name), needed: round3(d.needed), unit: d.unit,
      fromStock: round3(fromStock), orderQty: qty, orderedAmount: round3(qty * p.per!.v),
      lineTotal: offer.price != null ? round2(qty * offer.price) : undefined,
      groupLabels: [...d.groupIds].map(g => groupLabel(lang, g)), uses, checks, status,
      why: pick(lang, d.why) + lotNote, changed: d.changed ? pick(lang, d.changed) : undefined,
      calculatedQty: handSet !== undefined ? roundToLot(packs, p) : undefined,
      swappedFrom: d.swappedFrom.size ? [...d.swappedFrom].map(x => { const o = getProduct(x); return o ? localName(o, lang) : x; }).join(', ') : undefined,
    });
  }
  if (cutoff) {
    issues.push({ id: 'cutoff', kind: 'cutoff', severity: 'warn', resolved: false,
      title: tr(lang, `${cutoff} tuotteen tilausaika on mock-datassa jo umpeutunut`, `Beställningstiden har gått ut för ${cutoff} produkter i mock-datan`, `The order cutoff has passed for ${cutoff} products in the mock data`),
      detail: tr(lang, 'Valio Aimon haasterajapinta palauttaa kiinteän tilannekuvan, jossa osan tuotteista tilausaika on mennyt. Tilaus vaatii siksi aina ihmisen hyväksynnän, ja huomautus kirjataan tilaukselle.', 'Valio Aimos utmanings-API returnerar en fast ögonblicksbild där beställningstiden för vissa produkter har passerat. Beställningen kräver därför alltid mänskligt godkännande och en anmärkning sparas på ordern.', 'The Valio Aimo challenge API returns a fixed snapshot in which some cutoffs are already in the past. The order therefore always needs human approval and the note is recorded on the order.') });
  }
  const order = { blocked: 0, warning: 1, ok: 2 } as const;
  lines.sort((a, b) => order[a.status] - order[b.status] || a.ingredient.localeCompare(b.ingredient));
  const active = lines.filter(l => l.orderQty > 0);
  const net = round2(active.reduce((a, l) => a + (l.lineTotal ?? 0), 0));
  const vat = round2(active.reduce((a, l) => a + (l.lineTotal ?? 0) * ((l.offer.vatRate ?? 13.5) / 100), 0));
  const gross = round2(net + vat);
  const limit = st.kitchen.authority.creditLimit;
  if (limit != null && active.length && creditUsed() + gross > limit) {
    issues.push({ id: 'credit', kind: 'credit', severity: 'block', resolved: false,
      title: tr(lang, `Tilaus ylittäisi tilin luottorajan ${eur(lang, limit)}`, `Ordern skulle överskrida kontots kreditgräns ${eur(lang, limit)}`, `The order would exceed the account’s credit limit of ${eur(lang, limit)}`),
      detail: tr(lang, `Luottorajasta on käytössä ${eur(lang, creditUsed())} ja tämä tilaus on ${eur(lang, gross)} (sis. alv). Luottoraja on tukkurin asettama katto, jota mikään hyväksyntä ei ylitä: pienennä tilausta tai sovi rajan nostosta.`, `Av kreditgränsen används ${eur(lang, creditUsed())} och den här ordern är ${eur(lang, gross)} (inkl. moms). Kreditgränsen är ett tak som grossisten satt och som inget godkännande kan överskrida: minska ordern eller kom överens om en höjning.`, `${eur(lang, creditUsed())} of the credit limit is in use and this order is ${eur(lang, gross)} (incl. VAT). The credit limit is a cap set by the wholesaler that no approval can exceed: reduce the order or agree on a higher limit.`) });
  }
  const rank = { block: 0, warn: 1 } as const;
  issues.sort((a, b) => Number(a.resolved) - Number(b.resolved) || rank[a.severity] - rank[b.severity]);
  const last = [...st.orders].reverse().find(o => o.fromPlan && o.status !== 'rejected' && o.status !== 'cancelled' && o.deliveryDate === deliveryDate);
  // said on the list so nobody assumes these days come with the order; never blocking
  const notCovered = menu.days.filter(d => d.match === 'skipped' || d.match === 'custom').map(d => ({
    date: d.id ?? d.date, day: dayName(lang, d), name: choiceName(lang, d), kind: d.match as 'skipped' | 'custom',
  }));
  const removedLines = st.edits.removed.filter(id => demand.has(id)).map(id => {
    const p = getProduct(id);
    return { id, name: p ? localName(p, lang) : id, ingredient: pick(lang, demand.get(id)!.ing.name) };
  });
  return {
    id: `plan-${currentProfile().id}-${menu.weekStart}`, weekStart: menu.weekStart, weekLabel: menuTitle(lang), createdAt: new Date().toISOString(),
    deliveryDate, deliveryLabel: dayLabel(lang, deliveryDate), lines, issues,
    totals: { net, vat, gross, lineCount: active.length },
    ready: active.length > 0 && !issues.some(i => !i.resolved && i.severity === 'block'), orderId: last?.id,
    notCovered: notCovered.length ? notCovered : undefined,
    removedLines: removedLines.length ? removedLines : undefined,
  };
}

// ---------- plan edits ----------

function issueGroup(issueId: string): { ingKey: string; group: Group } | undefined {
  if (typeof issueId !== 'string') throw new UserError(l3('Asiaa ei löytynyt.', 'Ärendet hittades inte.', 'Item not found.'));
  const [kind, ingKey, gid] = issueId.split('|');
  const group = groups().find(g => g.id === gid);
  return kind === 'al' && group && group.reqs.length ? { ingKey, group } : undefined;
}

function assertSuitable(p: CatalogProduct | undefined, reqs: Requirement[], unit?: 'kg' | 'L'): asserts p is CatalogProduct {
  if (!p || p.del) throw new UserError(l3('Tuotetta ei löytynyt valikoimasta.', 'Produkten hittades inte i sortimentet.', 'Product not found in the assortment.'));
  if (!p.per || (unit && p.per.u !== unit)) throw new UserError(l3('Tuotteen pakkauskoko ei ole toimittajan tiedoissa, joten määrää ei voi laskea.', 'Produktens förpackningsstorlek saknas i leverantörsdata, så mängden kan inte räknas.', 'The product has no pack size in the supplier data, so the quantity cannot be calculated.'));
  const bad = checkAll(p, reqs, 'fi').find(c => c.verdict !== 'ok');
  if (bad) {
    const f = (lang: Lang) => checkAll(p, reqs, lang).find(c => c.verdict !== 'ok')!.summary;
    throw new UserError(l3(`En voi käyttää tuotetta ${p.name}. ${f('fi')}`, `Jag kan inte använda ${localName(p, 'sv')}. ${f('sv')}`, `I cannot use ${localName(p, 'en')}. ${f('en')}`));
  }
}

/** Accept a replacement for an allergen/availability issue. The rules re-verify the product; approval never overrides a failed check. */
export function resolveIssue(issueId: string, productId: string, lang: Lang, lastPlan?: Plan): string {
  const st = S();
  const p = getProduct(productId);
  const ig = issueGroup(issueId);
  if (ig) {
    const ing = allIngredients().find(i => i.key === ig.ingKey);
    if (!ing) throw new UserError(l3('Ainesosaa ei löytynyt.', 'Ingrediensen hittades inte.', 'Ingredient not found.'));
    assertSuitable(p, ig.group.reqs, physicalUnit(ing));
    st.overrides[`${ig.ingKey}|${ig.group.id}`] = p.id;
    st.skipped = st.skipped.filter(k => k !== `${ig.ingKey}|${ig.group.id}`);
    delete st.edits.qty[p.id];
    const mem = l3(`${requirementLabel('fi', ig.group.reqs[0])} · ${ing.name.fi}: käytetään tuotetta ${p.name}`, `${requirementLabel('sv', ig.group.reqs[0])} · ${ing.name.sv}: ${localName(p, 'sv')} används`, `${requirementLabel('en', ig.group.reqs[0])} · ${ing.name.en}: use ${localName(p, 'en')}`);
    st.kitchen.memory = st.kitchen.memory.filter(m => m.id !== `ov|${ig.ingKey}|${ig.group.id}`);
    st.kitchen.memory.push({ id: `ov|${ig.ingKey}|${ig.group.id}`, text: mem, at: new Date().toISOString() });
    audit(ACTOR.kitchen, 'resolve_issue', l3(`Korvaava tuote hyväksytty – ${mem.fi}. Allergeenitarkistus läpäisty.`, `Ersättare godkänd – ${mem.sv}. Allergenkontroll godkänd.`, `Replacement approved – ${mem.en}. Allergen check passed.`));
    return pick(lang, mem);
  }
  const [kind, oldId] = issueId.split('|');
  if (kind === 'av' || kind === 'pr') return swapLine(oldId, productId, lang, lastPlan);
  throw new UserError(l3('Tätä asiaa ei voi ratkaista tuotevaihdolla.', 'Det här kan inte lösas med ett produktbyte.', 'This item cannot be resolved by switching the product.'));
}

/** Leave the affected line out of the order. Nothing unverified is ordered; the rest of the order can proceed. */
export function skipIssue(issueId: string, lang: Lang): string {
  const st = S();
  const ig = issueGroup(issueId);
  if (ig) {
    const key = `${ig.ingKey}|${ig.group.id}`;
    if (!st.skipped.includes(key)) st.skipped.push(key);
    const ing = allIngredients().find(i => i.key === ig.ingKey);
    const what = l3(`${ing?.name.fi ?? ig.ingKey} (${requirementLabel('fi', ig.group.reqs[0]).toLowerCase()})`, `${ing?.name.sv ?? ig.ingKey} (${requirementLabel('sv', ig.group.reqs[0]).toLowerCase()})`, `${ing?.name.en ?? ig.ingKey} (${requirementLabel('en', ig.group.reqs[0]).toLowerCase()})`);
    audit(ACTOR.kitchen, 'skip_issue', l3(`Jätetty pois tilauksesta: ${what.fi}. Varmistamatonta tuotetta ei tilattu.`, `Utelämnad ur ordern: ${what.sv}. Ingen overifierad produkt beställdes.`, `Left out of the order: ${what.en}. No unverified product was ordered.`));
    return pick(lang, what);
  }
  const [kind, lineId] = issueId.split('|');
  if (kind === 'av' || kind === 'pr') { removeLine(lineId); return getProduct(lineId)?.name ?? lineId; }
  throw new UserError(l3('Tätä asiaa ei voi jättää pois.', 'Det här kan inte utelämnas.', 'This item cannot be left out.'));
}

export function swapLine(lineId: string, productId: string, lang: Lang, lastPlan?: Plan): string {
  const st = S();
  const line = lastPlan?.lines.find(l => l.id === lineId);
  const old = getProduct(lineId);
  if (!line || !old) throw new UserError(l3('Riviä ei löytynyt.', 'Raden hittades inte.', 'Line not found.'));
  const p = getProduct(productId);
  // the replacement must satisfy every requirement of every group the line serves
  const reqs = line.checks.map(c => c.requirement);
  assertSuitable(p, reqs, line.unit);
  // resolve chains: swapping an already swapped product replaces the original mapping
  const origin = Object.entries(st.swaps).find(([, v]) => v === lineId)?.[0] ?? lineId;
  for (const [k, v] of Object.entries(st.overrides)) if (v === lineId) st.overrides[k] = p.id;
  st.swaps[origin] = p.id;
  delete st.edits.qty[lineId];
  const mem = l3(`${line.ingredient}: ${old.name} → ${p.name}`, `${line.ingredient}: ${localName(old, 'sv')} → ${localName(p, 'sv')}`, `${line.ingredient}: ${localName(old, 'en')} → ${localName(p, 'en')}`);
  st.kitchen.memory = st.kitchen.memory.filter(m => m.id !== `sw|${origin}`);
  st.kitchen.memory.push({ id: `sw|${origin}`, text: mem, at: new Date().toISOString() });
  audit(ACTOR.kitchen, 'swap_line', l3(`Tuote vaihdettu – ${mem.fi}. Ruokavaliovaatimukset tarkistettu uudelleen.`, `Produkt bytt – ${mem.sv}. Kostkraven kontrollerade på nytt.`, `Product switched – ${mem.en}. Dietary requirements re-checked.`));
  return pick(lang, mem);
}

/** Stores the quantity rounded up to the product's lot size and returns what was stored. */
export function setLineQty(lineId: string, qty: number): number {
  if (!Number.isFinite(qty) || qty < 0 || qty > 100000) throw new UserError(l3('Määrä ei kelpaa.', 'Ogiltig mängd.', 'Invalid quantity.'));
  const p = getProduct(lineId);
  const stored = p ? roundToLot(Math.round(qty), p) : Math.round(qty);
  S().edits.qty[lineId] = stored;
  save();
  return stored;
}
export function removeLine(lineId: string) {
  const st = S();
  if (!st.edits.removed.includes(lineId)) st.edits.removed.push(lineId);
  const p = getProduct(lineId);
  audit(ACTOR.kitchen, 'remove_line', l3(`Rivi poistettu tilausehdotuksesta: ${p?.name ?? lineId}`, `Rad borttagen från orderförslaget: ${p ? localName(p, 'sv') : lineId}`, `Line removed from the proposal: ${p ? localName(p, 'en') : lineId}`));
}

const productName = (lang: Lang, id: string) => { const p = getProduct(id); return p ? localName(p, lang) : id; };

/** Put a removed line back. It returns at the calculated quantity: a hand-set quantity is dropped as well. */
export function restoreLine(lineId: string) {
  const st = S();
  if (typeof lineId !== 'string' || !st.edits.removed.includes(lineId)) throw new UserError(l3('Tätä riviä ei ole poistettu, joten palautettavaa ei ole.', 'Raden är inte borttagen, så det finns inget att återställa.', 'This line has not been removed, so there is nothing to restore.'));
  st.edits.removed = st.edits.removed.filter(id => id !== lineId);
  delete st.edits.qty[lineId];
  audit(ACTOR.kitchen, 'restore_line', l3(`Rivi palautettu tilausehdotukseen laskettuun määrään: ${productName('fi', lineId)}`, `Rad återställd i orderförslaget med beräknad mängd: ${productName('sv', lineId)}`, `Line restored to the proposal at the calculated quantity: ${productName('en', lineId)}`));
}

/** Drop a hand-set quantity: the line follows the calculation again. */
export function resetLineQty(lineId: string) {
  const st = S();
  if (typeof lineId !== 'string' || st.edits.qty[lineId] === undefined) throw new UserError(l3('Rivin määrää ei ole muutettu käsin.', 'Radens mängd har inte ändrats för hand.', 'The quantity of this line has not been changed by hand.'));
  delete st.edits.qty[lineId];
  audit(ACTOR.kitchen, 'reset_line_qty', l3(`Laskettu määrä palautettu: ${productName('fi', lineId)}`, `Beräknad mängd återställd: ${productName('sv', lineId)}`, `Calculated quantity restored: ${productName('en', lineId)}`));
}

/** Take back a product switch: the earlier product comes back wherever the switch applied, chosen and checked by the
 *  same rules as before (nothing unverified can return). The kitchen's memory of the switch is removed. */
export function restoreProduct(lineId: string) {
  const st = S();
  const origins = Object.entries(st.swaps).filter(([, v]) => v === lineId).map(([k]) => k);
  if (typeof lineId !== 'string' || !origins.length) throw new UserError(l3('Tämän rivin tuotetta ei ole vaihdettu.', 'Produkten på den här raden har inte bytts.', 'The product of this line has not been switched.'));
  for (const o of origins) {
    delete st.swaps[o];
    st.kitchen.memory = st.kitchen.memory.filter(m => m.id !== `sw|${o}`);
  }
  const names = (lang: Lang) => origins.map(o => productName(lang, o)).join(', ');
  audit(ACTOR.kitchen, 'restore_product', l3(`Tuotevaihto kumottu: ${productName('fi', lineId)} → ${names('fi')}`, `Produktbyte återtaget: ${productName('sv', lineId)} → ${names('sv')}`, `Product switch taken back: ${productName('en', lineId)} → ${names('en')}`));
}

/** Open a resolved allergen item again: the accepted alternative or the left-out choice and the kitchen's memory of it
 *  are removed. The plan then checks the usual products again, so the item blocks the order until it is resolved. */
export function reopenIssue(issueId: string, lang: Lang): string {
  const st = S();
  const ig = issueGroup(issueId);
  if (!ig) throw new UserError(l3('Tätä asiaa ei voi avata uudelleen.', 'Det här ärendet kan inte öppnas igen.', 'This item cannot be opened again.'));
  const key = `${ig.ingKey}|${ig.group.id}`;
  if (!(key in st.overrides) && !st.skipped.includes(key)) throw new UserError(l3('Asia on jo avoinna.', 'Ärendet är redan öppet.', 'The item is already open.'));
  delete st.overrides[key];
  st.skipped = st.skipped.filter(k => k !== key);
  st.kitchen.memory = st.kitchen.memory.filter(m => m.id !== `ov|${key}`);
  const ing = allIngredients().find(i => i.key === ig.ingKey);
  const what = l3(`${ing?.name.fi ?? ig.ingKey} (${requirementLabel('fi', ig.group.reqs[0]).toLowerCase()})`, `${ing?.name.sv ?? ig.ingKey} (${requirementLabel('sv', ig.group.reqs[0]).toLowerCase()})`, `${ing?.name.en ?? ig.ingKey} (${requirementLabel('en', ig.group.reqs[0]).toLowerCase()})`);
  audit(ACTOR.kitchen, 'reopen_issue', l3(`Valinta avattu uudelleen: ${what.fi}. Asia on taas ratkaisematta, eikä sitä tilata ennen uutta päätöstä.`, `Valet öppnat igen: ${what.sv}. Ärendet är olöst igen och beställs inte före ett nytt beslut.`, `Choice opened again: ${what.en}. The item is unresolved again and is not ordered until decided.`));
  return pick(lang, what);
}

function allIngredients(): RecipeIngredient[] {
  const out: RecipeIngredient[] = [];
  for (const d of S().menu?.days ?? []) { const r = recipeById(d.recipeId); if (r) out.push(...r.ingredients); }
  out.push(...sideRecipe().ingredients);
  return out;
}

// ---------- cheaper alternatives ----------

export async function findCheaper(lang: Lang, plan: Plan, lineId?: string): Promise<Card[]> {
  const cards: (Card & { saving: number })[] = [];
  const lines = plan.lines.filter(l => l.orderQty > 0 && l.lineTotal != null && (!lineId || l.id === lineId));
  const ings = allIngredients();
  for (const line of lines) {
    const cur = getProduct(line.id)!;
    const ing = ings.find(i => pick(lang, i.name) === line.ingredient);
    if (!ing) continue;
    const reqs = line.checks.map(c => c.requirement);
    const toOrder = Math.max(0, line.needed - line.fromStock);
    if (toOrder <= 0) continue;
    // "same kind of product": same supplier category and matching search word; never loosen dietary requirements
    const base = ing.special && reqs.length ? ing.search : norm(ing.search).split(' ').slice(-1)[0];
    const valid = (p: CatalogProduct) => p.id !== cur.id && !p.del && p.per?.u === line.unit && allOk(checkAll(p, reqs, lang));
    const supplied = cur.subs.map(getProduct).filter((p): p is CatalogProduct => !!p && valid(p));
    const ordinary = sameCategory(cur.cat).filter(p => valid(p) && norm(base).split(' ').every(t => p._s!.includes(t))).slice(0, 25);
    const pool = [...new Map([...supplied, ...ordinary].map(p => [p.id, p])).values()];
    if (!pool.length) continue;
    const offers = await fetchOffers(pool.map(p => p.id), plan.deliveryDate);
    const rows = pool.map(p => { const raw = offers.get(p.id); const qty = packsFor(toOrder, p); return { p, raw, qty, cost: raw?.price != null ? qty * raw.price : Infinity }; })
      .filter(r => r.raw?.hasAvailability && (r.raw.unknownQty || (r.raw.amount ?? 0) >= r.qty) && r.cost < (line.lineTotal ?? 0) * 0.97)
      .sort((a, b) => Number(cur.subs.includes(b.p.id)) - Number(cur.subs.includes(a.p.id)) || a.cost - b.cost).slice(0, 2);
    if (!rows.length) continue;
    const items: Alternative[] = rows.map(r => ({
      product: productView(r.p, lang), offer: toOffer(r.raw, lang, r.qty), checks: checkAll(r.p, reqs, lang), suitable: true,
      ...alternativeTier(r.p, cur, lang),
      note: tr(lang, `${r.qty} × ${num(lang, r.p.per!.v, 2)} ${r.p.per!.u} = ${eur(lang, r.cost)} · säästö ${eur(lang, (line.lineTotal ?? 0) - r.cost)}`, `${r.qty} × ${num(lang, r.p.per!.v, 2)} ${r.p.per!.u} = ${eur(lang, r.cost)} · besparing ${eur(lang, (line.lineTotal ?? 0) - r.cost)}`, `${r.qty} × ${num(lang, r.p.per!.v, 2)} ${r.p.per!.u} = ${eur(lang, r.cost)} · saves ${eur(lang, (line.lineTotal ?? 0) - r.cost)}`),
    }));
    const current: Alternative = { product: line.product, offer: line.offer, checks: line.checks, suitable: true, note: tr(lang, `Nyt: ${line.orderQty} × ${line.product.packLabel} = ${eur(lang, line.lineTotal ?? 0)}`, `Nu: ${line.orderQty} × ${line.product.packLabel} = ${eur(lang, line.lineTotal ?? 0)}`, `Now: ${line.orderQty} × ${line.product.packLabel} = ${eur(lang, line.lineTotal ?? 0)}`) };
    cards.push({
      type: 'comparison', lineId: line.id, current, items, saving: (line.lineTotal ?? 0) - rows[0].cost,
      title: tr(lang, `Halvempi vaihtoehto: ${line.ingredient}`, `Billigare alternativ: ${line.ingredient}`, `Cheaper alternative: ${line.ingredient}`),
      subtitle: reqs.length
        ? tr(lang, `Toimittajan korvaava tai sama tuoteryhmä. Vaatimukset tarkistettu: ${line.checks.map(c => c.requirementLabel).join(', ')}. Minä varmistan ruokavaliot – sinä päätät, sopiiko tuote reseptiin.`, `Leverantörens ersättare eller samma produktgrupp. Krav kontrollerade: ${line.checks.map(c => c.requirementLabel).join(', ')}. Jag säkrar kostkraven – du avgör om produkten passar receptet.`, `Supplier substitute or same product group. Requirements checked: ${line.checks.map(c => c.requirementLabel).join(', ')}. I guarantee the diets – you decide whether the product suits the recipe.`)
        : tr(lang, 'Toimittajan korvaava tai sama tuoteryhmä. Tämä rivi menee vain perusannoksiin, joten erityisruokavaliovaatimukset eivät muutu. Sinä päätät, sopiiko tuote reseptiin.', 'Leverantörens ersättare eller samma produktgrupp. Raden går bara till standardportioner, så specialkostkraven ändras inte. Du avgör om produkten passar receptet.', 'Supplier substitute or same product group. This line only serves standard portions, so no dietary requirement changes. You decide whether the product suits the recipe.'),
    });
  }
  cards.sort((a, b) => b.saving - a.saving);
  return cards.slice(0, lineId ? 1 : 3).map(({ saving: _s, ...c }) => c as Card);
}

// ---------- product search with checks (UI + MCP) ----------

export async function searchWithChecks(q: string, reqs: Requirement[], lang: Lang, date: string, limit = 8): Promise<Alternative[]> {
  const found = searchProducts(q, { limit: 30 });
  // verified products first, then by name relevance
  const ranked = found.map(p => ({ p, v: worst(checkAll(p, reqs, lang)) })).sort((a, b) => ({ ok: 0, unknown: 1, fail: 2 }[a.v] - { ok: 0, unknown: 1, fail: 2 }[b.v])).slice(0, limit);
  const offers = await fetchOffers(ranked.map(r => r.p.id), date);
  return ranked.map(({ p }) => { const checks = checkAll(p, reqs, lang); return { product: productView(p, lang), offer: toOffer(offers.get(p.id), lang), checks, suitable: allOk(checks) && !!p.per }; });
}

// ---------- menu editing by chat: line alternatives and recipe estimates (read-only, never change state) ----------

/** The recipe ingredient behind a plan line (matched by its localized name), if any. */
export const ingredientOfLine = (lang: Lang, line: PlanLine): RecipeIngredient | undefined => allIngredients().find(i => pick(lang, i.name) === line.ingredient);

/** Verified alternatives for one plan line, as a comparison card whose buttons use `swap_line` (same checks as every
 *  other alternative: every requirement of every group the line serves must be ok, a price must exist, it must be orderable). */
export async function lineAlternatives(lang: Lang, plan: Plan, lineId: string): Promise<Extract<Card, { type: 'comparison' }> | undefined> {
  const line = plan.lines.find(l => l.id === lineId);
  const cur = getProduct(lineId);
  const ing = line ? ingredientOfLine(lang, line) : undefined;
  if (!line || !cur || !ing) return undefined;
  const reqs = line.checks.map(c => c.requirement);
  const left = line.needed - line.fromStock;
  const items = await findAlternatives(ing.search, reqs, line.unit, left > 1e-6 ? left : line.needed, lang, plan.deliveryDate, [line.id], cur);
  const now = `${line.orderQty} × ${line.product.packLabel}` + (line.lineTotal != null ? ` = ${eur(lang, line.lineTotal)}` : '');
  return {
    type: 'comparison', lineId: line.id, items,
    current: { product: line.product, offer: line.offer, checks: line.checks, suitable: true, note: tr(lang, `Nyt: ${now}`, `Nu: ${now}`, `Now: ${now}`) },
    title: tr(lang, `Vaihtoehdot: ${line.ingredient}`, `Alternativ: ${line.ingredient}`, `Alternatives: ${line.ingredient}`),
    subtitle: reqs.length
      ? tr(lang, `Vaatimukset tarkistettu: ${line.checks.map(c => c.requirementLabel).join(', ')}. Minä varmistan ruokavaliot – sinä päätät, sopiiko tuote reseptiin.`, `Krav kontrollerade: ${line.checks.map(c => c.requirementLabel).join(', ')}. Jag säkrar kostkraven – du avgör om produkten passar receptet.`, `Requirements checked: ${line.checks.map(c => c.requirementLabel).join(', ')}. I guarantee the diets – you decide whether the product suits the recipe.`)
      : tr(lang, 'Tämä rivi menee vain perusannoksiin, joten erityisruokavaliovaatimukset eivät muutu. Sinä päätät, sopiiko tuote reseptiin.', 'Raden går bara till standardportioner, så specialkostkraven ändras inte. Du avgör om produkten passar receptet.', 'This line only serves standard portions, so no dietary requirement changes. You decide whether the product suits the recipe.'),
  };
}

/** What ordering one approved recipe for one menu day would look like with the current portions and diet groups. */
export interface RecipeEstimate {
  recipe: Recipe;
  /** things that would still need an answer: no verified product for a group, no price, not orderable */
  open: { allergen: number; price: number; availability: number };
  openCount: number;
  /** needs the user already left out of the order (no verified product for a diet group): nothing is ordered for them,
   *  so the recipe is not "fully ready" even though no question is open. Labels like "Leipä · Vehnätön". */
  skipped: string[];
  /** products whose order cutoff has passed in the supplier data (the order would need human approval) */
  cutoff: number;
  /** EUR excl. VAT: whole packs at the live price, for the products that have a price (no stock deduction) */
  cost: number;
  products: number;
}

/** Reads the state and the live offers; changes nothing. The same rules as buildPlan decide which product serves
 *  each diet group, so a recipe that is "orderable" here is one the plan could actually order. */
export async function estimateRecipes(recipes: Recipe[], dayKey: string, lang: Lang): Promise<RecipeEstimate[]> {
  const st = S();
  const menu = st.menu;
  if (!menu) return [];
  const day = findDay(dayKey);
  const gs = groups().filter(g => g.count > 0);
  const total = st.kitchen.portionsTotal;
  const scale = (day?.importedPortions ?? total) / total;
  const isEvent = menu.kind === 'event';
  const deliveryDate = isEvent ? addDays(menu.days[0]?.date ?? menu.weekStart, -1) : menu.weekStart;
  const parts = (r: Recipe) => (currentProfile().dailySides && !isEvent ? [r, sideRecipe()] : [r]);
  const rows = recipes.map(recipe => {
    const demand = new Map<string, number>();
    const failed = new Set<string>();
    const skipped = new Map<string, string>();
    for (const part of parts(recipe)) for (const ing of part.ingredients) for (const g of gs) {
      const c = choose(ing, g);
      if ('failedId' in c) {
        const key = `${ing.key}|${g.id}`;
        if (st.skipped.includes(key)) skipped.set(key, `${pick(lang, ing.name)} · ${groupLabel(lang, g.id)}`); else failed.add(key);
        continue;
      }
      demand.set(c.id, (demand.get(c.id) ?? 0) + (ing.amount * g.count * scale) / 1000);
    }
    return { recipe, demand, allergen: failed.size, skipped: [...skipped.values()] };
  });
  const offers = await fetchOffers([...new Set(rows.flatMap(r => [...r.demand.keys()]))], deliveryDate);
  return rows.map(({ recipe, demand, allergen, skipped }) => {
    const open = { allergen, price: 0, availability: 0 };
    let cutoff = 0, cost = 0;
    for (const [id, needed] of demand) {
      const p = getProduct(id);
      if (!p?.per) { open.price++; continue; }
      const qty = packsFor(needed, p);
      const offer = toOffer(offers.get(id), lang, qty);
      if (offer.price == null) { open.price++; continue; }
      cost += qty * offer.price;
      if (offer.availability === 'no_data' || offer.availability === 'unavailable' || offer.availability === 'limited') open.availability++;
      else if (offer.cutoffPassed) cutoff++;
    }
    return { recipe, open, openCount: open.allergen + open.price + open.availability, skipped, cutoff, cost: round2(cost), products: demand.size };
  });
}

export function stockView(lang: Lang): StockItem[] {
  return S().stock.map(s => { const p = getProduct(s.productId); return { productId: s.productId, name: p ? localName(p, lang) : s.productId, amount: s.amount, unit: p?.per?.u ?? 'kg' }; });
}
export { toAlternative };
