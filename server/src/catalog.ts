// In-memory view of the Valio Aimo challenge product catalog (synthetic challenge data).
import { readFileSync } from 'node:fs';
import type { Lang, ProductView } from '../../shared/types.ts';
import { allergenName, claimName } from './allergens.ts';
import { config } from './config.ts';
import { num, tr, unitLabel } from './i18n.ts';

export interface CatalogProduct {
  id: string; name: string; en?: string; sv?: string; brand: string; vendor: string; cat: string;
  su: string; bu?: string; lot: number; gtin?: string; del: boolean; var: boolean; dep: boolean;
  al: Record<string, 'C' | 'M' | 'U' | 'F'>; hasAl: boolean; claims: string[]; subs: string[];
  upd?: string; temp?: number; ing?: string; ingLang?: string; ing_en?: string; ing_sv?: string;
  per?: { v: number; u: 'kg' | 'L'; n: number }; n?: number; rel?: number; co2?: number;
  labels?: string[]; origin?: string;
  _s?: string; // normalized search text
}

let products: CatalogProduct[] = [];
let byId = new Map<string, CatalogProduct>();

export function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function loadCatalog(): number {
  products = JSON.parse(readFileSync(config.catalogFile, 'utf8'));
  byId = new Map(products.map(p => [p.id, p]));
  for (const p of products) p._s = norm(`${p.name} ${p.brand} ${p.sv ?? ''} ${p.en ?? ''}`);
  return products.length;
}

export const getProduct = (id: string) => byId.get(String(id));
export const catalogSize = () => products.length;

/** Smallest order step in sales units, from the supplier's allowedLotSize (`lot`). Valio Aimo confirmed that
 *  0.01 means 1. For other values we take the cautious reading: an order quantity is a whole number of sales
 *  units AND a multiple of the lot, so lot 2 allows 2, 4, 6 … and lot 1.5 allows 3, 6, 9 … */
export function lotStep(p: Pick<CatalogProduct, 'lot'>): number {
  const lot = Math.round(p.lot * 1e4);
  if (!(lot > 100)) return 1;
  let a = lot, b = 1e4;
  while (b) [a, b] = [b, a % b];
  return lot / a;
}
/** Round a quantity of sales units up to the next quantity the lot size allows. */
export function roundToLot(qty: number, p: Pick<CatalogProduct, 'lot'>): number {
  const step = lotStep(p);
  return Math.ceil(qty / step - 1e-9) * step || 0;
}

export function localName(p: CatalogProduct, lang: Lang): string {
  return (lang === 'sv' ? p.sv : lang === 'en' ? p.en : undefined) ?? p.name;
}
export function localIngredients(p: CatalogProduct, lang: Lang): string | undefined {
  // the Finnish list is the one the rules read; show a translation only when the supplier provides it
  return (lang === 'sv' ? p.ing_sv : lang === 'en' ? p.ing_en : undefined) ?? p.ing;
}

export function packLabel(p: CatalogProduct, lang: Lang): string {
  if (!p.per) return tr(lang, 'pakkauskoko ei toimittajan tiedoissa', 'förpackningsstorlek saknas i leverantörsdata', 'pack size not in supplier data');
  return `${num(lang, p.per.v, 2)} ${p.per.u} / ${unitLabel(lang, p.su)}`;
}

const PACKAGING_LABELS: Record<string, [string, string, string]> = {
  GOODS_FROM_FINLAND_BLUE_SWAN: ['Hyvää Suomesta', 'Gott från Finland', 'Food from Finland'],
  MADE_IN_FINLAND_FLAG_WITH_KEY: ['Avainlippu', 'Nyckelflaggan', 'Key Flag'],
  FINNISH_HEART_SYMBOL: ['Sydänmerkki', 'Hjärtmärket', 'Heart Symbol'],
  EU_ORGANIC_FARMING: ['EU-luomu', 'EU-ekologiskt', 'EU organic'],
  SVANEN: ['Joutsenmerkki', 'Svanenmärket', 'Nordic Swan Ecolabel'],
  RAINFOREST_ALLIANCE: ['Rainforest Alliance', 'Rainforest Alliance', 'Rainforest Alliance'],
  EU_ECO_LABEL: ['EU-ympäristömerkki', 'EU-miljömärket', 'EU Ecolabel'],
  MARINE_STEWARDSHIP_COUNCIL_LABEL: ['MSC', 'MSC', 'MSC'],
  FAIR_TRADE_MARK: ['Reilu kauppa', 'Fairtrade', 'Fairtrade'],
};

export function productView(p: CatalogProduct, lang: Lang): ProductView {
  const codes = (l: string) => Object.entries(p.al).filter(([, v]) => v === l).map(([k]) => allergenName(lang, k));
  return {
    id: p.id, name: localName(p, lang), brand: p.brand || undefined, vendor: p.vendor || undefined,
    salesUnit: p.su, unitLabel: unitLabel(lang, p.su), lotStep: lotStep(p) > 1 ? lotStep(p) : undefined,
    packSize: p.per ? { value: p.per.v, unit: p.per.u } : undefined,
    packLabel: packLabel(p, lang),
    ingredients: localIngredients(p, lang),
    declared: { contains: codes('C'), mayContain: codes('M'), freeFrom: codes('F') },
    claims: p.claims.map(c => claimName(lang, c)).filter((x): x is string => !!x),
    dataUpdated: p.upd?.slice(0, 10),
    hasIngredientList: !!p.ing, hasAllergenDeclaration: p.hasAl,
    deliveryReliability: p.rel, co2PerKg: p.co2,
    packagingLabels: (p.labels ?? []).map(id => ({ id, name: PACKAGING_LABELS[id] ? tr(lang, ...PACKAGING_LABELS[id]) : id })),
    countryOfOrigin: p.origin,
    originLabel: p.origin ? tr(lang, `Alkuperämaa: ${p.origin.toUpperCase()}`, `Ursprungsland: ${p.origin.toUpperCase()}`, `Country of origin: ${p.origin.toUpperCase()}`) : undefined,
    packagingLabelNote: tr(lang, 'Toimittajan ilmoittamat pakkausmerkit; Aimo ei todenna sertifikaatteja.', 'Förpackningsmärken enligt leverantören; Aimo verifierar inte certifikat.', 'Supplier-declared packaging labels; Aimo does not verify certificates.'),
  };
}

export interface SearchOpts { limit?: number; category?: string; needPack?: boolean }

/** Token search over product names (fi/sv/en) and brand. All tokens must match; prefix matches rank higher. */
export function searchProducts(query: string, opts: SearchOpts = {}): CatalogProduct[] {
  const tokens = norm(query).split(' ').filter(t => t.length > 1);
  if (!tokens.length) return [];
  const scored: [number, CatalogProduct][] = [];
  for (const p of products) {
    if (p.del || (opts.needPack && !p.per)) continue;
    if (opts.category && p.cat !== opts.category) continue;
    const s = p._s!;
    let score = 0, ok = true;
    for (const t of tokens) {
      const i = s.indexOf(t);
      if (i < 0) { ok = false; break; }
      // whole word ("olut") beats a word start ("olutmakkara"), which beats a substring ("solutions")
      const whole = (' ' + s + ' ').includes(' ' + t + ' ');
      score += whole ? 8 : (i === 0 || s[i - 1] === ' ') ? 3 : 1;
    }
    if (!ok) continue;
    if (p.per) score += 1;
    if (p.ing) score += 1;
    if (p.hasAl) score += 1;
    score -= s.length / 200;
    scored.push([score, p]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, opts.limit ?? 20).map(x => x[1]);
}

export function sameCategory(cat: string): CatalogProduct[] {
  return products.filter(p => p.cat === cat && !p.del);
}
