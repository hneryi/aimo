// Read-only, offline catalog audit. No offers, state, model or keys are needed.
import { catalogSize, loadCatalog, searchProducts } from '../src/catalog.ts';
import { needCandidates } from '../src/orders.ts';
import type { Requirement } from '../../shared/types.ts';
loadCatalog();
const cases: [string, 'kg' | 'L' | 'pcs', Requirement[]][] = [
  ['jauhoseos', 'kg', ['gluten_free', 'wheat_free']], ['sokeri', 'kg', ['gluten_free', 'wheat_free']],
  ['mansikka', 'kg', ['gluten_free', 'wheat_free']], ['kuohukerma', 'L', ['gluten_free', 'wheat_free']],
  ['kananmuna', 'pcs', ['gluten_free', 'wheat_free']], ['maitojuoma', 'L', ['lactose_free']],
  ['riisi', 'kg', []], ['ruokakerma', 'L', []], ['olut', 'pcs', []], ['alkoholiton olut', 'pcs', []],
  ['voi', 'kg', []], ['kerma', 'L', []], ['omena', 'kg', []], ['suola', 'kg', []], ['suklaa', 'kg', []], ['kaurajuoma', 'L', []], ['kahvi', 'pcs', []], ['kofeiiniton kahvi', 'pcs', []],
];
console.log('| Query | Name hits | Structured unit | Relevant | Types | Verified | Decision before offers |');
console.log('|---|---:|---:|---:|---:|---:|---|');
for (const [query, unit, reqs] of cases) {
  const usable = (p: ReturnType<typeof searchProducts>[number]) => unit === 'pcs' ? !!p.n : p.per?.u === unit;
  const all = searchProducts(query, { limit: catalogSize() });
  const s = needCandidates(query, reqs, 'en', usable);
  console.log(`| ${query} | ${all.length} | ${all.filter(usable).length} | ${s.matchCount} | ${s.typeCount} | ${s.products.length} | ${s.selectionRequired ? 'selection_required' : s.products.length ? 'eligible' : 'not_found'} |`);
}
