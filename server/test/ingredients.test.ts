// Ingredient help and model routing, entirely on loopback stubs with the real challenge catalog.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';
import { isIngredientRequest } from '../../shared/ingredientIntent.ts';
import type { Card, TurnResponse } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const supplier = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-ingredients-'));
const requests: any[] = [];
let reply: (body: any) => { status?: number; content?: unknown; tool_calls?: unknown[] } = () => ({});
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', b => raw += b);
  req.on('end', () => {
    const body = JSON.parse(raw); requests.push(body);
    const r = reply(body);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: r.content, tool_calls: r.tool_calls } }] }));
  });
});
await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  VALIO_BASE_URL: supplier.url, VALIO_API_KEY: 'offline-test', VERDA_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}`,
  VERDA_API_KEY: 'offline-test', VERDA_MODEL: 'test-chat', STATE_FILE: join(dir, 'state.json'), DATA_DIR: dir, AGENT_TOKEN: 'offline-test', APPROVERS: '',
});
const { loadCatalog, getProduct } = await import('../src/catalog.ts');
const { loadState, S, resetState } = await import('../src/store.ts');
const { handleChat, handleAction } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { suggestIngredients } = await import('../src/llm.ts');
loadCatalog(); loadState();
const T = { timeout: 120_000 };
const products = (r: TurnResponse) => r.cards.filter((c): c is Extract<Card, { type: 'products' }> => c.type === 'products');
const untouched = (r: TurnResponse) => {
  assert.equal(r.state.orders.length, 0);
  assert.equal(r.state.draft, undefined);
  assert.equal(S().quotes.length, 0);
  assert.ok(!r.cards.some(c => c.type === 'order' || c.type === 'draft'));
};
const ideas = { ingredients: [{ name: 'Jauhoseos', query: 'jauhoseos' }, { name: 'Sokeri', query: 'sokeri' }, { name: 'Kuohukerma', query: 'kuohukerma' }, { name: 'Mansikat', query: 'mansikka' }, { name: 'Kananmunat', query: 'kananmuna' }] };
beforeEach(() => {
  resetState(); requests.length = 0;
  config.llm.apiKey = 'offline-test';
  reply = () => ({ content: JSON.stringify(ideas) });
});
after(async () => {
  model.closeAllConnections(); await new Promise<void>(r => model.close(() => r()));
  await supplier.close(); rmSync(dir, { recursive: true, force: true });
});

it('ingredient context does not confuse product names such as cooking cream and baking powder with making a dish', () => {
  assert.equal(isIngredientRequest('Order 20 kg rice and 10 litres of cooking cream'), false);
  assert.equal(isIngredientRequest('I need 1 kg of baking powder'), false);
  assert.equal(isIngredientRequest('I am cooking soup for 20 people'), true);
  assert.equal(isIngredientRequest('Haluan tehdä mansikkakakun'), true);
});

it('own ingredient list, no amounts and no model: checked choices, reasons for missing wheat declarations, no mutations', T, async () => {
  config.llm.apiKey = '';
  const r = await handleChat('Tarvitsen mansikkakakun raaka-aineet, kaikki gluteenittomia ja vehnättömiä: jauhoseos, kuohukerma, sokeri, mansikka ja kananmuna', 'fi');
  untouched(r); assert.equal(requests.length, 0);
  assert.equal(products(r).length, 5);
  for (const c of products(r)) for (const a of c.items) {
    assert.equal(a.checks.length, 2);
    assert.ok(a.checks.every(c => c.verdict === 'ok'));
  }
  const cream = products(r).find(c => /kuohukerma/i.test(c.title))!;
  assert.deepEqual(cream.items, []);
  assert.match(cream.subtitle!, /vehn|Allergeeni/);
  assert.match(products(r).find(c => /kananmuna/i.test(c.title))!.subtitle!, /vehn|Allergeeni/);
  assert.ok(products(r).find(c => /jauhoseos/i.test(c.title))!.items.length);
  assert.ok(products(r).find(c => /sokeri/i.test(c.title))!.items.some(i => i.product.id === '460325'));
});

it('own quantified ingredient list is browsing for Etsi/Tarvitsen, and keeps an existing draft unchanged', T, async () => {
  config.llm.apiKey = '';
  await handleAction({ type: 'draft_set', productId: '460325', qty: 1, requirements: ['gluten_free', 'wheat_free'] }, 'fi');
  const before = structuredClone(S().draft);
  for (const verb of ['Etsi', 'Tarvitsen']) {
    const r = await handleChat(`${verb} raaka-aineet gluteenittomina ja vehnättöminä: 2 kg jauhoseosta, 1 kg sokeria`, 'fi');
    assert.equal(products(r).length, 2);
    assert.deepEqual(S().draft, before);
    assert.equal(r.state.orders.length, 0); assert.equal(S().quotes.length, 0);
  }
});

it('explicit order and own amounts: flour and plain sugar ordered; cream, eggs and ambiguous strawberry are left out', T, async () => {
  config.llm.apiKey = '';
  const r = await handleChat('Tilaa perjantaiksi mansikkakakun raaka-aineet, kaikki gluteenittomia ja vehnättömiä: 2 kg jauhoseosta, 2 litraa kuohukermaa, 1 kg sokeria, 2 kg mansikoita ja 30 kananmunaa', 'fi');
  const o = r.state.orders[0];
  assert.ok(o, r.reply); assert.equal(o.status, 'pending_approval');
  assert.equal(o.lines.length, 2);
  assert.ok(o.lines.some(l => getProduct(l.productId)!.cat === '21310'));
  assert.ok(o.lines.some(l => l.productId === '460325' && l.qty === 1));
  assert.ok(o.lines.every(l => l.checks.length === 2 && l.checks.every(c => c.verdict === 'ok')));
  assert.match(r.reply, /kuohukerma.*vehn/);
  assert.match(r.reply, /Kieku.*Tieto puuttuu: vehnätön/);
  assert.match(r.reply, /mansikoita.*Valitse/);
  assert.equal(r.state.draft, undefined);
});

it('order without amounts only shows options and explains why', T, async () => {
  const r = await handleChat('Tilaa raaka-aineet: sokeri, jauhoseos', 'fi');
  untouched(r); assert.match(r.reply, /Ilman määriä/); assert.equal(requests.length, 0);
});

it('dish-only request uses the recipe model, labels suggestion, keeps all requirements, and allows explicit draft selection', T, async () => {
  const r = await handleChat('Tarvitsen mansikkakakun raaka-aineet joka olisi gluteeniton ja samalla vehnätön', 'fi');
  untouched(r);
  assert.equal(requests.length, 1); assert.equal(requests[0].model, 'kimi-k3-1-pro');
  assert.match(r.reply, /Ehdotus lähtölistaksi.*ei keittiön hyväksytty resepti/);
  assert.equal(products(r).length, 5);
  assert.ok(!products(r).flatMap(c => c.items).some(a => /mansikkakakku/i.test(a.product.name)));
  for (const a of products(r).flatMap(c => c.items)) assert.ok(a.checks.length === 2 && a.checks.every(c => c.verdict === 'ok'));
  const picked = products(r).find(c => /Sokeri/.test(c.title))!.items[0];
  const added = await handleAction({ type: 'draft_set', productId: picked.product.id, qty: 1, requirements: picked.checks.map(c => c.requirement) }, 'fi');
  assert.equal(added.state.draft?.lines.length, 1); assert.equal(added.state.orders.length, 0);
});

it('even Tilaa + dish only is a suggestion, never an order', T, async () => {
  const r = await handleChat('Tilaa mansikkakakun raaka-aineet', 'fi'); untouched(r); assert.match(r.reply, /Ehdotus/);
});

it('recipe failure retries once with ordinary chat model; both calls have a 60-second timeout', T, async () => {
  reply = b => b.model === 'kimi-k3-1-pro' ? { status: 503 } : { content: JSON.stringify(ideas) };
  const timeouts: number[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ms => { timeouts.push(ms); return original(ms); };
  try {
    const list = await suggestIngredients('mansikkakakku', 'fi', false);
    assert.equal(list?.length, 5);
    assert.deepEqual(requests.map(r => r.model), ['kimi-k3-1-pro', 'test-chat']);
    assert.deepEqual(timeouts, [60_000, 60_000]);
  } finally { AbortSignal.timeout = original; }
});

it('malformed/empty model output and model errors ask for an own list, never mutate state', T, async () => {
  for (const response of [{ status: 503 }, { content: 'not JSON' }, { content: '{"ingredients":[]}' }, { content: '{"ingredients":[{"query":42}]}' }, { content: 'null' }]) {
    requests.length = 0; reply = () => response;
    const r = await handleChat('Tarvitsen kakun ainekset', 'fi'); untouched(r);
    assert.match(r.reply, /Luettele tarvitsemasi raaka-aineet/);
    assert.equal(requests.length, 2);
  }
});

it('model rows are capped, malformed rows discarded, unrequested amount estimates removed', T, async () => {
  reply = () => ({ content: JSON.stringify({ ingredients: [null, { name: 'bad', query: 'x', amount: -2, unit: 'kg' }, { name: 'Sugar', query: 'sokeri', amount: 20, unit: 'kg', suitable: true }, ...Array.from({ length: 30 }, (_, i) => ({ name: `row ${i}`, query: `q ${i}` }))] }) });
  const list = await suggestIngredients('cake', 'en', false);
  assert.equal(list?.length, 10);
  assert.deepEqual(list![0], { name: 'Sugar', query: 'sokeri' });
  const portions = await suggestIngredients('cake for 20 people', 'en', true);
  assert.equal(portions![0].amount, 20);
});

it('ingredient help has Finnish, Swedish and English replies and supplier checks', T, async () => {
  for (const [lang, text, re] of [['fi', 'Etsi raaka-aineet gluteenittomina: sokeri', /Oma raaka-ainelistasi/], ['sv', 'Hitta glutenfria ingredienser: socker', /Din ingredienslista/], ['en', 'Find gluten-free ingredients: sugar', /Your ingredient list/]] as const) {
    const r = await handleChat(text, lang); untouched(r);
    assert.ok(r.cards.some(c => c.type === 'note' && re.test(c.title ?? '')));
    assert.ok(products(r)[0].items.length);
    assert.ok(products(r)[0].items.every(a => a.checks.length === 1 && a.checks[0].verdict === 'ok'));
  }
});

it('challenge need wording remains a quick order in English and Finnish, with a tool stub and without a model', T, async () => {
  const messages = [
    'I need 1,000 litres of lactose-free milk by Monday. Find an option that meets our requirements based on price and availability.',
    'Tarvitsen 1 000 litraa laktoositonta maitoa maanantaiksi. Etsi vaatimuksemme täyttävä vaihtoehto hinnan ja saatavuuden perusteella.',
  ];
  reply = () => ({ tool_calls: [{ function: { name: 'quick_order', arguments: JSON.stringify({ items: [{ product: 'maitojuoma', amount: 1000, unit: 'l', requirements: [] }], weekday: 'mon' }) } }] });
  for (const key of ['offline-test', '']) for (const message of messages) {
    resetState(); config.llm.apiKey = key;
    const r = await handleChat(message, 'en');
    assert.equal(r.state.orders.length, 1, `${key ? 'model' : 'fallback'}: ${message} → ${r.reply}`);
    assert.equal(r.state.orders[0].status, 'pending_approval');
    assert.ok(r.state.orders[0].lines.every(l => l.checks.some(c => c.requirement === 'lactose_free' && c.verdict === 'ok')));
    assert.ok(r.state.orders[0].lines.reduce((sum, l) => sum + l.qty * getProduct(l.productId)!.per!.v, 0) >= 1000);
  }
});
