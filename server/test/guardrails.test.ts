// Integration tests for the guardrails: an isolated Aimo server is started on its own port with its
// own state file, driven through the same HTTP API the web UI uses and through the MCP endpoint an
// external purchasing agent uses, and killed afterwards.
//
// Prices and availability come from the real Valio Aimo challenge mock API (the server caches offers
// for 60 s). The mock occasionally fails a request; helpers below retry ONLY that specific condition
// ("mock API did not respond"), never a guardrail decision.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AuditEntry, DashboardState, Issue, Order, TurnResponse, UiAction } from '../../shared/types.ts';

const PORT = 8801;
const TOKEN = 'test-token-tests';
const AGENT = 'guardrail-test-agent';
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = resolve(SERVER_DIR, '../data/state-tests.json');
const T = { timeout: 180_000 };
const UPSTREAM_DOWN = /mock API did not respond|mockrajapinta ei vastannut|mock-API svarade inte/i;
const FRIDAY = '2026-11-20';
const DELIVERY = '2026-11-16';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- server lifecycle ----------

let server: ChildProcess | undefined;
let serverLog = '';

async function healthy(): Promise<boolean> {
  try { return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
function removeState() { for (const f of [STATE_FILE, STATE_FILE + '.tmp']) rmSync(f, { force: true }); }

before(async () => {
  assert.equal(await healthy(), false, `port ${PORT} is already in use – refusing to test against a server this suite did not start`);
  removeState();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), STATE_FILE: 'data/state-tests.json', AGENT_TOKEN: TOKEN, PUBLIC_URL: `http://localhost:${PORT}` };
  delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout?.on('data', d => { serverLog += d; });
  server.stderr?.on('data', d => { serverLog += d; });
  process.on('exit', () => server?.kill('SIGKILL'));
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode}):\n${serverLog}`);
    if (await healthy()) return;
    await sleep(250);
  }
  throw new Error(`server did not become healthy:\n${serverLog}`);
}, { timeout: 60_000 });

after(async () => {
  if (server && server.exitCode === null) {
    const gone = new Promise(r => server!.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([gone, sleep(5000).then(() => server!.kill('SIGKILL'))]);
  }
  removeState();
});

// ---------- HTTP helpers (same API as the web UI) ----------

interface Res<B> { status: number; body: B }

async function post<B = any>(path: string, payload: unknown): Promise<Res<B>> {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = { raw: text }; }
  return { status: res.status, body };
}
async function get<B = any>(path: string): Promise<Res<B>> {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

/** POST /api/action. Retries only when the upstream mock API was unreachable. */
async function act(action: UiAction | Record<string, unknown>, lang = 'en'): Promise<Res<TurnResponse & { error?: string }>> {
  let res = await post('/api/action', { action, lang });
  for (let i = 0; i < 4 && res.status === 422 && UPSTREAM_DOWN.test(res.body?.error ?? ''); i++) {
    await sleep(3000);
    res = await post('/api/action', { action, lang });
  }
  return res;
}

const openAllergenIssues = (s: DashboardState): Issue[] =>
  (s.plan?.issues ?? []).filter(i => !i.resolved && (i.kind === 'allergen_fail' || i.kind === 'allergen_unknown'));

/** GET /api/state. Re-reads when the plan visibly suffers from an upstream outage (offer errors). */
async function state(): Promise<DashboardState> {
  let res = await get<DashboardState>('/api/state?lang=en');
  for (let i = 0; i < 4; i++) {
    const plan = res.body?.plan;
    const outage = res.status === 200 && !!plan && (plan.lines.some(l => l.offer.error) || openAllergenIssues(res.body).some(x => !x.alternatives?.length));
    if (!outage) break;
    await sleep(3000);
    res = await get<DashboardState>('/api/state?lang=en');
  }
  assert.equal(res.status, 200, `GET /api/state -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body;
}
async function orders(): Promise<Order[]> {
  const res = await get<{ orders: Order[] }>('/api/orders?lang=en');
  assert.equal(res.status, 200);
  return res.body.orders;
}
async function auditLog(): Promise<AuditEntry[]> {
  const res = await get<{ entries: AuditEntry[] }>('/api/audit?lang=en');
  assert.equal(res.status, 200);
  return res.body.entries;
}
const orderCard = (r: Res<TurnResponse>): Order => {
  const c = r.body.cards.find(c => c.type === 'order');
  assert.ok(c && c.type === 'order', 'response carries an order card');
  return c.order;
};
/** approve_order; a re-check that was blocked only because the mock API was unreachable is retried. */
async function approve(orderId: string): Promise<Res<TurnResponse & { error?: string }>> {
  let res = await act({ type: 'approve_order', orderId });
  for (let i = 0; i < 4 && res.status === 200; i++) {
    const o = orderCard(res);
    if (o.status !== 'pending_approval' || o.recheck?.ok !== false || !o.recheck.changes.some(c => UPSTREAM_DOWN.test(c))) break;
    await sleep(3000);
    res = await act({ type: 'approve_order', orderId });
  }
  return res;
}

// ---------- MCP helpers (what an external purchasing agent sends) ----------

let rpcId = 0;
const AUTH = { authorization: `Bearer ${TOKEN}`, 'x-agent-name': AGENT };

async function mcpPost(payload: unknown, headers: Record<string, string> = AUTH): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(payload) });
  const text = await res.text();
  let json: any;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
    json = data.length ? JSON.parse(data[data.length - 1]) : undefined;
  } else {
    try { json = text ? JSON.parse(text) : undefined; } catch { json = { raw: text }; }
  }
  return { status: res.status, headers: res.headers, json };
}
async function rpc(method: string, params?: unknown): Promise<any> {
  const res = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method, params });
  assert.equal(res.status, 200, `${method} -> HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  assert.equal(res.json?.error, undefined, `${method} -> ${JSON.stringify(res.json?.error)}`);
  return res.json.result;
}
interface ToolResult { isError: boolean; data: any }
/** tools/call. Retries only when the tool reports that the upstream mock API was unreachable. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  let out: ToolResult = { isError: true, data: undefined };
  for (let i = 0; i < 5; i++) {
    const result = await rpc('tools/call', { name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    let data = result.structuredContent;
    if (data === undefined) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
    out = { isError: !!result.isError, data };
    if (!(out.isError && UPSTREAM_DOWN.test(String(data?.message ?? data?.raw ?? '')))) break;
    await sleep(3000);
  }
  return out;
}

// =====================================================================================================
// 1. Kitchen flow through the UI API
// =====================================================================================================

describe('kitchen flow: menu -> portions -> plan -> allergen guardrail -> approval -> submission', () => {
  let resolvedWith: { issueId: string; productId: string }[] = [];
  let orderId = '';
  let orderNet = 0;
  let confirmation = '';

  it('starts clean: no menu, no plan, no orders, default authority policy', T, async () => {
    const s = await state();
    assert.equal(s.menu, undefined);
    assert.equal(s.plan, undefined);
    assert.deepEqual(s.orders, []);
    assert.equal(s.kitchen.authority.autoApproveLimit, 1500);
    assert.equal(s.kitchen.authority.agentAutoLimit, 500);
    assert.equal(s.kitchen.authority.weeklyBudget, 6000);
    assert.equal(s.kitchen.authority.spentThisWeek, 0);
    const rules = s.kitchen.authority.rules ?? [];
    assert.equal(rules.find(r => r.id === 'allergen')?.effect, 'never', 'allergen rule cannot be overridden');
    assert.equal(rules.find(r => r.id === 'recheck')?.effect, 'never');
    assert.match(s.integration.ordering.label, /simulation/i, 'order submission is labelled as a simulation');
    const r = await act({ type: 'create_order' });
    assert.equal(r.status, 422, 'no order without a menu');
  });

  it('load_demo_menu: 5 days imported, the unclear Friday dish is a suggestion and not a guess', T, async () => {
    const r = await act({ type: 'load_demo_menu' });
    assert.equal(r.status, 200);
    const s = await state();
    assert.ok(s.menu);
    assert.deepEqual(s.menu.days.map(d => d.date), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', FRIDAY]);
    assert.equal(s.menu.source.kind, 'demo');
    const fri = s.menu.days.find(d => d.date === FRIDAY)!;
    assert.equal(fri.match, 'suggested');
    assert.equal(fri.recipeId, undefined, 'a recipe is never auto-linked from a similar name');
    assert.equal(fri.suggestion?.recipeId, 'lohikeitto');
    for (const d of s.menu.days.filter(d => d.date !== FRIDAY)) assert.equal(d.match, 'confirmed', d.dishName);
    assert.ok(s.plan);
    assert.equal(s.plan.deliveryDate, DELIVERY);
    assert.equal(s.plan.ready, false);
    const open = s.plan.issues.filter(i => !i.resolved && i.severity === 'block').map(i => i.kind);
    assert.ok(open.includes('suggested_recipe'), 'recipe confirmation is a blocking question');
    assert.ok(open.includes('portions'), 'portions are a blocking question');
  });

  it('create_order is refused while portions and the recipe are unconfirmed', T, async () => {
    const r = await act({ type: 'create_order' });
    assert.equal(r.status, 422);
    assert.match(r.body.error ?? '', /open items|unverified/i);
    assert.deepEqual((await state()).orders, []);
  });

  it('set_portions(350, gluten_free 20, wheat_free 8): two separate diet groups', T, async () => {
    const r = await act({ type: 'set_portions', total: 350, groups: [{ requirement: 'gluten_free', count: 20 }, { requirement: 'wheat_free', count: 8 }] });
    assert.equal(r.status, 200);
    const s = await state();
    assert.equal(s.kitchen.portionsConfirmed, true);
    assert.equal(s.kitchen.portionsTotal, 350);
    assert.equal(s.kitchen.standardCount, 322);
    assert.deepEqual(s.kitchen.groups.map(g => [g.id, g.count, g.requirements]), [['gluten_free', 20, ['gluten_free']], ['wheat_free', 8, ['wheat_free']]]);
    assert.ok(!s.plan!.issues.some(i => i.kind === 'portions' && !i.resolved));
    assert.equal(s.plan!.ready, false, 'the Friday recipe is still unconfirmed');
  });

  it('confirm_recipe for Friday: plan is calculated, blocking allergen issues appear, ready=false', T, async () => {
    const r = await act({ type: 'confirm_recipe', date: FRIDAY, recipeId: 'lohikeitto' });
    assert.equal(r.status, 200);
    const s = await state();
    const fri = s.menu!.days.find(d => d.date === FRIDAY)!;
    assert.equal(fri.match, 'confirmed');
    assert.equal(fri.recipeId, 'lohikeitto');
    const plan = s.plan!;
    assert.equal(plan.ready, false);
    assert.ok(!plan.issues.some(i => i.kind === 'suggested_recipe' || i.kind === 'missing_recipe' || i.kind === 'portions'));

    const issues = openAllergenIssues(s);
    assert.ok(issues.length >= 1, 'at least one blocking allergen issue');
    for (const i of issues) {
      assert.equal(i.severity, 'block', i.id);
      assert.ok(i.product, i.id);
      assert.ok(i.check && i.check.verdict !== 'ok', `${i.id}: the reason is a failed or unknown check`);
      assert.equal(i.kind, i.check.verdict === 'fail' ? 'allergen_fail' : 'allergen_unknown');
      assert.ok(i.check.evidence.length > 0, `${i.id}: evidence is shown`);
      assert.ok(i.alternatives && i.alternatives.length >= 1, `${i.id}: a verified alternative is suggested`);
      for (const a of i.alternatives) {
        assert.notEqual(a.product.id, i.product.id);
        assert.equal(a.suitable, true);
        assert.ok(a.checks.length > 0 && a.checks.every(c => c.verdict === 'ok'), `${i.id}: alternative ${a.product.id} is verified`);
        assert.ok(a.checks.some(c => c.requirement === i.check!.requirement), `${i.id}: alternative is checked for the same requirement`);
        assert.equal(typeof a.offer.price, 'number', `${i.id}: alternative ${a.product.id} has a live price`);
        assert.ok(a.product.packSize, 'alternative has a pack size so the quantity can be calculated');
      }
    }
    // the three cases the demo is built around: gluten-free wheat starch (declared + undeclared) and missing data
    const byId = new Map(issues.map(i => [i.id, i]));
    const flour = byId.get('al|jauho|wheat_free'), bread = byId.get('al|leipa|wheat_free'), stock = byId.get('al|liemi|wheat_free');
    assert.ok(flour && bread && stock, `expected wheat-free issues for flour, bread and stock, got ${[...byId.keys()].join(', ')}`);
    assert.equal(flour.product!.id, '460734');
    assert.equal(flour.kind, 'allergen_fail');
    assert.equal(flour.check!.requirement, 'wheat_free');
    assert.equal(bread.product!.id, '467032');
    assert.equal(bread.kind, 'allergen_fail');
    assert.equal(stock.product!.id, '461219');
    assert.equal(stock.kind, 'allergen_unknown', 'missing supplier data blocks just like a failed check');
    assert.equal(stock.check!.verdict, 'unknown');
    // gluten-free portions are fine with the same products: the two diets are checked separately
    assert.ok(!issues.some(i => i.id.endsWith('|gluten_free')), 'no gluten-free issue');

    // nothing unverified sits on a line, and the stopped products do not serve the wheat-free group
    for (const l of plan.lines) {
      assert.ok(l.checks.every(c => c.verdict === 'ok'), `line ${l.id}: every check ok`);
      if (l.groupLabels.includes('Wheat-free')) {
        assert.ok(!['460734', '467032', '461219', '460001'].includes(l.id), `line ${l.id} must not serve wheat-free portions`);
        assert.ok(l.checks.some(c => c.requirement === 'wheat_free'), `line ${l.id} is checked for wheat-free`);
      }
      if (l.groupLabels.includes('Gluten-free')) assert.ok(l.checks.some(c => c.requirement === 'gluten_free'), `line ${l.id} is checked for gluten-free`);
    }
    assert.ok(plan.lines.find(l => l.id === '460734')?.groupLabels.includes('Gluten-free'), 'the wheat-starch flour still serves gluten-free portions');
    assert.ok(s.attention.some(a => a.tone === 'block'), 'the dashboard asks for attention');
  });

  it('create_order is refused while the plan is not ready', T, async () => {
    const r = await act({ type: 'create_order' });
    assert.equal(r.status, 422);
    assert.match(r.body.error ?? '', /open items|unverified/i);
    const s = await state();
    assert.deepEqual(s.orders, []);
    assert.equal(s.plan!.orderId, undefined);
  });

  it('resolve_issue with a product that fails the check (or has no data) is refused with HTTP 422', T, async () => {
    const attempts: [string, string, RegExp][] = [
      ['al|jauho|wheat_free', '460734', /wheat/i],          // the very product that was stopped
      ['al|leipa|wheat_free', '467032', /wheat/i],          // gluten-free bread with gluten-free wheat starch
      ['al|leipa|wheat_free', '460001', /wheat/i],          // ordinary wheat macaroni
      ['al|liemi|wheat_free', '461219', /information|not used until/i], // unknown is not approvable either
      ['al|jauho|wheat_free', '999999', /not found/i],      // not in the assortment
    ];
    for (const [issueId, productId, why] of attempts) {
      const r = await act({ type: 'resolve_issue', issueId, productId });
      assert.equal(r.status, 422, `${issueId} <- ${productId}`);
      assert.match(r.body.error ?? '', why, `${issueId} <- ${productId}: ${r.body.error}`);
    }
    const s = await state();
    assert.equal(openAllergenIssues(s).length, 3, 'nothing was resolved by a refused product');
    assert.equal(s.plan!.ready, false);
    assert.deepEqual(s.kitchen.memory, [], 'a refused product is not remembered');
    assert.ok(!(await auditLog()).some(a => a.action === 'resolve_issue'), 'no approval was recorded');
  });

  it('resolving each issue with its first suggested alternative works; the plan becomes ready', T, async () => {
    resolvedWith = [];
    for (let guard = 0; guard < 8; guard++) {
      const s = await state();
      const open = openAllergenIssues(s);
      if (!open.length) break;
      const issue = open[0];
      const alt = issue.alternatives?.[0];
      assert.ok(alt, `${issue.id} has a suggested alternative`);
      const r = await act({ type: 'resolve_issue', issueId: issue.id, productId: alt.product.id });
      assert.equal(r.status, 200, `${issue.id} <- ${alt.product.id}: ${r.body?.error}`);
      resolvedWith.push({ issueId: issue.id, productId: alt.product.id });
      const now = await state();
      const same = now.plan!.issues.find(i => i.id === issue.id);
      assert.ok(same?.resolved, `${issue.id} is resolved`);
      assert.ok((same.resolution ?? '').length > 0, 'the resolution is explained');
    }
    assert.equal(resolvedWith.length, 3);
    const s = await state();
    const plan = s.plan!;
    assert.deepEqual(openAllergenIssues(s), []);
    assert.ok(!plan.issues.some(i => !i.resolved && i.severity === 'block'), 'no blocking issue left');
    assert.equal(plan.ready, true);
    assert.equal(s.kitchen.memory.length, 3, 'approved substitutions are remembered');
    for (const { productId } of resolvedWith) {
      const line = plan.lines.find(l => l.id === productId);
      assert.ok(line, `replacement ${productId} is on the plan`);
      assert.ok(line.groupLabels.includes('Wheat-free'));
      assert.ok(line.orderQty >= 1);
      assert.equal(line.checks.find(c => c.requirement === 'wheat_free')?.verdict, 'ok');
      assert.ok(line.changed, 'the change against the usual product is shown');
    }
    for (const l of plan.lines) {
      assert.ok(l.checks.every(c => c.verdict === 'ok'), `line ${l.id}`);
      assert.notEqual(l.status, 'blocked', `line ${l.id}`);
      if (l.groupLabels.includes('Wheat-free')) assert.ok(!['460734', '467032', '461219', '460001'].includes(l.id));
    }
    assert.ok(plan.totals.net > 1500, `the week order (${plan.totals.net} EUR) is above the kitchen user's 1500 EUR limit`);
    assert.equal(plan.totals.lineCount, plan.lines.filter(l => l.orderQty > 0).length);
    assert.equal((await auditLog()).filter(a => a.action === 'resolve_issue').length, 3);
  });

  it('create_order: above the user limit -> pending_approval with reasons, nothing submitted', T, async () => {
    const before = await state();
    const r = await act({ type: 'create_order' });
    assert.equal(r.status, 200, r.body?.error ?? 'unexpected HTTP status');
    const o = orderCard(r);
    orderId = o.id;
    orderNet = o.totals.net;
    assert.match(o.id, /^AIMO-\d{4}-\d{4}$/);
    assert.equal(o.status, 'pending_approval');
    assert.equal(o.source, 'ui');
    assert.equal(o.approval.required, true);
    assert.ok(o.approval.reasons.length >= 1);
    assert.ok(o.approval.reasons.some(x => /exceeds/i.test(x) && /1,500/.test(x)), `limit reason expected, got: ${o.approval.reasons.join(' | ')}`);
    assert.equal(o.approval.decidedBy, undefined);
    assert.equal(o.confirmation, undefined, 'no confirmation before approval');
    assert.ok(o.recheck?.ok, 'prices, availability and allergens were checked at creation');
    assert.equal(o.integration.submission, 'local_simulation');
    assert.equal(o.integration.prices, 'valio_mock');
    assert.equal(o.deliveryDate, DELIVERY);
    assert.equal(o.totals.net, before.plan!.totals.net, 'the order is exactly the plan the user saw');
    assert.equal(o.lines.length, before.plan!.totals.lineCount);
    assert.ok(o.totals.net > 1500);
    for (const l of o.lines) {
      assert.ok(Number.isInteger(l.qty) && l.qty > 0, l.productId);
      assert.ok(l.checks.every(c => c.verdict === 'ok'), `order line ${l.productId}`);
      if (l.groupLabels.includes('Wheat-free')) assert.ok(!['460734', '467032', '461219', '460001'].includes(l.productId));
    }
    for (const { productId } of resolvedWith) assert.ok(o.lines.find(l => l.productId === productId)?.groupLabels.includes('Wheat-free'));

    const s = await state();
    assert.equal(s.orders.length, 1);
    assert.equal(s.orders[0].id, orderId);
    assert.equal(s.plan!.orderId, orderId);
    assert.equal(s.kitchen.authority.spentThisWeek, 0, 'a pending order does not count as spent');
    assert.ok(s.attention.some(a => a.action?.type === 'show_order' && a.action.orderId === orderId), 'the approval request is on the dashboard');
    const log = await auditLog();
    assert.ok(log.some(a => a.action === 'order_created' && a.orderId === orderId));
    assert.ok(log.some(a => a.action === 'approval_required' && a.orderId === orderId));
    assert.ok(!log.some(a => a.action === 'order_submitted'));
  });

  it('create_order again returns the same order id – no duplicate', T, async () => {
    const r = await act({ type: 'create_order' });
    assert.equal(r.status, 200, r.body?.error ?? 'unexpected HTTP status');
    const o = orderCard(r);
    assert.equal(o.id, orderId);
    assert.equal(o.status, 'pending_approval');
    assert.match(r.body.reply, /already exists/i);
    assert.equal((await orders()).length, 1);
    assert.ok((await auditLog()).some(a => a.action === 'duplicate_prevented' && a.orderId === orderId));
  });

  it('approve_order: fresh re-check, then submission with a confirmation number', T, async () => {
    const r = await approve(orderId);
    assert.equal(r.status, 200, r.body?.error ?? 'unexpected HTTP status');
    const o = orderCard(r);
    assert.equal(o.id, orderId);
    assert.equal(o.status, 'submitted', `re-check: ${JSON.stringify(o.recheck)}`);
    assert.match(o.confirmation ?? '', /^SIM-[0-9A-F]{8}$/);
    confirmation = o.confirmation!;
    assert.ok(o.recheck, 'a re-check result is stored on the order');
    assert.equal(o.recheck.ok, true);
    assert.ok(Date.parse(o.recheck.at) > Date.parse(o.createdAt), 're-check happened at approval time, after creation');
    assert.equal(o.recheck.at, o.approval.decidedAt, 're-check and decision belong to the same approval');
    assert.equal(o.approval.decidedBy, 'Kitchen manager');
    assert.ok(o.events.some(e => /re-checked/i.test(e.text)));
    assert.ok(o.events.some(e => /simulation/i.test(e.text) && e.text.includes(confirmation)));
    assert.match(o.integration.note, /nothing was sent to Valio Aimo/i);
    orderNet = o.totals.net;

    const s = await state();
    assert.equal(s.orders.length, 1);
    assert.equal(s.kitchen.authority.spentThisWeek, orderNet, 'the submitted order counts against the weekly budget');
    assert.ok(s.deliveries.some(d => d.orderId === orderId && d.status === 'submitted' && d.date === DELIVERY));
    const log = await auditLog();
    assert.equal(log.filter(a => a.action === 'order_approved' && a.orderId === orderId).length, 1);
    assert.equal(log.filter(a => a.action === 'order_submitted' && a.orderId === orderId).length, 1);
  });

  it('approving again does not create or send a second order', T, async () => {
    const r = await approve(orderId);
    assert.equal(r.status, 200, r.body?.error ?? 'unexpected HTTP status');
    const o = orderCard(r);
    assert.equal(o.id, orderId);
    assert.equal(o.status, 'submitted');
    assert.equal(o.confirmation, confirmation);
    const all = await orders();
    assert.equal(all.length, 1);
    const s = await state();
    assert.equal(s.kitchen.authority.spentThisWeek, orderNet, 'not charged twice');
    const log = await auditLog();
    assert.equal(log.filter(a => a.action === 'order_submitted').length, 1, 'exactly one submission in the audit log');
    assert.equal(log.filter(a => a.action === 'order_approved').length, 1);
  });

  it('create_order after submission still returns the same order', T, async () => {
    const r = await act({ type: 'create_order' });
    assert.equal(r.status, 200, r.body?.error ?? 'unexpected HTTP status');
    assert.equal(orderCard(r).id, orderId);
    assert.equal(orderCard(r).status, 'submitted');
    assert.equal((await orders()).length, 1);
  });

  it('a submitted order cannot be rejected or cancelled afterwards; unknown orders are refused', T, async () => {
    assert.equal((await act({ type: 'reject_order', orderId })).status, 422);
    assert.equal((await act({ type: 'cancel_order', orderId })).status, 422);
    assert.equal((await act({ type: 'approve_order', orderId: 'AIMO-0000-9999' })).status, 422);
    assert.equal((await orders())[0].status, 'submitted');
  });

  it('the audit log is a valid SHA-256 hash chain and tells the whole story', T, async () => {
    assert.ok(existsSync(STATE_FILE));
    const stored: { id: string; at: string; actor: unknown; action: string; text: unknown; orderId?: string; hash: string }[] = JSON.parse(readFileSync(STATE_FILE, 'utf8')).profiles.school.audit;
    assert.ok(stored.length >= 10);
    let prev = 'genesis';
    for (const a of stored) {
      const entry = { id: a.id, at: a.at, actor: a.actor, action: a.action, text: a.text, orderId: a.orderId };
      const expected = createHash('sha256').update(prev + JSON.stringify(entry)).digest('hex');
      assert.equal(a.hash, expected, `audit entry ${a.id} (${a.action}) breaks the chain`);
      prev = a.hash;
    }
    const actions = stored.map(a => a.action);
    const order = ['set_portions', 'confirm_recipe', 'resolve_issue', 'order_created', 'approval_required', 'duplicate_prevented', 'order_approved', 'order_submitted'];
    let at = -1;
    for (const step of order) {
      const i = actions.indexOf(step, at + 1);
      assert.ok(i > at, `audit log has "${step}" in the expected order (${actions.join(', ')})`);
      at = i;
    }
    // the API shows the same entries, newest first, with the hash truncated for display
    const shown = await auditLog();
    for (const e of shown) {
      const full = stored.find(a => a.id === e.id);
      assert.ok(full, e.id);
      assert.ok(e.hash && full.hash.startsWith(e.hash) && e.hash.length >= 16);
      assert.ok(e.actor.length > 0 && e.text.length > 0);
    }
  });
});

// =====================================================================================================
// 2. External purchasing agent through MCP
// =====================================================================================================

describe('MCP: an external purchasing agent is held to the same rules', () => {
  const TOOLS = ['get_authority', 'search_products', 'get_price_availability', 'check_allergens', 'prepare_order', 'place_order', 'request_approval', 'get_order_status', 'list_orders', 'get_audit_log'];
  const KEY_OVER = 'itest-over-limit-0001';
  const KEY_UNDER = 'itest-within-limit-0001';
  let productId = '';
  let unitPrice = 0;
  let clean = false; // the chosen product has stated stock and an open cutoff, so the amount is the only possible reason
  let overQuote = '';
  let overTotal = 0;
  let mcpOrderId = '';

  it('a request without a token is rejected with 401', T, async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {});
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/i);
    assert.equal(res.json?.result, undefined);
    assert.ok(res.json?.error, 'JSON-RPC error body');
    const call = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_orders', arguments: {} } }, {});
    assert.equal(call.status, 401);
    assert.equal(call.json?.result, undefined);
  });

  it('a wrong token is rejected with 401', T, async () => {
    for (const authorization of ['Bearer wrong-token', `Bearer ${TOKEN}x`, TOKEN, `Basic ${TOKEN}`]) {
      const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization });
      assert.equal(res.status, 401, authorization.replace(TOKEN, '<token>'));
    }
  });

  it('speaks MCP over Streamable HTTP: initialize and tools/list', T, async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'aimo-test-suite', version: '1.0.0' } });
    assert.equal(init.serverInfo?.name, 'aimo-purchasing');
    assert.ok(init.capabilities?.tools, 'server advertises tools');
    assert.ok(typeof init.protocolVersion === 'string');
    const list = await rpc('tools/list');
    assert.deepEqual(list.tools.map((t: { name: string }) => t.name).sort(), [...TOOLS].sort());
    for (const t of list.tools) {
      assert.ok(t.description?.length > 20, `${t.name} is described`);
      assert.equal(t.inputSchema?.type, 'object', `${t.name} has an input schema`);
    }
    // the same list is published for people at /api/agent-info
    const info = await get('/api/agent-info?lang=en');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.tools.map((t: { name: string }) => t.name).sort(), [...TOOLS].sort());
    assert.match(info.body.mcpUrl, /\/mcp$/);
    // stateless server: GET is not supported
    const res = await fetch(`${BASE}/mcp`, { headers: { ...AUTH, accept: 'text/event-stream' } });
    assert.equal(res.status, 405);
    await res.text();
  });

  it('get_authority states the agent limit (500 EUR), the budget and the never-rules', T, async () => {
    const { isError, data } = await tool('get_authority');
    assert.equal(isError, false);
    assert.equal(data.agent, AGENT);
    assert.equal(data.per_order_limit_excl_vat, 500);
    assert.equal(data.weekly_budget, 6000);
    assert.equal(data.currency, 'EUR');
    assert.ok(Math.abs(data.weekly_budget - data.spent_this_week - data.remaining_this_week) < 0.011);
    assert.equal(data.rules.find((r: { id: string }) => r.id === 'allergen').effect, 'never');
    assert.equal(data.rules.find((r: { id: string }) => r.id === 'agent-limit').effect, 'auto');
    assert.match(data.provenance.order_submission, /simulation/i);
    assert.ok(data.supported_requirements.includes('wheat_free') && data.supported_requirements.includes('gluten_free'));
  });

  it('check_allergens explains gluten-free vs wheat-free with evidence', T, async () => {
    const { isError, data } = await tool('check_allergens', { product_id: '460734', requirements: ['gluten_free', 'wheat_free'] });
    assert.equal(isError, false);
    const by = Object.fromEntries(data.requirement_checks.map((c: { requirement: string }) => [c.requirement, c]));
    assert.equal(by.gluten_free.verdict, 'ok');
    assert.equal(by.wheat_free.verdict, 'fail');
    assert.ok(by.wheat_free.evidence.length > 0);
    assert.equal(data.suitable, false);
    const unknown = await tool('check_allergens', { product_id: '461219', requirements: ['wheat_free'] });
    assert.equal(unknown.data.requirement_checks[0].verdict, 'unknown');
    assert.equal(unknown.data.suitable, false);
    assert.equal((await tool('check_allergens', { product_id: '000000' })).isError, true);
  });

  it('prepare_order refuses a product that fails or lacks data for the requirement – no quote, no order', T, async () => {
    const n = (await orders()).length;
    const fail = await tool('prepare_order', { delivery_date: DELIVERY, requirements: ['wheat_free'], items: [{ product_id: '460734', quantity: 1 }] });
    assert.equal(fail.isError, true);
    assert.equal(fail.data.error, 'rejected_by_rules');
    assert.match(fail.data.message, /wheat/i);
    assert.equal(fail.data.quote_id, undefined);
    const unknown = await tool('prepare_order', { delivery_date: DELIVERY, requirements: ['wheat_free'], items: [{ product_id: '461219', quantity: 1 }] });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.data.error, 'rejected_by_rules');
    const mixed = await tool('prepare_order', { delivery_date: DELIVERY, requirements: ['gluten_free', 'wheat_free'], items: [{ product_id: '474235', quantity: 1 }, { product_id: '467032', quantity: 1 }] });
    assert.equal(mixed.isError, true, 'one unsuitable line rejects the whole quote');
    const bogus = await tool('place_order', { quote_id: 'Q-DOESNOTEXIST', idempotency_key: 'itest-bogus-quote-1' });
    assert.equal(bogus.isError, true);
    assert.equal((await orders()).length, n);
  });

  it('prepare_order above 500 EUR: quote says approval is required', T, async () => {
    // pick a dry-goods product with stated stock and an open cutoff, so the amount is the only reason
    const candidates = ['463624', '466090', '462171', '476460'];
    const pa = await tool('get_price_availability', { product_ids: candidates, delivery_date: DELIVERY });
    assert.equal(pa.isError, false, JSON.stringify(pa.data).slice(0, 300));
    const offers: { product_id: string; offer: { price_eur_excl_vat_per_sales_unit: number | null; availability: string; available_sales_units: number | null; cutoff_passed: boolean | null; source: string; observed_at: string } }[] = pa.data.offers;
    for (const o of offers) { assert.equal(o.offer.source, 'valio_mock'); assert.ok(!Number.isNaN(Date.parse(o.offer.observed_at))); }
    const priced = offers.filter(o => typeof o.offer.price_eur_excl_vat_per_sales_unit === 'number' && o.offer.price_eur_excl_vat_per_sales_unit > 0);
    assert.ok(priced.length > 0, 'the mock returned at least one price');
    const need = (price: number) => Math.floor(500 / price) + 1;
    const best = priced.find(o => o.offer.availability === 'available' && o.offer.cutoff_passed === false && (o.offer.available_sales_units ?? 0) >= need(o.offer.price_eur_excl_vat_per_sales_unit!));
    const chosen = best ?? priced[0];
    clean = !!best;
    productId = chosen.product_id;
    unitPrice = chosen.offer.price_eur_excl_vat_per_sales_unit!;

    const q = await tool('prepare_order', { delivery_date: DELIVERY, items: [{ product_id: productId, quantity: need(unitPrice) }] });
    assert.equal(q.isError, false, JSON.stringify(q.data).slice(0, 400));
    overQuote = q.data.quote_id;
    overTotal = q.data.total_excl_vat;
    assert.match(overQuote, /^Q-[0-9A-F]{10}$/);
    assert.ok(overTotal > 500, `quote total ${overTotal}`);
    assert.ok(Math.abs(overTotal - need(unitPrice) * unitPrice) < 0.011);
    assert.equal(q.data.within_agent_authority, false);
    assert.equal(q.data.next_step, 'request_approval');
    assert.ok(q.data.approval_required_because.some((x: string) => /exceeds/i.test(x) && /500/.test(x)), q.data.approval_required_because.join(' | '));
    if (clean) assert.equal(q.data.approval_required_because.length, 1, `the limit is the only reason: ${q.data.approval_required_because.join(' | ')}`);
    assert.ok(Date.parse(q.data.expires_at) > Date.now(), 'quote has an expiry in the future');
    assert.match(q.data.content_sha256, /^[0-9a-f]{64}$/);
  });

  it('place_order beyond the 500 EUR agent limit returns approval_required and creates nothing', T, async () => {
    const before = await orders();
    const r = await tool('place_order', { quote_id: overQuote, idempotency_key: KEY_OVER });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, 'approval_required');
    assert.ok(r.data.reasons.some((x: string) => /exceeds/i.test(x) && /500/.test(x)), r.data.reasons.join(' | '));
    assert.equal(r.data.order, undefined);
    const now = await orders();
    assert.equal(now.length, before.length, 'no order was created');
    assert.ok(!now.some(o => o.source === 'mcp' && o.status === 'submitted' && o.totals.net === overTotal));
    assert.ok((await auditLog()).some(a => a.action === 'agent_blocked' && a.text.includes(AGENT)), 'the blocked attempt is in the audit log');
    // trying again does not help
    const again = await tool('place_order', { quote_id: overQuote, idempotency_key: 'itest-over-limit-0002' });
    assert.equal(again.data.error, 'approval_required');
    assert.equal((await orders()).length, before.length);
  });

  it('request_approval creates an order with source mcp in pending_approval', T, async () => {
    const before = await orders();
    const r = await tool('request_approval', { quote_id: overQuote, idempotency_key: KEY_OVER, note: 'restock for week 47' });
    assert.equal(r.isError, false, JSON.stringify(r.data).slice(0, 400));
    assert.equal(r.data.duplicate, false);
    const o = r.data.order;
    mcpOrderId = o.order_id;
    assert.equal(o.status, 'pending_approval');
    assert.equal(o.confirmation, null);
    assert.equal(o.total_excl_vat, overTotal);
    assert.equal(o.approval.required, true);
    assert.ok(o.approval.reasons[0].includes(AGENT), 'the first reason is the agent\'s request');
    assert.ok(o.approval.reasons[0].includes('restock for week 47'), 'the agent\'s note is shown to the approver');
    assert.ok(o.approval.reasons.some((x: string) => /exceeds/i.test(x) && /500/.test(x)));
    assert.equal(o.integration.submission, 'local_simulation');
    assert.ok(o.created_by.includes(AGENT));

    const all = await orders();
    assert.equal(all.length, before.length + 1);
    const stored = all.find(x => x.id === mcpOrderId)!;
    assert.equal(stored.source, 'mcp');
    assert.equal(stored.status, 'pending_approval');
    assert.equal(stored.confirmation, undefined);
    assert.deepEqual(stored.lines.map(l => l.productId), [productId]);
    const s = await state();
    assert.ok(s.attention.some(a => a.action?.type === 'show_order' && a.action.orderId === mcpOrderId), 'the kitchen sees the approval request');
  });

  it('repeating the same idempotency_key returns the same order', T, async () => {
    const before = await orders();
    const again = await tool('request_approval', { quote_id: overQuote, idempotency_key: KEY_OVER, note: 'restock for week 47' });
    assert.equal(again.isError, false);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.order.order_id, mcpOrderId);
    assert.equal(again.data.order.status, 'pending_approval');
    // the key also cannot be used to slip the same order through place_order
    const placed = await tool('place_order', { quote_id: overQuote, idempotency_key: KEY_OVER });
    assert.equal(placed.isError, false);
    assert.equal(placed.data.duplicate, true);
    assert.equal(placed.data.order.order_id, mcpOrderId);
    assert.equal(placed.data.order.status, 'pending_approval', 'still waiting for the human');
    const all = await orders();
    assert.equal(all.length, before.length, 'no second order');
    assert.equal(all.filter(o => o.source === 'mcp' && o.totals.net === overTotal).length, 1);
  });

  it('get_order_status / list_orders show the pending order; unknown ids are errors', T, async () => {
    const st = await tool('get_order_status', { order_id: mcpOrderId });
    assert.equal(st.isError, false);
    assert.equal(st.data.order.status, 'pending_approval');
    assert.ok(st.data.order.events.length >= 2, 'event history is included');
    const list = await tool('list_orders');
    const row = list.data.orders.find((o: { order_id: string }) => o.order_id === mcpOrderId);
    assert.ok(row);
    assert.equal(row.status, 'pending_approval');
    assert.equal(row.approval_required, true);
    assert.equal((await tool('get_order_status', { order_id: 'AIMO-0000-9999' })).isError, true);
  });

  it('the human approves in the kitchen UI -> the agent sees a submitted order with a confirmation', T, async () => {
    const r = await approve(mcpOrderId);
    assert.equal(r.status, 200, r.body?.error ?? 'unexpected HTTP status');
    assert.equal(orderCard(r).status, 'submitted', JSON.stringify(orderCard(r).recheck));
    const st = await tool('get_order_status', { order_id: mcpOrderId });
    assert.equal(st.data.order.status, 'submitted');
    assert.match(st.data.order.confirmation, /^SIM-[0-9A-F]{8}$/);
    assert.equal(st.data.order.approval.decidedBy, 'Kitchen manager');
    assert.equal(st.data.order.recheck.ok, true);
    // the idempotency key keeps pointing at the same, now submitted, order
    const again = await tool('request_approval', { quote_id: overQuote, idempotency_key: KEY_OVER });
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.order.order_id, mcpOrderId);
    assert.equal((await auditLog()).filter(a => a.action === 'order_submitted' && a.orderId === mcpOrderId).length, 1);
  });

  it('inside its authority the agent orders on its own, exactly once per idempotency_key', T, async t => {
    const qty = Math.floor(500 / unitPrice);
    assert.ok(qty >= 1);
    const q = await tool('prepare_order', { delivery_date: DELIVERY, items: [{ product_id: productId, quantity: qty }] });
    assert.equal(q.isError, false, JSON.stringify(q.data).slice(0, 400));
    assert.ok(q.data.total_excl_vat <= 500);
    assert.ok(!q.data.approval_required_because.some((x: string) => /ordering authority/i.test(x)), 'at or below 500 EUR the limit is not a reason');
    if (!q.data.within_agent_authority) {
      // mock data (passed cutoff / unstated stock) or the weekly budget asks for a human: the agent must not get through
      const blocked = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: KEY_UNDER });
      assert.equal(blocked.data.error, 'approval_required');
      t.skip(`live mock data requires approval for another reason: ${q.data.approval_required_because.join(' | ')}`);
      return;
    }
    assert.equal(q.data.next_step, 'place_order');
    const before = await orders();
    const r = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: KEY_UNDER });
    assert.equal(r.isError, false, JSON.stringify(r.data).slice(0, 400));
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.order.status, 'submitted');
    assert.match(r.data.order.confirmation, /^SIM-[0-9A-F]{8}$/);
    assert.equal(r.data.order.approval.required, false);
    assert.equal(r.data.order.approval.decidedBy, 'Aimo rules', 'auto-approval is attributed to the rules, not to a person');
    assert.equal(r.data.order.integration.submission, 'local_simulation');
    const id = r.data.order.order_id;
    const again = await tool('place_order', { quote_id: q.data.quote_id, idempotency_key: KEY_UNDER });
    assert.equal(again.isError, false);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.order.order_id, id);
    const all = await orders();
    assert.equal(all.length, before.length + 1, 'exactly one new order');
    assert.equal(all.find(o => o.id === id)!.source, 'mcp');
    const log = await auditLog();
    assert.equal(log.filter(a => a.action === 'order_submitted' && a.orderId === id).length, 1);
    assert.equal(log.filter(a => a.action === 'auto_approved' && a.orderId === id).length, 1);
  });

  it('get_audit_log gives the agent the same hash-chained record', T, async () => {
    const { isError, data } = await tool('get_audit_log', { limit: 100 });
    assert.equal(isError, false);
    assert.match(data.hash_chain, /sha256/i);
    const actions = data.entries.map((e: { action: string }) => e.action);
    for (const a of ['quote_prepared', 'agent_blocked', 'order_created', 'approval_required', 'duplicate_prevented', 'order_approved', 'order_submitted']) assert.ok(actions.includes(a), `audit has ${a}`);
    for (const e of data.entries) assert.match(e.hash, /^[0-9a-f]{16}$/);
    assert.ok(data.entries.some((e: { actor: string }) => e.actor.includes(AGENT)));
    const one = await tool('get_audit_log', { order_id: mcpOrderId });
    assert.ok(one.data.entries.length >= 3);
    assert.ok(one.data.entries.every((e: { orderId: string }) => e.orderId === mcpOrderId));
  });
});

// =====================================================================================================
// 3. Robustness of the action endpoint against bad input.
//    Runs last: one of these requests currently corrupts the server state.
// =====================================================================================================

describe('robustness: bad input is refused cleanly and never changes state', () => {
  it('a rejected set_portions leaves the confirmed portions untouched', T, async () => {
    const before = await state();
    assert.equal(before.kitchen.portionsTotal, 350);
    try {
      const r = await act({ type: 'set_portions', total: 10 }); // 28 special-diet portions do not fit into 10
      assert.equal(r.status, 422);
      const now = await state();
      assert.equal(now.kitchen.portionsTotal, 350, 'the refused total must not be applied');
      assert.equal(now.kitchen.standardCount, 322);
    } finally {
      await act({ type: 'set_portions', total: 350 });
    }
  });

  it('POST /api/action without an action is a client error, not a 500', T, async () => {
    const r = await post('/api/action', { lang: 'en' });
    assert.ok(r.status >= 400 && r.status < 500, `got HTTP ${r.status}`);
    assert.ok(r.body?.error, 'an error message is returned');
  });

  it('an unknown action type is refused with an error', T, async () => {
    const r = await act({ type: 'drop_all_guardrails' });
    assert.ok(r.status >= 400 && r.status < 500, `got HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.error, 'an error message is returned');
  });

  it('resolve_issue for an id that is not an open issue is a client error, not a 500', T, async () => {
    const r = await act({ type: 'resolve_issue', issueId: 'al|leipa|standard', productId: '462683' });
    assert.ok(r.status >= 400 && r.status < 500, `got HTTP ${r.status}`);
    assert.equal((await act({ type: 'resolve_issue', issueId: 'zz|nothing', productId: '462683' })).status, 422);
  });

  it('set_portions with an unknown dietary requirement is refused and the dashboard keeps working', T, async () => {
    try {
      const r = await act({ type: 'set_portions', groups: [{ requirement: 'bogus_free', count: 5 }] });
      assert.ok(r.status >= 400 && r.status < 500, `got HTTP ${r.status}`);
      const after = await get('/api/state?lang=en');
      assert.equal(after.status, 200, 'GET /api/state must keep working after a refused request');
      assert.ok(!after.body.kitchen.groups.some((g: { id: string }) => g.id === 'bogus_free'));
    } finally {
      // recover the isolated server if the request went through (it only affects this suite's own state file)
      if ((await get('/api/state?lang=en')).status !== 200) await act({ type: 'reset_demo' });
    }
  });
});
