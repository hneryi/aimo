// Menu editing by chat: change one day's dish, recommend a dish for a day, offer alternatives for a shopping-list
// line. The model (or the keyword rules below, when there is no model) only picks the tool and its words. Which
// recipe exists, what it costs and whether it can be ordered is decided here and in planner.ts, from approved
// recipes and live supplier data. Nothing is ever invented: a dish without an approved recipe changes nothing.
import type { Card, Lang, Plan, PlanLine, RecipeChoice, Requirement, TurnResponse, Weekday } from '../../shared/types.ts';
import { requirementLabel } from './allergens.ts';
import { norm } from './catalog.ts';
import { WEEKDAYS, dayLabel, eur, tr, weekdayOf } from './i18n.ts';
import type { ToolDef } from './llm.ts';
import { buildPlan, confirmRecipe, estimateRecipes, ingredientOfLine, kitchenView, lineAlternatives, menuView } from './planner.ts';
import { type Recipe, dayRole, mainRecipes, matchRecipe, recipeById, recipeName, recipeRole, recipesForRole } from './recipes.ts';
import { type StoredDay, S } from './store.ts';
import { undoLabel, withUndo } from './undo.ts';

/** What app.ts lends this module (kept as arguments so the two files do not import each other). */
export interface MenuChatDeps {
  respond: (lang: Lang, reply: string, cards: Card[], plan?: Plan) => Promise<TurnResponse>;
  planCards: (plan: Plan | undefined, lang: Lang) => Card[];
  planReply: (plan: Plan | undefined, lang: Lang) => string;
  dietsIn: (text: string) => Requirement[];
}

// ---------- tools offered to the model ----------

const WEEKDAY_PROP = { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], description: 'weekday of the menu day, when the user names one' };
export const MENU_TOOLS: ToolDef[] = [
  { name: 'change_dish', description: 'The user wants a DIFFERENT MAIN DISH on one day of the imported menu, e.g. "can I have burgers instead of the macaroni casserole?", "saako makaronilaatikon tilalle lohikeittoa?", "vaihda maanantain ruoka lohikeittoon". The day is found from the weekday or from the dish being replaced. Never invents recipes: the code looks the dish up among the kitchen\'s approved recipes. If the user only says "something else" without naming a dish, put that in new_dish as typed.', parameters: { type: 'object', properties: { new_dish: { type: 'string', description: 'the dish the user wants instead, as typed (or "something else")' }, current_dish: { type: 'string', description: 'the dish or product being replaced, as typed' }, weekday: WEEKDAY_PROP } } },
  { name: 'recommend_dish', description: 'The user asks Aimo to recommend or suggest a dish for a menu day that can actually be ordered, e.g. "suosittele maanantaille jotain mitä on tilattavissa", "what could we serve on Tuesday?". The code picks from approved recipes and checks price and availability.', parameters: { type: 'object', properties: { weekday: WEEKDAY_PROP, current_dish: { type: 'string', description: 'the dish of that day, if the user named it instead of a weekday' } } } },
  { name: 'ingredient_alternatives', description: 'The user asks for another product for ONE ingredient of the shopping list, e.g. "saako makaronin tilalle jotain muuta?", "can I replace the rice with something else?". Not for whole dishes.', parameters: { type: 'object', required: ['ingredient'], properties: { ingredient: { type: 'string', description: 'the ingredient or product to replace, as typed' } } } },
];

// ---------- words ----------

const WEEKDAY_WORDS: [Weekday, RegExp][] = [['mon', /maanant|måndag|monday/], ['tue', /tiista|tisdag|tuesday/], ['wed', /keskiviik|onsdag|wednesday/], ['thu', /torsta|torsdag|thursday/], ['fri', /perjant|fredag|friday/], ['sat', /lauant|lördag|saturday/], ['sun', /sunnunt|söndag|sunday/]];
const weekdayIn = (text: string): Weekday | undefined => WEEKDAY_WORDS.find(([, re]) => re.test(text.toLowerCase()))?.[0];
const validWeekday = (x: unknown): Weekday | undefined => (WEEKDAYS as string[]).includes(x as string) ? x as Weekday : undefined;

/** Politeness, question and filler words plus the plain nouns for "dish". They say nothing about WHICH dish or product. */
const JOIN = new Set(['ja', 'och', 'and', 'with']);
const DROP = new Set([...JOIN, ...('saako saisiko voiko voisiko voinko voisinko saanko saisinko olisiko mahdollista vaikka ehka sitten kiitos ole hyva ruoka ruokaa ruoan ruoaksi ruuaksi ruokalaji ruokalajin ruokalajia ruokalajiksi lounas lounaan lounasta lounaaksi paiva paivan paivalle se sen tama taman tuo tuon mita jos entas saatko saisinko ' +
  'kan jag vi fa far kunde skulle vad sags om den det en ett mat maten ratt ratten dagens dag pa ha vill gora mig oss mot till ' +
  'can could may i we you have get please what about how let lets s want would like id give me us the a an my our of some to for dish meal food lunch day on is it there any possible').split(' ')]);
/** "something else": a request without a concrete target */
const VAGUE = new Set('jotain jotakin jokin jonkin muuta muu muuhun muuksi toista toinen toiseen toiseksi johonkin joksikin something anything else other another nagot nat annat nagon vaihtoehto vaihtoehtoa alternative'.split(' '));

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** the words of a phrase that name something (weekdays, diets and filler removed), normalized */
function tokens(text: string, deps: MenuChatDeps): string[] {
  return words(text).filter(w => !WEEKDAY_WORDS.some(([, re]) => re.test(w)) && !DROP.has(norm(w)) && !deps.dietsIn(w).length).map(norm).filter(w => w.length > 1);
}
const isVague = (toks: string[]) => toks.every(t => VAGUE.has(t));
/** a dish name as typed: filler removed, but "and" stays so that "pea soup and pancake" still reads as one dish */
const dishPhrase = (text: string) => words(text).filter(w => !WEEKDAY_WORDS.some(([, re]) => re.test(w)) && (JOIN.has(norm(w)) || !DROP.has(norm(w)))).join(' ');

/** A typed word refers to a dictionary word: same word, or the dictionary word plus a Finnish case ending or plural.
 *  Compounds do not count ("makaronin" is "makaroni", "makaronilaatikon" is not). Both are norm()-ed. */
export function wordMatches(token: string, word: string): boolean {
  if (token === word) return true;
  let p = 0;
  while (p < token.length && p < word.length && token[p] === word[p]) p++;
  return p >= 4 && p >= word.length - 2 && token.length - p <= 4;
}

const dn = (lang: Lang, d: StoredDay) => d.label ?? dayLabel(lang, d.date);
const entryOf = (d: StoredDay) => d.id ?? d.date;
const currentDish = (lang: Lang, d: StoredDay) => d.match === 'confirmed' ? recipeName(lang, d.recipeId) ?? d.dishName : d.match === 'custom' && d.customName ? d.customName : d.dishName;
const dayList = (lang: Lang) => S().menu!.days.map(d => `${dn(lang, d)} ${d.dishName}`).join(' · ');

// ---------- finding the day and the line ----------

/** the names a day answers to: the imported dish, the course label, the linked recipe and the kitchen's own dish */
function dayNames(d: StoredDay): string[] {
  const r = recipeById(d.recipeId);
  return [d.dishName, d.label ?? '', d.customName ?? '', ...(r ? [r.name.fi, r.name.sv, r.name.en, ...r.aliases] : [])].map(norm).filter(Boolean);
}
/** a typed word, possibly inflected, occurs in a (compound) name: "lohikeiton" in "lohikeitto". Doubled letters are
 *  collapsed on both sides so that Finnish consonant gradation (keitto → keiton) does not hide the match. */
const collapse = (s: string) => s.replace(/(.)\1/g, '$1');
const nameHas = (name: string, t: string) => {
  const plain = collapse(name);
  return [t, t.slice(0, -1), t.slice(0, -2)].some((s, i) => (i === 0 || s.length >= 5) && s.length > 2 && (name.includes(s) || plain.includes(collapse(s))));
};

function daysMatching(term: string, deps: MenuChatDeps): StoredDay[] {
  const toks = tokens(term, deps);
  if (!toks.length) return [];
  return (S().menu?.days ?? []).filter(d => { const names = dayNames(d); return toks.every(t => names.some(n => nameHas(n, t))); });
}

/** the diet groups a request names: from the user's own words and from the term the model passed on */
const dietsOf = (term: string, original: string, deps: MenuChatDeps): Requirement[] => [...new Set([...deps.dietsIn(original.toLowerCase()), ...deps.dietsIn(term.toLowerCase())])];

/** Lines whose name fits the term and that serve EVERY requested diet group ("wheat-free macaroni" never lands on the
 *  standard line). When no line serves them the result is empty: the caller asks instead of showing another group's products. */
function linesMatching(plan: Plan, lang: Lang, term: string, reqs: Requirement[], deps: MenuChatDeps): PlanLine[] {
  const toks = tokens(term, deps);
  if (!toks.length) return [];
  return plan.lines.filter(l => {
    const ing = ingredientOfLine(lang, l);
    const ws = norm([l.ingredient, ing?.name.fi, ing?.name.sv, ing?.name.en, l.product.name].filter(Boolean).join(' ')).split(' ');
    return toks.every(t => ws.some(w => wordMatches(t, w))) && reqs.every(r => l.checks.some(c => c.requirement === r));
  });
}

// ---------- refusals: "do not change Monday's dish" never changes anything ----------

const bounded = (s: string) => new RegExp(`(?<![\\p{L}])(?:${s})(?![\\p{L}])`, 'u');
const NOT_CHANGE: RegExp[] = [
  // Finnish: "älä vaihda …", "älä muuta …", "ei saa / tarvitse vaihtaa …", "ei vaihdeta …", "en vaihda …"
  bounded('(?:älä|älkää)\\s+(?:\\p{L}+\\s+){0,2}?(?:vaihda|vaihtaa|vaihdeta|vaihtamaan|vaihtako|korvaa|korvata|korvataan|muuttaa|muuttamaan)'),
  bounded('(?:älä|älkää)\\s+muuta'),
  bounded('(?:ei|en|emme)\\s+(?:saa|tarvitse|kannata|halua|haluaisi|haluta|pidä|pitäisi|voi)\\s+(?:\\p{L}+\\s+){0,2}?(?:vaihtaa|vaihtamaan|korvata|muuttaa|muuttamaan)'),
  bounded('(?:ei|en|emme)\\s+(?:vaihda|vaihdeta|korvaa|korvata|muuttaa)'),
  // English: "do not change …", "don't replace …", "no need to swap …", "I would rather not switch …"
  bounded('(?:not|dont|never|no need to)\\s+(?:(?:to|want|wish|need|you|me|us|we|i|ever|yet|please|just|now|really|go|ahead|and)\\s+)*(?:change|replace|swap|switch|substitute|alter)'),
  // Swedish: "byt inte …", "ändra inte …", "vi vill inte byta …", "låt bli att byta …"
  bounded('(?:byt|byta|ändra|ändrar|ersätt|ersätta|ersätter)\\s+(?:inte|ej)'),
  bounded('(?:inte|ej|aldrig)\\s+(?:(?:att|vill|ska|bör|måste|får|behöver|du|vi|jag|ens|gärna|nu|alls|verkligen)\\s+)*(?:byta|byt|ändra|ersätta|ersätt)'),
  bounded('låt\\s+bli\\s+att\\s+(?:byta|ändra|ersätta)'),
];
/** A clear "do not change / replace" in fi/sv/en. Deliberately narrow: only these phrasings, so nothing else is held back. */
export const refusesChange = (message: string): boolean => { const m = message.toLowerCase().replace(/['’`´]/g, ''); return NOT_CHANGE.some(re => re.test(m)); };

// ---------- keyword rules (no model) ----------

type Intent = { name: string; args: Record<string, any> };
const LEADS = 'saako|saisiko|voiko|voisiko|voinko|voisinko|saanko|olisiko|mahdollista|entä|mitä jos|kan jag få|kan vi få|får jag|får vi|kan vi ha|vad sägs om|can i have|can we have|could we have|could i have|may i have|can i get|can we get|what about|how about|i want|i would like|i\'d like|give me';

/** Keyword reading of "X tilalle Y", "vaihda maanantain ruoka …", "suosittele maanantaille …" in fi/sv/en. Matches only those
 *  phrasings, so nothing the chat did before is taken over. Returns the tool and its arguments, like the model would. */
export function menuEditIntent(message: string): Intent | undefined {
  const m = message.toLowerCase().replace(/[“”"„']/g, '').trim().replace(/[?!.\s]+$/, '');
  if (!m || m.length > 400) return undefined;
  if (refusesChange(message)) return { name: 'change_dish', args: { refused: true } };
  const wd = weekdayIn(m);
  const lead = (s: string) => s.replace(new RegExp(`\\b(?:${LEADS})\\b`, 'g'), ' ');
  const make = (nw: string, old: string, extra: Record<string, unknown> = {}): Intent => ({ name: 'change_dish', args: { new_dish: nw.trim(), current_dish: old.trim(), weekday: wd, ...extra } });
  let x: RegExpMatchArray | null;
  // Finnish: "<old> tilalle <new>"
  if ((x = m.match(/^(.*?)\btilalle\b\s*(.*)$/s))) return make(lead(x[2]), lead(x[1]));
  // English / Swedish: "<new> instead of <old>"
  if ((x = m.match(/^(.*?)\b(?:instead of|in place of|rather than|i stället för|istället för)\b\s*(.*)$/s))) return make(lead(x[1]), lead(x[2]));
  const plain = !/\d/.test(m);
  const vagueNew = (s: string) => isVague(tokens(s, NO_DIETS));
  // English: "replace <old> with <new>", "change Monday's dish to <new>"
  if (plain && (x = m.match(/\b(?:replace|swap|substitute|change|switch)\s+(?:out\s+)?(.*?)\s+(?:with|for|to|into|by)\s+(.*)$/s)) && (wd || /\b(?:dish|meal|food)\b/.test(x[1]) || vagueNew(x[2]) || daysMatching(x[1], NO_DIETS).length)) return make(lead(x[2]), lead(x[1]));
  // Swedish: "byt <old> mot <new>"
  if (plain && (x = m.match(/\b(?:byt|byta|ersätt|ersätta|ändra)\s+(.*?)\s+(?:mot|till|med|på)\s+(.*)$/s)) && (wd || /\b(?:rätt|rätten|maten)\b/.test(x[1]) || vagueNew(x[2]) || daysMatching(x[1], NO_DIETS).length)) return make(lead(x[2]), lead(x[1]));
  // Finnish: "vaihda maanantain ruoka lohikeittoon", "vaihda makaronilaatikko lohikeittoon", "vaihda makaroni johonkin muuhun"
  if (plain && (x = m.match(/\b(?:vaihda|vaihdetaan|vaihtaa|vaihtaisi\w*|korvaa|korvataan|muuta)\b\s*(.*)$/s))) {
    const rest = lead(x[1]);
    if (wd) return make(rest, '');
    if (/ruoka|ruoan|ruokalaji|ruuaksi|ruoaksi|johonkin|joksikin|muuhun|muuksi/.test(rest) || daysMatching(rest.split(/\s+/)[0] ?? '', NO_DIETS).length) return make(rest, '', { split: true });
  }
  // "suosittele maanantaille jotain mitä on tilattavissa"
  if (/suosit|ehdota|recommend|suggest|föreslå|föreslår|rekommender/.test(m) && (wd || /ruoka|ruokaa|ruokalaji|lounas|\bdish|\bmeal|\blunch|\brätt|\bmat\b/.test(m))) return { name: 'recommend_dish', args: { weekday: wd } };
  return undefined;
}
const NO_DIETS: MenuChatDeps = { respond: () => Promise.reject(), planCards: () => [], planReply: () => '', dietsIn: () => [] };

// ---------- the tools ----------

const noMenu = (lang: Lang) => tr(lang, 'Tilillä ei ole ruokalistaa, joten ei ole mitään vaihdettavaa. Tuo ensin ruokalista (Excel, PDF tai kirjoita se tähän) tai kokeile esimerkkilistaa.', 'Kontot har ingen matsedel, så det finns inget att byta. Importera först en matsedel (Excel, PDF eller skriv den här) eller prova exempellistan.', 'This account has no menu, so there is nothing to change. Import a menu first (Excel, PDF or type it here) or try the sample menu.');

const notChanged = (lang: Lang) => tr(lang, 'Selvä, en vaihtanut mitään. Ruokalista ja ostoslista pysyvät ennallaan.', 'Uppfattat, jag bytte ingenting. Matsedeln och inköpslistan är oförändrade.', 'Understood, I changed nothing. The menu and the shopping list stay as they are.');

export async function runMenuTool(name: string, args: Record<string, any>, lang: Lang, original: string, deps: MenuChatDeps): Promise<TurnResponse> {
  // "do not change …": answered whatever tool the model picked, and nothing (state, log) is touched
  if (name === 'change_dish' && refusesChange(original)) return deps.respond(lang, notChanged(lang), []);
  if (!S().menu) return deps.respond(lang, noMenu(lang), []);
  // the model's words win; the keyword reading fills in what it left out
  const kw = menuEditIntent(original)?.args ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const wd = validWeekday(args.weekday) ?? validWeekday(kw.weekday) ?? weekdayIn(original);
  const old = str(args.current_dish) || str(args.ingredient) || str(kw.current_dish);
  if (name === 'recommend_dish') return recommend(lang, wd, old, deps);
  if (name === 'ingredient_alternatives') return vague(lang, wd, old, original, deps);
  let nw = str(args.new_dish) || str(kw.new_dish);
  let from = old;
  if (kw.split && !str(args.current_dish) && !wd) {
    // "vaihda makaronilaatikko lohikeittoon": the longest leading part that names a menu day (or says "something else" about a line) is the old dish
    const parts = nw.split(/\s+/);
    for (let k = parts.length - 1; k >= 1; k--) {
      const head = parts.slice(0, k).join(' '), tail = parts.slice(k).join(' ');
      if (daysMatching(head, deps).length && tokens(tail, deps).length) { from = head; nw = tail; break; }
    }
  }
  const nwTokens = tokens(nw, deps);
  if (!nwTokens.length || isVague(nwTokens)) return vague(lang, wd, from, original, deps);
  return changeDish(lang, wd, from, dishPhrase(nw), deps);
}

/** the menu days a request points at: by weekday, by the dish being replaced, or both */
function pickDays(wd: Weekday | undefined, old: string, deps: MenuChatDeps): StoredDay[] {
  const days = S().menu!.days;
  const byName = old ? daysMatching(old, deps) : [];
  if (wd) { const byDay = days.filter(d => weekdayOf(d.date) === wd); const both = byDay.filter(d => byName.includes(d)); return both.length ? both : byDay; }
  if (byName.length) return byName;
  return old ? [] : days.length === 1 ? days : [];
}

function whichDay(lang: Lang, found: StoredDay[], what: string): string {
  const list = (found.length ? found : S().menu!.days).map(d => `${dn(lang, d)} ${currentDish(lang, d)}`).join(' · ');
  return found.length > 1
    ? tr(lang, `Mikä päivä tarkoitetaan? ${list}. Kerro viikonpäivä, niin jatkan.`, `Vilken dag menar du? ${list}. Säg veckodagen så fortsätter jag.`, `Which day do you mean? ${list}. Tell me the weekday and I will continue.`)
    : what
      ? tr(lang, `En löytänyt ruokalistalta päivää tai ruokalajia ”${what}”. Ruokalistalla: ${list}.`, `Jag hittade ingen dag eller rätt ”${what}” på matsedeln. På matsedeln: ${list}.`, `I found no day or dish “${what}” on the menu. On the menu: ${list}.`)
      : tr(lang, `Minkä päivän ruokaa tarkoitat? ${list}. Kerro viikonpäivä, niin jatkan.`, `Vilken dags mat menar du? ${list}. Säg veckodagen så fortsätter jag.`, `Which day do you mean? ${list}. Tell me the weekday and I will continue.`);
}

// --- C1: change the dish of one day ---

/** the typed dish, with Finnish case endings removed word by word ("lohikeittoa" → "lohikeitto"), tried against the recipe book */
function lookUp(phrase: string, candidates: Recipe[]): { recipe?: Recipe; confidence: 'exact' | 'close' | 'none' } {
  const variants = new Set([phrase]);
  for (const e of ['a', 'ä', 'n', 'ta', 'tä', 'ksi', 'on', 'lle', 'ssa', 'ssä', 'sta', 'stä', 'na', 'nä', 't', 'en']) variants.add(phrase.split(' ').map(w => (w.length > e.length + 3 && w.endsWith(e) ? w.slice(0, -e.length) : w)).join(' '));
  let best: ReturnType<typeof matchRecipe> = { confidence: 'none', score: 0 };
  for (const v of variants) {
    const r = matchRecipe(v, candidates);
    if (r.confidence === 'exact') return { recipe: r.recipe, confidence: 'exact' };
    if (r.confidence === 'close' && r.score > best.score) best = r;
  }
  return { recipe: best.recipe, confidence: best.confidence };
}

async function changeDish(lang: Lang, wd: Weekday | undefined, old: string, phrase: string, deps: MenuChatDeps): Promise<TurnResponse> {
  const found = pickDays(wd, old, deps);
  if (found.length !== 1) return deps.respond(lang, whichDay(lang, found, old), []);
  const day = found[0];
  const when = dn(lang, day);
  const role = dayRole(S().menu?.kind, day);
  if (!role) return deps.respond(lang, tr(lang, 'Valitse ensin ruokalajin rooli ruokalistalta.', 'Välj först rättens roll på matsedeln.', 'Choose the course role on the menu first.'), []);
  const candidates = recipesForRole(role);
  const anyHit = lookUp(phrase, mainRecipes());
  if (anyHit.confidence === 'exact' && anyHit.recipe && recipeRole(anyHit.recipe) !== role) {
    return deps.respond(lang, tr(lang, `Resepti ${recipeName(lang, anyHit.recipe.id)} on hyväksytty, mutta ei sovi tämän rivin rooliin. Mitään ei vaihdettu.`, `Receptet ${recipeName(lang, anyHit.recipe.id)} är godkänt, men passar inte radens roll. Inget byttes.`, `The recipe ${recipeName(lang, anyHit.recipe.id)} is approved, but does not match this course role. Nothing was changed.`), []);
  }
  const hit = lookUp(phrase, candidates);
  if (hit.confidence === 'exact' && hit.recipe) {
    const r = hit.recipe;
    if (day.match === 'confirmed' && day.recipeId === r.id) {
      return deps.respond(lang, tr(lang, `${when}: ruokalajina on jo ${recipeName('fi', r.id)}. Mitään ei vaihdettu.`, `${when}: rätten är redan ${recipeName('sv', r.id)}. Inget byttes.`, `${when} already has ${recipeName('en', r.id)}. Nothing was changed.`), []);
    }
    const was = currentDish(lang, day);
    // same path as the "Change recipe" button: the stack is filled before the change, the plan is recalculated
    await withUndo(() => undoLabel({ type: 'confirm_recipe', date: entryOf(day), recipeId: r.id }), () => confirmRecipe(entryOf(day), r.id));
    const plan = await buildPlan(lang);
    const head = tr(lang, `Vaihdoin ${when}: ”${was}” → ${recipeName('fi', r.id)}. Ostoslista on laskettu uudelleen. Voit kumota muutoksen Kumoa-painikkeella.`, `Jag bytte ${when}: ”${was}” → ${recipeName('sv', r.id)}. Inköpslistan är omräknad. Du kan ångra ändringen med Ångra-knappen.`, `I changed ${when}: “${was}” → ${recipeName('en', r.id)}. The shopping list is recalculated. You can take the change back with Undo.`);
    return deps.respond(lang, `${head} ${deps.planReply(plan, lang)}`, [{ type: 'menu', menu: menuView(lang)! }, ...deps.planCards(plan, lang)], plan);
  }
  if (hit.confidence === 'close' && hit.recipe) {
    const r = hit.recipe;
    const why = tr(lang, `Lähin hyväksytty resepti ruokalajille ”${phrase}”. Se ei ole täsmälleen sama ruokalaji, joten vahvista valinta.`, `Närmaste godkända recept för ”${phrase}”. Det är inte exakt samma rätt, så bekräfta valet.`, `The closest approved recipe for “${phrase}”. It is not exactly the same dish, so please confirm.`);
    return deps.respond(lang, tr(lang, `Ruokalajille ”${phrase}” ei ole täsmällistä hyväksyttyä reseptiä. Lähin on ${recipeName('fi', r.id)}. En vaihda mitään ennen kuin vahvistat.`, `Det finns inget exakt godkänt recept för ”${phrase}”. Närmast är ${recipeName('sv', r.id)}. Jag byter ingenting innan du bekräftar.`, `There is no exact approved recipe for “${phrase}”. The closest is ${recipeName('en', r.id)}. I will not change anything until you confirm.`),
      [{ type: 'note', tone: 'info', title: tr(lang, `${when}: vaihdetaanko?`, `${when}: byta?`, `${when}: switch?`), text: tr(lang, `Nyt: ”${currentDish(lang, day)}”.`, `Nu: ”${currentDish(lang, day)}”.`, `Now: “${currentDish(lang, day)}”.`), recipeChoices: { date: entryOf(day), options: [{ recipeId: r.id, recipeName: recipeName(lang, r.id)!, why }] } }]);
  }
  const list = candidates.map(r => recipeName(lang, r.id)).join(', ');
  return deps.respond(lang,
    tr(lang, `Ruokalajille ”${phrase}” ei ole keittiön hyväksyttyä reseptiä, joten en vaihda mitään enkä keksi reseptiä tai määriä. Hyväksytyt reseptit: ${list}. Raaka-aineita voi etsiä erikseen, esimerkiksi ”Etsi raaka-aineet ruokalajille ”${phrase}””.`,
      `Det finns inget av köket godkänt recept för ”${phrase}”, så jag byter ingenting och hittar inte på recept eller mängder. Godkända recept: ${list}. Ingredienser kan sökas separat, till exempel ”Hitta ingredienser till ”${phrase}””.`,
      `The kitchen has no approved recipe for “${phrase}”, so I changed nothing and will not make up a recipe or amounts. Approved recipes: ${list}. Ingredients can be searched separately, for example “Find ingredients for “${phrase}””.`),
    []);
}

// --- C3 (and C2 when the words name a dish): "something else instead of X" ---

async function vague(lang: Lang, wd: Weekday | undefined, old: string, original: string, deps: MenuChatDeps): Promise<TurnResponse> {
  if (tokens(old, deps).length) {
    const plan = await buildPlan(lang);
    const reqs = dietsOf(old, original, deps);
    const lines = plan ? linesMatching(plan, lang, old, reqs, deps) : [];
    if (plan && lines.length === 1) return alternativesFor(lang, plan, lines[0], deps);
    if (plan && lines.length > 1) {
      const list = lines.map(l => `${l.product.name}${l.groupLabels.length ? ` (${l.groupLabels.join(', ')})` : ''}`).join(' · ');
      return deps.respond(lang, tr(lang, `”${old}” löytyy ostoslistalta useammalta riviltä: ${list}. Kerro tarkemmin, minkä tuotteen haluat vaihtaa (esimerkiksi ruokavalio tai tuotteen nimi).`, `”${old}” finns på flera rader i inköpslistan: ${list}. Säg vilken produkt du vill byta (till exempel kost eller produktnamn).`, `“${old}” appears on several lines of the shopping list: ${list}. Tell me which product you want to replace (for example the diet or the product name).`), [], plan);
    }
    // the name fits but no line serves the requested diet group (for example no such portions are set): ask, show nothing as verified
    const byName = plan && reqs.length ? linesMatching(plan, lang, old, [], deps) : [];
    if (plan && byName.length) {
      const diets = reqs.map(r => requirementLabel(lang, r).toLowerCase()).join(' + ');
      const list = byName.map(l => `${l.product.name}${l.groupLabels.length ? ` (${l.groupLabels.join(', ')})` : ''}`).join(' · ');
      return deps.respond(lang, tr(lang, `Ostoslistalla ei ole riviä ”${old}”, joka palvelisi ruokavaliota ${diets}. Nimellä löytyy: ${list}. En näytä muille ruokavalioille tarkistettuja tuotteita enkä muuttanut mitään. Kerro tarkemmin, minkä rivin haluat vaihtaa, tai vahvista ensin annosmäärät ja erityisruokavaliot (esimerkiksi ”350 lounasta, joista 20 gluteenitonta”).`, `Inköpslistan har ingen rad ”${old}” som tjänar kosten ${diets}. Med namnet finns: ${list}. Jag visar inga produkter som kontrollerats för andra kostgrupper och ändrade ingenting. Säg vilken rad du vill byta, eller bekräfta först portionsantal och specialkost (till exempel ”350 luncher, varav 20 glutenfria”).`, `The shopping list has no line “${old}” that serves ${diets}. Found by name: ${list}. I show no products checked for other diet groups and changed nothing. Tell me which line you want to replace, or confirm the portions and special diets first (for example “350 lunches, including 20 gluten-free”).`), [], plan);
    }
    // no line: perhaps the words name a dish ("makaronilaatikon tilalle jotain muuta") → recommend for that day
    const days = pickDays(wd, old, deps);
    if (days.length === 1) return recommend(lang, wd, old, deps);
    if (days.length > 1) return deps.respond(lang, whichDay(lang, days, old), []);
    const names = plan ? [...new Set(plan.lines.map(l => l.ingredient))].slice(0, 12).join(', ') : '';
    return deps.respond(lang, plan?.lines.length
      ? tr(lang, `En löytänyt ostoslistalta riviä ”${old}”. Rivit: ${names}.`, `Jag hittade ingen rad ”${old}” i inköpslistan. Rader: ${names}.`, `I found no line “${old}” on the shopping list. Lines: ${names}.`)
      : tr(lang, `Ostoslistalla ei ole vielä rivejä, joten ”${old}” ei löydy. Vahvista ensin ruokalistan reseptit ja annosmäärät.`, `Inköpslistan har inga rader än, så ”${old}” hittas inte. Bekräfta först matsedelns recept och portionsantal.`, `The shopping list has no lines yet, so “${old}” cannot be found. Confirm the menu’s recipes and the portions first.`), plan ? [{ type: 'plan', plan }] : [], plan);
  }
  return recommend(lang, wd, '', deps);
}

async function alternativesFor(lang: Lang, plan: Plan, line: PlanLine, deps: MenuChatDeps): Promise<TurnResponse> {
  const card = await lineAlternatives(lang, plan, line.id);
  if (!card) return deps.respond(lang, tr(lang, `Riville ${line.ingredient} ei voi hakea vaihtoehtoja.`, `Inga alternativ kan sökas för raden ${line.ingredient}.`, `Alternatives cannot be searched for the line ${line.ingredient}.`), [], plan);
  if (!card.items.length) return deps.respond(lang, tr(lang, `En löytänyt tarkistettua, tilattavaa vaihtoehtoa tuotteelle ${line.product.name}. Nykyinen valinta pysyy.`, `Jag hittade inget verifierat, beställningsbart alternativ för ${line.product.name}. Nuvarande val står kvar.`, `I found no verified, orderable alternative for ${line.product.name}. The current choice stays.`), [card], plan);
  return deps.respond(lang, tr(lang, `Löysin ${card.items.length} tarkistettua vaihtoehtoa riville ${line.ingredient}. Mitään ei ole vaihdettu: valitse tuote, jos haluat vaihtaa. Muutoksen voi kumota.`, `Jag hittade ${card.items.length} verifierade alternativ för raden ${line.ingredient}. Inget är bytt: välj en produkt om du vill byta. Ändringen kan ångras.`, `I found ${card.items.length} verified alternatives for the line ${line.ingredient}. Nothing is changed: pick a product if you want to switch. The change can be undone.`), [card], plan);
}

// --- C2: recommend a dish for a day ---

const portionsText = (lang: Lang) => { const k = kitchenView(lang); return `${k.portionsTotal} ${k.portionLabel}${k.groups.map(g => `, ${g.count} ${g.label.toLowerCase()}`).join('')}`; };

/** Counts only: reads state and live offers, writes nothing. */
async function recommend(lang: Lang, wd: Weekday | undefined, old: string, deps: MenuChatDeps): Promise<TurnResponse> {
  const menu = S().menu!;
  const found = pickDays(wd, old, deps);
  if (found.length !== 1) return deps.respond(lang, whichDay(lang, found, old), []);
  const day = found[0];
  const when = dn(lang, day);
  const role = dayRole(menu.kind, day);
  if (!role) return deps.respond(lang, tr(lang, 'Valitse ensin ruokalajin rooli ruokalistalta.', 'Välj först rättens roll på matsedeln.', 'Choose the course role on the menu first.'), []);
  const used = new Set(menu.days.filter(d => d.match === 'confirmed' && d.recipeId).map(d => d.recipeId));
  const pool = recipesForRole(role).filter(r => !used.has(r.id));
  if (!pool.length) return deps.respond(lang, tr(lang, 'Muita tämän roolin hyväksyttyjä reseptejä ei ole. Voit hakea raaka-aineita tai tuotteita erikseen.', 'Det finns inga andra godkända recept för rollen. Du kan söka ingredienser eller produkter separat.', 'There are no other approved recipes for this role. You can search for ingredients or products separately.'), []);
  const gaps = (e: { openCount: number; skipped: string[] }) => e.openCount + e.skipped.length;
  const rows = (await estimateRecipes(pool, entryOf(day), lang)).sort((a, b) => gaps(a) - gaps(b) || a.cost - b.cost).slice(0, 3);
  const options: RecipeChoice[] = rows.map(e => {
    const o = e.open;
    const issues = [
      o.allergen ? tr(lang, `${o.allergen} tuotetta ei sovi ruokavalioryhmälle tai tieto puuttuu`, `${o.allergen} produkter passar inte en kostgrupp eller uppgift saknas`, `${o.allergen} products do not suit a diet group or data is missing`) : '',
      o.price ? tr(lang, `${o.price} tuotteelta puuttuu hinta`, `${o.price} produkter saknar pris`, `${o.price} products have no price`) : '',
      o.availability ? tr(lang, `${o.availability} tuotetta ei ole saatavilla`, `${o.availability} produkter är inte tillgängliga`, `${o.availability} products are not available`) : '',
    ].filter(Boolean).join('; ');
    return {
      recipeId: e.recipe.id, recipeName: recipeName(lang, e.recipe.id)!,
      why: [
        e.openCount === 0 && !e.skipped.length
          ? tr(lang, 'Päivän raaka-aineille löytyy tarkistettu tuote kaikille annosryhmille, ja hinnat ja saatavuus löytyvät. Ei ratkaistavia asioita päivän osalta.', 'För dagens råvaror finns en verifierad produkt för alla portionsgrupper, och priser och tillgänglighet finns. Inget att lösa för dagen.', 'For the day’s ingredients every portion group has a verified product, and prices and availability are found. Nothing to resolve for the day.')
          : e.openCount
            ? tr(lang, `${e.openCount} asiaa jäisi ratkaistavaksi: ${issues}.`, `${e.openCount} saker skulle återstå att lösa: ${issues}.`, `${e.openCount} items would be left to resolve: ${issues}.`)
            : tr(lang, 'Muille päivän raaka-aineille löytyy tarkistettu tuote, hinta ja saatavuus.', 'För dagens övriga råvaror finns verifierad produkt, pris och tillgänglighet.', 'For the day’s other ingredients a verified product, price and availability are found.'),
        e.skipped.length ? tr(lang, `Aiemmin pois jätetyt tarpeet (${e.skipped.join(', ')}): niille ei tilata mitään, joten resepti ei ole täysin valmis. Hoida ne erikseen.`, `Tidigare utelämnade behov (${e.skipped.join(', ')}): inget beställs för dem, så receptet är inte helt klart. Sköt dem separat.`, `Needs left out earlier (${e.skipped.join(', ')}): nothing is ordered for them, so the recipe is not fully ready. Handle them separately.`) : '',
      ].filter(Boolean).join(' '),
      facts: [
        tr(lang, `Päivän arvioitu hinta noin ${eur(lang, e.cost)} (alv 0 %, kokonaisia pakkauksia, ei varastovähennystä)`, `Dagens beräknade pris cirka ${eur(lang, e.cost)} (moms 0 %, hela förpackningar, utan lageravdrag)`, `Estimated price for the day about ${eur(lang, e.cost)} (excl. VAT, whole packs, no stock deduction)`),
        ...(e.cutoff ? [tr(lang, `${e.cutoff} tuotteen tilausaika on mock-datassa ohi: tilaus vaatisi hyväksynnän`, `Beställningstiden har gått ut för ${e.cutoff} produkter i mock-datan: ordern kräver godkännande`, `The order cutoff has passed for ${e.cutoff} products in the mock data: the order would need approval`)] : []),
      ],
    };
  });
  const ok = rows.filter(e => gaps(e) === 0).length;
  const scope = tr(lang, 'Arvio koskee vain tämän päivän raaka-aineita: koko viikon saatavuus ja tilausvaltuus tarkistetaan erikseen suunnitelmassa ja tilauksessa.', 'Bedömningen gäller bara dagens råvaror: veckans hela tillgänglighet och beställningsbehörigheten kontrolleras separat i planen och ordern.', 'The estimate covers only this day’s ingredients: availability for the whole week and the ordering authority are checked separately in the plan and the order.');
  const head = tr(lang, `Suosittelen ${when} ${options.length} tähän ruokalajin rooliin sopivaa hyväksyttyä reseptiä nykyisillä annosmäärillä (${portionsText(lang)}). ${ok ? `${ok} niistä on päivän raaka-aineiden osalta valmis.` : 'Yhdenkään päivän raaka-aineet eivät ole täysin valmiit, joten kerron mitä jäisi ratkaistavaksi tai on jätetty pois.'} ${scope} Mitään ei ole vaihdettu: valitse painikkeella, niin lasken ostoslistan uudelleen. Valinnan voi kumota.`,
    `Jag rekommenderar ${options.length} godkända recept för rättens roll för ${when} med nuvarande portionsantal (${portionsText(lang)}). ${ok ? `${ok} av dem är klara när det gäller dagens råvaror.` : 'Inget av dem har helt klara råvaror för dagen, så jag säger vad som återstår att lösa eller utelämnats.'} ${scope} Inget är ändrat: välj med knappen så räknar jag om inköpslistan. Valet kan ångras.`,
    `I recommend ${options.length} approved recipes for this course role for ${when} with the current portions (${portionsText(lang)}). ${ok ? `${ok} of them are ready as far as the day’s ingredients go.` : 'None has fully ready ingredients for the day, so I say what would be left to resolve or has been left out.'} ${scope} Nothing is changed: pick one with the button and I recalculate the shopping list. The choice can be undone.`);
  return deps.respond(lang, head, [{ type: 'note', tone: 'info', title: tr(lang, `Suositukset: ${when}`, `Rekommendationer: ${when}`, `Recommendations: ${when}`), text: tr(lang, `Nyt: ”${currentDish(lang, day)}”. Hinnat ja saatavuus haettu Valio Aimon mock-rajapinnasta.`, `Nu: ”${currentDish(lang, day)}”. Priser och tillgänglighet från Valio Aimos mock-API.`, `Now: “${currentDish(lang, day)}”. Prices and availability from the Valio Aimo mock API.`), recipeChoices: { date: entryOf(day), options } }]);
}
