// Unit tests for the deterministic allergen rules (src/allergens.ts) against REAL products of the
// Valio Aimo challenge catalog plus synthetic products that probe edge cases.
//
// The one rule everything else hangs on: missing or conflicting supplier data must never become "ok".
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Lang, Requirement, Verdict } from '../../shared/types.ts';
import { REQUIREMENTS, allOk, checkAll, checkProduct, worst } from '../src/allergens.ts';
import { type CatalogProduct, getProduct, loadCatalog, searchProducts } from '../src/catalog.ts';

const LANGS: Lang[] = ['fi', 'sv', 'en'];

/** A synthetic catalog product. By default it carries NO supplier data at all. */
function mk(over: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id: 'synthetic', name: 'Synthetic test product', brand: '', vendor: '', cat: '00000', su: 'ST', lot: 1,
    del: false, var: false, dep: false, al: {}, hasAl: false, claims: [], subs: [], ...over,
  };
}
const verdict = (p: CatalogProduct, r: Requirement, lang: Lang = 'fi'): Verdict => checkProduct(p, r, lang).verdict;
function real(id: string): CatalogProduct {
  const p = getProduct(id);
  assert.ok(p, `catalog product ${id} must exist`);
  return p;
}
/** Every product of the catalog that can be ordered. */
function everyProduct(): CatalogProduct[] {
  const seen = new Map<string, CatalogProduct>();
  // searchProducts is the only public iterator; walk the id space the challenge catalog uses instead
  for (let id = 460000; id < 480000; id++) { const p = getProduct(String(id)); if (p && !p.del) seen.set(p.id, p); }
  return [...seen.values()];
}

let catalogCount = 0;
before(() => { catalogCount = loadCatalog(); });

describe('catalog fixture', () => {
  it('loads the full challenge catalog', () => {
    assert.equal(catalogCount, 17546);
    assert.ok(everyProduct().length > 15000, 'the id walk used by the invariant tests must cover the catalog');
    assert.ok(searchProducts('makaroni').length > 0);
  });
});

describe('real catalog products', () => {
  it('460734 gluten-free flour mix with gluten-free wheat starch: gluten_free ok, wheat_free fail', () => {
    const p = real('460734');
    assert.ok(p.claims.includes('FREE_FROM_GLUTEN'), 'fixture: product carries the gluten-free claim');
    assert.match(p.ing ?? '', /gluteeniton vehnätärkkelys/i, 'fixture: ingredient list has gluten-free wheat starch');
    const gf = checkProduct(p, 'gluten_free', 'en');
    const wf = checkProduct(p, 'wheat_free', 'en');
    assert.equal(gf.verdict, 'ok');
    assert.equal(wf.verdict, 'fail');
    // the wheat verdict is explained from the ingredient list, and the gluten-free claim is NOT counted as support
    assert.ok(wf.evidence.some(e => e.kind === 'ingredient' && e.tone === 'fail' && /wheat starch/i.test(e.text)));
    assert.ok(!wf.evidence.some(e => e.kind === 'claim' && e.tone === 'ok'), 'gluten-free claim must not be positive evidence for wheat-free');
    assert.match(wf.summary, /wheat/i);
    // the gluten-free verdict warns about the wheat starch
    assert.ok(gf.evidence.some(e => e.tone === 'info' && /wheat/i.test(e.text)));
  });

  it('467032 gluten-free bread: declared allergens do not list wheat, ingredient list does -> wheat_free fail', () => {
    const p = real('467032');
    assert.equal(p.al.UW, undefined, 'fixture: wheat is not among the declared allergens');
    assert.equal(p.al.AW, 'F', 'fixture: supplier even declares "free from cereals containing gluten"');
    assert.match(p.ing ?? '', /GLUTEENITON VEHNÄTÄRKKELYS/);
    const wf = checkProduct(p, 'wheat_free', 'fi');
    assert.equal(wf.verdict, 'fail');
    assert.equal(wf.evidence[0].tone, 'fail', 'most important evidence comes first');
    assert.equal(wf.evidence[0].kind, 'ingredient');
    assert.equal(verdict(p, 'gluten_free'), 'ok');
    // "may contain traces of egg" in the ingredient list + declared M
    assert.equal(verdict(p, 'egg_free'), 'fail');
  });

  it('461219 stock without an allergen declaration: wheat_free unknown, never ok', () => {
    const p = real('461219');
    assert.equal(p.hasAl, false, 'fixture: no allergen declaration');
    const wf = checkProduct(p, 'wheat_free', 'en');
    assert.equal(wf.verdict, 'unknown');
    assert.ok(wf.evidence.some(e => e.kind === 'missing' && e.tone === 'unknown'));
    assert.match(wf.summary, /not used until/i);
    // nothing that is not backed by a regulated claim may be ok for this product
    for (const r of REQUIREMENTS) {
      const v = verdict(p, r);
      if (r === 'gluten_free' || r === 'lactose_free') assert.equal(v, 'ok', `${r} is backed by a regulated claim`);
      else assert.equal(v, 'unknown', `${r} has no declaration to rely on`);
    }
    assert.equal(allOk(checkAll(p, ['gluten_free', 'wheat_free'], 'fi')), false);
    assert.equal(worst(checkAll(p, ['gluten_free', 'wheat_free'], 'fi')), 'unknown');
  });

  it('464179 lactose-free milk drink: lactose_free ok, milk_free fail', () => {
    const p = real('464179');
    const lf = checkProduct(p, 'lactose_free', 'en');
    const mf = checkProduct(p, 'milk_free', 'en');
    assert.equal(lf.verdict, 'ok');
    assert.equal(mf.verdict, 'fail');
    assert.ok(lf.evidence.some(e => e.tone === 'info' && /milk/i.test(e.text)), 'lactose-free verdict notes that the product contains milk');
    assert.ok(!mf.evidence.some(e => e.kind === 'claim' && e.tone === 'ok'), 'lactose-free claim must not be positive evidence for milk-free');
    assert.ok(mf.evidence.some(e => e.kind === 'declared' && e.tone === 'fail'));
    assert.ok(mf.evidence.some(e => e.kind === 'ingredient' && e.tone === 'fail'));
  });

  it('460001 wheat macaroni: gluten_free fail and wheat_free fail', () => {
    const p = real('460001');
    assert.equal(verdict(p, 'gluten_free'), 'fail');
    assert.equal(verdict(p, 'wheat_free'), 'fail');
    assert.equal(worst(checkAll(p, ['gluten_free', 'wheat_free'], 'fi')), 'fail');
  });

  it('474235 maize pasta: gluten_free ok and wheat_free ok', () => {
    const p = real('474235');
    const checks = checkAll(p, ['gluten_free', 'wheat_free'], 'fi');
    assert.deepEqual(checks.map(c => c.verdict), ['ok', 'ok']);
    assert.equal(allOk(checks), true);
    // wheat-free rests on the declaration + ingredient list, not on the gluten-free claim
    const wf = checkProduct(p, 'wheat_free', 'en');
    assert.ok(wf.evidence.some(e => e.kind === 'declared' && e.tone === 'ok'));
    assert.ok(wf.evidence.some(e => e.kind === 'ingredient' && e.tone === 'ok'));
    assert.ok(!wf.evidence.some(e => e.kind === 'claim' && e.tone === 'ok'));
  });

  it('checkAll keeps the requested order and returns localized labels', () => {
    const p = real('464179');
    const reqs: Requirement[] = ['milk_free', 'gluten_free', 'lactose_free', 'wheat_free'];
    const checks = checkAll(p, reqs, 'fi');
    assert.deepEqual(checks.map(c => c.requirement), reqs);
    assert.deepEqual(checks.map(c => c.requirementLabel), ['Maidoton', 'Gluteeniton', 'Laktoositon', 'Vehnätön']);
    assert.deepEqual(checkAll(p, [], 'fi'), []);
  });

  it('verdicts do not depend on the language of the explanation', () => {
    for (const id of ['460734', '467032', '461219', '464179', '460001', '474235']) {
      const p = real(id);
      for (const r of REQUIREMENTS) {
        const [fi, sv, en] = LANGS.map(l => verdict(p, r, l));
        assert.equal(sv, fi, `${id} ${r} sv`);
        assert.equal(en, fi, `${id} ${r} en`);
      }
    }
  });
});

describe('evidence and summaries exist in fi, sv and en', () => {
  const cases: [string, Requirement][] = [['460734', 'wheat_free'], ['460734', 'gluten_free'], ['461219', 'wheat_free'], ['464179', 'milk_free'], ['464179', 'lactose_free'], ['474235', 'wheat_free']];
  for (const [id, r] of cases) {
    it(`${id} ${r}`, () => {
      const p = real(id);
      const by = Object.fromEntries(LANGS.map(l => [l, checkProduct(p, r, l)])) as Record<Lang, ReturnType<typeof checkProduct>>;
      for (const l of LANGS) {
        const c = by[l];
        assert.ok(c.summary.trim().length > 10, `${l} summary`);
        assert.ok(c.requirementLabel.trim().length > 0, `${l} label`);
        assert.ok(c.evidence.length > 0, `${l} evidence`);
        for (const e of c.evidence) assert.ok(e.text.trim().length > 5, `${l} evidence text`);
        assert.ok(!/undefined|\[object/.test(c.summary + c.evidence.map(e => e.text).join(' ')), `${l} text has no template leak`);
      }
      // same structure in every language, different words
      assert.deepEqual(by.sv.evidence.map(e => [e.kind, e.tone]), by.fi.evidence.map(e => [e.kind, e.tone]));
      assert.deepEqual(by.en.evidence.map(e => [e.kind, e.tone]), by.fi.evidence.map(e => [e.kind, e.tone]));
      assert.notEqual(by.fi.summary, by.sv.summary);
      assert.notEqual(by.fi.summary, by.en.summary);
      assert.notEqual(by.sv.summary, by.en.summary);
      assert.notEqual(by.fi.evidence[0].text, by.en.evidence[0].text);
      assert.notEqual(by.sv.evidence[0].text, by.en.evidence[0].text);
    });
  }

  it('requirement labels are localized', () => {
    const p = real('460734');
    assert.deepEqual(LANGS.map(l => checkProduct(p, 'wheat_free', l).requirementLabel), ['Vehnätön', 'Vetefri', 'Wheat-free']);
    assert.deepEqual(LANGS.map(l => checkProduct(p, 'gluten_free', l).requirementLabel), ['Gluteeniton', 'Glutenfri', 'Gluten-free']);
    assert.deepEqual(LANGS.map(l => checkProduct(p, 'milk_free', l).requirementLabel), ['Maidoton', 'Mjölkfri', 'Milk-free']);
    assert.deepEqual(LANGS.map(l => checkProduct(p, 'lactose_free', l).requirementLabel), ['Laktoositon', 'Laktosfri', 'Lactose-free']);
  });
});

describe('synthetic: missing data never becomes ok', () => {
  it('a product with no supplier data at all is unknown for every requirement', () => {
    const p = mk();
    for (const r of REQUIREMENTS) for (const l of LANGS) {
      const c = checkProduct(p, r, l);
      assert.equal(c.verdict, 'unknown', `${r} ${l}`);
      assert.ok(c.evidence.some(e => e.tone === 'unknown'), `${r} ${l} explains what is missing`);
      assert.ok(c.summary.length > 10);
    }
    assert.equal(allOk(checkAll(p, REQUIREMENTS, 'fi')), false);
    assert.equal(worst(checkAll(p, REQUIREMENTS, 'fi')), 'unknown');
  });

  it('an allergen declaration without an ingredient list is not enough', () => {
    const p = mk({ hasAl: true, al: { BM: 'C' } });
    for (const r of REQUIREMENTS) assert.equal(verdict(p, r), 'unknown', r);
  });

  it('an ingredient list without an allergen declaration is not enough', () => {
    const p = mk({ ing: 'vesi, sokeri, suola' });
    for (const r of REQUIREMENTS) assert.equal(verdict(p, r), 'unknown', r);
  });

  it('an empty ingredient string counts as missing', () => {
    const p = mk({ hasAl: true, al: { BM: 'C' }, ing: '' });
    for (const r of REQUIREMENTS) assert.equal(verdict(p, r), 'unknown', r);
  });

  it('an explicit "free from" declaration alone (no ingredient list) is not ok for the text-checked requirements', () => {
    const p = mk({ hasAl: true, al: { AM: 'F', AE: 'F', AN: 'F', AP: 'F', AY: 'F', AF: 'F', AW: 'F' } });
    for (const r of ['milk_free', 'egg_free', 'nut_free', 'soy_free', 'fish_free', 'gluten_free', 'wheat_free'] as Requirement[]) assert.equal(verdict(p, r), 'unknown', r);
  });
});

describe('synthetic: "may contain" means fail', () => {
  it('declared MAY_CONTAIN fails the matching requirement', () => {
    const base = { hasAl: true, ing: 'vesi, sokeri, suola' };
    assert.equal(verdict(mk({ ...base, al: { AM: 'M' } }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { AM: 'M' } }), 'lactose_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { ML: 'M' } }), 'lactose_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { UW: 'M' } }), 'wheat_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { UW: 'M' } }), 'gluten_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { GS: 'M' } }), 'wheat_free'), 'fail', 'spelt is wheat');
    assert.equal(verdict(mk({ ...base, al: { AW: 'M' } }), 'gluten_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { NR: 'M' } }), 'gluten_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { GO: 'M' } }), 'gluten_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { AE: 'M' } }), 'egg_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { AN: 'M' } }), 'nut_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { AP: 'M' } }), 'nut_free'), 'fail', 'peanut counts for nut-free');
    assert.equal(verdict(mk({ ...base, al: { SH: 'M' } }), 'nut_free'), 'fail', 'hazelnut');
    assert.equal(verdict(mk({ ...base, al: { AY: 'M' } }), 'soy_free'), 'fail');
    assert.equal(verdict(mk({ ...base, al: { AF: 'M' } }), 'fish_free'), 'fail');
  });

  it('"may contain cereals containing gluten" is never ok for wheat-free', () => {
    assert.notEqual(verdict(mk({ hasAl: true, al: { AW: 'M' }, ing: 'vesi, sokeri' }), 'wheat_free'), 'ok');
    assert.notEqual(verdict(mk({ hasAl: true, al: { AW: 'C' }, ing: 'vesi, sokeri' }), 'wheat_free'), 'ok');
  });

  it('declared MAY_CONTAIN beats a "free from" claim: gluten-free claim + may contain gluten cereal is a conflict, not ok', () => {
    const p = mk({ hasAl: true, al: { AW: 'M' }, claims: ['FREE_FROM_GLUTEN'], ing: 'riisijauho, vesi' });
    assert.equal(verdict(p, 'gluten_free'), 'unknown');
    assert.notEqual(verdict(p, 'wheat_free'), 'ok');
  });

  it('lactose: declared lactose (contains / may contain) fails even with a lactose-free claim', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'M' }, claims: ['FREE_FROM_LACTOSE'] }), 'lactose_free'), 'fail');
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'C' }, claims: ['FREE_FROM_LACTOSE'] }), 'lactose_free'), 'fail');
  });

  it('"may contain" written in the ingredient list fails, in Finnish, Swedish and English', () => {
    const free = { AM: 'F', AW: 'F', UW: 'F', AE: 'F', AN: 'F', AY: 'F', AF: 'F' } as const;
    const p = (ing: string) => mk({ hasAl: true, al: { ...free }, ing });
    assert.equal(verdict(p('Riisi, suola. Saattaa sisältää maitoa.'), 'milk_free'), 'fail');
    assert.equal(verdict(p('Riisi, suola. Saattaa sisältää pieniä määriä vehnää.'), 'wheat_free'), 'fail');
    assert.equal(verdict(p('Riisi, suola. Saattaa sisältää pieniä määriä vehnää.'), 'gluten_free'), 'fail');
    assert.equal(verdict(p('Rice, salt. May contain traces of wheat.'), 'wheat_free'), 'fail');
    assert.equal(verdict(p('Rice, salt. May contain traces of milk.'), 'milk_free'), 'fail');
    assert.equal(verdict(p('Ris, salt. Kan innehålla spår av vete.'), 'wheat_free'), 'fail');
    assert.equal(verdict(p('Ris, salt. Kan innehålla spår av mjölk.'), 'milk_free'), 'fail');
    assert.equal(verdict(p('Riisi. Saattaa sisältää soijaa.'), 'soy_free'), 'fail');
    assert.equal(verdict(p('Riisi. Saattaa sisältää kananmunaa.'), 'egg_free'), 'fail');
    assert.equal(verdict(p('Riisi. Saattaa sisältää kalaa.'), 'fish_free'), 'fail');
    assert.equal(verdict(p('Riisi. Saattaa sisältää pähkinää.'), 'nut_free'), 'fail');
    // the explanation says it is a trace statement
    const c = checkProduct(p('Rice, salt. May contain traces of wheat.'), 'wheat_free', 'en');
    assert.ok(c.evidence.some(e => e.tone === 'fail' && /may contain/i.test(e.text)));
  });
});

describe('synthetic: lactose-free and milk-free are separate', () => {
  it('LOW_LACTOSE claim is not lactose-free', () => {
    const p = mk({ hasAl: true, al: { AM: 'C' }, claims: ['LOW_LACTOSE'], ing: 'MAITO, suola' });
    const c = checkProduct(p, 'lactose_free', 'en');
    assert.equal(c.verdict, 'fail');
    assert.ok(c.evidence.some(e => e.kind === 'claim' && e.tone === 'fail' && /low-lactose/i.test(e.text)));
    assert.equal(verdict(p, 'milk_free'), 'fail');
    // even with no other data the low-lactose claim alone is a fail, never ok
    assert.equal(verdict(mk({ claims: ['LOW_LACTOSE'] }), 'lactose_free'), 'fail');
    assert.notEqual(verdict(mk({ claims: ['LOW_LACTOSE'] }), 'milk_free'), 'ok');
  });

  it('a lactose-free claim never makes a product milk-free', () => {
    assert.equal(verdict(mk({ claims: ['FREE_FROM_LACTOSE'] }), 'lactose_free'), 'ok');
    assert.equal(verdict(mk({ claims: ['FREE_FROM_LACTOSE'] }), 'milk_free'), 'unknown');
    assert.equal(verdict(mk({ claims: ['FREE_FROM_LACTOSE'], ing: 'vesi, sokeri' }), 'milk_free'), 'unknown');
    const withMilk = mk({ hasAl: true, al: { AM: 'C', ML: 'F' }, claims: ['FREE_FROM_LACTOSE'], ing: 'MAITO, D-vitamiini' });
    assert.equal(verdict(withMilk, 'lactose_free'), 'ok');
    assert.equal(verdict(withMilk, 'milk_free'), 'fail');
  });

  it('milk without any lactose-free declaration fails lactose-free', () => {
    const p = mk({ hasAl: true, al: { AM: 'C' }, ing: 'KERMA, suola' });
    assert.equal(verdict(p, 'lactose_free'), 'fail');
    assert.equal(verdict(p, 'milk_free'), 'fail');
  });

  it('declared lactose makes the product not milk-free', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'C' }, ing: 'vesi, sokeri' }), 'milk_free'), 'fail');
  });

  it('no milk at all: both ok, and the reason for lactose-free is "no milk"', () => {
    const p = mk({ hasAl: true, al: { AM: 'F' }, ing: 'vesi, sokeri, suola' });
    assert.equal(verdict(p, 'milk_free'), 'ok');
    const lf = checkProduct(p, 'lactose_free', 'en');
    assert.equal(lf.verdict, 'ok');
    assert.ok(lf.evidence.some(e => e.kind === 'note'));
  });
});

describe('synthetic: plant "milks", cocoa butter and lactic acid are not milk', () => {
  const silent = { hasAl: true, al: { AY: 'C' } as CatalogProduct['al'] };
  const lists: Record<string, string> = {
    'fi coconut milk / cocoa butter / lactic acid': 'kookosmaito, kaakaovoi, happamuudensäätöaine (maitohappo), sokeri',
    'en coconut milk / cocoa butter / lactic acid': 'coconut milk, cocoa butter, acidity regulator (lactic acid), sugar',
    'sv coconut milk / cocoa butter / lactic acid': 'kokosmjölk, kakaosmör, surhetsreglerande medel (mjölksyra), socker',
    'fi inflected forms': 'kookosmaitoa, kaakaovoita, maitohappoa, maitohappobakteeri, kookoskermaa',
    'fi oat / soy / almond / rice drinks': 'kauramaito, soijamaito, mantelimaito, riisimaito, kaurakerma',
    'en plant drinks and nut butters': 'oat milk, soy milk, almond milk, rice milk, coconut cream, peanut butter, shea butter',
    'fi peanut butter and shea butter': 'maapähkinävoi, sheavoi, kookosvoi',
    'fi "milk-free" statement': 'vesi, sokeri. Maidoton.',
  };
  for (const [name, ing] of Object.entries(lists)) {
    it(name, () => {
      const p = mk({ ...silent, ing });
      const c = checkProduct(p, 'milk_free', 'en');
      assert.equal(c.verdict, 'ok', c.evidence.map(e => e.text).join(' | '));
      assert.equal(verdict(p, 'lactose_free'), 'ok');
    });
  }

  it('real milk next to the look-alikes is still found', () => {
    assert.equal(verdict(mk({ ...silent, ing: 'kookosmaito, MAITO' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'kaakaovoi, VOI' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'maitohappo, kermajauhe' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'coconut milk, skimmed milk powder' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'cocoa butter, butter' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'kokosmjölk, grädde' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'heraproteiini, sokeri' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'juusto, suola' }), 'milk_free'), 'fail');
    assert.equal(verdict(mk({ ...silent, ing: 'sokeri, laktoosi' }), 'milk_free'), 'fail');
  });
});

describe('synthetic: buckwheat is not wheat', () => {
  const al = { AW: 'F' } as CatalogProduct['al'];
  for (const [lang, ing] of [['fi tattari', 'tattarijauho, vesi, suola'], ['en buckwheat', 'buckwheat flour, water, salt'], ['sv bovete', 'bovetemjöl, vatten, salt']]) {
    it(`${lang}: wheat_free ok and gluten_free ok`, () => {
      const p = mk({ hasAl: true, al, ing });
      assert.equal(verdict(p, 'wheat_free'), 'ok');
      assert.equal(verdict(p, 'gluten_free'), 'ok');
    });
  }
  it('buckwheat does not hide real wheat in the same list', () => {
    assert.equal(verdict(mk({ hasAl: true, al, ing: 'buckwheat flour, wheat flour' }), 'wheat_free'), 'fail');
    assert.equal(verdict(mk({ hasAl: true, al, ing: 'buckwheat flour, wheat flour' }), 'gluten_free'), 'fail');
    assert.equal(verdict(mk({ hasAl: true, al, ing: 'bovetemjöl, vetemjöl' }), 'wheat_free'), 'fail');
    assert.equal(verdict(mk({ hasAl: true, al, ing: 'tattarijauho, VEHNÄjauho' }), 'wheat_free'), 'fail');
  });
  it('wheat relatives count as wheat', () => {
    for (const ing of ['spelttijauho, vesi', 'durumvehnä, vesi', 'kamut, vesi', 'couscous, vesi', 'bulgur, vesi', 'mannasuurimo, vesi']) {
      assert.equal(verdict(mk({ hasAl: true, al, ing }), 'wheat_free'), 'fail', ing);
    }
  });
});

describe('synthetic: gluten-free oats', () => {
  it('gluten-free oats with the regulated claim are gluten_free ok', () => {
    for (const ing of ['gluteeniton KAURA 10 %, vesi', 'TÄYSJYVÄKAURA (gluteeniton), vesi, suola', 'gluten-free OATS, water', 'glutenfri HAVRE, vatten']) {
      const p = mk({ hasAl: true, al: { GO: 'C' }, claims: ['FREE_FROM_GLUTEN'], ing });
      const c = checkProduct(p, 'gluten_free', 'en');
      assert.equal(c.verdict, 'ok', `${ing}: ${c.evidence.map(e => e.text).join(' | ')}`);
      assert.ok(c.evidence.some(e => e.kind === 'claim' && e.tone === 'ok'));
    }
  });
  it('oats described as gluten-free but WITHOUT the claim are not ok', () => {
    assert.equal(verdict(mk({ hasAl: true, al: {}, ing: 'gluteeniton kaura, vesi' }), 'gluten_free'), 'unknown');
    assert.equal(verdict(mk({ hasAl: true, al: { GO: 'C' }, ing: 'gluteeniton kaura, vesi' }), 'gluten_free'), 'fail');
  });
  it('ordinary oats fail gluten-free', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { GO: 'C' }, ing: 'KAURAhiutale, vesi' }), 'gluten_free'), 'fail');
    assert.equal(verdict(mk({ hasAl: true, al: {}, ing: 'kaurahiutale, vesi' }), 'gluten_free'), 'fail');
  });
  it('gluten-free claim + unqualified gluten cereal in the ingredients is a conflict (unknown), not ok', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { GO: 'C' }, claims: ['FREE_FROM_GLUTEN'], ing: 'KAURAhiutale, vesi' }), 'gluten_free'), 'unknown');
    assert.equal(verdict(mk({ hasAl: true, al: {}, claims: ['FREE_FROM_GLUTEN'], ing: 'ohrajauho, vesi' }), 'gluten_free'), 'unknown');
  });
  it('gluten-free oats say nothing about wheat', () => {
    const p = mk({ hasAl: true, al: { GO: 'C' }, claims: ['FREE_FROM_GLUTEN'], ing: 'gluteeniton KAURA, vesi' });
    assert.notEqual(verdict(p, 'wheat_free'), 'ok');
  });
});

describe('synthetic: a gluten-free claim never makes wheat_free ok by itself', () => {
  const claim = ['FREE_FROM_GLUTEN'];
  it('claim only, no other data', () => assert.equal(verdict(mk({ claims: claim }), 'wheat_free'), 'unknown'));
  it('claim + clean ingredient list, no declaration', () => assert.equal(verdict(mk({ claims: claim, ing: 'riisijauho, vesi' }), 'wheat_free'), 'unknown'));
  it('claim + clean ingredient list + declaration that is silent about wheat and gluten cereals', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { AM: 'C' }, claims: claim, ing: 'riisijauho, vesi' }), 'wheat_free'), 'unknown');
  });
  it('claim + "free from gluten cereals" declaration but no ingredient list', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { AW: 'F' }, claims: claim }), 'wheat_free'), 'unknown');
  });
  it('claim + gluten-free wheat starch is a fail even when the supplier declares "free from gluten cereals"', () => {
    for (const ing of ['gluteeniton vehnätärkkelys, vesi', 'GLUTEN FREE WHEAT STARCH, water', 'glutenfri vetestärkelse, vatten', 'vehnätärkkelys (gluteeniton), vesi']) {
      const p = mk({ hasAl: true, al: { AW: 'F' }, claims: claim, ing });
      assert.equal(verdict(p, 'wheat_free'), 'fail', ing);
      assert.equal(verdict(p, 'gluten_free'), 'ok', ing);
    }
  });
  it('the claim is listed as information, never as positive evidence', () => {
    for (const p of [mk({ claims: claim }), mk({ hasAl: true, al: { AW: 'F' }, claims: claim, ing: 'riisijauho, vesi' })]) {
      const c = checkProduct(p, 'wheat_free', 'en');
      const ev = c.evidence.filter(e => e.kind === 'claim');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].tone, 'info');
    }
  });
  it('what does make wheat_free ok: a wheat declaration / wheat-free claim together with a clean ingredient list', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { UW: 'F' }, ing: 'riisijauho, vesi' }), 'wheat_free'), 'ok');
    assert.equal(verdict(mk({ hasAl: true, al: { AW: 'F' }, ing: 'riisijauho, vesi' }), 'wheat_free'), 'ok');
    assert.equal(verdict(mk({ claims: ['FREE_FROM_WHEAT'], ing: 'riisijauho, vesi' }), 'wheat_free'), 'ok');
  });
  it('and the reverse: a wheat-free claim never makes gluten_free ok', () => {
    assert.equal(verdict(mk({ claims: ['FREE_FROM_WHEAT'], ing: 'riisijauho, vesi' }), 'gluten_free'), 'unknown');
    assert.equal(verdict(mk({ hasAl: true, al: { NR: 'C' }, claims: ['FREE_FROM_WHEAT'], ing: 'RUISjauho, vesi' }), 'gluten_free'), 'fail');
  });
});

describe('catalog-wide invariants (all orderable products)', () => {
  it('a product with no ingredient list, no allergen declaration and no claim is never ok', () => {
    const bad: string[] = [];
    for (const p of everyProduct()) {
      if (p.ing || p.hasAl || p.claims.length) continue;
      for (const r of REQUIREMENTS) if (verdict(p, r) === 'ok') bad.push(`${p.id}:${r}`);
    }
    assert.deepEqual(bad, []);
  });

  it('declared CONTAINS / MAY_CONTAIN is never ok', () => {
    const map: [Requirement, string[]][] = [
      ['milk_free', ['AM']], ['wheat_free', ['UW', 'GS', 'GK']], ['egg_free', ['AE']], ['soy_free', ['AY']], ['fish_free', ['AF']],
      ['nut_free', ['AN', 'AP', 'SA', 'SH', 'SW', 'SC', 'SP', 'SR', 'ST', 'SM']], ['lactose_free', ['ML']],
    ];
    const bad: string[] = [];
    for (const p of everyProduct()) {
      for (const [r, codes] of map) {
        if (codes.some(k => p.al[k] === 'C' || p.al[k] === 'M') && verdict(p, r) !== 'fail') bad.push(`${p.id}:${r}`);
      }
      // gluten: a declared gluten cereal is only acceptable together with the regulated gluten-free claim
      const cereal = ['AW', 'UW', 'NR', 'GB', 'GO', 'GS', 'GK'].some(k => p.al[k] === 'C' || p.al[k] === 'M');
      if (cereal && !p.claims.includes('FREE_FROM_GLUTEN') && verdict(p, 'gluten_free') !== 'fail') bad.push(`${p.id}:gluten_free`);
    }
    assert.deepEqual(bad, []);
  });

  it('wheat_free ok always rests on a wheat / gluten-cereal declaration or a wheat-free claim, never on the gluten-free claim', () => {
    const bad: string[] = [];
    let ok = 0;
    for (const p of everyProduct()) {
      if (verdict(p, 'wheat_free') !== 'ok') continue;
      ok++;
      const backed = p.al.UW === 'F' || p.al.AW === 'F' || p.claims.includes('FREE_FROM_WHEAT');
      if (!backed) bad.push(p.id);
      if (/vehnä/i.test((p.ing ?? '').replace(/vehnät[oö]n\p{L}*/giu, ''))) bad.push(`${p.id}:mentions wheat`);
    }
    assert.ok(ok > 1000, 'sanity: the catalog has wheat-free products');
    assert.deepEqual(bad, []);
  });

  it('every product with gluten-free wheat starch is gluten_free-compatible at best, and always wheat_free fail', () => {
    const bad: string[] = [];
    let n = 0;
    for (const p of everyProduct()) {
      if (!/gluteeniton\s+vehnätärkkelys/i.test(p.ing ?? '')) continue;
      n++;
      if (verdict(p, 'wheat_free') !== 'fail') bad.push(p.id);
    }
    assert.ok(n > 20, 'sanity: the catalog has gluten-free wheat starch products');
    assert.deepEqual(bad, []);
  });

  it('lactose-free claimed milk products are lactose_free ok and milk_free fail', () => {
    const bad: string[] = [];
    let n = 0;
    for (const p of everyProduct()) {
      if (!p.claims.includes('FREE_FROM_LACTOSE') || p.al.AM !== 'C' || p.al.ML === 'C' || p.al.ML === 'M') continue;
      n++;
      if (verdict(p, 'lactose_free') !== 'ok' || verdict(p, 'milk_free') !== 'fail') bad.push(p.id);
    }
    assert.ok(n > 100, 'sanity: the catalog has lactose-free dairy');
    assert.deepEqual(bad, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Expected behaviour that the current rules do NOT meet. Each failing test below is a real defect
// in src/allergens.ts (kept as a hard assertion on purpose; see the report of this suite).
// ---------------------------------------------------------------------------------------------
describe('defects: data the supplier marks as UNDECLARED must not become ok', () => {
  it('synthetic: declared level "U" (supplier has not declared) is unknown, not ok', () => {
    const ing = 'vesi, sokeri, suola';
    assert.notEqual(verdict(mk({ hasAl: true, al: { AM: 'U' }, ing }), 'milk_free'), 'ok', 'milk undeclared');
    assert.notEqual(verdict(mk({ hasAl: true, al: { AM: 'U' }, ing }), 'lactose_free'), 'ok', 'milk undeclared -> lactose');
    assert.notEqual(verdict(mk({ hasAl: true, al: { AW: 'U' }, ing }), 'gluten_free'), 'ok', 'gluten cereals undeclared');
    assert.notEqual(verdict(mk({ hasAl: true, al: { AE: 'U' }, ing }), 'egg_free'), 'ok', 'egg undeclared');
    assert.notEqual(verdict(mk({ hasAl: true, al: { AN: 'U', AP: 'U' }, ing }), 'nut_free'), 'ok', 'nuts undeclared');
    assert.notEqual(verdict(mk({ hasAl: true, al: { AY: 'U' }, ing }), 'soy_free'), 'ok', 'soy undeclared');
    assert.notEqual(verdict(mk({ hasAl: true, al: { AF: 'U' }, ing }), 'fish_free'), 'ok', 'fish undeclared');
  });

  it('real 469698 (ice cream, nuts/egg/soy/gluten cereals all marked undeclared; English list says "may contain barley, egg, nut and soy")', () => {
    const p = real('469698');
    assert.equal(p.al.AN, 'U', 'fixture');
    assert.equal(p.al.AE, 'U', 'fixture');
    assert.equal(p.al.AY, 'U', 'fixture');
    assert.equal(p.al.AW, 'U', 'fixture');
    assert.match(p.ing_en ?? '', /May contain barley, egg, nut and soy/);
    for (const r of ['nut_free', 'egg_free', 'soy_free', 'gluten_free'] as Requirement[]) {
      const c = checkProduct(p, r, 'en');
      assert.notEqual(c.verdict, 'ok', `${r}: ${c.evidence.map(e => `[${e.tone}] ${e.text}`).join(' | ')}`);
    }
  });

  it('catalog-wide: no product gets ok for a requirement whose allergen code is "U" and never "F"', () => {
    const map: [Requirement, string[]][] = [
      ['milk_free', ['AM']], ['egg_free', ['AE']], ['soy_free', ['AY']], ['fish_free', ['AF']], ['nut_free', ['AN', 'AP']],
      ['gluten_free', ['AW']],
    ];
    const bad: string[] = [];
    for (const p of everyProduct()) {
      for (const [r, codes] of map) {
        if (codes.some(k => p.al[k] === 'U') && !codes.some(k => p.al[k] === 'F') && verdict(p, r) === 'ok') bad.push(`${p.id}:${r}`);
      }
    }
    assert.deepEqual(bad.slice(0, 12), [], `${bad.length} product/requirement pairs are ok although the supplier marked the allergen as undeclared`);
  });

  it('synthetic: a placeholder ingredient list ("-", ".") is missing data, not a clean list', () => {
    for (const ing of ['-', '.', ',', '(.)']) {
      const p = mk({ hasAl: true, al: { BM: 'C' }, ing });
      for (const r of ['milk_free', 'egg_free', 'nut_free', 'soy_free', 'fish_free', 'gluten_free', 'lactose_free'] as Requirement[]) {
        assert.notEqual(verdict(p, r), 'ok', `ingredient list ${JSON.stringify(ing)} -> ${r}`);
      }
    }
  });
});

describe('defects: allergen words the ingredient scan misses (false "ok")', () => {
  it('synthetic: "saattaa sisältää pähkinöitä" (partitive plural of nut) fails nut_free', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { AM: 'C' }, ing: 'MAITO, sokeri. Saattaa sisältää pähkinöitä.' }), 'nut_free'), 'fail');
    assert.equal(verdict(mk({ hasAl: true, al: { AM: 'C' }, ing: 'MAITO, sokeri. Saattaa sisältää hasselpähkinöitä.' }), 'nut_free'), 'fail');
  });

  it('real 471146 and 472632 (ice creams whose Finnish list says "Saattaa sisältää (hassel)pähkinöitä") are not nut_free ok', () => {
    for (const id of ['471146', '472632']) {
      const p = real(id);
      assert.match(p.ing ?? '', /Saattaa sisältää (hassel)?pähkinöitä/, 'fixture');
      const c = checkProduct(p, 'nut_free', 'en');
      assert.notEqual(c.verdict, 'ok', `${id}: ${c.evidence.map(e => `[${e.tone}] ${e.text}`).join(' | ')}`);
    }
  });

  it('synthetic: "MUNAT" (eggs, plural) fails egg_free', () => {
    assert.equal(verdict(mk({ hasAl: true, al: { AM: 'C' }, ing: 'Sokeri, MAITO, vesi, MUNAT, VEHNÄjauho' }), 'egg_free'), 'fail');
    assert.equal(verdict(mk({ hasAl: true, al: { AM: 'C' }, ing: 'sokeri, munia, vesi' }), 'egg_free'), 'fail');
  });

  it('real 467394 (chocolate cake whose Finnish list contains "MUNAT", egg not among declared allergens) is not egg_free ok', () => {
    const p = real('467394');
    assert.match(p.ing ?? '', /MUNAT/, 'fixture');
    assert.match(p.ing_en ?? '', /EGGS/, 'fixture');
    const c = checkProduct(p, 'egg_free', 'en');
    assert.notEqual(c.verdict, 'ok', c.evidence.map(e => `[${e.tone}] ${e.text}`).join(' | '));
  });

  it('synthetic: "may contain lactose" (ML = M) is not milk_free ok', () => {
    assert.notEqual(verdict(mk({ hasAl: true, al: { ML: 'M' }, ing: 'vesi, sokeri' }), 'milk_free'), 'ok');
  });
});

describe('defects: false alarms', () => {
  it('synthetic: the Finnish verb "voi" in "Voi sisältää ..." (= may contain) is not butter', () => {
    const p = mk({ hasAl: true, al: { AM: 'F', AN: 'M' }, ing: 'Riisi, suola. Voi sisältää pähkinää.' });
    const c = checkProduct(p, 'milk_free', 'en');
    assert.equal(c.verdict, 'ok', c.evidence.map(e => `[${e.tone}] ${e.text}`).join(' | '));
    assert.equal(verdict(p, 'nut_free'), 'fail', 'the trace statement itself must still count');
  });

  it('real 462841 (Valrhona cocoa butter: "Voi sisältää jäämiä pähkinöistä ja soijasta") is not blocked for milk because of the verb "voi"', () => {
    const p = real('462841');
    assert.match(p.ing ?? '', /Voi sisältää jäämiä pähkinöistä ja soijasta/, 'fixture');
    const c = checkProduct(p, 'milk_free', 'en');
    assert.ok(!c.evidence.some(e => e.tone === 'fail' && /”Voi”/.test(e.text)), c.evidence.map(e => `[${e.tone}] ${e.text}`).join(' | '));
  });
});

// ---------------------------------------------------------------------------------------------
// Regression set for the "undeclared" level (U) on real catalog products. An allergen the supplier
// explicitly left undeclared gives "unknown" for the requirement it concerns, and only for that one.
// ---------------------------------------------------------------------------------------------
describe('UNDECLARED level on real catalog products', () => {
  const verdicts = (id: string) => Object.fromEntries(REQUIREMENTS.map(r => [r, verdict(real(id), r)]));
  const undeclaredCodes = (id: string) => Object.entries(real(id).al).filter(([, l]) => l === 'U').map(([k]) => k).sort();

  it('33 catalog products carry at least one undeclared allergen', () => {
    assert.equal(everyProduct().filter(p => Object.values(p.al).includes('U')).length, 33);
  });

  it('465565 fries: only gluten cereals undeclared -> gluten_free and wheat_free unknown, nothing else changes', () => {
    assert.deepEqual(undeclaredCodes('465565'), ['AW']);
    assert.deepEqual(verdicts('465565'), { gluten_free: 'unknown', wheat_free: 'unknown', lactose_free: 'ok', milk_free: 'ok', egg_free: 'ok', nut_free: 'ok', soy_free: 'ok', fish_free: 'ok' });
    for (const lang of LANGS) {
      const c = checkProduct(real('465565'), 'gluten_free', lang);
      assert.ok(c.evidence.some(e => e.kind === 'declared' && e.tone === 'unknown'), `${lang}: the undeclared allergen is the evidence`);
      assert.ok(c.summary.length > 20);
    }
  });

  it('463083 sesame seeds: gluten cereals undeclared next to explicit "free from" statements for the others', () => {
    const p = real('463083');
    assert.equal(p.al.AW, 'U', 'fixture');
    assert.equal(p.al.AM, 'F', 'fixture');
    const v = verdicts('463083');
    assert.equal(v.gluten_free, 'unknown');
    assert.equal(v.wheat_free, 'unknown');
    assert.equal(v.milk_free, 'ok');
    assert.equal(v.egg_free, 'ok');
    assert.equal(v.fish_free, 'ok');
  });

  it('460556 mustard and 465464 corn cake: a gluten-free claim does not outweigh undeclared gluten cereals', () => {
    for (const id of ['460556', '465464']) {
      const p = real(id);
      assert.ok(p.claims.includes('FREE_FROM_GLUTEN'), `${id} fixture: gluten-free claim`);
      assert.equal(p.al.AW, 'U', `${id} fixture: gluten cereals undeclared`);
      for (const lang of LANGS) {
        const c = checkProduct(p, 'gluten_free', lang);
        assert.equal(c.verdict, 'unknown', `${id} ${lang}`);
        assert.ok(c.evidence.some(e => e.kind === 'claim' && e.tone === 'ok'), 'the claim is still shown');
        assert.ok(c.evidence.some(e => e.kind === 'declared' && e.tone === 'unknown'), 'and the undeclared cereal is what decides');
      }
      assert.equal(verdict(p, 'wheat_free'), 'unknown');
    }
    // 460556 also has milk undeclared: milk_free is unknown, while the lactose-free claim speaks about lactose itself
    assert.equal(real('460556').al.AM, 'U', 'fixture');
    assert.equal(real('460556').al.ML, undefined, 'fixture: lactose itself is not marked undeclared');
    assert.equal(verdict(real('460556'), 'milk_free'), 'unknown');
    assert.equal(verdict(real('460556'), 'lactose_free'), 'ok');
  });

  it('464167 cane sugar: every allergen undeclared -> every requirement unknown', () => {
    for (const r of REQUIREMENTS) assert.equal(verdict(real('464167'), r), 'unknown', r);
  });

  it('465233 and 471195: nuts undeclared never gives nut_free ok', () => {
    for (const id of ['465233', '471195']) {
      assert.equal(real(id).al.AN, 'U', `${id} fixture`);
      assert.notEqual(verdict(real(id), 'nut_free'), 'ok', id);
    }
  });

  it('an undeclared allergen that no supported requirement concerns does not spread (475061 mustard, 476428 crustaceans)', () => {
    assert.deepEqual(undeclaredCodes('475061'), ['BM']);
    assert.deepEqual(undeclaredCodes('476428'), ['AC']);
    for (const r of ['egg_free', 'nut_free', 'soy_free', 'fish_free', 'gluten_free', 'lactose_free'] as Requirement[]) assert.equal(verdict(real('475061'), r), 'ok', `475061 ${r}`);
    for (const r of ['egg_free', 'nut_free', 'soy_free', 'milk_free', 'lactose_free', 'gluten_free'] as Requirement[]) assert.equal(verdict(real('476428'), r), 'ok', `476428 ${r}`);
  });

  it('synthetic: undeclared lactose blocks lactose_free and milk_free, also next to a lactose-free claim', () => {
    const ing = 'vesi, sokeri, suola';
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'U' }, ing, claims: ['FREE_FROM_LACTOSE'] }), 'lactose_free'), 'unknown');
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'U', AM: 'F' }, ing }), 'lactose_free'), 'unknown');
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'U', AM: 'F' }, ing }), 'milk_free'), 'unknown');
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'U', AM: 'C' }, ing }), 'milk_free'), 'fail', 'a declared "contains" still fails');
    assert.equal(verdict(mk({ hasAl: true, al: { ML: 'F', AM: 'F' }, ing }), 'milk_free'), 'ok');
    assert.equal(verdict(mk({ hasAl: true, al: { GB: 'U' }, ing, claims: ['FREE_FROM_GLUTEN'] }), 'gluten_free'), 'unknown');
    assert.equal(verdict(mk({ hasAl: true, al: { AW: 'F' }, ing, claims: ['FREE_FROM_GLUTEN'] }), 'gluten_free'), 'ok');
  });

  it('catalog-wide, without exceptions: no requirement is ok while one of its allergen codes is undeclared', () => {
    const codes: Record<Requirement, string[]> = {
      gluten_free: ['AW', 'UW', 'NR', 'GB', 'GO', 'GS', 'GK'], wheat_free: ['UW', 'GS', 'GK', 'AW'], lactose_free: ['ML'], milk_free: ['AM', 'ML'],
      egg_free: ['AE'], nut_free: ['AN', 'AP', 'SA', 'SH', 'SW', 'SC', 'SP', 'SR', 'ST', 'SM'], soy_free: ['AY'], fish_free: ['AF'],
    };
    const bad: string[] = [];
    let pairs = 0;
    for (const p of everyProduct()) for (const r of REQUIREMENTS) {
      if (!codes[r].some(k => p.al[k] === 'U')) continue;
      pairs++;
      if (verdict(p, r) === 'ok') bad.push(`${p.id}:${r}`);
    }
    assert.ok(pairs > 100, `the catalog has ${pairs} product/requirement pairs with an undeclared allergen`);
    assert.deepEqual(bad, []);
  });
});
