// The kitchen's approved recipe book (our own demo data). Quantities are per portion.
// Every product id refers to the Valio Aimo challenge catalog; nothing about allergens is stored
// here — suitability is always computed from supplier data at planning time.
import type { CourseRole, Lang } from '../../shared/types.ts';
import { norm } from './catalog.ts';
import { type L3, type StoredDay, l3, pick } from './store.ts';

export interface RecipeIngredient {
  key: string;          // shared across recipes so approved substitutions are remembered kitchen-wide
  name: L3;
  amount: number;       // grams or millilitres per portion
  unit: 'g' | 'ml';
  product: string;      // the kitchen's usual product
  special?: string;     // the kitchen's usual product for special-diet portions
  search: string;       // catalog search used when looking for alternatives
}
export interface Recipe { id: string; name: L3; aliases: string[]; ingredients: RecipeIngredient[]; side?: boolean;
  /** drink or dessert: stays in the approved book (explicit choice, event import) but is never SUGGESTED as a main dish */
  course?: 'drink' | 'dessert';
  /** words that make this recipe a plausible SUGGESTION (never an automatic match) */
  hints?: string[] }

const I = {
  makaroni: (g: number): RecipeIngredient => ({ key: 'makaroni', name: l3('Makaroni', 'Makaroner', 'Macaroni'), amount: g, unit: 'g', product: '460001', special: '474235', search: 'makaroni' }),
  jauheliha: (g: number): RecipeIngredient => ({ key: 'jauheliha', name: l3('Naudan jauheliha', 'Nötfärs', 'Minced beef'), amount: g, unit: 'g', product: '463104', search: 'naudan jauheliha' }),
  maito: (ml: number): RecipeIngredient => ({ key: 'maito', name: l3('Laktoositon maitojuoma', 'Laktosfri mjölkdryck', 'Lactose-free milk drink'), amount: ml, unit: 'ml', product: '464179', search: 'laktoositon maitojuoma' }),
  muna: (g: number): RecipeIngredient => ({ key: 'muna', name: l3('Kokomunamassa', 'Helägg', 'Liquid whole egg'), amount: g, unit: 'g', product: '475201', search: 'kokomuna' }),
  sipuli: (g: number): RecipeIngredient => ({ key: 'sipuli', name: l3('Sipulikuutio', 'Löktärningar', 'Diced onion'), amount: g, unit: 'g', product: '465097', search: 'sipulikuutio' }),
  broileri: (g: number): RecipeIngredient => ({ key: 'broileri', name: l3('Broilerin fileesuikale', 'Kycklingfiléstrimlor', 'Chicken fillet strips'), amount: g, unit: 'g', product: '462452', search: 'broilerin fileesuikale' }),
  kerma: (ml: number): RecipeIngredient => ({ key: 'kerma', name: l3('Laktoositon ruokakerma', 'Laktosfri matgrädde', 'Lactose-free cooking cream'), amount: ml, unit: 'ml', product: '464396', search: 'ruokakerma laktoositon' }),
  jauho: (g: number): RecipeIngredient => ({ key: 'jauho', name: l3('Jauho (suurustus ja taikina)', 'Mjöl (redning och smet)', 'Flour (thickening and batter)'), amount: g, unit: 'g', product: '460091', special: '460734', search: 'gluteeniton jauhoseos' }),
  riisi: (g: number): RecipeIngredient => ({ key: 'riisi', name: l3('Riisi', 'Ris', 'Rice'), amount: g, unit: 'g', product: '463624', search: 'riisi' }),
  porkkana: (g: number): RecipeIngredient => ({ key: 'porkkana', name: l3('Porkkanakuutio', 'Morotstärningar', 'Diced carrot'), amount: g, unit: 'g', product: '467270', search: 'porkkanakuutio' }),
  peruna: (g: number): RecipeIngredient => ({ key: 'peruna', name: l3('Kuutioperuna', 'Tärnad potatis', 'Diced potato'), amount: g, unit: 'g', product: '476460', search: 'kuutioperuna' }),
  liemi: (g: number): RecipeIngredient => ({ key: 'liemi', name: l3('Kasvisliemi', 'Grönsaksbuljong', 'Vegetable stock'), amount: g, unit: 'g', product: '461219', search: 'kasvisliemi' }),
  hernekeitto: (g: number): RecipeIngredient => ({ key: 'hernekeitto', name: l3('Hernekeitto', 'Ärtsoppa', 'Pea soup'), amount: g, unit: 'g', product: '462898', search: 'hernekeitto' }),
  hillo: (g: number): RecipeIngredient => ({ key: 'hillo', name: l3('Mansikkahillo', 'Jordgubbssylt', 'Strawberry jam'), amount: g, unit: 'g', product: '462171', search: 'mansikkahillo' }),
  lohi: (g: number): RecipeIngredient => ({ key: 'lohi', name: l3('Lohikuutio', 'Laxtärningar', 'Diced salmon'), amount: g, unit: 'g', product: '470558', search: 'lohikuutio' }),
  leipa: (g: number): RecipeIngredient => ({ key: 'leipa', name: l3('Leipä', 'Bröd', 'Bread'), amount: g, unit: 'g', product: '462683', special: '467032', search: 'gluteeniton leipä' }),
  levite: (g: number): RecipeIngredient => ({ key: 'levite', name: l3('Margariini', 'Margarin', 'Margarine'), amount: g, unit: 'g', product: '466090', search: 'margariini' }),
};

const E = {
  kuohu: (ml: number): RecipeIngredient => ({ key: 'kuohu', name: l3('Alkoholiton kuohujuoma', 'Alkoholfri mousserande dryck', 'Alcohol-free sparkling drink'), amount: ml, unit: 'ml', product: '477215', search: 'alkoholiton kuohu' }),
  paahtopaisti: (g: number): RecipeIngredient => ({ key: 'paahtopaisti', name: l3('Paahtopaisti viipaleina', 'Rostbiff i skivor', 'Sliced roast beef'), amount: g, unit: 'g', product: '462611', search: 'paahtopaisti' }),
  perunasalaatti: (g: number): RecipeIngredient => ({ key: 'perunasalaatti', name: l3('Perunasalaatti', 'Potatissallad', 'Potato salad'), amount: g, unit: 'g', product: '465524', search: 'perunasalaatti' }),
  salaatti: (g: number): RecipeIngredient => ({ key: 'salaatti', name: l3('Salaatti', 'Sallad', 'Salad leaves'), amount: g, unit: 'g', product: '468068', search: 'salaatti' }),
  karjalanpaisti: (g: number): RecipeIngredient => ({ key: 'karjalanpaisti', name: l3('Karjalanpaisti', 'Karelsk stek', 'Karelian stew'), amount: g, unit: 'g', product: '462590', search: 'karjalanpaisti' }),
  kakku: (g: number): RecipeIngredient => ({ key: 'kakku', name: l3('Mansikkakakku', 'Jordgubbstårta', 'Strawberry cake'), amount: g, unit: 'g', product: '470261', search: 'kakku' }),
};

export const RECIPES: Recipe[] = [
  {
    id: 'alkumalja', course: 'drink', name: l3('Alkoholiton kuohujuoma', 'Alkoholfri mousserande dryck', 'Alcohol-free sparkling drink'),
    aliases: ['alkumalja', 'alkoholiton kuohujuoma', 'alkoholiton kuohuviini', 'valkomstskal', 'welcome toast', 'sparkling drink'], hints: ['kuohu', 'malja', 'skal', 'toast', 'sparkling'],
    ingredients: [E.kuohu(100)],
  },
  {
    id: 'paahtopaisti_perunasalaatti', name: l3('Paahtopaisti ja perunasalaatti', 'Rostbiff och potatissallad', 'Roast beef and potato salad'),
    aliases: ['paahtopaisti ja perunasalaatti', 'paahtopaisti perunasalaatti', 'rostbiff och potatissallad', 'roast beef and potato salad'], hints: ['paahtopaisti', 'perunasalaatti', 'rostbiff', 'roast beef'],
    ingredients: [E.paahtopaisti(60), E.perunasalaatti(120), E.salaatti(40)],
  },
  {
    id: 'karjalanpaisti', name: l3('Karjalanpaisti ja perunat', 'Karelsk stek och potatis', 'Karelian stew with potatoes'),
    aliases: ['karjalanpaisti ja perunat', 'karjalanpaisti', 'karelsk stek', 'karelian stew'], hints: ['karjalanpaisti', 'karelsk', 'karelian'],
    ingredients: [E.karjalanpaisti(160), I.peruna(180)],
  },
  {
    id: 'mansikkakakku', course: 'dessert', name: l3('Mansikkakakku', 'Jordgubbstårta', 'Strawberry cake'),
    aliases: ['mansikkakakku', 'jordgubbstarta', 'strawberry cake'], hints: ['kakku', 'tarta', 'cake'],
    ingredients: [E.kakku(110)],
  },
  {
    id: 'lihamakaronilaatikko', name: l3('Lihamakaronilaatikko', 'Köttmakaronilåda', 'Beef macaroni casserole'),
    aliases: ['makaronilaatikko', 'liha makaronilaatikko', 'jauheliha makaronilaatikko', 'kottmakaronilada', 'makaronilada', 'macaroni casserole'], hints: ['makaroni', 'macaroni'],
    ingredients: [I.makaroni(45), I.jauheliha(50), I.maito(120), I.muna(20), I.sipuli(10)],
  },
  {
    id: 'broilerikastike', name: l3('Broilerikastike ja riisi', 'Kycklingsås och ris', 'Chicken sauce with rice'),
    aliases: ['broilerikastike', 'kanakastike ja riisi', 'kanakastike', 'broileri kermakastike riisi', 'kycklingsas', 'chicken sauce rice'], hints: ['broileri', 'kana', 'kyckling', 'chicken'],
    ingredients: [I.broileri(60), I.kerma(50), I.jauho(6), I.riisi(60), I.sipuli(8)],
  },
  {
    id: 'porkkanasosekeitto', name: l3('Porkkanasosekeitto', 'Morotspurésoppa', 'Carrot purée soup'),
    aliases: ['porkkanasosekeitto', 'porkkanakeitto', 'morotssoppa', 'carrot soup'], hints: ['porkkana', 'morot', 'carrot'],
    ingredients: [I.porkkana(120), I.peruna(60), I.liemi(4), I.kerma(30)],
  },
  {
    id: 'hernekeitto_pannukakku', name: l3('Hernekeitto ja pannukakku', 'Ärtsoppa och pannkaka', 'Pea soup and oven pancake'),
    aliases: ['hernekeitto ja pannukakku', 'hernekeitto pannukakku', 'hernekeitto pannari', 'artsoppa pannkaka', 'pea soup pancake'], hints: ['herne', 'pannukakku', 'pannari', 'arts', 'pea soup'],
    ingredients: [I.hernekeitto(250), I.jauho(25), I.maito(80), I.muna(15), I.hillo(20)],
  },
  {
    id: 'lohikeitto', name: l3('Lohikeitto', 'Laxsoppa', 'Salmon soup'),
    aliases: ['lohikeitto', 'kermainen lohikeitto', 'laxsoppa', 'salmon soup'], hints: ['kala', 'lohi', 'fisk', 'lax', 'fish', 'salmon'],
    ingredients: [I.lohi(60), I.peruna(120), I.kerma(40), I.sipuli(10), I.liemi(3)],
  },
  {
    id: 'jauhelihakastike', name: l3('Jauhelihakastike ja perunat', 'Köttfärssås och potatis', 'Minced beef sauce with potatoes'),
    aliases: ['jauhelihakastike', 'jauhelihakastike ja perunat', 'kottfarssas', 'minced meat sauce'], hints: ['jauheliha', 'kottfars', 'minced'],
    ingredients: [I.jauheliha(70), I.peruna(150), I.jauho(5), I.sipuli(10), I.kerma(20)],
  },
  {
    id: 'lisukkeet', side: true, name: l3('Leipä, levite ja ruokajuoma', 'Bröd, bredbart och måltidsdryck', 'Bread, spread and milk'),
    aliases: [], ingredients: [I.leipa(30), I.levite(8), I.maito(150)],
  },
];

export const recipeById = (id?: string) => RECIPES.find(r => r.id === id);
export const mainRecipes = () => RECIPES.filter(r => !r.side);
/** what a recommendation may offer as a day's main dish: no sides, drinks or desserts */
export const mainDishRecipes = () => mainRecipes().filter(r => !r.course);
export const sideRecipe = () => RECIPES.find(r => r.side)!;
export const recipeRole = (r: Recipe): CourseRole => r.course ?? 'main';
export const recipesForRole = (role?: CourseRole) => role ? mainRecipes().filter(r => recipeRole(r) === role) : [];
/** Only unambiguous imported labels establish an event role; dish names and recipes do not. */
export function roleFromLabel(label?: string): CourseRole | undefined {
  const s = norm(label ?? '');
  if (/^(alkumalja|tervetuliaismalja|juoma|juomat|valkomstskal|dryck|drycker|welcome drink|drink|drinks)$/.test(s)) return 'drink';
  if (/^(paaruoka|lammin ruoka|varmratt|huvudratt|main course|main|mains)$/.test(s)) return 'main';
  if (/^(jalkiruoka|kakku|efterratt|dessert)$/.test(s)) return 'dessert';
  return undefined;
}
export const dayRole = (kind: 'week' | 'event' | undefined, day: { role?: CourseRole; label?: string }): CourseRole | undefined =>
  kind === 'event' ? day.role ?? roleFromLabel(day.label) : 'main';

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function similarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}

export interface RecipeMatch { recipe?: Recipe; confidence: 'exact' | 'close' | 'none'; score: number }

/** Match an imported dish name to an approved recipe. Only an exact name/alias match is auto-linked;
 *  anything else is returned as a suggestion that the user must confirm. */
export function matchRecipe(dish: string, candidates: Recipe[] = mainRecipes()): RecipeMatch {
  const d = norm(dish);
  if (!d) return { confidence: 'none', score: 0 };
  // generic dish-type words say nothing about which recipe it is
  const generic = /\b(ja|och|and|with)\b|keitto|kastike|laatikko|sosekeitto|soppa|sas|soup|sauce/g;
  const core = (s: string) => s.replace(generic, ' ').replace(/ +/g, ' ').trim() || s;
  let best: { r: Recipe; s: number } | undefined;
  for (const r of candidates) {
    const names = [r.name.fi, r.name.sv, r.name.en, ...r.aliases].map(norm);
    if (names.includes(d)) return { recipe: r, confidence: 'exact', score: 1 };
    let s = Math.max(...names.map(n => similarity(core(d), core(n))));
    if (r.hints?.some(h => d.includes(h))) s = Math.max(s, 0.5) + 0.2;
    if (!best || s > best.s) best = { r, s };
  }
  if (best && best.s >= 0.5) return { recipe: best.r, confidence: 'close', score: best.s };
  return { confidence: 'none', score: best?.s ?? 0 };
}

export const recipeName = (lang: Lang, id?: string) => { const r = recipeById(id); return r ? pick(lang, r.name) : undefined; };

/** Link an imported menu entry to an approved recipe of its role: an exact name or alias confirms it, a close name
 *  becomes a suggestion, an exact name of another role is only recorded (the entry then asks for a check). */
export function linkRecipe(day: StoredDay, event = false): StoredDay {
  const role = dayRole(event ? 'event' : 'week', day);
  const exact = matchRecipe(day.dishName, mainRecipes());
  if (exact.confidence === 'exact' && exact.recipe && (!role || recipeRole(exact.recipe) !== role)) {
    day.recipeId = exact.recipe.id;
    return day;
  }
  const m = matchRecipe(day.dishName, recipesForRole(role));
  if (m.confidence === 'exact') { day.match = 'confirmed'; day.recipeId = m.recipe!.id; }
  else if (m.confidence === 'close') {
    day.match = 'suggested';
    day.suggestion = { recipeId: m.recipe!.id, why: l3(`Lähin hyväksytty resepti nimen perusteella on ${m.recipe!.name.fi}.`, `Det närmaste godkända receptet utifrån namnet är ${m.recipe!.name.sv}.`, `The closest approved recipe by name is ${m.recipe!.name.en}.`) };
  }
  return day;
}

/** Link an entry again exactly the way the import links it (same role rules); the user's earlier choices are dropped. */
export function relinkAsImported(day: StoredDay, event: boolean): StoredDay {
  day.match = 'missing'; day.recipeId = undefined; day.suggestion = undefined; day.customName = undefined; day.removed = undefined;
  return linkRecipe(day, event);
}

/** The approved recipe of the entry's role that the imported dish name points to, for marking it in the picker. */
export function importRecipe(kind: 'week' | 'event' | undefined, day: StoredDay): { recipeId: string; exact: boolean } | undefined {
  const m = matchRecipe(day.dishName, recipesForRole(dayRole(kind, day)));
  return m.recipe && m.confidence !== 'none' ? { recipeId: m.recipe.id, exact: m.confidence === 'exact' } : undefined;
}

/** Search words of a recipe for the picker: every name and alias (exact match), and its hint words (search only). */
export const recipeTerms = (r: Recipe) => ({
  names: [...new Set([r.name.fi, r.name.sv, r.name.en, ...r.aliases].map(norm).filter(Boolean))],
  hints: [...new Set((r.hints ?? []).map(norm).filter(Boolean))],
});
