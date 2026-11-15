// Offline tests for agent identity and authority, signed quotes and confirmations, and approver identity.
//
// A real Aimo server (src/index.ts) is started on a free local port, once with APPROVERS set and once without,
// and driven over HTTP exactly like the web UI and an external agent do. Prices and availability come from the
// local stub of the Valio Aimo mock (test/mock-stub.ts); state, the signing key and everything else live in a
// temporary directory. No network, no keys.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentInfo, AuditEntry, DashboardState, Order, TurnResponse, UiAction } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = { timeout: 60_000 };
const DATE = '2026-11-16';
const PASTA = '474235';            // SamMills gluten-free macaroni; the stub prices everything at EUR 2 per sales unit
const SHARED = 'shared-demo-token';
const MAIJA = { name: 'Maija Virtanen', pin: 'kahvi-4821' };
const OLLI = { name: 'Olli Kokki', pin: 'puuro-9034' };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const stub = await startStub();
after(() => stub.close());

// ---------- an isolated server ----------

interface Srv { base: string; dir: string; stateFile: string; start(): Promise<void>; stop(): Promise<void> }

async function isolatedServer(extra: Record<string, string>): Promise<Srv> {
  const port = await new Promise<number>(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => done(p)); }); });
  const dir = mkdtempSync(join(tmpdir(), 'aimo-trust-'));
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, STATE_FILE: join(dir, 'state.json'), DATA_DIR: dir,
    VALIO_BASE_URL: stub.url, VALIO_API_KEY: 'offline-test', VERDA_API_KEY: '', VERDA_BASE_URL: stub.url, AGENT_TOKEN: SHARED, CUTOFF_MODE: 'warn', ...extra,
  };
  for (const k of ['NODE_TEST_CONTEXT', 'SIGNING_KEY', ...(extra.APPROVERS ? [] : ['APPROVERS'])]) delete env[k];
  let child: ChildProcess | undefined;
  let log = '';
  const healthy = async () => { try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
  return {
    base, dir, stateFile: join(dir, 'state.json'),
    async start() {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', d => { log += d; });
      child.stderr?.on('data', d => { log += d; });
      const c = child;
      process.on('exit', () => c.kill('SIGKILL'));
      for (let i = 0; i < 160; i++) {
        if (c.exitCode !== null) throw new Error(`server exited early (${c.exitCode}):\n${log}`);
        if (await healthy()) return;
        await sleep(125);
      }
      throw new Error(`server did not become healthy:\n${log}`);
    },
    async stop() {
      const c = child;
      if (!c || c.exitCode !== null) return;
      const gone = new Promise(r => c.once('exit', r));
      c.kill('SIGTERM');
      await Promise.race([gone, sleep(4000).then(() => c.kill('SIGKILL'))]);
    },
  };
}

// ---------- clients: the web UI's API and an agent's MCP calls ----------

interface Res<B> { status: number; headers: Headers; body: B; text: string }

function client(s: Srv) {
  async function http<B = any>(path: string, init: { body?: unknown; session?: string } = {}): Promise<Res<B>> {
    const headers: Record<string, string> = init.session ? { authorization: `Bearer ${init.session}` } : {};
    const res = await fetch(s.base + path, init.body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(init.body) });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: res.status, headers: res.headers, body, text };
  }
  let rpcId = 0;
  return {
    http,
    act: (action: UiAction, o: { session?: string; profile?: string } = {}) => http<TurnResponse & { error?: string; code?: string }>('/api/action', { body: { action, lang: 'en', profile: o.profile ?? 'school' }, session: o.session }),
    state: async (profile = 'school') => (await http<DashboardState>(`/api/state?lang=en&profile=${profile}`)).body,
    audit: async (profile = 'school') => (await http<{ entries: AuditEntry[] }>(`/api/audit?lang=en&profile=${profile}`)).body.entries,
    login: (who: { name: string; pin: string }) => http<{ token?: string; name?: string; error?: string; code?: string }>('/api/login', { body: { ...who, lang: 'en' } }),
    /** one MCP tool call; `status` is the HTTP status (401/403 carry no tool result) */
    async tool(token: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ status: number; isError: boolean; data: any; message?: string }> {
      const res = await fetch(`${s.base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      });
      const text = await res.text();
      const frames = text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
      const json = JSON.parse(frames.length ? frames[frames.length - 1] : text);
      if (res.status !== 200) return { status: res.status, isError: true, data: undefined, message: json?.error?.message };
      let data = json.result.structuredContent;
      if (data === undefined) { try { data = JSON.parse(json.result.content[0].text); } catch { data = { raw: json.result.content?.[0]?.text }; } }
      return { status: 200, isError: !!json.result.isError, data };
    },
  };
}

/** Verify a compact JWS against a JWK Set, with nothing but node:crypto — what an external agent would do. */
function verifyJws(jws: string, jwkSet: { keys: any[] }): { ok: boolean; header: any; payload: any } {
  const [h, p, sig] = jws.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const jwk = jwkSet.keys.find(k => k.kid === header.kid);
  const ok = !!jwk && header.alg === 'EdDSA' && verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  return { ok, header, payload: JSON.parse(Buffer.from(p, 'base64url').toString()) };
}
const quote = (c: ReturnType<typeof client>, token: string, quantity: number, headers: Record<string, string> = {}) =>
  c.tool(token, 'prepare_order', { delivery_date: DATE, items: [{ product_id: PASTA, quantity }] }, headers);

// =====================================================================================================
describe('with APPROVERS configured', () => {
  let s: Srv;
  let c: ReturnType<typeof client>;
  let session = '';         // Maija's session
  let agentToken = '';      // the registered agent "hotel-bot" (account: hotel)
  let agentId = '';
  let approvedOrder = '';   // an agent order a person approved
  let oldQuote = '';        // a signed quote from before the restart
  let oldKid = '';
  const HOTEL = { 'x-aimo-account': 'hotel' };

  before(async () => {
    s = await isolatedServer({ APPROVERS: `${MAIJA.name}:${MAIJA.pin}, ${OLLI.name}:${OLLI.pin}` });
    c = client(s);
    await s.start();
  }, { timeout: 60_000 });
  after(async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); });

  // ---------------------------------------------------------------------------------------------------
  describe('C. approver identity', () => {
    let pending = '';

    it('the state says that approving needs a signed-in approver; everyday use stays open', T, async () => {
      const st = await c.state();
      assert.equal(st.integration.access.open, false);
      assert.match(st.integration.access.label, /signed-in approver/);
      assert.equal((await c.act({ type: 'draft_set', productId: PASTA, qty: 1 })).status, 200);
      assert.equal((await c.act({ type: 'set_portions', total: 300 })).status, 200);
    });

    it('approving, rejecting and changing authority without signing in are refused with 401', T, async () => {
      const q = await quote(c, SHARED, 300); // EUR 600: above the shared demo limit of EUR 500
      const asked = await c.tool(SHARED, 'request_approval', { quote_id: q.data.quote_id, idempotency_key: 'trust-pending-0001' });
      pending = asked.data.order.order_id;
      assert.equal(asked.data.order.status, 'pending_approval');
      const actions: UiAction[] = [
        { type: 'approve_order', orderId: pending }, { type: 'reject_order', orderId: pending }, { type: 'cancel_order', orderId: pending },
        { type: 'set_credit_limit', limit: 1 }, { type: 'agent_create', name: 'sneaky', perOrderLimit: 9999, weeklyLimit: 9999, validDays: 30 },
        { type: 'agent_update', agentId: 'ag-00000000', perOrderLimit: 9999, weeklyLimit: 9999 }, { type: 'agent_revoke', agentId: 'ag-00000000' }, { type: 'reset_demo' },
      ];
      for (const action of actions) {
        for (const sessionToken of [undefined, 'not-a-session']) {
          const r = await c.act(action, { session: sessionToken });
          assert.equal(r.status, 401, action.type);
          assert.equal(r.body.code, 'approver_required', action.type);
          assert.match(r.body.error ?? '', /signed-in approver/);
        }
      }
      const st = await c.state();
      assert.equal(st.orders.find(o => o.id === pending)?.status, 'pending_approval', 'nothing was decided');
      assert.equal(st.kitchen.authority.creditLimit, undefined);
      assert.deepEqual(st.agents, []);
    });

    it('a wrong PIN or an unknown name gets no session', T, async () => {
      for (const who of [{ name: MAIJA.name, pin: 'kahvi-0000' }, { name: MAIJA.name, pin: '' }, { name: 'Nobody Here', pin: MAIJA.pin }]) {
        const r = await c.login(who);
        assert.equal(r.status, 401, who.name);
        assert.equal(r.body.code, 'login_failed');
        assert.equal(r.body.error, 'The name or PIN is not right.');
        assert.equal(r.body.token, undefined);
      }
    });

    it('the right PIN signs the approver in, and the approval is logged under her name', T, async () => {
      const r = await c.login({ name: MAIJA.name.toUpperCase(), pin: MAIJA.pin });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.name, MAIJA.name);
      session = r.body.token!;
      assert.ok(session.length >= 20);

      const done = await c.act({ type: 'approve_order', orderId: pending }, { session });
      assert.equal(done.status, 200, done.body.error ?? 'unexpected HTTP status');
      const o = done.body.state.orders.find(x => x.id === pending) as Order;
      assert.equal(o.status, 'submitted');
      assert.equal(o.approval.decidedBy, MAIJA.name);
      assert.ok(o.events.some(e => e.actor === MAIJA.name && /^Approved\./.test(e.text)), 'the order event names the approver');
      const entry = (await c.audit()).find(a => a.action === 'order_approved' && a.orderId === pending);
      assert.equal(entry?.actor, MAIJA.name, 'the audit log names the approver');
      // the agent sees who approved
      const seen = await c.tool(SHARED, 'get_order_status', { order_id: pending });
      assert.equal(seen.data.order.approval.decidedBy, MAIJA.name);
    });

    it('an order made without signing in waits for an approver; a signed-in approver’s own order goes out under her name', T, async () => {
      const unsigned = await c.act({ type: 'draft_order' }); // the draft holds 1 x pasta, EUR 2: far below every limit
      assert.equal(unsigned.status, 200, unsigned.body.error ?? 'unexpected HTTP status');
      const waiting = unsigned.body.state.orders[0];
      assert.equal(waiting.status, 'pending_approval');
      assert.match(waiting.approval.reasons.join(' '), /without signing in/);
      assert.equal(waiting.createdBy, 'Kitchen manager');

      await c.act({ type: 'draft_set', productId: PASTA, qty: 2 });
      const signed = await c.act({ type: 'draft_order' }, { session });
      const sent = signed.body.state.orders[0];
      assert.equal(sent.status, 'submitted');
      assert.equal(sent.createdBy, MAIJA.name);
      assert.equal(sent.approval.required, false);
    });

    it('the shared demo token is shown only to a signed-in approver', T, async () => {
      const anonymous = await c.http<AgentInfo>('/api/agent-info?lang=en');
      assert.equal(anonymous.status, 200);
      assert.equal(anonymous.body.token, undefined);
      assert.ok(!anonymous.text.includes(SHARED));
      assert.match(anonymous.body.tokenNote, /self-declared/);
      const signedIn = await c.http<AgentInfo>('/api/agent-info?lang=en', { session });
      assert.equal(signedIn.body.token, SHARED);
      assert.equal(signedIn.body.jwksUrl, `${s.base}/.well-known/jwks.json`);
    });

    it('five wrong PINs lock the name: then even the right PIN is refused with 429', T, async () => {
      for (let i = 0; i < 5; i++) assert.equal((await c.login({ name: OLLI.name, pin: `puuro-000${i}` })).status, 401, `attempt ${i + 1}`);
      const locked = await c.login(OLLI);
      assert.equal(locked.status, 429);
      assert.equal(locked.body.code, 'too_many_attempts');
      assert.ok(Number(locked.headers.get('retry-after')) > 60);
      assert.equal(locked.body.token, undefined);
      // the lock is per name: another approver is not shut out
      assert.equal((await c.login(MAIJA)).status, 200);
    });

    it('PINs and session tokens are neither in the state file nor in the log', T, async () => {
      const file = readFileSync(s.stateFile, 'utf8');
      const log = JSON.stringify(await c.audit());
      for (const secret of [MAIJA.pin, OLLI.pin, 'kahvi-0000', session, sha256(MAIJA.pin)]) {
        assert.ok(!file.includes(secret), 'state file');
        assert.ok(!log.includes(secret), 'audit log');
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('A. registered agents: own token, own account, own limits', () => {
    it('creating an agent returns its token once; afterwards no endpoint and no file has it', T, async () => {
      const r = await c.act({ type: 'agent_create', name: 'hotel-bot', perOrderLimit: 100, weeklyLimit: 150, validDays: 30 }, { session, profile: 'hotel' });
      assert.equal(r.status, 200, r.body.error ?? 'unexpected HTTP status');
      agentToken = r.body.issuedToken!.token;
      agentId = r.body.issuedToken!.agentId;
      assert.match(agentToken, /^aimo-agt-[\w-]{32}$/);
      assert.equal(r.body.issuedToken!.name, 'hotel-bot');
      const view = r.body.state.agents;
      assert.deepEqual(view.map(a => [a.id, a.name, a.perOrderLimit, a.weeklyLimit, a.spentThisWeek, a.status]), [[agentId, 'hotel-bot', 100, 150, 0, 'active']]);
      assert.deepEqual(Object.keys(view[0]).filter(k => /token|hash/i.test(k)), [], 'the view has no token field');
      assert.ok(Date.parse(view[0].expiresAt) > Date.now() + 29 * 86_400_000);
      assert.deepEqual((await c.state('school')).agents, [], 'the agent belongs to the hotel account only');

      // every read endpoint, signed in or not, and the agent's own tools
      const reads = [
        ...(await Promise.all(['/api/state?profile=hotel', '/api/agent-info?profile=hotel', '/api/audit?profile=hotel', '/api/orders?profile=hotel', '/.well-known/jwks.json'].flatMap(p => [c.http(p), c.http(p, { session })]))).map(x => x.text),
        JSON.stringify((await c.tool(agentToken, 'get_authority')).data),
        JSON.stringify((await c.tool(agentToken, 'get_audit_log', { limit: 100 })).data),
        JSON.stringify((await c.act({ type: 'show_audit' }, { session, profile: 'hotel' })).body),
      ];
      for (const text of reads) assert.ok(!text.includes(agentToken) && !text.includes(sha256(agentToken)), text.slice(0, 80));

      const file = readFileSync(s.stateFile, 'utf8');
      assert.ok(!file.includes(agentToken), 'the state file does not hold the token in clear text');
      assert.equal(JSON.parse(file).profiles.hotel.agents[0].tokenHash, sha256(agentToken), 'only its SHA-256 is stored');
      const created = (await c.audit('hotel')).find(a => a.action === 'agent_created');
      assert.equal(created?.actor, MAIJA.name);
      assert.match(created!.text, /hotel-bot .* registered for the account Hotelli Majakka/);
    });

    it('the token decides name and account: X-Agent-Name is ignored, another account is refused', T, async () => {
      const a = await c.tool(agentToken, 'get_authority', {}, { 'x-agent-name': 'spoofed-name' });
      assert.equal(a.status, 200);
      assert.equal(a.data.agent, 'hotel-bot');
      assert.equal(a.data.identity, 'registered');
      assert.equal(a.data.account.id, 'hotel');
      assert.deepEqual(a.data.available_accounts.map((x: any) => x.id), ['hotel']);
      assert.deepEqual(a.data.authorization, { agent_id: agentId, per_order_limit_excl_vat: 100, weekly_limit_excl_vat: 150, ordered_alone_last_7_days: 0, weekly_remaining: 150, expires_at: a.data.authorization.expires_at });
      assert.ok(Date.parse(a.data.authorization.expires_at) > Date.now());
      assert.equal(a.data.per_order_limit_excl_vat, 100);
      assert.equal(a.data.weekly_budget, 12000, 'the account budget still applies');
      assert.match(a.data.rules.find((r: any) => r.id === 'agent-limit').text, /hotel-bot may order on its own up to €100\.00 .* €150\.00 within seven days/);

      for (const account of ['school', 'wedding', 'no-such-account']) {
        const other = await c.tool(agentToken, 'get_authority', {}, { 'x-aimo-account': account });
        assert.equal(other.status, 403, account);
        assert.match(other.message ?? '', /authorised for the account "hotel" only/);
      }
      assert.equal((await c.tool(agentToken, 'list_orders', {}, HOTEL)).status, 200, 'naming its own account is fine');
    });

    it('its own per-order and weekly limits decide what goes through without a human', T, async () => {
      // EUR 120 is inside the account's shared demo limit (EUR 750) but above this agent's EUR 100
      assert.equal((await quote(c, SHARED, 60, HOTEL)).data.within_agent_authority, true);
      const over = await quote(c, agentToken, 60);
      assert.equal(over.data.within_agent_authority, false);
      assert.match(over.data.approval_required_because.join(' | '), /€120\.00 exceeds the agent’s ordering authority of €100\.00/);
      const blocked = await c.tool(agentToken, 'place_order', { quote_id: over.data.quote_id, idempotency_key: 'agent-over-0001' });
      assert.equal(blocked.data.error, 'approval_required');
      assert.equal((await c.state('hotel')).orders.length, 0);

      const first = await quote(c, agentToken, 40); // EUR 80
      assert.equal(first.data.within_agent_authority, true, first.data.approval_required_because.join(' | '));
      const placed = await c.tool(agentToken, 'place_order', { quote_id: first.data.quote_id, idempotency_key: 'agent-own-0001' });
      assert.equal(placed.data.order.status, 'submitted', JSON.stringify(placed.data));
      assert.equal(placed.data.order.created_by, 'Registered agent (hotel-bot)');
      assert.equal(placed.data.order.approval.decidedBy, 'Aimo rules');

      // EUR 80 + EUR 80 would pass the weekly limit of EUR 150, although each order is below EUR 100
      const second = await quote(c, agentToken, 40);
      assert.equal(second.data.within_agent_authority, false);
      assert.deepEqual(second.data.approval_required_because.length, 1);
      assert.match(second.data.approval_required_because[0], /weekly limit of €150\.00 would be exceeded \(ordered on its own in the last 7 days: €80\.00\)/);
      const stopped = await c.tool(agentToken, 'place_order', { quote_id: second.data.quote_id, idempotency_key: 'agent-own-0002' });
      assert.equal(stopped.data.error, 'approval_required', 'the same check runs again at place_order');
      assert.match(stopped.data.reasons.join(' '), /weekly limit/);
      assert.ok((await c.audit('hotel')).some(a => a.action === 'agent_blocked' && /hotel-bot/.test(a.text)));

      const third = await quote(c, agentToken, 30); // EUR 60: 140 in total
      assert.equal(third.data.within_agent_authority, true);
      assert.equal((await c.tool(agentToken, 'place_order', { quote_id: third.data.quote_id, idempotency_key: 'agent-own-0003' })).data.order.status, 'submitted');

      // an order a person approves is that person's decision: it does not use up the agent's weekly limit
      const asked = await c.tool(agentToken, 'request_approval', { quote_id: second.data.quote_id, idempotency_key: 'agent-own-0002' });
      approvedOrder = asked.data.order.order_id;
      assert.equal(asked.data.order.status, 'pending_approval');
      const ok = await c.act({ type: 'approve_order', orderId: approvedOrder }, { session, profile: 'hotel' });
      assert.equal(ok.body.state.orders.find(o => o.id === approvedOrder)?.status, 'submitted');

      const a = await c.tool(agentToken, 'get_authority');
      assert.equal(a.data.authorization.ordered_alone_last_7_days, 140);
      assert.equal(a.data.authorization.weekly_remaining, 10);
      assert.equal((await c.state('hotel')).agents[0].spentThisWeek, 140);
    });

    it('a person can change the limits, and the change is logged', T, async () => {
      const r = await c.act({ type: 'agent_update', agentId, perOrderLimit: 500, weeklyLimit: 1000 }, { session, profile: 'hotel' });
      assert.equal(r.status, 200, r.body.error ?? 'unexpected HTTP status');
      assert.deepEqual(r.body.state.agents.map(a => [a.perOrderLimit, a.weeklyLimit]), [[500, 1000]]);
      assert.equal((await quote(c, agentToken, 60)).data.within_agent_authority, true);
      const entry = (await c.audit('hotel')).find(a => a.action === 'agent_updated');
      assert.equal(entry?.actor, MAIJA.name);
      assert.match(entry!.text, /€100\.00 per order, €150\.00 per week .* → €500\.00 per order, €1,000\.00 per week/);
      assert.equal((await c.act({ type: 'agent_update', agentId, perOrderLimit: -1, weeklyLimit: 10 }, { session, profile: 'hotel' })).status, 422);
      // the agent of another account is out of reach from here
      assert.equal((await c.act({ type: 'agent_update', agentId, perOrderLimit: 1, weeklyLimit: 1 }, { session, profile: 'school' })).status, 422);
    });

    it('a quote belongs to the agent it was given to', T, async () => {
      const mine = await quote(c, agentToken, 5);
      const theirs = await quote(c, SHARED, 5, HOTEL);
      for (const [token, quoteId] of [[SHARED, mine.data.quote_id], [agentToken, theirs.data.quote_id]] as const) {
        for (const call of ['place_order', 'request_approval']) {
          const r = await c.tool(token, call, { quote_id: quoteId, idempotency_key: 'cross-agent-0001' }, HOTEL);
          assert.equal(r.isError, true, call);
          assert.equal(r.data.message, 'Quote not found.');
        }
      }
    });

    it('the shared demo token works as before and is marked self-declared', T, async () => {
      const a = await c.tool(SHARED, 'get_authority', {}, { 'x-agent-name': 'legacy-agent' });
      assert.equal(a.data.agent, 'legacy-agent');
      assert.equal(a.data.identity, 'self_declared');
      assert.match(a.data.identity_note, /self-declared/);
      assert.equal(a.data.account.id, 'school', 'default account');
      assert.equal(a.data.per_order_limit_excl_vat, 500);
      assert.equal(a.data.authorization.agent_id, null);
      assert.deepEqual(a.data.available_accounts.map((x: any) => x.id), ['school', 'wedding', 'hotel', 'cafe']);
      assert.equal((await c.tool(SHARED, 'get_authority', {}, HOTEL)).data.per_order_limit_excl_vat, 750, 'the account comes from the header');
      const q = await quote(c, SHARED, 10, { 'x-agent-name': 'legacy-agent' });
      const placed = await c.tool(SHARED, 'place_order', { quote_id: q.data.quote_id, idempotency_key: 'legacy-key-0001' }, { 'x-agent-name': 'legacy-agent' });
      assert.equal(placed.data.order.status, 'submitted');
      assert.equal(placed.data.order.created_by, 'External agent (legacy-agent)');
      for (const bad of ['', 'wrong', SHARED + 'x', agentToken + 'x']) assert.equal((await c.tool(bad, 'get_authority')).status, 401);
    });

    it('a revoked token is refused with 401', T, async () => {
      const r = await c.act({ type: 'agent_revoke', agentId }, { session, profile: 'hotel' });
      assert.equal(r.status, 200, r.body.error ?? 'unexpected HTTP status');
      assert.equal(r.body.state.agents[0].status, 'revoked');
      const refused = await c.tool(agentToken, 'get_authority');
      assert.equal(refused.status, 401);
      assert.match(refused.message ?? '', /revoked/);
      const res = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: '{}' });
      assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
      await res.text();
      assert.equal((await c.audit('hotel')).find(a => a.action === 'agent_revoked')?.actor, MAIJA.name);
      assert.equal((await c.act({ type: 'agent_update', agentId, perOrderLimit: 5, weeklyLimit: 5 }, { session, profile: 'hotel' })).status, 422, 'a revoked grant cannot be changed');
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('B. signed quotes and order confirmations', () => {
    let jwkSet: { keys: any[] };

    it('the public key is published as a JWK Set', T, async () => {
      const r = await c.http('/.well-known/jwks.json');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/jwk-set\+json/);
      jwkSet = r.body;
      assert.equal(jwkSet.keys.length, 1);
      const { kty, crv, alg, use, kid, x, ...rest } = jwkSet.keys[0];
      assert.deepEqual([kty, crv, alg, use], ['OKP', 'Ed25519', 'EdDSA', 'sig']);
      assert.deepEqual(rest, {}, 'no private key material');
      assert.equal(Buffer.from(x, 'base64url').length, 32);
      // kid is the RFC 7638 thumbprint
      assert.equal(kid, createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url'));
      oldKid = kid;
    });

    it('a quote verifies with the published key and states what was promised; altered content does not verify', T, async () => {
      const q = await quote(c, SHARED, 7, { 'x-agent-name': 'signature-checker' });
      assert.equal(q.isError, false, JSON.stringify(q.data));
      assert.deepEqual(q.data.signature, { format: 'JWS compact serialization (RFC 7515)', alg: 'EdDSA', kid: oldKid, jwks_url: `${s.base}/.well-known/jwks.json` });
      oldQuote = q.data.signed_quote;
      const v = verifyJws(oldQuote, jwkSet);
      assert.equal(v.ok, true);
      assert.deepEqual(v.header, { alg: 'EdDSA', typ: 'JWT', kid: oldKid });
      const p = v.payload;
      assert.equal(p.iss, s.base);
      assert.equal(p.type, 'aimo.quote.v1');
      assert.equal(p.jti, q.data.quote_id);
      assert.deepEqual(p.agent, { id: null, name: 'signature-checker', identity: 'self_declared' });
      assert.equal(p.account, 'school');
      assert.equal(p.exp, Math.floor(Date.parse(q.data.expires_at) / 1000));
      assert.equal(p.exp - p.iat, 15 * 60);
      assert.equal(p.delivery_date, DATE);
      assert.deepEqual(p.lines, [{ product_id: PASTA, gtin: p.lines[0].gtin, quantity: 7, unit_price_excl_vat: 2 }]);
      assert.match(p.lines[0].gtin, /^\d{8,14}$/);
      assert.deepEqual([p.total_excl_vat, p.vat, p.total_incl_vat, p.currency], [q.data.total_excl_vat, q.data.vat, q.data.total_incl_vat, 'EUR']);
      assert.equal(p.total_excl_vat, 14);
      assert.equal(p.price_and_availability.source, 'valio_mock');
      assert.ok(Math.abs(Date.parse(p.price_and_availability.fetched_at) - Date.now()) < 30_000, 'when price and availability were fetched');
      assert.equal(p.content_sha256, q.data.content_sha256);

      // change one figure of the payload, keep the signature
      const [h, , sig] = oldQuote.split('.');
      const forged = Buffer.from(JSON.stringify({ ...p, total_excl_vat: 1 })).toString('base64url');
      assert.equal(verifyJws(`${h}.${forged}.${sig}`, jwkSet).ok, false, 'altered payload');
      const flipped = Buffer.from(sig, 'base64url');
      flipped[0] ^= 1;
      assert.equal(verifyJws(`${h}.${oldQuote.split('.')[1]}.${flipped.toString('base64url')}`, jwkSet).ok, false, 'altered signature');
    });

    it('a submitted order carries a signed confirmation, marked as a local simulation', T, async () => {
      const q = await quote(c, SHARED, 8, { 'x-agent-name': 'signature-checker' });
      const placed = await c.tool(SHARED, 'place_order', { quote_id: q.data.quote_id, idempotency_key: 'signed-order-0001' }, { 'x-agent-name': 'signature-checker' });
      const o = placed.data.order;
      assert.equal(o.status, 'submitted', JSON.stringify(placed.data));
      const v = verifyJws(o.signed_confirmation, jwkSet);
      assert.equal(v.ok, true);
      const p = v.payload;
      assert.deepEqual([p.iss, p.type, p.jti, p.order_id, p.confirmation, p.quote_id, p.account], [s.base, 'aimo.order_confirmation.v1', o.order_id, o.order_id, o.confirmation, q.data.quote_id, 'school']);
      assert.match(p.confirmation, /^SIM-[0-9A-F]{8}$/);
      assert.deepEqual(p.lines, [{ product_id: PASTA, gtin: p.lines[0].gtin, quantity: 8, unit_price_excl_vat: 2 }]);
      assert.deepEqual([p.total_excl_vat, p.vat, p.total_incl_vat], [o.total_excl_vat, o.vat, o.total_incl_vat]);
      assert.deepEqual([p.created_by, p.approval_required, p.approved_by], ['External agent (signature-checker)', false, 'Aimo rules']);
      assert.deepEqual([p.submission, p.simulated], ['local_simulation', true]);
      assert.equal(verifyJws(o.signed_confirmation.replace(/\.[^.]+\./, `.${Buffer.from(JSON.stringify({ ...p, simulated: false })).toString('base64url')}.`), jwkSet).ok, false);
      // the same confirmation again from get_order_status
      assert.equal((await c.tool(SHARED, 'get_order_status', { order_id: o.order_id })).data.order.signed_confirmation, o.signed_confirmation);

      // an order a person approved names that person; a waiting order has no confirmation yet
      const human = verifyJws((await c.tool(SHARED, 'get_order_status', { order_id: approvedOrder }, HOTEL)).data.order.signed_confirmation, jwkSet);
      assert.equal(human.ok, true);
      assert.deepEqual([human.payload.approved_by, human.payload.approval_required, human.payload.agent_id, human.payload.account], [MAIJA.name, true, agentId, 'hotel']);
      const big = await quote(c, SHARED, 400);
      const waiting = await c.tool(SHARED, 'request_approval', { quote_id: big.data.quote_id, idempotency_key: 'signed-order-0002' });
      assert.equal(waiting.data.order.signed_confirmation, null);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('across a restart', () => {
    let shortLived = '';

    it('the signing key is a private file in the data directory and survives a restart', T, async () => {
      const made = await c.act({ type: 'agent_create', name: 'short-lived', perOrderLimit: 50, weeklyLimit: 50, validDays: 1 }, { session, profile: 'school' });
      shortLived = made.body.issuedToken!.token;
      assert.equal((await c.tool(shortLived, 'get_authority')).data.account.id, 'school');

      const keyFile = join(s.dir, 'signing-key.pem');
      assert.equal(statSync(keyFile).mode & 0o777, 0o600);
      const pem = readFileSync(keyFile, 'utf8');
      await s.stop();
      // while the server is down: let the new agent's grant run out
      const stored = JSON.parse(readFileSync(s.stateFile, 'utf8'));
      stored.profiles.school.agents.find((a: any) => a.name === 'short-lived').expiresAt = new Date(Date.now() - 1000).toISOString();
      writeFileSync(s.stateFile, JSON.stringify(stored));
      await s.start();

      assert.equal(readFileSync(keyFile, 'utf8'), pem, 'the key was not replaced');
      const jwkSet = (await c.http('/.well-known/jwks.json')).body;
      assert.equal(jwkSet.keys[0].kid, oldKid);
      assert.equal(verifyJws(oldQuote, jwkSet).ok, true, 'a quote signed before the restart still verifies');
      const fresh = await quote(c, SHARED, 3);
      assert.equal(verifyJws(fresh.data.signed_quote, jwkSet).ok, true);
    });

    it('an expired token is refused with 401; a revoked one stays revoked; sessions do not survive', T, async () => {
      const expired = await c.tool(shortLived, 'get_authority');
      assert.equal(expired.status, 401);
      assert.match(expired.message ?? '', /expired/);
      assert.equal((await c.state('school')).agents.find(a => a.name === 'short-lived')?.status, 'expired');
      assert.equal((await c.tool(agentToken, 'get_authority')).status, 401);
      assert.equal((await c.act({ type: 'set_credit_limit', limit: 5 }, { session })).status, 401, 'the old session is gone');
    });

    it('signing out ends the session', T, async () => {
      const fresh = (await c.login(MAIJA)).body.token!;
      assert.equal((await c.act({ type: 'set_credit_limit', limit: 9000 }, { session: fresh })).status, 200);
      assert.equal((await c.audit()).find(a => a.action === 'set_credit_limit')?.actor, MAIJA.name);
      assert.equal((await c.http('/api/logout', { body: {}, session: fresh })).status, 200);
      assert.equal((await c.act({ type: 'set_credit_limit', limit: 1 }, { session: fresh })).status, 401);
    });
  });
});

// =====================================================================================================
describe('without APPROVERS: open demo mode, as before', () => {
  let s: Srv;
  let c: ReturnType<typeof client>;

  before(async () => {
    s = await isolatedServer({});
    c = client(s);
    await s.start();
  }, { timeout: 60_000 });
  after(async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); });

  it('the state says so, and there is nothing to sign in to', T, async () => {
    const st = await c.state();
    assert.equal(st.integration.access.open, true);
    assert.match(st.integration.access.label, /Open demo mode/);
    assert.deepEqual(st.agents, []);
    const r = await c.login(MAIJA);
    assert.equal(r.status, 422);
    assert.match(r.body.error ?? '', /open demo mode/);
  });

  it('anyone can approve, and the log says "Kitchen manager"', T, async () => {
    const q = await quote(c, SHARED, 300);
    const id = (await c.tool(SHARED, 'request_approval', { quote_id: q.data.quote_id, idempotency_key: 'open-pending-0001' })).data.order.order_id;
    const done = await c.act({ type: 'approve_order', orderId: id });
    assert.equal(done.status, 200, done.body.error ?? 'unexpected HTTP status');
    const o = done.body.state.orders.find(x => x.id === id)!;
    assert.equal(o.status, 'submitted');
    assert.equal(o.approval.decidedBy, 'Kitchen manager');
    assert.equal((await c.audit()).find(a => a.action === 'order_approved')?.actor, 'Kitchen manager');
    // an order inside the kitchen user's own limit still goes out at once
    await c.act({ type: 'draft_set', productId: PASTA, qty: 1 });
    const own = (await c.act({ type: 'draft_order' })).body.state.orders[0];
    assert.deepEqual([own.status, own.createdBy, own.approval.required], ['submitted', 'Kitchen manager', false]);
    const rejected = await quote(c, SHARED, 301);
    const rid = (await c.tool(SHARED, 'request_approval', { quote_id: rejected.data.quote_id, idempotency_key: 'open-pending-0002' })).data.order.order_id;
    assert.equal((await c.act({ type: 'reject_order', orderId: rid })).body.state.orders.find(x => x.id === rid)?.approval.decidedBy, 'Kitchen manager');
  });

  it('authority can be changed without signing in, and the demo token is shown', T, async () => {
    assert.equal((await c.act({ type: 'set_credit_limit', limit: 9000 })).body.state.kitchen.authority.creditLimit, 9000);
    const made = await c.act({ type: 'agent_create', name: 'open-bot', perOrderLimit: 10, weeklyLimit: 10, validDays: 7 });
    assert.equal(made.status, 200, made.body.error ?? 'unexpected HTTP status');
    assert.equal((await c.audit()).find(a => a.action === 'agent_created')?.actor, 'Kitchen manager');
    const a = await c.tool(made.body.issuedToken!.token, 'get_authority');
    assert.deepEqual([a.data.agent, a.data.identity, a.data.per_order_limit_excl_vat], ['open-bot', 'registered', 10]);
    const info = await c.http<AgentInfo>('/api/agent-info?lang=en');
    assert.equal(info.body.token, SHARED);
    assert.match(info.body.tokenNote, /self-declared/);
    assert.ok(!info.text.includes(made.body.issuedToken!.token));
    // resetting the account also removes its agents: their tokens stop working
    assert.equal((await c.act({ type: 'reset_demo' })).status, 200);
    assert.equal((await c.tool(made.body.issuedToken!.token, 'get_authority')).status, 401);
  });
});
