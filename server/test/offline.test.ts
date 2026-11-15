// Offline tests for the basic order flow: lot sizes, single-use quotes, multi-need quotes over MCP, multi-product
// chat orders through the keyword fallback, the order draft, and the rate-limited supplier API.
//
// Nothing here needs network or keys. Prices and availability come from a local stub of the Valio Aimo mock
// (test/mock-stub.ts), the language model is unreachable on purpose (no key), the catalog is the real challenge
// catalog and the state lives in a temporary file. The modules under test are imported after the environment
// is set, because src/config.ts reads it once.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import express from 'express';
import type { Card, Lang, Order, TurnResponse, UiAction } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const stub = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-offline-'));
const STATE_FILE = join(dir, 'state.json');
Object.assign(process.env, {
  VALIO_BASE_URL: stub.url, VALIO_API_KEY: 'offline-test', STATE_FILE, DATA_DIR: dir, AGENT_TOKEN: 'offline-token', CUTOFF_MODE: 'warn',
  VERDA_API_KEY: '', VERDA_BASE_URL: stub.url, // no model: the chat must work through the keyword fallback
});

const { getProduct, loadCatalog, lotStep, roundToLot } = await import('../src/catalog.ts');
const { handleAction, handleChat, stateView } = await import('../src/app.ts');
const { handleMcp } = await import('../src/mcp.ts');
const { createOrder, needCandidates, sourceNeed, sourcingLines, verify } = await import('../src/orders.ts');
const { UserError } = await import('../src/planner.ts');
const { loadState, runAs, l3, ACTOR } = await import('../src/store.ts');
const { weekdayOf } = await import('../src/i18n.ts');

loadCatalog();
loadState();

// the MCP endpoint, mounted like in src/index.ts
const app = express();
app.use(express.json());
app.all('/mcp', (req, res) => { void runAs(req.headers['x-aimo-account'], () => handleMcp(req, res)); });
const http: Server = await new Promise(ready => { const s = app.listen(0, '127.0.0.1', () => ready(s)); });
const MCP = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;

after(async () => {
  http.closeAllConnections();
  await new Promise(done => http.close(done));
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

const DATE = '2026-11-16';
const LANGS: Lang[] = ['fi', 'sv', 'en'];
const T = { timeout: 120_000 };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const chat = (message: string, lang: Lang = 'fi', profile = 'school'): Promise<TurnResponse> => runAs(profile, () => handleChat(message, lang));
const act = (action: UiAction, lang: Lang = 'en', profile = 'school'): Promise<TurnResponse> => runAs(profile, () => handleAction(action, lang));
const state = (profile = 'school') => runAs(profile, () => stateView('en'));
const orderOf = (r: TurnResponse): Order => {
  const c = r.cards.find((x): x is Extract<Card, { type: 'order' }> => x.type === 'order');
  assert.ok(c, `response carries an order card (reply: ${r.reply})`);
  return c.order;
};
/** the error a refused action or chat turn throws, with its three-language text */
async function refused(run: () => Promise<unknown>): Promise<InstanceType<typeof UserError>> {
  try { await run(); } catch (e) { assert.ok(e instanceof UserError, `expected a UserError, got ${e}`); return e; }
  assert.fail('expected the request to be refused');
}

let rpcId = 0;
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer offline-token', 'x-agent-name': 'offline-agent' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const frames = text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  const result = JSON.parse(frames.length ? frames[frames.length - 1] : text).result;
  let data = result.structuredContent;
  if (data === undefined) { try { data = JSON.parse(result.content[0].text); } catch { data = { raw: result.content?.[0]?.text }; } }
  return { isError: !!result.isError, data };
}

// catalog fixtures (real challenge products)
const STEW = '462590';      // Atria Karjalanpaisti, sold by the kg, allowedLotSize 2
const HAM = '462356';       // Casa Modena parmankinkku, allowedLotSize 1.5
const BACON = '462682';     // Mattila Bros. savupekonikuutio, allowedLotSize 2.5
const PASTA = '474235';     // SamMills gluten-free macaroni 5 kg, allowedLotSize 0.01
const COFFEE = '460588';    // Paulig coffee 12 x 400 g: no pack size in structured supplier data
const FLOUR_GF = '460734';  // gluten-free flour mix with gluten-free wheat starch: fails wheat_free
const NO_PRICE = '460003';

stub.offers.set(STEW, { price: 9, amount: 500, closingTime: '2099-01-01T17:00:00+0200' });
stub.offers.set(BACON, { price: 7, amount: 12, closingTime: '2099-01-01T17:00:00+0200' });
stub.offers.set(NO_PRICE, { amount: 5, closingTime: '2099-01-01T17:00:00+0200' });

// =====================================================================================================
describe('1. lot size', () => {
  it('lotStep: 0.01 means 1; other lots allow whole sales units that are a multiple of the lot', () => {
    const step = (lot: number) => lotStep({ lot });
    assert.equal(step(0.01), 1);
    assert.equal(step(1), 1);
    assert.equal(step(2), 2);
    assert.equal(step(10), 10);
    assert.equal(step(1.5), 3, '1.5 -> 3, 6, 9 … (cautious reading)');
    assert.equal(step(2.5), 5);
    assert.equal(step(0.5), 1);
    assert.equal(step(0.35), 7);
    assert.equal(step(1.44), 36);
    assert.equal(roundToLot(7, { lot: 3 }), 9);
    assert.equal(roundToLot(6, { lot: 3 }), 6);
    assert.equal(roundToLot(1, { lot: 1.5 }), 3);
    assert.equal(roundToLot(5, { lot: 0.01 }), 5);
    assert.equal(roundToLot(0, { lot: 2 }), 0);
  });

  it('the challenge catalog: 624 products have an order step above 1', () => {
    let stepped = 0, notDefault = 0;
    for (let id = 460000; id < 480000; id++) {
      const p = getProduct(String(id));
      if (!p) continue;
      if (p.lot !== 0.01) notDefault++;
      if (lotStep(p) > 1) stepped++;
    }
    assert.equal(notDefault, 674, 'products whose allowedLotSize is not 0.01');
    assert.equal(stepped, 624, 'products that can only be ordered in multiples');
    assert.equal(lotStep(getProduct(STEW)!), 2);
    assert.equal(lotStep(getProduct(HAM)!), 3);
    assert.equal(lotStep(getProduct(BACON)!), 5);
    assert.equal(lotStep(getProduct(PASTA)!), 1);
  });

  it('verify() blocks a quantity that is not a multiple of the lot and names the allowed step in fi/sv/en', T, async () => {
    const line = (productId: string, qty: number) => [{ productId, qty, reqs: [], groupIds: [] }];
    const bad = await runAs('school', () => verify(line(STEW, 3), DATE, 'ui'));
    assert.equal(bad.blockers.length, 1);
    assert.equal(bad.lines.length, 0);
    assert.match(bad.blockers[0].fi, /2 myyntiyksikön erissä.*määrä 3 ei käy.*2 ja 4/);
    assert.match(bad.blockers[0].sv, /partier om 2 försäljningsenheter.*2 och 4/);
    assert.match(bad.blockers[0].en, /lots of 2 sales units.*quantity of 3 is not allowed.*2 and 4/);

    const good = await runAs('school', () => verify(line(STEW, 4), DATE, 'ui'));
    assert.deepEqual(good.blockers, []);
    assert.equal(good.lines[0].qty, 4);
    assert.equal(good.net, 36);

    // lot 1.5: two sales units are not a multiple of 1.5, three are
    const half = await runAs('school', () => verify(line(HAM, 2), DATE, 'ui'));
    assert.match(half.blockers[0].en, /lots of 3 sales units.*smallest allowed quantity is 3/);
    assert.deepEqual((await runAs('school', () => verify(line(HAM, 3), DATE, 'ui'))).blockers, []);
    // lot 0.01 keeps accepting any whole number
    assert.deepEqual((await runAs('school', () => verify(line(PASTA, 7), DATE, 'ui'))).blockers, []);
  });

  it('createOrder refuses the same quantity: no order', T, async () => {
    const before = (await state()).orders.length;
    const e = await refused(() => runAs('school', () => createOrder({ source: 'ui', actor: ACTOR.kitchen, title: l3('t', 't', 't'), deliveryDate: DATE, idempotencyKey: 'lot-test-1', lines: [{ productId: STEW, qty: 5, reqs: [], groupIds: [] }] })));
    assert.match(e.text.en, /lots of 2 sales units/);
    assert.equal((await state()).orders.length, before);
  });

  it('sourcing a need rounds up to the lot and says so; availability is rounded down to the lot', T, async () => {
    const s = await runAs('school', () => sourceNeed('karjalanpaisti', 5, 'kg', [], DATE, 'en', STEW));
    assert.equal(s.allocation.length, 1);
    assert.equal(s.allocation[0].qty, 6, '5 kg -> 5 sales units -> next multiple of 2');
    assert.equal(s.allocation[0].lotRounded, true);
    assert.equal(s.covered, 6);
    assert.equal(s.shortfall, 0);
    const why = sourcingLines(s, [])[0].why!;
    assert.match(why.fi, /2 myyntiyksikön erissä.*pyöristettiin ylöspäin: 6/);
    assert.match(why.sv, /partier om 2.*avrundades uppåt till 6/);
    assert.match(why.en, /lots of 2 sales units.*rounded up to 6/);

    // 12 available, lot step 5: only 10 can be ordered, the rest is a reported shortfall
    const b = await runAs('school', () => sourceNeed('savupekonikuutio', 14, 'kg', [], DATE, 'en', BACON));
    assert.equal(b.allocation[0].qty, 10);
    assert.equal(b.allocation[0].partial, true);
    assert.equal(b.shortfall, 4);
  });

  it('MCP items: a quantity off the lot is refused with the step, a multiple is quoted with order_multiple', T, async () => {
    const off = await tool('prepare_order', { delivery_date: DATE, items: [{ product_id: STEW, quantity: 3 }] });
    assert.equal(off.isError, true);
    assert.equal(off.data.error, 'rejected_by_rules');
    assert.match(off.data.message, /lots of 2 sales units.*2 and 4/);
    assert.equal(off.data.quote_id, undefined);
    const on = await tool('prepare_order', { delivery_date: DATE, items: [{ product_id: STEW, quantity: 4 }] });
    assert.equal(on.isError, false, JSON.stringify(on.data));
    assert.equal(on.data.lines[0].quantity, 4);
    assert.equal(on.data.lines[0].order_multiple, 2);
    const pa = await tool('get_price_availability', { product_ids: [STEW, PASTA], delivery_date: DATE });
    assert.deepEqual(pa.data.offers.map((o: any) => o.order_multiple), [2, 1]);
  });

  it('the week plan rounds packs up to the lot, tells why, and a manual quantity is rounded up too', T, async () => {
    await act({ type: 'load_demo_menu' }, 'en', 'wedding');
    // 127 guests x 160 g of Karelian stew = 20.32 kg -> 21 sales units of 1 kg -> lot of 2 -> 22
    const r = await act({ type: 'set_portions', total: 127 }, 'en', 'wedding');
    const line = r.state.plan?.lines.find(l => l.id === STEW);
    assert.ok(line, `the wedding menu uses the stew (lines: ${r.state.plan?.lines.map(l => l.id).join(',')})`);
    assert.equal(line.product.lotStep, 2);
    assert.equal(line.orderQty, 22);
    assert.match(line.why, /lots of 2 sales units, so the quantity 21 was rounded up to 22/);
    for (const l of r.state.plan!.lines) assert.equal(l.orderQty % (l.product.lotStep ?? 1), 0, l.product.name);

    const edit = await act({ type: 'set_line_qty', lineId: STEW, qty: 5 }, 'fi', 'wedding');
    assert.equal(edit.state.plan?.lines.find(l => l.id === STEW)?.orderQty, 6);
    assert.match(edit.reply, /2 myyntiyksikön erissä.*6/);
    const exact = await act({ type: 'set_line_qty', lineId: STEW, qty: 8 }, 'fi', 'wedding');
    assert.equal(exact.state.plan?.lines.find(l => l.id === STEW)?.orderQty, 8);
    assert.doesNotMatch(exact.reply, /erissä/);
  });
});

// =====================================================================================================
describe('3. a quote produces at most one order', () => {
  const orders = async () => (await state()).orders;

  it('placed once: the same key returns the order, any other key gets quote_already_used', T, async () => {
    const q = await tool('prepare_order', { delivery_date: DATE, items: [{ product_id: PASTA, quantity: 2 }] });
    assert.equal(q.isError, false, JSON.stringify(q.data));
    assert.equal(q.data.within_agent_authority, true, q.data.approval_required_because.join(' | '));
    assert.equal(q.data.single_use, true);
    const before = (await orders()).length;

    const placed = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0001' });
    assert.equal(placed.isError, false, JSON.stringify(placed.data));
    assert.equal(placed.data.duplicate, false);
    assert.equal(placed.data.order.status, 'submitted');
    const id = placed.data.order.order_id;

    const same = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0001' });
    assert.equal(same.isError, false);
    assert.equal(same.data.duplicate, true);
    assert.equal(same.data.order.order_id, id);

    for (const call of ['place_order', 'request_approval']) {
      const other = await tool(call, { quote_id: q.data.quote_id, idempotency_key: `offline-key-0002-${call}` });
      assert.equal(other.isError, true, call);
      assert.equal(other.data.error, 'quote_already_used', call);
      assert.equal(other.data.order_id, id);
      assert.equal(other.data.order_status, 'submitted');
      assert.match(other.data.message, new RegExp(id));
    }
    for (const lang of LANGS) {
      const r = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0003', lang });
      assert.equal(r.data.error, 'quote_already_used');
      assert.match(r.data.message, lang === 'fi' ? /jo käytetty/ : lang === 'sv' ? /redan använts/ : /already used/);
    }
    assert.equal((await orders()).length, before + 1, 'exactly one order from the quote');
    const log = await tool('get_audit_log', { order_id: id });
    assert.ok(log.data.entries.some((a: any) => a.action === 'quote_reuse_blocked'), 'the refused reuse is in the audit log');
    assert.equal(log.data.entries.filter((a: any) => a.action === 'order_submitted').length, 1);
  });

  it('a refused place_order does not use the quote up; request_approval then creates its one order', T, async () => {
    const q = await tool('prepare_order', { delivery_date: DATE, items: [{ product_id: PASTA, quantity: 300 }] });
    assert.equal(q.data.within_agent_authority, false);
    const before = (await orders()).length;
    const blocked = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0010' });
    assert.equal(blocked.data.error, 'approval_required');
    assert.equal((await orders()).length, before);
    const asked = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0010', note: 'pasta for the week' });
    assert.equal(asked.isError, false, JSON.stringify(asked.data));
    assert.equal(asked.data.order.status, 'pending_approval');
    const again = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0010' });
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.order.order_id, asked.data.order.order_id);
    const other = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0011' });
    assert.equal(other.data.error, 'quote_already_used');
    assert.equal((await orders()).length, before + 1);
  });

  it('a quote whose order was rejected stays used: a new attempt needs a new quote', T, async () => {
    const args = { delivery_date: DATE, items: [{ product_id: PASTA, quantity: 3 }] };
    const q = await tool('prepare_order', args);
    const asked = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0020' });
    const id = asked.data.order.order_id;
    assert.equal((await act({ type: 'reject_order', orderId: id })).state.orders.find(o => o.id === id)?.status, 'rejected');
    const before = (await orders()).length;

    for (const key of ['offline-key-0020', 'offline-key-0021']) {
      const retry = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: key });
      assert.equal(retry.isError, true, key);
      assert.equal(retry.data.error, 'quote_already_used', key);
      assert.equal(retry.data.order_id, id);
      assert.equal(retry.data.order_status, 'rejected');
    }
    assert.equal((await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0022' })).data.error, 'quote_already_used');
    assert.equal((await orders()).length, before, 'the rejected quote created nothing more');

    const fresh = await tool('prepare_order', args);
    assert.notEqual(fresh.data.quote_id, q.data.quote_id);
    const second = await tool('request_approval', { quote_id: fresh.data.quote_id, idempotency_key: 'offline-key-0023' });
    assert.equal(second.isError, false, JSON.stringify(second.data));
    assert.notEqual(second.data.order.order_id, id);
    assert.equal((await orders()).length, before + 1);
  });
});

// =====================================================================================================
describe('5b. MCP: several needs and explicit items in one quote', () => {
  it('needs + items: one quote, fulfilment per need, a need without a product does not stop the rest', T, async () => {
    const q = await tool('prepare_order', {
      delivery_date: DATE,
      needs: [{ query: 'riisi', amount: 20, unit: 'kg' }, { query: 'ruokakerma', amount: 10, unit: 'L' }, { query: 'yksisarvinen', amount: 5, unit: 'kg' }],
      items: [{ product_id: PASTA, quantity: 2 }],
    });
    assert.equal(q.isError, false, JSON.stringify(q.data));
    const by = q.data.fulfilment_by_need;
    assert.deepEqual(by.map((n: any) => [n.query, n.status]), [['riisi', 'covered'], ['ruokakerma', 'covered'], ['yksisarvinen', 'not_found']]);
    assert.ok(by[0].covered >= 20 && by[0].unit === 'kg' && by[0].shortfall === 0);
    assert.ok(by[1].covered >= 10 && by[1].unit === 'L');
    assert.deepEqual(by[2].lines, []);
    assert.equal(by[2].covered, 0);
    assert.equal(q.data.fulfilment, undefined, 'the single-need summary is only given for one need');

    const lines: { product_id: string; quantity: number; line_total_excl_vat: number }[] = q.data.lines;
    const sourced = [...by[0].lines, ...by[1].lines];
    assert.ok(sourced.length >= 2);
    for (const l of sourced) assert.equal(lines.find(x => x.product_id === l.product_id)?.quantity, l.quantity);
    assert.equal(lines.find(l => l.product_id === PASTA)?.quantity, 2);
    assert.equal(lines.length, sourced.length + 1);
    assert.equal(getProduct(by[0].lines[0].product_id)!.per!.u, 'kg');
    assert.equal(getProduct(by[1].lines[0].product_id)!.per!.u, 'L');
    assert.ok(Math.abs(q.data.total_excl_vat - lines.reduce((a, l) => a + l.line_total_excl_vat, 0)) < 0.011);

    const asked = await tool('request_approval', { quote_id: q.data.quote_id, idempotency_key: 'offline-key-0100' });
    assert.equal(asked.isError, false, JSON.stringify(asked.data));
    assert.equal(asked.data.order.lines.length, lines.length, 'all of it is one order');
    assert.match(asked.data.order.title, /20 kg riisi \+ 10 L ruokakerma \+ 5 kg yksisarvinen \+ 1 items/);
  });

  it('requirements apply to every need; a need follows the lot size', T, async () => {
    const q = await tool('prepare_order', {
      delivery_date: DATE, requirements: ['lactose_free'],
      needs: [{ query: 'laktoositon maitojuoma', amount: 40, unit: 'L' }, { query: 'karjalanpaisti', amount: 5, unit: 'kg', product_id: STEW }],
    });
    assert.equal(q.isError, false, JSON.stringify(q.data));
    for (const l of q.data.lines) assert.ok(l.requirement_checks.every((c: any) => c.requirement === 'lactose_free' && c.verdict === 'ok'), l.name);
    const stew = q.data.lines.find((l: any) => l.product_id === STEW);
    assert.equal(stew.quantity, 6);
    assert.equal(stew.order_multiple, 2);
    assert.match(stew.why, /rounded up to 6/);
    assert.equal(q.data.fulfilment_by_need[1].covered, 6);
  });

  it('a single need answers as before, plus fulfilment_by_need', T, async () => {
    const q = await tool('prepare_order', { delivery_date: DATE, requirements: ['lactose_free'], need: { query: 'laktoositon maitojuoma', amount: 40, unit: 'L' } });
    assert.equal(q.isError, false, JSON.stringify(q.data));
    assert.equal(q.data.fulfilment.requested, 40);
    assert.ok(q.data.fulfilment.covered >= 40);
    assert.equal(q.data.fulfilment.shortfall, 0);
    assert.ok(q.data.ranked_options.length > 0);
    assert.ok(q.data.excluded_by_rules);
    assert.equal(q.data.fulfilment_by_need.length, 1);
  });

  it('nothing orderable: no quote; no input: invalid_request', T, async () => {
    const none = await tool('prepare_order', { delivery_date: DATE, needs: [{ query: 'yksisarvinen', amount: 5, unit: 'kg' }] });
    assert.equal(none.isError, true);
    assert.equal(none.data.error, 'no_suitable_product');
    assert.equal(none.data.fulfilment_by_need[0].status, 'not_found');
    assert.equal(none.data.quote_id, undefined);
    const single = await tool('prepare_order', { delivery_date: DATE, need: { query: 'yksisarvinen', amount: 5, unit: 'kg' } });
    assert.equal(single.data.error, 'no_suitable_product');
    assert.ok(single.data.excluded);
    assert.equal((await tool('prepare_order', { delivery_date: DATE })).data.error, 'invalid_request');
    // one line that breaks a rule still refuses the whole quote
    const mixed = await tool('prepare_order', { delivery_date: DATE, requirements: ['wheat_free'], needs: [{ query: 'riisi', amount: 5, unit: 'kg' }], items: [{ product_id: FLOUR_GF, quantity: 1 }] });
    assert.equal(mixed.isError, true);
    assert.equal(mixed.data.error, 'rejected_by_rules');
    assert.match(mixed.data.message, /wheat/i);
  });
});

// =====================================================================================================
describe('5a. chat: several products in one message become one order (keyword fallback, no model)', () => {
  it('rice + cream + unspecified beer -> one order for two needs, beer requires selection', T, async () => {
    const before = (await state()).orders.length;
    const r = await chat('Tilaa 20 kg riisiä, 10 l ruokakermaa ja 70 olutta perjantaiksi');
    const o = orderOf(r);
    assert.equal(r.state.orders.length, before + 1, 'exactly one order');
    assert.equal(o.status, 'pending_approval', 'a chat order always waits for the user');
    assert.equal(weekdayOf(o.deliveryDate), 'fri');
    assert.equal(o.lines.length, 2);
    const p = o.lines.map(l => ({ l, p: getProduct(l.productId)! }));
    const rice = p.find(x => x.p.per?.u === 'kg' && /riisi/i.test(x.p.name));
    const cream = p.find(x => x.p.per?.u === 'L' && /kerma/i.test(x.p.name));
    const beer = p.find(x => /olut/i.test(x.p.name));
    assert.ok(rice && cream, o.lines.map(l => l.name).join(' | '));
    assert.equal(beer, undefined, 'never silently substitute alcohol-free beer');
    assert.ok(rice.l.qty * rice.p.per!.v >= 20);
    assert.ok(cream.l.qty * cream.p.per!.v >= 10);
    assert.ok(r.cards.some(c => c.type === 'products' && c.items.length > 0), 'beer alternatives are shown for selection');
    for (const l of o.lines) assert.ok(l.why, 'every line says why it was chosen');
    assert.match(r.reply, /yhden tilauksen 2 tarpeesta/);
    assert.match(r.reply, /20 kg riisiä/);
    assert.match(r.reply, /10 L ruokakerma/);
    assert.match(r.reply, /70 kpl olutta/);
    assert.deepEqual(r.cards.map(c => c.type), ['note', 'products', 'products', 'products', 'order']);
    assert.ok(r.cards.slice(2, 4).every(c => c.type === 'products' && c.items.some(o => o.roles?.some(r => r.role === 'cheapest'))), 'each allocated need also shows its named alternatives');
    assert.match(r.reply, /alkoholittomia tai matala-alkoholisia/);
  });

  it('a product that cannot be found is reported and left out; the rest is still ordered', T, async () => {
    const before = (await state()).orders.length;
    const r = await chat('Tilaa 15 kg riisiä ja 5 kg yksisarvista tiistaiksi', 'en');
    const o = orderOf(r);
    assert.equal(r.state.orders.length, before + 1);
    assert.equal(o.lines.length, 1);
    assert.match(getProduct(o.lines[0].productId)!.name, /riisi/i);
    assert.match(r.reply, /5 kg yksisarvista: I found no orderable product.*This was not ordered\./);
    const note = r.cards.find(c => c.type === 'note');
    assert.ok(note && note.type === 'note' && note.tone === 'warn' && /yksisarvista/.test(note.text), 'the missing product is shown as a warning card');
  });

  it('an unverifiable product is never ordered: a wheat-free need with only failing products is left out', T, async () => {
    const r = await chat('Tilaa 10 kg riisiä ja 2 kg vehnätöntä vehnäjauhoa maanantaiksi', 'en');
    const o = orderOf(r);
    assert.equal(o.lines.length, 1, o.lines.map(l => l.name).join(' | '));
    assert.match(getProduct(o.lines[0].productId)!.name, /riisi/i);
    assert.match(r.reply, /vehnäjauhoa: I found no orderable product that meets the requirements \(wheat-free\)/);
    for (const l of o.lines) assert.ok(l.checks.every(c => c.verdict === 'ok'));
  });

  it('nothing found at all: no order', T, async () => {
    const before = (await state()).orders.length;
    const r = await chat('Tilaa 5 kg yksisarvista ja 3 l lohikäärmeenverta');
    assert.equal(r.state.orders.length, before);
    assert.deepEqual(r.cards, []);
    assert.match(r.reply, /yksisarvista.*Tätä ei tilattu\..*Tätä ei tilattu\./);
  });

  it('one product per message behaves as before: options card + order card', T, async () => {
    const r = await chat('Tilaa 70 alkoholitonta olutta perjantaiksi');
    assert.deepEqual(r.cards.map(c => c.type), ['products', 'order']);
    const o = orderOf(r);
    assert.equal(o.lines.length, 1);
    assert.match(r.reply, /^Valmistelin tilauksen: 72 kpl toimitukseen pe /);
    assert.match(r.reply, /Tuote myydään 24 kpl:n erissä, joten saat 72 kpl\./);
    assert.equal(o.lines[0].qty, 3);
    assert.ok(r.cards.some(c => c.type === 'products' && c.items.some(a => /pantti/.test(a.note ?? ''))));
    const litres = await chat('Tilaa 40 litraa laktoositonta maitoa maanantaiksi');
    assert.deepEqual(litres.cards.map(c => c.type), ['products', 'order']);
    const lo = orderOf(litres);
    assert.ok(lo.lines.every(l => l.checks.length === 1 && l.checks[0].requirement === 'lactose_free' && l.checks[0].verdict === 'ok'));
    // a delivery day after the product is not taken for the product, and words before the amount still work
    const day = await chat('Tilaa 20 kg riisiä tiistaiksi');
    assert.match(getProduct(orderOf(day).lines[0].productId)!.name, /riisi/i);
    assert.equal(weekdayOf(orderOf(day).deliveryDate), 'tue');
    const inverted = await chat('Tarvitsen laktoositonta maitoa 30 litraa');
    assert.deepEqual(inverted.cards.map(c => c.type), ['products', 'order']);
    // a portions message with several numbers is still a portions message
    const portions = await chat('Meillä on 350 lounasta päivässä, joista 20 gluteenitonta ja 8 vehnätöntä');
    assert.equal(portions.state.kitchen.portionsTotal, 350);
    assert.equal(portions.state.orders.length, inverted.state.orders.length);
  });
});

// =====================================================================================================
describe('need matching regressions', () => {
  it('unrequested material variants are not a beer-only rule: ordinary coffee vs decaffeinated coffee', () => {
    // ordinary coffee was asked for: decaffeinated products are not candidates, and nothing is picked while
    // the remaining matches still span several product types
    const broad = needCandidates('kahvi', [], 'fi');
    assert.ok(broad.selectionRequired);
    assert.ok(broad.products.length > 0);
    assert.ok(broad.products.every(p => !/kofeiinit|koffeinfri|decaf/i.test(`${p.name} ${p.sv ?? ''} ${p.en ?? ''}`)));
    const explicit = needCandidates('kofeiiniton kahvi', [], 'fi');
    assert.equal(explicit.selectionRequired, undefined);
    assert.ok(explicit.products.some(p => p.id === '468595'));
  });
  it('verified flour in neighbouring categories is found before any category restriction', T, async () => {
    const s = await sourceNeed('jauhoseosta', 2, 'kg', ['gluten_free', 'wheat_free'], '2098-01-01', 'fi');
    assert.equal(s.selectionRequired, undefined);
    assert.ok(s.allocation.length);
    // Named options are now role winners, not the first five candidates. Check matching directly.
    const candidates = needCandidates('jauhoseosta', ['gluten_free', 'wheat_free'], 'fi', p => p.per?.u === 'kg').products;
    assert.ok(candidates.some(p => p.cat === '21310'));
    assert.ok(candidates.some(p => p.cat === '21370'));
    const neighbour = candidates.find(p => p.cat === '21370')!;
    const explicit = await sourceNeed('jauhoseosta', 2, 'kg', ['gluten_free', 'wheat_free'], '2098-01-01', 'fi', neighbour.id);
    assert.equal(explicit.allocation[0].product.id, neighbour.id);
    assert.ok(s.options.every(a => a.checks.length === 2 && a.checks.every(c => c.verdict === 'ok')));
  });
  it('coverage cost beats per-kg price: 1 kg of sugar is not 15 kg of icing', T, async () => {
    stub.offers.set('460325', { price: 1.55, amount: 500 });
    stub.offers.set('465354', { price: 2, amount: 500 }); // cheaper per kg, more expensive to cover 1 kg
    const s = await sourceNeed('sokeria', 1, 'kg', ['gluten_free', 'wheat_free'], '2098-01-02', 'fi');
    assert.equal(s.allocation[0].product.id, '460325');
    assert.equal(s.allocation[0].qty, 1);
    assert.equal(s.net, 1.55);
    assert.equal(s.covered, 1);
  });
  it('strawberry is selection_required in both chat and MCP, with alternatives and no quote/order', T, async () => {
    const r = await chat('Tilaa 2 kg mansikoita perjantaiksi');
    assert.ok(!r.cards.some(c => c.type === 'order'));
    assert.ok(r.cards.some(c => c.type === 'products' && c.items.length));
    assert.match(r.reply, /Valitse/);
    const q = await tool('prepare_order', { delivery_date: DATE, need: { query: 'mansikka', amount: 2, unit: 'kg' } });
    assert.equal(q.data.error, 'selection_required');
    assert.equal(q.data.fulfilment_by_need[0].status, 'selection_required');
    assert.deepEqual(q.data.fulfilment_by_need[0].lines, []);
    assert.ok(q.data.fulfilment_by_need[0].ranked_options.length);
    assert.equal(q.data.quote_id, undefined);
    const mixed = await tool('prepare_order', { delivery_date: DATE, needs: [{ query: 'mansikka', amount: 2, unit: 'kg' }, { query: 'riisi', amount: 5, unit: 'kg' }] });
    assert.equal(mixed.isError, false);
    assert.deepEqual(mixed.data.fulfilment_by_need.map((n: any) => n.status), ['selection_required', 'covered']);
    assert.ok(mixed.data.lines.every((l: any) => getProduct(l.product_id)!.cat === '21340'));
    assert.ok(mixed.data.quote_id);
  });
  it('unspecified beer is never silently replaced with an alcohol-free variant', T, async () => {
    const r = await chat('Tilaa 70 olutta perjantaiksi');
    assert.ok(!r.cards.some(c => c.type === 'order'));
    assert.ok(r.cards.some(c => c.type === 'products' && c.items.length));
    assert.match(r.reply, /alkoholittomia tai matala-alkoholisia/);
  });
  it('1000 L of lactose-free milk remains orderable and can be split across suppliers', T, async () => {
    // "kevytmaitojuoma" products are milk drinks too (compound head in the same category); the 10 l box would
    // cover the whole need alone at the stub's flat price, so it is priced out to keep this a test of splitting
    stub.offers.set('464179', { price: 40, amount: 500 });
    try {
      const s = await sourceNeed('maitojuoma', 1000, 'L', ['lactose_free'], '2098-01-03', 'en');
      assert.equal(s.selectionRequired, undefined);
      assert.equal(s.covered, 1000);
      assert.equal(s.allocation.length, 2);
      assert.ok(s.options.every(o => o.checks.every(c => c.verdict === 'ok')));
      assert.ok(needCandidates('maitojuoma', ['lactose_free'], 'en', p => p.per?.u === 'L').products.some(p => /kevytmaitojuoma/i.test(p.name)), 'compound-head milk drinks are candidates, even when they win no named role');
    } finally { stub.offers.delete('464179'); }
  });
});

// =====================================================================================================
describe('5c. order draft from search results', () => {
  const stored = () => JSON.parse(readFileSync(STATE_FILE, 'utf8')).profiles;

  it('add, change, remove: quantities are sales units, follow the lot, and the draft is kept per account', T, async () => {
    assert.equal((await state()).draft, undefined);
    // a product without a pack size in structured data can be ordered by the sales unit
    assert.equal(getProduct(COFFEE)!.per, undefined, 'fixture: no pack size');
    const a = await act({ type: 'draft_set', productId: COFFEE, qty: 2 }, 'fi');
    assert.deepEqual(a.cards.map(c => c.type), ['draft']);
    assert.deepEqual(a.state.draft?.lines.map(l => [l.product.id, l.qty]), [[COFFEE, 2]]);
    assert.equal(a.state.draft?.lines[0].lineTotal, 4);
    assert.match(a.reply, /Luonnoksessa ”.*”: .* × 2 laatikko\./);

    // lot of 2: three is rounded up to four, and the reply says so in the user's language
    for (const [lang, re] of [['fi', /2 myyntiyksikön erissä.*4/], ['sv', /partier om 2.*4/], ['en', /lots of 2 sales units.*4/]] as const) {
      const b = await act({ type: 'draft_set', productId: STEW, qty: 3 }, lang);
      assert.equal(b.state.draft?.lines.find(l => l.product.id === STEW)?.qty, 4);
      assert.match(b.reply, re);
    }
    const s = await state();
    assert.equal(s.draft?.lines.length, 2);
    assert.equal(s.draft?.totals.net, 2 * 2 + 4 * 9);
    assert.equal(s.draft?.lines.find(l => l.product.id === STEW)?.product.lotStep, 2);
    assert.ok(s.attention.some(x => x.action?.type === 'show_draft'), 'the draft is reachable from the summary');

    const more = await act({ type: 'draft_set', productId: COFFEE, qty: 5 });
    assert.equal(more.state.draft?.lines.find(l => l.product.id === COFFEE)?.qty, 5);
    assert.equal(more.state.draft?.lines.length, 2, 'changing a quantity does not add a line');

    // kept in the state file, and only for this account
    assert.deepEqual(stored().school.draft.map((l: any) => [l.productId, l.qty]), [[COFFEE, 5], [STEW, 4]]);
    assert.deepEqual(stored().hotel.draft, []);
    assert.equal((await state('hotel')).draft, undefined);

    const removed = await act({ type: 'draft_set', productId: COFFEE, qty: 0 });
    assert.deepEqual(removed.state.draft?.lines.map(l => l.product.id), [STEW]);
    assert.ok(removed.state.audit.some(x => x.action === 'draft_line_removed'));
    assert.ok(removed.state.audit.some(x => x.action === 'draft_line_set'));
  });

  it('a product that is not verified for the searched requirement never enters the draft', T, async () => {
    const e = await refused(() => act({ type: 'draft_set', productId: FLOUR_GF, qty: 1, requirements: ['wheat_free'] }));
    assert.match(e.text.en, /wheat/i);
    assert.match(e.text.fi, /vehnä/i);
    assert.ok(!(await state()).draft?.lines.some(l => l.product.id === FLOUR_GF));
    // the same product is fine for the requirement it is verified for, and the requirement stays on the line
    const ok = await act({ type: 'draft_set', productId: FLOUR_GF, qty: 1, requirements: ['gluten_free'] });
    assert.deepEqual(ok.state.draft?.lines.find(l => l.product.id === FLOUR_GF)?.checks.map(c => [c.requirement, c.verdict]), [['gluten_free', 'ok']]);
    const again = await refused(() => act({ type: 'draft_set', productId: FLOUR_GF, qty: 2, requirements: ['wheat_free'] }));
    assert.match(again.text.en, /wheat/i);
    assert.equal((await state()).draft?.lines.find(l => l.product.id === FLOUR_GF)?.qty, 1);
    await refused(() => act({ type: 'draft_set', productId: '999999', qty: 1 }));
    await refused(() => act({ type: 'draft_set', productId: PASTA, qty: -1 }));
  });

  it('the draft becomes an order only through createOrder/verify: a line without a price blocks it', T, async () => {
    await act({ type: 'draft_set', productId: NO_PRICE, qty: 1 });
    const before = (await state()).orders.length;
    const e = await refused(() => act({ type: 'draft_order' }));
    assert.match(e.text.en, /no price returned/);
    const s = await state();
    assert.equal(s.orders.length, before, 'nothing was created');
    assert.equal(s.draft?.lines.length, 3, 'the draft is kept so the user can fix it');

    await act({ type: 'draft_set', productId: NO_PRICE, qty: 0 });
    const r = await act({ type: 'draft_order' });
    const o = orderOf(r);
    assert.equal(r.state.orders.length, before + 1);
    assert.deepEqual(o.lines.map(l => [l.productId, l.qty]).sort(), [[FLOUR_GF, 1], [STEW, 4]].sort());
    assert.equal(o.source, 'ui');
    assert.equal(o.status, 'submitted', 'inside the kitchen user’s own authority');
    assert.equal(o.recheck?.ok, true);
    assert.equal(o.integration.submission, 'local_simulation');
    assert.deepEqual(o.lines.find(l => l.productId === FLOUR_GF)?.checks.map(c => c.verdict), ['ok']);
    assert.equal(r.state.draft, undefined, 'the draft is emptied once it became an order');
    assert.deepEqual(stored().school.draft, []);
    assert.ok(r.state.audit.some(x => x.action === 'order_created' && x.orderId === o.id));

    const empty = await refused(() => act({ type: 'draft_order' }));
    assert.match(empty.text.en, /draft is empty/);
    assert.match((await act({ type: 'show_draft' })).reply, /no order drafts/);
  });
});

// =====================================================================================================
// Last on purpose: the cooldown is process-wide.
describe('2. rate-limited supplier API: nothing is created or sent, and the caller is told when to retry', () => {
  it('429 -> own error with the wait for agent and user; approval keeps the order pending; no call during the cooldown', T, async () => {
    const pending = orderOf(await chat('Tilaa 30 kg riisiä ja 20 l ruokakermaa keskiviikoksi'));
    assert.equal(pending.status, 'pending_approval');
    await act({ type: 'draft_set', productId: PASTA, qty: 1 });
    const before = (await state()).orders.length;

    stub.mode = 'limited';
    stub.retryAfter = '2';
    const quote = await tool('prepare_order', { delivery_date: DATE, items: [{ product_id: PASTA, quantity: 2 }] });
    assert.equal(quote.isError, true);
    assert.equal(quote.data.error, 'supplier_rate_limited');
    assert.ok(quote.data.retry_after_seconds >= 1 && quote.data.retry_after_seconds <= 2);
    assert.match(quote.data.message, /rate limit was hit\. Try again in [12] seconds\. Nothing is created or sent on stale data\./);
    assert.equal(quote.data.quote_id, undefined);
    const calls = stub.calls.length;
    stub.mode = 'ok'; // even if the mock would answer again, it is not asked before the cooldown has passed

    for (const [lang, re] of [['fi', /kutsuraja tuli vastaan\. Yritä uudelleen [12] sekunnin päästä/], ['sv', /begränsade anropen\. Försök igen om [12] sekunder/], ['en', /rate limit was hit\. Try again in [12] seconds/]] as const) {
      const e = await refused(() => act({ type: 'draft_order' }, lang));
      assert.equal(e.code, 'supplier_rate_limited');
      assert.ok(Number(e.extra?.retry_after_seconds) >= 1);
      assert.match(e.text[lang], re);
    }
    const need = await tool('prepare_order', { delivery_date: DATE, need: { query: 'kaurajuoma', amount: 10, unit: 'L' } });
    assert.equal(need.data.error, 'supplier_rate_limited', 'a need is not answered with "no suitable product" while rate-limited');
    const chatError = await refused(() => chat('Tilaa 12 kg makaronia ja 3 kg sokeria torstaiksi'));
    assert.equal(chatError.code, 'supplier_rate_limited');

    const approved = orderOf(await act({ type: 'approve_order', orderId: pending.id }));
    assert.equal(approved.status, 'pending_approval', 'nothing is sent without a fresh check');
    assert.equal(approved.recheck?.ok, false);
    assert.match(approved.recheck!.changes.join(' '), /rate limit was hit/);
    assert.equal(approved.confirmation, undefined);

    const s = await state();
    assert.equal(s.orders.length, before, 'no order was created while rate-limited');
    assert.ok(s.attention.some(a => a.id === 'valio' && /rate limit/.test(a.text)), 'the user sees the rate limit');
    assert.equal(stub.calls.length, calls, 'the mock was not called during the cooldown');

    await sleep(2100);
    const sent = orderOf(await act({ type: 'approve_order', orderId: pending.id }));
    assert.equal(sent.status, 'submitted');
    assert.equal(sent.recheck?.ok, true);
    assert.ok(stub.calls.length > calls);
    assert.equal(orderOf(await act({ type: 'draft_order' })).lines[0].productId, PASTA);
  });
});

// =====================================================================================================
describe('sole-trader café account', () => {
  it('has no menu, small limits of its own and suggestions that start from ordering', async () => {
    const s = await state('cafe');
    assert.equal(s.kitchen.kind, 'cafe');
    assert.equal(s.menu, undefined);
    const a = s.kitchen.authority;
    assert.deepEqual([a.autoApproveLimit, a.agentAutoLimit, a.weeklyBudget, a.creditLimit], [300, 100, 500, 1000]);
    assert.ok(s.profiles.some(p => p.id === 'cafe' && p.kind === 'cafe'));
    assert.ok(s.suggestions.length >= 3);
    assert.ok(s.suggestions.every(x => !/menu|lunches|portions/i.test(x)), 'nothing about menus or portions');
  });
  it('an own order inside 300 EUR goes out at once; a larger one waits for approval', T, async () => {
    await act({ type: 'draft_set', productId: PASTA, qty: 2 }, 'en', 'cafe');
    const small = orderOf(await act({ type: 'draft_order' }, 'en', 'cafe'));
    assert.equal(small.status, 'submitted');
    assert.ok(small.totals.net < 300);
    await act({ type: 'draft_set', productId: PASTA, qty: 200 }, 'en', 'cafe');
    const big = orderOf(await act({ type: 'draft_order' }, 'en', 'cafe'));
    assert.ok(big.totals.net > 300);
    assert.equal(big.status, 'pending_approval');
    assert.ok(big.approval.reasons.some(r => /300/.test(r)), big.approval.reasons.join(' | '));
    // the other accounts keep their own limits
    assert.equal((await state('school')).kitchen.authority.autoApproveLimit, 1500);
  });
});
