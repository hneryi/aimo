// Shared purchasing path, using only the local supplier stub and ephemeral signing keys.
import assert from 'node:assert/strict';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';
import express from 'express';
import type { Order, TurnResponse, UiAction } from '../../shared/types.ts';
import { documentClaims, priceDifferences, verifyDocument } from '../../web/src/signatures.ts';
import { startStub } from './mock-stub.ts';

const stub = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-purchasing-'));
Object.assign(process.env, {
  VALIO_BASE_URL: stub.url, VALIO_API_KEY: 'offline-test', STATE_FILE: join(dir, 'state.json'), DATA_DIR: dir,
  SIGNING_KEY: '', AGENT_TOKEN: 'offline-shared', APPROVERS: 'Buyer:1234', CUTOFF_MODE: 'warn',
  VERDA_API_KEY: '', VERDA_BASE_URL: stub.url, PUBLIC_URL: 'https://aimo.invalid',
});
const { loadCatalog } = await import('../src/catalog.ts');
const { handleAction, handleChat } = await import('../src/app.ts');
const { createOrder, prepareQuote, approveOrder, decideOrder, orderView, getQuote } = await import('../src/orders.ts');
const { loadState, S, resetState, save, ACTOR, l3, runAs } = await import('../src/store.ts');
const { createAgent } = await import('../src/agents.ts');
const { handleMcp } = await import('../src/mcp.ts');
const { jwks } = await import('../src/signing.ts');
loadCatalog();
loadState();
const app = express();
app.use(express.json());
app.all('/mcp', handleMcp);
app.get('/.well-known/jwks.json', (_req, res) => res.json(jwks()));
const http: Server = await new Promise(done => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
after(async () => {
  http.closeAllConnections();
  await new Promise(done => http.close(done));
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  // The supplier client deliberately keeps a 15 s outage circuit breaker, even for fresh reads.
  if (stub.mode === 'down') await new Promise(done => setTimeout(done, 15_100));
  resetState(); stub.mode = 'ok'; stub.offers.clear();
});

const DATE = '2026-11-16', PASTA = '474235';
const T = { timeout: 60_000 };
const act = (action: UiAction, approver: string | undefined = 'Buyer') => handleAction(action, 'en', approver);
function orderOf(r: TurnResponse): Order {
  const c = r.cards.find(c => c.type === 'order');
  assert.ok(c && c.type === 'order');
  return c.order;
}
const newOrder = (key = 'kitchen-test-1') => ({ source: 'ui' as const, actor: ACTOR.kitchen, title: l3('Testi', 'Test', 'Test'), deliveryDate: DATE, idempotencyKey: key, lines: [{ productId: PASTA, qty: 1, reqs: [], groupIds: [] }] });
const prepared = () => prepareQuote({ ...newOrder(), agentName: 'Aimo', request: 'Test' });
function assertProof(o: Order) {
  assert.ok(o.quote);
  assert.equal(o.quoteId, o.quote.id);
  assert.equal(o.quote.recipient.identity, 'kitchen');
  assert.equal(o.quote.recipient.id, 'kitchen');
  assert.equal(o.quote.account, 'school');
  assert.ok(Date.parse(o.quote.observedAt) <= Date.parse(o.quote.createdAt));
  const stored = S().quotes.find(q => q.id === o.quoteId)!;
  assert.equal(stored.source, 'ui');
  assert.equal(stored.orderId, o.id);
  assert.equal(S().audit.filter(a => a.action === 'quote_prepared').length, 1);
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(base + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const frames = (await res.text()).split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
  const result = JSON.parse(frames.at(-1)!).result;
  return { error: !!result.isError, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
}

it('weekly order: signed quote, same order before and after submission, no surplus quotes', T, async () => {
  await act({ type: 'load_demo_menu' });
  await act({ type: 'set_portions', total: 20 });
  await act({ type: 'confirm_recipe', date: '2026-11-20', recipeId: 'lohikeitto' });
  S().kitchen.authority.autoApproveLimit = 1;
  const first = orderOf(await act({ type: 'create_order' }));
  assertProof(first);
  assert.equal(first.status, 'pending_approval');
  assert.match(first.approval.reasons.join(' '), /ordering authority/);
  assert.equal(orderOf(await act({ type: 'create_order' })).id, first.id);
  assert.equal(S().quotes.length, 1);
  assert.equal(orderOf(await act({ type: 'approve_order', orderId: first.id })).status, 'submitted');
  assert.equal(orderOf(await act({ type: 'create_order' })).id, first.id);
  assert.equal(S().quotes.length, 1);
  assert.equal(S().orders.length, 1);
});

it('draft order: same quote path and content-based retry, also after quote retention cleanup', T, async () => {
  await act({ type: 'draft_set', productId: PASTA, qty: 1 });
  const first = orderOf(await act({ type: 'draft_order' }));
  assertProof(first);
  assert.equal(first.status, 'submitted');
  const signature = first.quote!.signed;
  S().quotes = []; // order evidence must not depend on the rolling quote cache
  await act({ type: 'draft_set', productId: PASTA, qty: 1 });
  const again = orderOf(await act({ type: 'draft_order' }));
  assert.equal(again.id, first.id);
  assert.equal(again.quote!.signed, signature);
  assert.equal(S().quotes.length, 0);
  assert.equal(S().orders.length, 1);
});

it('chat quick order: signed single-use quote and mandatory confirmation even below the limit', T, async () => {
  const message = 'Tilaa 10 litraa laktoositonta maitoa maanantaiksi';
  const first = orderOf(await handleChat(message, 'fi'));
  assertProof(first);
  assert.equal(first.status, 'pending_approval');
  assert.ok(first.totals.net < S().kitchen.authority.autoApproveLimit);
  assert.match(first.approval.reasons.join(' '), /vahvista ennen/);
  const second = orderOf(await handleChat(message, 'fi'));
  assert.equal(second.id, first.id);
  assert.equal(S().quotes.length, 1);
});

it('approver mode stays unchanged: unsigned draft waits, signed-in draft can submit', T, async () => {
  await act({ type: 'draft_set', productId: PASTA, qty: 1 });
  const unsigned = orderOf(await handleAction({ type: 'draft_order' }, 'en'));
  assertProof(unsigned);
  assert.equal(unsigned.status, 'pending_approval');
  assert.match(unsigned.approval.reasons.join(' '), /without signing in/);
  await assert.rejects(() => handleAction({ type: 'approve_order', orderId: unsigned.id }, 'en'), (e: any) => e.code === 'approver_required');
  await act({ type: 'draft_set', productId: PASTA, qty: 2 });
  const signed = orderOf(await act({ type: 'draft_order' }));
  assert.equal(signed.status, 'submitted');
  assert.equal(signed.createdBy, 'Buyer');
});

it('kitchen quote cannot be consumed through MCP by either token kind or through another account', T, async () => {
  const { quote } = await prepared();
  const { token } = createAgent('outside', 100, 1000, 1, ACTOR.kitchen);
  for (const credential of ['offline-shared', token]) for (const method of ['place_order', 'request_approval']) {
    const r = await tool(credential, method, { quote_id: quote.id, idempotency_key: 'foreign-quote-key' });
    assert.equal(r.error, true);
    assert.match(r.data.message, /Quote not found/);
  }
  assert.throws(() => runAs('hotel', () => getQuote(quote.id, undefined, undefined, 'ui')), /Quote not found/);
  assert.equal(S().orders.length, 0);
  assert.equal(quote.orderId, undefined);
  assert.equal(S().audit.filter(a => a.action === 'quote_access_denied').length, 4);
});

it('agent quote cannot be used by the in-process kitchen path (including forged caller lines)', T, async () => {
  for (const credential of ['offline-shared', createAgent('outside', 100, 1000, 1, ACTOR.kitchen).token]) {
    const q = await tool(credential, 'prepare_order', { delivery_date: DATE, items: [{ product_id: PASTA, quantity: 1 }] });
    await assert.rejects(() => createOrder({ ...newOrder(), quoteId: q.data.quote_id }), /Quote not found/);
  }
  assert.equal(S().orders.length, 0);
});

it('kitchen quote is single-use, stays used after rejection, and rejects expired quotes', T, async () => {
  const { quote } = await prepared();
  const n = { ...newOrder(), quoteId: quote.id, forceApproval: l3('Vahvista', 'Bekräfta', 'Confirm') };
  const first = await createOrder(n);
  assert.equal((await createOrder(n)).order.id, first.order.id);
  await assert.rejects(() => createOrder({ ...n, idempotencyKey: 'other-key' }), (e: any) => e.code === 'quote_already_used');
  decideOrder(first.order.id, 'rejected');
  await assert.rejects(() => createOrder(n), (e: any) => e.code === 'quote_already_used');
  const fresh = (await prepared()).quote;
  fresh.expiresAt = '2000-01-01T00:00:00Z';
  await assert.rejects(() => createOrder({ ...n, quoteId: fresh.id }), /expired/);
});

it('concurrent kitchen retries prepare exactly one quote and send exactly once', T, async () => {
  const results = await Promise.all([createOrder(newOrder()), createOrder(newOrder())]);
  assert.equal(results[0].order.id, results[1].order.id);
  assert.equal(results[1].duplicate, true);
  assert.equal(S().quotes.length, 1);
  assert.equal(S().audit.filter(a => a.action === 'order_submitted').length, 1);
});

it('automatic kitchen and MCP orders refuse price drift without consuming the quote', T, async () => {
  const { quote } = await prepared();
  const external = await tool('offline-shared', 'prepare_order', { delivery_date: DATE, items: [{ product_id: PASTA, quantity: 1 }] });
  stub.offers.set(PASTA, { ...stub.fallback, price: 3 });
  await assert.rejects(() => createOrder({ ...newOrder(), quoteId: quote.id }), (e: any) => e.code === 'price_changed');
  const mcp = await tool('offline-shared', 'place_order', { quote_id: external.data.quote_id, idempotency_key: 'price-change-key' });
  assert.equal(mcp.data.error, 'price_changed');
  assert.equal(S().orders.length, 0);
  assert.equal(quote.orderId, undefined);
  assert.ok(S().audit.some(a => a.action === 'quote_price_changed'));
});

it('human approval never sends a changed price with the same click; signed quote stays original, confirmation has the final prices', T, async () => {
  const { quote } = await prepared();
  stub.offers.set(PASTA, { ...stub.fallback, price: 3 });
  const { order } = await createOrder({ ...newOrder(), quoteId: quote.id, forceApproval: l3('Vahvista', 'Bekräfta', 'Confirm') });
  assert.equal(order.net, 3);
  assert.equal(order.status, 'pending_approval');
  stub.offers.set(PASTA, { ...stub.fallback, price: 4 });
  await approveOrder(order.id);
  // first click: the price moved from 3 to 4, so nothing is sent; the order shows the new price and waits
  assert.equal(order.status, 'pending_approval');
  assert.equal(order.net, 4);
  assert.equal(order.confirmation, undefined);
  assert.equal(order.recheck?.ok, false);
  assert.equal(order.recheck?.repriced, true);
  assert.match(order.recheck!.changes.map(c => c.en).join(' '), /price changed.*Approve again/s);
  assert.ok(S().audit.some(a => a.action === 'recheck_price_changed'));
  // second click, at the price now shown: sent
  await approveOrder(order.id);
  assert.equal(order.status, 'submitted');
  assert.equal(order.net, 4);
  assert.equal(order.recheck?.ok, true);
  assert.match(order.events.map(e => e.text.en).join(' '), /price changed/);
  const v = orderView(order, 'en');
  const keys = (await (await fetch(base + '/.well-known/jwks.json')).json()).keys;
  const q = await verifyDocument(v.quote!.signed, keys, { type: 'aimo.quote.v1', jti: v.quoteId });
  const c = await verifyDocument(v.signedConfirmation!, keys, { type: 'aimo.order_confirmation.v1', jti: v.id });
  assert.equal(q.claims!.total_excl_vat, 2);
  assert.equal(c.claims!.total_excl_vat, 4);
  assert.equal(c.claims!.quote_id, q.claims!.jti);
  assert.equal(c.claims!.submission, 'local_simulation');
  assert.deepEqual(priceDifferences(q.claims!, c.claims!), [{ id: PASTA, quoted: 2, sent: 4 }]);
  assert.deepEqual(priceDifferences(q.claims!, q.claims!), []);
  assert.deepEqual(priceDifferences(documentClaims(v.quote!.signed)!, documentClaims(v.signedConfirmation!)!), [{ id: PASTA, quoted: 2, sent: 4 }]);
});

it('both signatures verify with the published key in Node and browser WebCrypto; tampering fails', T, async () => {
  const { order } = await createOrder(newOrder());
  const o = orderView(order, 'en');
  const { keys } = await (await fetch(base + '/.well-known/jwks.json')).json();
  for (const token of [o.quote!.signed, o.signedConfirmation!]) {
    const [h, p, sig] = token.split('.');
    assert.equal(verifySignature(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(sig, 'base64url')), true);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const expected = { type: claims.type, jti: claims.jti, account: 'school' };
    assert.equal((await verifyDocument(token, keys, expected)).status, 'verified');
    const changed = Buffer.from(JSON.stringify({ ...claims, total_excl_vat: 999 })).toString('base64url');
    assert.equal((await verifyDocument(`${h}.${changed}.${sig}`, keys, expected)).status, 'invalid');
    assert.equal((await verifyDocument(token, keys, { ...expected, jti: 'another-order' })).status, 'invalid');
    assert.equal((await verifyDocument(token, [], expected)).status, 'invalid');
  }
});

it('browser verifier reports unsupported Ed25519 without claiming verification', T, async t => {
  const { order } = await createOrder(newOrder());
  const token = order.quote!.signed;
  t.mock.method(crypto.subtle, 'importKey', async () => { throw new DOMException('Unsupported', 'NotSupportedError'); });
  assert.equal((await verifyDocument(token, jwks().keys, {})).status, 'unsupported');
});

it('supplier failure and failed/unknown allergens never produce a kitchen quote or order', T, async () => {
  for (const productId of ['460734', '461219']) {
    await assert.rejects(() => createOrder({ ...newOrder(), lines: [{ productId, qty: 1, reqs: ['wheat_free'], groupIds: [] }] }));
  }
  stub.mode = 'down';
  await assert.rejects(() => createOrder(newOrder()), /mock API did not respond/);
  assert.equal(S().quotes.length, 0);
  assert.equal(S().orders.length, 0);
});

it('supplier failure at quote consumption or approval sends nothing', T, async () => {
  const { quote } = await prepared();
  const { order } = await createOrder({ ...newOrder('pending-before-outage'), forceApproval: l3('Vahvista', 'Bekräfta', 'Confirm') });
  stub.mode = 'down';
  await assert.rejects(() => createOrder({ ...newOrder(), quoteId: quote.id }), /mock API did not respond/);
  assert.equal(S().orders.length, 1);
  assert.equal((await approveOrder(order.id)).status, 'pending_approval');
  assert.equal(order.signedConfirmation, undefined);
  assert.equal(S().audit.filter(a => a.action === 'order_submitted').length, 0);
});

it('legacy state without a quote still loads and displays, without inventing a past quote', T, async () => {
  const { order } = await createOrder(newOrder());
  delete order.quote;
  delete order.quoteId;
  delete order.signedConfirmation;
  S().quotes = [];
  save();
  loadState();
  const old = orderView(S().orders[0], 'en');
  assert.equal(old.id, order.id);
  assert.equal(old.quote, undefined);
  assert.equal(old.quoteId, undefined);
  assert.equal(old.status, 'submitted');
  assert.ok(old.signedConfirmation);
});
