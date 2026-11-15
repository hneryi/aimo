// Deterministic allergen rules. No AI is involved in a verdict: the inputs are the supplier's
// declared allergens, the supplier's ingredient list and regulated label claims from the
// Valio Aimo challenge catalog. Missing or conflicting data yields "unknown", never "ok".
import type { AllergenCheck, Evidence, Lang, Requirement, Verdict } from '../../shared/types.ts';
import type { CatalogProduct } from './catalog.ts';
import { tr } from './i18n.ts';

export const REQUIREMENTS: Requirement[] = [
  'gluten_free', 'wheat_free', 'lactose_free', 'milk_free', 'egg_free', 'nut_free', 'soy_free', 'fish_free',
];

export function requirementLabel(lang: Lang, r: Requirement): string {
  const m: Record<Requirement, [string, string, string]> = {
    gluten_free: ['Gluteeniton', 'Glutenfri', 'Gluten-free'],
    wheat_free: ['Vehnätön', 'Vetefri', 'Wheat-free'],
    lactose_free: ['Laktoositon', 'Laktosfri', 'Lactose-free'],
    milk_free: ['Maidoton', 'Mjölkfri', 'Milk-free'],
    egg_free: ['Munaton', 'Äggfri', 'Egg-free'],
    nut_free: ['Pähkinätön', 'Nötfri', 'Nut-free'],
    soy_free: ['Soijaton', 'Sojafri', 'Soy-free'],
    fish_free: ['Kalaton', 'Fiskfri', 'Fish-free'],
  };
  return tr(lang, ...m[r]);
}

const ALLERGEN_NAMES: Record<string, [string, string, string]> = {
  AW: ['gluteenia sisältävät viljat', 'spannmål som innehåller gluten', 'cereals containing gluten'],
  UW: ['vehnä', 'vete', 'wheat'], NR: ['ruis', 'råg', 'rye'], GB: ['ohra', 'korn', 'barley'],
  GO: ['kaura', 'havre', 'oats'], GS: ['speltti', 'spelt', 'spelt'], GK: ['kamut-vehnä', 'kamutvete', 'kamut wheat'],
  AM: ['maito', 'mjölk', 'milk'], ML: ['laktoosi', 'laktos', 'lactose'], AE: ['kananmuna', 'ägg', 'egg'],
  AF: ['kala', 'fisk', 'fish'], AC: ['äyriäiset', 'kräftdjur', 'crustaceans'], UM: ['nilviäiset', 'blötdjur', 'molluscs'],
  AN: ['pähkinät', 'nötter', 'tree nuts'], AP: ['maapähkinä', 'jordnöt', 'peanut'], AS: ['seesami', 'sesam', 'sesame'],
  AY: ['soija', 'soja', 'soy'], AU: ['sulfiitit', 'sulfiter', 'sulphites'], BC: ['selleri', 'selleri', 'celery'],
  BM: ['sinappi', 'senap', 'mustard'], NL: ['lupiini', 'lupin', 'lupin'], SA: ['manteli', 'mandel', 'almond'],
  SH: ['hasselpähkinä', 'hasselnöt', 'hazelnut'], SW: ['saksanpähkinä', 'valnöt', 'walnut'],
  SC: ['cashewpähkinä', 'cashewnöt', 'cashew'], SP: ['pekaanipähkinä', 'pekannöt', 'pecan'],
  SR: ['parapähkinä', 'paranöt', 'brazil nut'], ST: ['pistaasi', 'pistasch', 'pistachio'],
  SM: ['macadamiapähkinä', 'macadamianöt', 'macadamia'], NM: ['maissi', 'majs', 'maize'],
};
export function allergenName(lang: Lang, code: string): string {
  const n = ALLERGEN_NAMES[code];
  return n ? tr(lang, ...n) : code;
}

const CLAIM_NAMES: Record<string, [string, string, string]> = {
  FREE_FROM_GLUTEN: ['Gluteeniton', 'Glutenfri', 'Gluten-free'],
  FREE_FROM_WHEAT: ['Vehnätön', 'Vetefri', 'Wheat-free'],
  FREE_FROM_LACTOSE: ['Laktoositon', 'Laktosfri', 'Lactose-free'],
  LOW_LACTOSE: ['Vähälaktoosinen', 'Låglaktos', 'Low-lactose'],
  FREE_FROM_EGGS: ['Munaton', 'Äggfri', 'Egg-free'],
  FREE_FROM_SOY: ['Soijaton', 'Sojafri', 'Soy-free'],
  VEGAN: ['Vegaaninen', 'Vegansk', 'Vegan'],
  VEGETARIAN: ['Kasvis', 'Vegetarisk', 'Vegetarian'],
};
export function claimName(lang: Lang, id: string): string | undefined {
  const n = CLAIM_NAMES[id];
  return n ? tr(lang, ...n) : undefined;
}

// ---------- ingredient text scanning ----------

interface TextRule { hit: RegExp; exclude?: RegExp }

const TEXT_RULES: Record<string, TextRule> = {
  wheat: {
    hit: /vehnä|wheat|(?<![a-zåäö])vete|durumvete|kornsvete|dinkelvete|spelt|durum|kamut|mannasuurim|semolina|couscous|kuskus|bulgur|seitan/gi,
    exclude: /vehnät[öo]n|vehnättö\w*|buckwheat|bovete\w*|wheat[- ]free|vetefri/gi,
  },
  gluten: {
    hit: /vehnä|wheat|(?<![a-zåäö])vete|durumvete|kornsvete|dinkelvete|spelt|durum|kamut|mannasuurim|semolina|couscous|kuskus|bulgur|seitan|ruis|rukii|\brye\b|råg|ohra|barley|\bkorn|kaura|\boat|havre|mallas|maltaa|\bmalt|gluteeni(?!ton)|gluten(?![- ]?fr)/gi,
    exclude: /vehnät[öo]n|buckwheat|bovete\w*|maltodekstriini\w*|maltodextrin\w*|maltitoli\w*|maltitol\w*|maltoosi\w*|maltose|peppar?korn\w*|korngryn/gi,
  },
  milk: {
    hit: /maito|maido|kerma|\bvoi\b|\bvoita\b|voiöljy|voirasva|juusto|rahka|jogurt|piimä|\bhera|kaseiin|laktoosi|\bviili|milk|cream|butter|cheese|\bwhey|casein|lactose|yoghurt|yogurt|mjölk|grädde|smör|\bost\b|vassle|kasein|laktos/gi,
    exclude: /\bvoi(?=\s+(?:sisältää|sisältäen|olla|esiintyä))|maitohap\w*|kookosmai\w*|kauramai\w*|soijamai\w*|mantelimai\w*|riisimai\w*|kookosker\w*|kaurakerma\w*|soijakerma\w*|kaakaovoi\w*|sheavoi\w*|maapähkinävoi\w*|kookosvoi\w*|coconut milk|oat milk|soy milk|almond milk|rice milk|coconut cream|cream of tartar|cocoa butter|peanut butter|shea butter|kokosmjölk|mjölksyra\w*|kakaosmör|jordnötssmör|sheasmör|lactic acid|maidot[oö]n|mjölkfri|milk[- ]free|dairy[- ]free/gi,
  },
  egg: { hit: /kananmun|munajauhe|munanvalk|munankeltu|keltuai|kokomun|\bmun(?:a|at|aa|an|ia|ien|issa|ista)\b|\begg(?!plant)|ägg/gi, exclude: /munaton|munattom\w*|munakoiso\w*|äggfri|egg[- ]free/gi },
  nut: {
    hit: /pähkin|manteli|mantelei|cashew|pistaasi|pekaani|\bnuts?\b|hazelnut|walnut|almond|peanut|nöt|mandel/gi,
    exclude: /kookospähkin\w*|muskottipähkin\w*|pähkinät[öo]n|pähkinättöm\w*|coconut\w*|nutmeg|butternut|kokosnöt\w*|muskotnöt\w*|nötkött\w*|\bnöt(?=kött)/gi,
  },
  soy: { hit: /soija|\bsoy|soja/gi, exclude: /soijaton|sojafri|soy[- ]free/gi },
  fish: {
    hit: /kala|lohi|lohta|seiti|turska|silakka|silakoi|kuha|siika|anjovis|\bfish|salmon|\bcod\b|pollock|fisk|\blax\b|torsk|strömming/gi,
    exclude: /kalamata\w*|kalaton|fiskfri|fish[- ]free/gi,
  },
};

const TRACE_SPLIT = /saattaa sisältää|voi sisältää|may contain|kan innehålla|spår av|jäämiä|traces of/i;
const GF_QUALIFIER = /gluteenit|gluten[- ]?fri|gluten[- ]?free/i;

interface TextHit { word: string; trace: boolean; gfQualified: boolean; wheatStarch: boolean }

function scan(text: string | undefined, rule: TextRule): TextHit[] {
  if (!text) return [];
  const idx = text.search(TRACE_SPLIT);
  const parts: [string, boolean][] = idx >= 0 ? [[text.slice(0, idx), false], [text.slice(idx), true]] : [[text, false]];
  const hits: TextHit[] = [];
  for (const [raw, trace] of parts) {
    const part = rule.exclude ? raw.replace(rule.exclude, m => ' '.repeat(m.length)) : raw;
    rule.hit.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.hit.exec(part))) {
      // expand to the whole word and the two preceding/following words for context
      let s = m.index, e = m.index + m[0].length;
      while (s > 0 && /[\p{L}\-]/u.test(part[s - 1])) s--;
      while (e < part.length && /[\p{L}\-]/u.test(part[e])) e++;
      const word = raw.slice(s, e);
      const ctx = raw.slice(Math.max(0, s - 28), Math.min(raw.length, e + 26));
      const gfQualified = GF_QUALIFIER.test(ctx);
      const wheatStarch = /vehnätärkkel|wheat starch|vetestärkelse/i.test(ctx) || /tärkkelys|starch|stärkelse|kuitu|fibre|fiber/i.test(word) && /vehnä|wheat|vete/i.test(word);
      const label = gfQualified && !GF_QUALIFIER.test(word) ? ctx.match(new RegExp(`(gluteeniton\\w*|glutenfri\\w*|gluten[- ]free)\\s+${escapeRe(word)}|${escapeRe(word)}\\s*\\(?(gluteeniton|glutenfri|gluten[- ]free)\\)?`, 'i'))?.[0] ?? word : word;
      if (!hits.some(h => h.word.toLowerCase() === label.toLowerCase() && h.trace === trace)) hits.push({ word: label.trim(), trace, gfQualified, wheatStarch });
    }
  }
  return hits;
}
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- verdict logic ----------

interface Ctx { p: CatalogProduct; lang: Lang; ev: Evidence[]; text?: string }
const lvl = (c: Ctx, code: string) => c.p.al[code] as 'C' | 'M' | 'U' | 'F' | undefined;
const add = (c: Ctx, kind: Evidence['kind'], tone: Evidence['tone'], text: string) => c.ev.push({ kind, tone, text });
const quote = (hs: TextHit[]) => hs.slice(0, 4).map(h => `”${h.word}”`).join(', ');

/** Declared-allergen pass. Returns 'fail' when any code is CONTAINS / MAY_CONTAIN. */
function declared(c: Ctx, codes: string[]): 'fail' | 'undeclared' | 'free' | 'silent' | 'none' {
  let failed = false, free = false, undeclared = false;
  for (const code of codes) {
    const l = lvl(c, code);
    const name = allergenName(c.lang, code);
    if (l === 'C') { failed = true; add(c, 'declared', 'fail', tr(c.lang, `Toimittaja ilmoittaa: sisältää – ${name}.`, `Leverantören deklarerar: innehåller – ${name}.`, `Supplier declares: contains ${name}.`)); }
    else if (l === 'M') { failed = true; add(c, 'declared', 'fail', tr(c.lang, `Toimittaja ilmoittaa: saattaa sisältää – ${name} (ristikontaminaatio).`, `Leverantören deklarerar: kan innehålla – ${name} (korskontamination).`, `Supplier declares: may contain ${name} (cross-contact).`)); }
    else if (l === 'F') { free = true; add(c, 'declared', 'ok', tr(c.lang, `Toimittaja ilmoittaa: ei sisällä – ${name}.`, `Leverantören deklarerar: fri från – ${name}.`, `Supplier declares: free from ${name}.`)); }
    else if (l === 'U') { undeclared = true; add(c, 'declared', 'unknown', tr(c.lang, `Toimittaja ei ole ilmoittanut tietoa: ${name}.`, `Leverantören har inte deklarerat: ${name}.`, `Supplier has not declared: ${name}.`)); }
  }
  if (failed) return 'fail';
  // the supplier explicitly left this allergen undeclared: that is missing information, never "free from"
  if (undeclared) return 'undeclared';
  if (free) return 'free';
  return c.p.hasAl ? 'silent' : 'none';
}

/** An allergen the supplier explicitly left undeclared can never support an "ok", whatever else the data says. */
function notIfUndeclared(c: Ctx, code: string, v: Verdict): Verdict {
  if (v !== 'ok' || lvl(c, code) !== 'U') return v;
  declared(c, [code]);
  return 'unknown';
}

function missingIngredients(c: Ctx) {
  add(c, 'missing', 'unknown', tr(c.lang, 'Ainesosaluettelo puuttuu toimittajan tiedoista.', 'Ingrediensförteckning saknas i leverantörens data.', 'The supplier data has no ingredient list.'));
}
function missingDeclaration(c: Ctx) {
  add(c, 'missing', 'unknown', tr(c.lang, 'Allergeeni-ilmoitus puuttuu toimittajan tiedoista.', 'Allergendeklaration saknas i leverantörens data.', 'The supplier data has no allergen declaration.'));
}
function cleanIngredients(c: Ctx, what: string) {
  add(c, 'ingredient', 'ok', tr(c.lang, `Ainesosaluettelossa ei mainita: ${what}.`, `Ingrediensförteckningen nämner inte: ${what}.`, `The ingredient list does not mention ${what}.`));
}

/** Shared tail for "X-free" requirements that have no special claim logic. */
function generic(c: Ctx, codes: string[], rule: TextRule, what: string): Verdict {
  const d = declared(c, codes);
  const hits = scan(c.text, rule);
  const main = hits.filter(h => !h.trace), trace = hits.filter(h => h.trace);
  if (main.length) add(c, 'ingredient', 'fail', tr(c.lang, `Ainesosaluettelossa: ${quote(main)}.`, `I ingrediensförteckningen: ${quote(main)}.`, `In the ingredient list: ${quote(main)}.`));
  if (trace.length) add(c, 'ingredient', 'fail', tr(c.lang, `Ainesosaluettelon mukaan saattaa sisältää: ${quote(trace)}.`, `Enligt ingrediensförteckningen kan innehålla: ${quote(trace)}.`, `Ingredient list says it may contain: ${quote(trace)}.`));
  if (d === 'fail' || hits.length) return 'fail';
  if (!c.text) {
    missingIngredients(c);
    return 'unknown';
  }
  cleanIngredients(c, what);
  if (d === 'undeclared') return 'unknown';
  if (d === 'free') return 'ok';
  if (d === 'silent') {
    add(c, 'declared', 'ok', tr(c.lang, `Ilmoitetuissa allergeeneissa ei mainita: ${what}.`, `Deklarerade allergener nämner inte: ${what}.`, `Declared allergens do not list ${what}.`));
    return 'ok';
  }
  missingDeclaration(c);
  return 'unknown';
}

function wheatFree(c: Ctx): Verdict {
  const hits = scan(c.text, TEXT_RULES.wheat);
  const main = hits.filter(h => !h.trace), trace = hits.filter(h => h.trace);
  const starch = main.filter(h => h.wheatStarch && h.gfQualified);
  if (starch.length) add(c, 'ingredient', 'fail', tr(c.lang,
    `Ainesosaluettelossa: ${quote(starch)}. Gluteeniton vehnätärkkelys on vehnäperäinen ainesosa – se sopii gluteenittomaan, mutta ei vehnättömään ruokavalioon.`,
    `I ingrediensförteckningen: ${quote(starch)}. Glutenfri vetestärkelse kommer från vete – den passar glutenfri kost men inte vetefri kost.`,
    `In the ingredient list: ${quote(starch)}. Gluten-free wheat starch is still derived from wheat – fine for a gluten-free diet, not for a wheat-free one.`));
  const other = main.filter(h => !starch.includes(h));
  if (other.length) add(c, 'ingredient', 'fail', tr(c.lang, `Ainesosaluettelossa vehnää tai vehnäperäinen ainesosa: ${quote(other)}.`, `Vete eller veteingrediens i ingrediensförteckningen: ${quote(other)}.`, `Wheat or a wheat-derived ingredient in the ingredient list: ${quote(other)}.`));
  if (trace.length) add(c, 'ingredient', 'fail', tr(c.lang, `Ainesosaluettelon mukaan saattaa sisältää: ${quote(trace)}.`, `Enligt ingrediensförteckningen kan innehålla: ${quote(trace)}.`, `Ingredient list says it may contain: ${quote(trace)}.`));
  const d = declared(c, ['UW', 'GS', 'GK']);
  if (c.p.claims.includes('FREE_FROM_GLUTEN')) add(c, 'claim', 'info', tr(c.lang,
    'Tuotteessa on Gluteeniton-merkintä. Se ei kerro vehnättömyydestä, joten sitä ei käytetä tässä tarkistuksessa.',
    'Produkten är märkt Glutenfri. Det säger inget om vetefrihet och används därför inte i den här kontrollen.',
    'The product carries a gluten-free claim. That says nothing about wheat, so it is not used for this check.'));
  if (d === 'fail' || hits.length) return 'fail';

  const aw = lvl(c, 'AW');
  if (!c.text) {
    if (lvl(c, 'UW') === 'F' && d !== 'undeclared') return 'ok'; // explicit supplier declaration for wheat itself
    missingIngredients(c);
    return 'unknown';
  }
  cleanIngredients(c, tr(c.lang, 'vehnää tai vehnäperäisiä ainesosia', 'vete eller veteingredienser', 'wheat or wheat-derived ingredients'));
  if (d === 'undeclared' || aw === 'U') {
    if (aw === 'U') add(c, 'declared', 'unknown', tr(c.lang, 'Toimittaja ei ole ilmoittanut tietoa: gluteenia sisältävät viljat.', 'Leverantören har inte deklarerat: spannmål som innehåller gluten.', 'Supplier has not declared: cereals containing gluten.'));
    return 'unknown';
  }
  if (lvl(c, 'UW') === 'F') return 'ok';
  if (c.p.claims.includes('FREE_FROM_WHEAT')) {
    add(c, 'claim', 'ok', tr(c.lang, 'Toimittajan merkintä: Vehnätön.', 'Leverantörens märkning: Vetefri.', 'Supplier claim: wheat-free.'));
    return 'ok';
  }
  if (aw === 'F') {
    add(c, 'declared', 'ok', tr(c.lang, 'Toimittaja ilmoittaa: ei sisällä gluteenia sisältäviä viljoja (vehnä kuuluu ryhmään).', 'Leverantören deklarerar: fri från spannmål som innehåller gluten (vete ingår i gruppen).', 'Supplier declares: free from cereals containing gluten (wheat belongs to that group).'));
    return 'ok';
  }
  if (aw === 'C' || aw === 'M') {
    add(c, 'declared', 'unknown', tr(c.lang, 'Toimittaja ilmoittaa gluteenia sisältävän viljan, mutta ei erittele, onko vehnä suljettu pois.', 'Leverantören deklarerar spannmål med gluten men anger inte om vete är uteslutet.', 'Supplier declares a gluten-containing cereal but does not state whether wheat is excluded.'));
    return 'unknown';
  }
  if (c.p.hasAl) {
    add(c, 'declared', 'unknown', tr(c.lang, 'Allergeeni-ilmoituksessa ei oteta kantaa vehnään tai gluteeniviljoihin.', 'Allergendeklarationen tar inte ställning till vete eller glutenspannmål.', 'The allergen declaration says nothing about wheat or gluten cereals.'));
    return 'unknown';
  }
  missingDeclaration(c);
  return 'unknown';
}

function glutenFree(c: Ctx): Verdict {
  const claim = c.p.claims.includes('FREE_FROM_GLUTEN');
  const hits = scan(c.text, TEXT_RULES.gluten);
  const trace = hits.filter(h => h.trace);
  const unqualified = hits.filter(h => !h.trace && !h.gfQualified);
  const qualified = hits.filter(h => !h.trace && h.gfQualified);
  const cereals = ['AW', 'UW', 'NR', 'GB', 'GO', 'GS', 'GK'];
  if (claim) {
    add(c, 'claim', 'ok', tr(c.lang, 'Toimittajan merkintä: Gluteeniton (säännelty väite, alle 20 mg/kg gluteenia).', 'Leverantörens märkning: Glutenfri (reglerat påstående, under 20 mg/kg gluten).', 'Supplier claim: gluten-free (regulated claim, below 20 mg/kg gluten).'));
    const may = cereals.filter(k => lvl(c, k) === 'M');
    if (may.length || trace.length) {
      add(c, 'declared', 'unknown', tr(c.lang,
        `Ristiriita: tuote on merkitty gluteenittomaksi, mutta saattaa sisältää: ${[...may.map(k => allergenName(c.lang, k)), ...trace.map(h => h.word)].join(', ')}.`,
        `Motstridigt: produkten är märkt glutenfri men kan innehålla: ${[...may.map(k => allergenName(c.lang, k)), ...trace.map(h => h.word)].join(', ')}.`,
        `Conflict: labelled gluten-free but may contain: ${[...may.map(k => allergenName(c.lang, k)), ...trace.map(h => h.word)].join(', ')}.`));
      return 'unknown';
    }
    if (unqualified.length) {
      add(c, 'ingredient', 'unknown', tr(c.lang, `Ristiriita: ainesosaluettelossa gluteeniviljaa ilman gluteeniton-mainintaa: ${quote(unqualified)}.`, `Motstridigt: glutenspannmål utan glutenfri-angivelse i ingredienserna: ${quote(unqualified)}.`, `Conflict: gluten cereal without a gluten-free qualifier in the ingredients: ${quote(unqualified)}.`));
      return 'unknown';
    }
    // the claim does not outweigh a gluten cereal the supplier explicitly left undeclared
    const undeclared = cereals.filter(k => lvl(c, k) === 'U');
    if (undeclared.length) {
      const names = undeclared.map(k => allergenName(c.lang, k)).join(', ');
      add(c, 'declared', 'unknown', tr(c.lang, `Ristiriita: tuote on merkitty gluteenittomaksi, mutta toimittaja ei ole ilmoittanut tietoa: ${names}.`, `Motstridigt: produkten är märkt glutenfri, men leverantören har inte deklarerat: ${names}.`, `Conflict: labelled gluten-free, but the supplier has not declared: ${names}.`));
      return 'unknown';
    }
    if (qualified.some(h => h.wheatStarch)) add(c, 'ingredient', 'info', tr(c.lang, `Sisältää gluteenitonta vehnätärkkelystä (${quote(qualified.filter(h => h.wheatStarch))}) – ei sovi vehnättömään ruokavalioon.`, `Innehåller glutenfri vetestärkelse (${quote(qualified.filter(h => h.wheatStarch))}) – passar inte vetefri kost.`, `Contains gluten-free wheat starch (${quote(qualified.filter(h => h.wheatStarch))}) – not suitable for a wheat-free diet.`));
    return 'ok';
  }
  const d = declared(c, cereals);
  if (unqualified.length) add(c, 'ingredient', 'fail', tr(c.lang, `Ainesosaluettelossa gluteenia sisältävää viljaa: ${quote(unqualified)}.`, `Glutenspannmål i ingrediensförteckningen: ${quote(unqualified)}.`, `Gluten-containing cereal in the ingredient list: ${quote(unqualified)}.`));
  if (trace.length) add(c, 'ingredient', 'fail', tr(c.lang, `Ainesosaluettelon mukaan saattaa sisältää: ${quote(trace)}.`, `Enligt ingrediensförteckningen kan innehålla: ${quote(trace)}.`, `Ingredient list says it may contain: ${quote(trace)}.`));
  if (d === 'fail' || unqualified.length || trace.length) return 'fail';
  if (qualified.length) {
    add(c, 'ingredient', 'unknown', tr(c.lang, `Ainesosissa gluteenittomaksi mainittu vilja (${quote(qualified)}), mutta tuotteelta puuttuu Gluteeniton-merkintä.`, `Ingredienserna anger glutenfri spannmål (${quote(qualified)}), men produkten saknar märkningen Glutenfri.`, `Ingredients mention a gluten-free cereal (${quote(qualified)}), but the product has no gluten-free claim.`));
    return 'unknown';
  }
  if (!c.text) { missingIngredients(c); return 'unknown'; }
  cleanIngredients(c, tr(c.lang, 'gluteenia sisältäviä viljoja', 'spannmål som innehåller gluten', 'gluten-containing cereals'));
  if (d === 'undeclared') return 'unknown';
  if (d === 'free') return 'ok';
  if (d === 'silent') { add(c, 'declared', 'ok', tr(c.lang, 'Ilmoitetuissa allergeeneissa ei mainita gluteenia sisältäviä viljoja.', 'Deklarerade allergener nämner inte spannmål med gluten.', 'Declared allergens do not list gluten-containing cereals.')); return 'ok'; }
  missingDeclaration(c);
  return 'unknown';
}

const lactoseFree = (c: Ctx): Verdict => notIfUndeclared(c, 'ML', lactoseRules(c));

function lactoseRules(c: Ctx): Verdict {
  const ml = lvl(c, 'ML');
  if (ml === 'C' || ml === 'M') { declared(c, ['ML']); return 'fail'; }
  if (c.p.claims.includes('FREE_FROM_LACTOSE') || ml === 'F') {
    if (c.p.claims.includes('FREE_FROM_LACTOSE')) add(c, 'claim', 'ok', tr(c.lang, 'Toimittajan merkintä: Laktoositon.', 'Leverantörens märkning: Laktosfri.', 'Supplier claim: lactose-free.'));
    else declared(c, ['ML']);
    if (lvl(c, 'AM') === 'C') add(c, 'declared', 'info', tr(c.lang, 'Huom. tuote sisältää maitoa: laktoositon ei tarkoita maidotonta.', 'Obs! Produkten innehåller mjölk: laktosfri betyder inte mjölkfri.', 'Note: the product contains milk – lactose-free does not mean milk-free.'));
    return 'ok';
  }
  if (c.p.claims.includes('LOW_LACTOSE')) {
    add(c, 'claim', 'fail', tr(c.lang, 'Toimittajan merkintä: Vähälaktoosinen – se ei ole laktoositon.', 'Leverantörens märkning: Låglaktos – det är inte laktosfritt.', 'Supplier claim: low-lactose – that is not lactose-free.'));
    return 'fail';
  }
  const before = c.ev.length;
  const milk = generic(c, ['AM'], TEXT_RULES.milk, tr(c.lang, 'maitoa', 'mjölk', 'milk'));
  if (milk === 'fail') {
    add(c, 'claim', 'fail', tr(c.lang, 'Tuote sisältää maitoa, eikä laktoosittomuutta ole ilmoitettu.', 'Produkten innehåller mjölk och laktosfrihet har inte deklarerats.', 'The product contains milk and no lactose-free declaration is given.'));
    return 'fail';
  }
  if (milk === 'ok') add(c, 'note', 'ok', tr(c.lang, 'Ei maitoa, joten ei laktoosia.', 'Ingen mjölk, alltså ingen laktos.', 'No milk, therefore no lactose.'));
  void before;
  return milk;
}

function milkFree(c: Ctx): Verdict {
  if (c.p.claims.includes('FREE_FROM_LACTOSE')) add(c, 'claim', 'info', tr(c.lang, 'Tuotteessa on Laktoositon-merkintä. Laktoositon ei tarkoita maidotonta, joten sitä ei käytetä tässä tarkistuksessa.', 'Produkten är märkt Laktosfri. Laktosfri betyder inte mjölkfri och används därför inte här.', 'The product carries a lactose-free claim. Lactose-free does not mean milk-free, so it is not used for this check.'));
  const ml = lvl(c, 'ML');
  if (ml === 'C') add(c, 'declared', 'fail', tr(c.lang, 'Toimittaja ilmoittaa: sisältää laktoosia (maitoperäinen).', 'Leverantören deklarerar: innehåller laktos (från mjölk).', 'Supplier declares: contains lactose (milk-derived).'));
  if (ml === 'M') add(c, 'declared', 'fail', tr(c.lang, 'Toimittaja ilmoittaa: saattaa sisältää laktoosia (maitoperäinen, ristikontaminaatio).', 'Leverantören deklarerar: kan innehålla laktos (från mjölk, korskontamination).', 'Supplier declares: may contain lactose (milk-derived, cross-contact).'));
  const v = generic(c, ['AM'], TEXT_RULES.milk, tr(c.lang, 'maitoa tai maitoperäisiä ainesosia', 'mjölk eller mjölkingredienser', 'milk or milk-derived ingredients'));
  return ml === 'C' || ml === 'M' ? 'fail' : notIfUndeclared(c, 'ML', v);
}

function summarize(c: Ctx, r: Requirement, v: Verdict): string {
  const label = requirementLabel(c.lang, r).toLowerCase();
  const first = (tone: Evidence['tone']) => c.ev.find(e => e.tone === tone)?.text ?? '';
  if (v === 'ok') return tr(c.lang, `Sopii: ${label}. Varmistettu toimittajan tiedoista.`, `Passar: ${label}. Verifierat mot leverantörens data.`, `Suitable: ${label}. Verified from supplier data.`);
  if (v === 'fail') return tr(c.lang, `Ei sovi: ${label}. ${first('fail')}`, `Passar inte: ${label}. ${first('fail')}`, `Not suitable: ${label}. ${first('fail')}`);
  return tr(c.lang, `Tieto puuttuu: ${label}. ${first('unknown')} Tuotetta ei käytetä ennen kuin tieto on varmistettu.`, `Uppgift saknas: ${label}. ${first('unknown')} Produkten används inte förrän uppgiften är verifierad.`, `Needs information: ${label}. ${first('unknown')} The product is not used until this is verified.`);
}

export function checkProduct(p: CatalogProduct, r: Requirement, lang: Lang): AllergenCheck {
  // a placeholder such as "-" or "." is not an ingredient list
  const c: Ctx = { p, lang, ev: [], text: p.ing && (p.ing.match(/\p{L}/gu)?.length ?? 0) >= 3 ? p.ing : undefined };
  let v: Verdict;
  switch (r) {
    case 'wheat_free': v = wheatFree(c); break;
    case 'gluten_free': v = glutenFree(c); break;
    case 'lactose_free': v = lactoseFree(c); break;
    case 'milk_free': v = milkFree(c); break;
    case 'egg_free': v = generic(c, ['AE'], TEXT_RULES.egg, tr(lang, 'kananmunaa', 'ägg', 'egg')); break;
    case 'nut_free': v = generic(c, ['AN', 'AP', 'SA', 'SH', 'SW', 'SC', 'SP', 'SR', 'ST', 'SM'], TEXT_RULES.nut, tr(lang, 'pähkinöitä', 'nötter', 'nuts')); break;
    case 'soy_free': v = generic(c, ['AY'], TEXT_RULES.soy, tr(lang, 'soijaa', 'soja', 'soy')); break;
    case 'fish_free': v = generic(c, ['AF'], TEXT_RULES.fish, tr(lang, 'kalaa', 'fisk', 'fish')); break;
  }
  // most important evidence first
  const order = { fail: 0, unknown: 1, ok: 2, info: 3 } as const;
  c.ev.sort((a, b) => order[a.tone] - order[b.tone]);
  return { requirement: r, requirementLabel: requirementLabel(lang, r), verdict: v, summary: summarize(c, r, v), evidence: c.ev };
}

export function checkAll(p: CatalogProduct, reqs: Requirement[], lang: Lang): AllergenCheck[] {
  return reqs.map(r => checkProduct(p, r, lang));
}
export const allOk = (checks: AllergenCheck[]) => checks.every(c => c.verdict === 'ok');
export function worst(checks: AllergenCheck[]): Verdict {
  return checks.some(c => c.verdict === 'fail') ? 'fail' : checks.some(c => c.verdict === 'unknown') ? 'unknown' : 'ok';
}
