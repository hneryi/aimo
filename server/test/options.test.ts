// Offline regressions using the real catalog, a local supplier stub and an isolated account store.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, it } from 'node:test';
import express from 'express';
import type { Lang } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const stub = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-options-'));
Object.assign(process.env, {
  VALIO_BASE_URL: stub.url, VALIO_API_KEY: 'offline-test', STATE_FILE: join(dir, 'state.json'), DATA_DIR: dir,
  AGENT_TOKEN: 'offline-token', CUTOFF_MODE: 'warn', VERDA_API_KEY: '', VERDA_BASE_URL: stub.url,
});
const { getProduct, loadCatalog, productView } = await import('../src/catalog.ts');
const { sourceNeed, approveOrder, orderView } = await import('../src/orders.ts');
const { findAlternatives, swapLine } = await import('../src/planner.ts');
const { handleChat } = await import('../src/app.ts');
const { handleMcp } = await import('../src/mcp.ts');
const { loadState, resetState, S } = await import('../src/store.ts');
loadCatalog(); loadState();
const app = express(); app.use(express.json());
app.all('/mcp', (req, res) => { void handleMcp(req, res); });
const http = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => http.once('listening', resolve));
const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
after(async () => { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); await stub.close(); rmSync(dir, { recursive: true, force: true }); });
let seq = 0, date: string;
beforeEach(() => {
  resetState(); stub.offers.clear(); stub.mode = 'ok';
  stub.fallback = { price: 2, amount: 500, closingTime: '2099-01-01T17:00:00+0200' };
  date = `2027-01-${String(++seq).padStart(2, '0')}`; // separate browse-cache key per test
});
let rpc = 0;
async function tool(name: string, args: Record<string, unknown>, account = 'school') {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer offline-token', 'x-aimo-account': account },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const frames = text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
  const result = JSON.parse(frames.length ? frames.at(-1)! : text).result;
  return { error: !!result.isError, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
}
const product = (id: string) => { const p = getProduct(id); assert.ok(p); return p; };
const roles = (s: Awaited<ReturnType<typeof sourceNeed>>) => s.options.flatMap(o => o.roles?.map(r => r.role) ?? []);
const quoteReplacement = (id = '460325', from = '465354') => tool('prepare_order', { delivery_date: date, items: [{ product_id: id, quantity: 1, substitute_for: from }] });

it('catalog carries only real packaging labels and exact supplier origins on all 17,546 products', () => {
  const raw = JSON.parse(readFileSync(new URL('../../data/raw/products.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(readFileSync(new URL('../../data/catalog.json', import.meta.url), 'utf8'));
  assert.equal(catalog.length, 17546);
  const byId = new Map(raw.map((p: any) => [String(p.id), p]));
  for (const p of catalog) {
    const r: any = byId.get(p.id);
    const labels = [...new Set((r.synkkaData?.classifications ?? []).filter((c: any) => c.name === 'packagingMarkedLabel').flatMap((c: any) => c.values.map((v: any) => v.id)).filter((id: string) => !['warmTemperature', 'coolTemperature', 'freezeTemperature'].includes(id)))].sort();
    assert.deepEqual(p.labels ?? [], labels, p.id);
    assert.equal(p.origin, r.countryOfOrigin || undefined, p.id);
  }
});

it('product views and MCP expose localized labels, origin and a supplier-declaration disclaimer', async () => {
  for (const lang of ['fi', 'sv', 'en'] as Lang[]) {
    const view = productView(product('464306'), lang);
    assert.equal(view.countryOfOrigin, 'fi');
    assert.equal(view.packagingLabels?.[0].name, { fi: 'Hyvää Suomesta', sv: 'Gott från Finland', en: 'Food from Finland' }[lang]);
    assert.ok(view.packagingLabelNote);
    const r = await tool('check_allergens', { product_id: '464306', requirements: [], lang });
    assert.equal(r.error, false);
    assert.deepEqual(r.data.packaging_labels, view.packagingLabels);
    assert.equal(r.data.country_of_origin, 'fi');
    assert.equal(r.data.packaging_label_note, view.packagingLabelNote);
  }
  const unknown = productView(product('468569'), 'fi').packagingLabels!.find(x => x.id === 'KRAV_MARK');
  assert.equal(unknown?.name, 'KRAV_MARK', 'untranslated labels are not hidden');
});

it('all nine common packaging labels have readable names in all three languages', () => {
  const cases: [string, string, string[]][] = [
    ['460000', 'GOODS_FROM_FINLAND_BLUE_SWAN', ['Hyvää Suomesta', 'Gott från Finland', 'Food from Finland']],
    ['460084', 'MADE_IN_FINLAND_FLAG_WITH_KEY', ['Avainlippu', 'Nyckelflaggan', 'Key Flag']],
    ['460093', 'FINNISH_HEART_SYMBOL', ['Sydänmerkki', 'Hjärtmärket', 'Heart Symbol']],
    ['460191', 'EU_ORGANIC_FARMING', ['EU-luomu', 'EU-ekologiskt', 'EU organic']],
    ['460023', 'SVANEN', ['Joutsenmerkki', 'Svanenmärket', 'Nordic Swan Ecolabel']],
    ['460448', 'RAINFOREST_ALLIANCE', ['Rainforest Alliance', 'Rainforest Alliance', 'Rainforest Alliance']],
    ['460028', 'EU_ECO_LABEL', ['EU-ympäristömerkki', 'EU-miljömärket', 'EU Ecolabel']],
    ['460038', 'MARINE_STEWARDSHIP_COUNCIL_LABEL', ['MSC', 'MSC', 'MSC']],
    ['460638', 'FAIR_TRADE_MARK', ['Reilu kauppa', 'Fairtrade', 'Fairtrade']],
  ];
  for (const [id, label, names] of cases) for (const [i, lang] of (['fi', 'sv', 'en'] as Lang[]).entries()) {
    assert.equal(productView(product(id), lang).packagingLabels!.find(l => l.id === label)?.name, names[i]);
  }
});

it('three named choices have structured evidence while allocation remains cheapest', async () => {
  // Whole-word "riisi" includes organic rice, while the cheapest has no history.
  stub.offers.set('468026', { ...stub.fallback, price: 1 });
  const s = await sourceNeed('riisi', 20, 'kg', [], date, 'en');
  assert.equal(s.selectionRequired, undefined);
  assert.equal(s.allocation[0].product.id, '468026');
  assert.equal(s.net, 2);
  assert.deepEqual(roles(s), ['cheapest', 'most_reliable', 'most_sustainable']);
  assert.equal(s.options.length, 3);
  for (const o of s.options) {
    const p = product(o.product.id);
    assert.equal(o.basis!.costToCover, o.basis!.salesUnits * o.offer.price!);
    assert.equal(o.basis!.reliability, p.rel);
    assert.deepEqual(o.basis!.packagingLabels, p.labels ?? []);
    assert.equal(o.basis!.countryOfOrigin, p.origin);
    assert.equal(o.basis!.co2PerKg, p.co2);
  }
  const sustainable = s.options.find(o => o.roles?.some(r => r.role === 'most_sustainable'))!;
  assert.ok(sustainable.product.packagingLabels?.some(l => l.id === 'EU_ORGANIC_FARMING'));
  assert.match(sustainable.basis!.sustainabilityRule!, /Not a product life-cycle/);
  const r = await tool('prepare_order', { delivery_date: date, need: { query: 'riisi', amount: 20, unit: 'kg' } });
  assert.equal(r.error, false);
  assert.equal(r.data.lines[0].product_id, '468026');
  assert.equal(r.data.total_excl_vat, 2);
  assert.equal(r.data.ranked_options.length, 3);
  assert.deepEqual(r.data.ranked_options[2].roles, sustainable.roles);
  assert.equal(r.data.ranked_options[2].basis.cost_to_cover_eur_excl_vat, sustainable.basis!.costToCover);
});

it('sustainability prefers declared Finnish origin among labelled options, not lower price or extra health labels', async () => {
  stub.offers.set('462297', { ...stub.fallback, price: 0.01 }); // Danish organic oats, cheapest
  const s = await sourceNeed('kaurahiutale', 1, 'kg', [], date, 'en');
  assert.equal(s.selectionRequired, undefined);
  assert.equal(s.allocation[0].product.id, '462297');
  const sustainable = s.options.find(o => o.roles?.some(r => r.role === 'most_sustainable'))!;
  assert.equal(sustainable.product.countryOfOrigin, 'fi');
  assert.ok(sustainable.product.packagingLabels?.some(l => l.id === 'EU_ORGANIC_FARMING'));
  assert.equal(sustainable.basis!.co2PerKg, 0.995);
});

it('comparable category CO2 breaks a sustainability tie without changing the cheapest allocation', async () => {
  stub.offers.set('468569', { ...stub.fallback, price: 0.5 });
  const s = await sourceNeed('organic sugar', 1, 'kg', [], date, 'en');
  assert.equal(s.selectionRequired, undefined);
  assert.equal(s.allocation[0].product.id, '468569');
  const sustainable = s.options.find(o => o.roles?.some(r => r.role === 'most_sustainable'))!;
  assert.equal(sustainable.product.id, '468706');
  assert.equal(sustainable.basis!.co2PerKg, 0.79);
  assert.equal(sustainable.basis!.salesUnits, 1);
  assert.equal(sustainable.basis!.coveredAmount, 25, 'the large excess remains explicit');
  assert.equal(sustainable.basis!.costToCover, 2);
  assert.equal(product('468569').co2, 0.885);
});

it('same product holds multiple roles once; missing history and environmental labels create no roles', async () => {
  stub.offers.set('460325', { ...stub.fallback, price: 0.5 });
  const sugar = await sourceNeed('sokeri', 2, 'kg', [], date, 'fi');
  assert.equal(sugar.allocation[0].product.id, '460325');
  assert.equal(sugar.options.length, 1);
  assert.deepEqual(roles(sugar), ['cheapest', 'most_reliable']);
  const noData = await sourceNeed('Sunrice', 10, 'kg', [], date, 'en', '468026');
  assert.deepEqual(roles(noData), ['cheapest']);
  const organic = await sourceNeed('riisi', 1, 'kg', [], date, 'en', '468146');
  assert.equal(organic.options.length, 1);
  assert.deepEqual(roles(organic), ['cheapest', 'most_reliable', 'most_sustainable']);
});

it('chat quick-order cards carry named options and still order Siro', async () => {
  stub.offers.set('460325', { ...stub.fallback, price: 0.5 });
  const r = await handleChat('Tilaa 2 kg sokeria', 'fi');
  const options = r.cards.find(c => c.type === 'products');
  assert.ok(options?.type === 'products');
  assert.ok(options.items[0].roles?.some(r => r.role === 'cheapest'));
  assert.ok(options.items.every(o => o.suitable && o.checks.every(c => c.verdict === 'ok')));
  const order = r.cards.find(c => c.type === 'order');
  assert.ok(order?.type === 'order');
  assert.equal(order.order.lines[0].productId, '460325');
});

it('supplier substitutes rank first even outside the search text; ordinary alternatives retain category/cost order', async () => {
  const original = product('464306');
  stub.offers.set('464201', { ...stub.fallback, price: 20 });
  stub.offers.set('464398', { ...stub.fallback, price: 21 });
  stub.offers.set('469363', { ...stub.fallback, price: 22 });
  const list = await findAlternatives('maitojuoma', ['lactose_free'], 'L', 10, 'en', date, [original.id], original, 20);
  assert.deepEqual(list.slice(0, 3).map(a => a.product.id), ['464201', '464398', '469363']);
  assert.ok(list.slice(0, 3).every(a => a.tier === 'supplier_substitute' && /Supplier/.test(a.tierLabel!)));
  assert.ok(list.slice(3).every(a => a.tier === 'same_category'));
  assert.ok(list.every(a => a.checks.every(c => c.verdict === 'ok')));
  const ordinaryCosts = list.slice(3).map(a => Math.ceil(10 / a.product.packSize!.value) * a.offer.price!);
  assert.deepEqual(ordinaryCosts, [...ordinaryCosts].sort((a, b) => a - b));
});

it('supplier substitutes with failed or missing allergen data or insufficient stock are never alternatives', async () => {
  const original = product('462045'); // supplier substitute has may-contain nuts
  const safe = await findAlternatives('chia', ['nut_free'], 'kg', 1, 'en', date, [original.id], original, 20);
  assert.ok(!safe.some(a => a.product.id === '464436'));
  const tomato = product('460027'); // supplier's replacement has no declaration
  const verified = await findAlternatives('tomaatti', ['wheat_free'], 'kg', 1, 'en', date, [tomato.id], tomato, 20);
  assert.ok(!verified.some(a => a.product.id === '460065'));
  stub.offers.set('464201', { ...stub.fallback, amount: 1 });
  const milk = await findAlternatives('maitojuoma', ['lactose_free'], 'L', 10, 'en', date, ['464306'], product('464306'), 20);
  assert.ok(!milk.some(a => a.product.id === '464201'));
});

it('new declared replacement needs human approval, then the submitted product is accepted next time', async () => {
  const q = await quoteReplacement();
  assert.equal(q.error, false);
  assert.equal(q.data.lines[0].substitute_for, '465354');
  assert.equal(q.data.lines[0].substitution, true);
  assert.ok(q.data.approval_required_because.some((s: string) => /substitute products/.test(s)));
  const blocked = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: 'new-substitution' });
  assert.equal(blocked.data.error, 'approval_required');
  assert.equal(S().orders.length, 0);
  const pending = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: 'approve-substitution' });
  assert.equal(pending.data.order.lines[0].substitute_for, '465354');
  assert.match(pending.data.order.lines[0].substitution_note, /Replaces/);
  const approved = await approveOrder(pending.data.order.order_id);
  assert.equal(approved.status, 'submitted');
  const again = await quoteReplacement();
  assert.equal(again.data.lines[0].substitution, false);
  assert.equal(again.data.within_agent_authority, true);
  const placed = await tool('place_order', { quote_id: again.data.quote_id, idempotency_key: 'known-substitution' });
  assert.equal(placed.data.order.status, 'submitted');
  const elsewhere = await tool('prepare_order', { delivery_date: date, items: [{ product_id: '460325', quantity: 1, substitute_for: '465354' }] }, 'hotel');
  assert.equal(elsewhere.data.lines[0].substitution, true, 'another account has not accepted it');
});

it('substitute metadata survives changed-price approval, then a second approval submits', async () => {
  const q = await quoteReplacement();
  const pending = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: 'repriced-substitution' });
  const id = pending.data.order.order_id;
  stub.offers.set('460325', { ...stub.fallback, price: 3 });
  const first = await approveOrder(id);
  assert.equal(first.status, 'pending_approval');
  assert.equal(first.recheck?.repriced, true);
  assert.equal(first.lines[0].unitPrice, 3);
  assert.equal(first.lines[0].substituteFor, '465354');
  assert.equal(first.lines[0].substitution, true);
  const second = await approveOrder(id);
  assert.equal(second.status, 'submitted');
  assert.equal(second.lines[0].substituteFor, '465354');
  assert.equal(second.lines[0].substitution, true);
  for (const lang of ['fi', 'sv', 'en'] as Lang[]) assert.ok(orderView(second, lang).lines[0].substitutionLabel?.includes('465354'));
});

it('kitchen-approved swap memory exempts the product without a parallel memory', async () => {
  // Drive the existing human swap path, using a minimal real-product plan line.
  const p = product('465354');
  swapLine(p.id, '460325', 'en', { lines: [{ id: p.id, ingredient: 'Sugar', unit: 'kg', checks: [] }] } as any);
  assert.equal(S().swaps[p.id], '460325');
  assert.ok(S().kitchen.memory.some(m => m.id === `sw|${p.id}`));
  const q = await quoteReplacement();
  assert.equal(q.data.lines[0].substitution, false);
  assert.equal(q.data.within_agent_authority, true);
});

it('remembered allergen override exempts the product and explicit need preserves substitution intent', async () => {
  S().overrides['flour|wheat_free'] = '474235';
  const q = await tool('prepare_order', { delivery_date: date, need: { query: 'makaroni', amount: 5, unit: 'kg', product_id: '474235', substitute_for: '460734' }, requirements: ['wheat_free'] });
  assert.equal(q.error, false);
  assert.equal(q.data.lines[0].substitution, false);
  assert.equal(q.data.lines[0].substitute_for, '460734');
});

it('declared replacement cannot bypass allergens, and invalid replacement ids are invalid_request', async () => {
  const unsafe = await tool('prepare_order', { delivery_date: date, items: [{ product_id: '460734', quantity: 1, substitute_for: '474235' }], requirements: ['wheat_free'] });
  assert.equal(unsafe.error, true);
  assert.equal(S().quotes.length, 0);
  for (const from of ['missing', '460325', '']) {
    const r = await quoteReplacement('460325', from);
    assert.equal(r.error, true);
    assert.equal(r.data.error, 'invalid_request');
  }
  const need = await tool('prepare_order', { delivery_date: date, need: { query: 'sokeri', amount: 1, unit: 'kg', product_id: '460325', substitute_for: 'missing' } });
  assert.equal(need.data.error, 'invalid_request');
});

it('merged explicit and sourced lines cannot drop the substitution approval flag', async () => {
  const q = await tool('prepare_order', { delivery_date: date, need: { query: 'sokeri', amount: 1, unit: 'kg', product_id: '460325' }, items: [{ product_id: '460325', quantity: 1, substitute_for: '465354' }] });
  assert.equal(q.error, false);
  assert.equal(q.data.lines.length, 1);
  assert.equal(q.data.lines[0].quantity, 2);
  assert.equal(q.data.lines[0].substitution, true);
  assert.equal(q.data.lines[0].substitute_for, '465354');
  assert.equal(q.data.within_agent_authority, false);
});

it('pinned shortfalls list verified supplier replacements first without allocating any of them', async () => {
  stub.offers.set('464306', { ...stub.fallback, amount: 2 });
  const r = await tool('prepare_order', { delivery_date: date, need: { query: 'maitojuoma', amount: 10, unit: 'L', product_id: '464306' }, requirements: ['lactose_free'] });
  assert.equal(r.error, false);
  assert.equal(r.data.fulfilment.shortfall, 8);
  assert.deepEqual(r.data.lines.map((l: any) => [l.product_id, l.quantity]), [['464306', 2]]);
  assert.ok(r.data.substitute_options.length > 0);
  assert.ok(r.data.substitute_options.every((o: any) => o.substitute_for === '464306' && o.tier === 'supplier_substitute'));
  assert.ok(r.data.substitute_options.every((o: any) => product('464306').subs.includes(o.product_id)));
  assert.equal(r.data.substitute_options[0].basis.sales_units, 8);
  assert.deepEqual(r.data.fulfilment_by_need[0].substitute_options, r.data.substitute_options);
});

it('a fully unavailable pinned product still returns substitute information on the no-quote error', async () => {
  stub.offers.set('464306', { ...stub.fallback, amount: 0 });
  const r = await tool('prepare_order', { delivery_date: date, need: { query: 'maitojuoma', amount: 10, unit: 'L', product_id: '464306' }, requirements: ['lactose_free'] });
  assert.equal(r.data.error, 'no_suitable_product');
  assert.ok(r.data.fulfilment_by_need[0].substitute_options.length);
  assert.equal(S().quotes.length, 0);
  assert.equal(S().orders.length, 0);
});

it('pinned piece needs also get supplier alternatives, but unsafe or unknown substitutes never appear', async () => {
  stub.offers.set('464306', { ...stub.fallback, amount: 2 });
  const r = await tool('prepare_order', { delivery_date: date, need: { query: 'maitojuoma', amount: 10, unit: 'pcs', product_id: '464306' }, requirements: ['lactose_free'] });
  assert.equal(r.error, false);
  assert.equal(r.data.fulfilment.shortfall, 8);
  assert.equal(r.data.substitute_options[0].product_id, '465039');
  assert.equal(r.data.substitute_options[0].basis.sales_units, 2);
  assert.equal(r.data.substitute_options[0].basis.covered_amount, 10, 'two structured five-piece sales units cover eight pieces');
  stub.offers.set('462045', { ...stub.fallback, amount: 0 });
  const nuts = await tool('prepare_order', { delivery_date: date, need: { query: 'chia', amount: 1, unit: 'kg', product_id: '462045' }, requirements: ['nut_free'] });
  assert.equal(nuts.error, true);
  assert.ok(nuts.data.fulfilment_by_need[0].substitute_options.every((o: any) => o.product_id !== '464436'));
  stub.offers.set('460027', { ...stub.fallback, amount: 0 });
  const unknown = await tool('prepare_order', { delivery_date: date, need: { query: 'tomaatti', amount: 1, unit: 'kg', product_id: '460027' }, requirements: ['wheat_free'] });
  assert.ok(unknown.data.fulfilment_by_need[0].substitute_options.every((o: any) => o.product_id !== '460065'));
});
