// External purchasing agent demo — a hotel chain's own agent buying through the Aimo MCP server.
//
// It proves the challenge scenario WITHOUT the Aimo UI: an independent agent connects over the
// Model Context Protocol (Streamable HTTP, bearer token), reads its authority, gets a fixed-price
// quote for a need, and either places the order (inside its authority) or hands it to a human.
// The agent never decides allergens, prices or approvals itself — the Aimo rules do.
// It does check the server's signature on every quote and order confirmation with the public key the
// server publishes at /.well-known/jwks.json (JWS, EdDSA), and prints the result.
//
// Run (from server/, so the MCP SDK resolves from server/node_modules):
//   AIMO_AGENT_TOKEN=<token> npx tsx scripts/external-agent.ts "I need 1,000 litres of lactose-free milk by Monday."
//   ... --no-llm     scripted flow without a model (also used automatically if the model call fails)
//   ... --poll       wait up to 3 minutes for the human decision, then print status + audit trail
//
// Environment:
//   AIMO_MCP_URL      default http://localhost:8787/mcp
//   AIMO_AGENT_TOKEN  required: the agent's own token (created in the Aimo UI, shown once), or the shared demo
//                     token (shown in the Aimo UI / GET /api/agent-info; the agent name is then self-declared)
//   AIMO_ACCOUNT      shared demo token only: school | wedding | hotel (default hotel). A registered agent's
//                     token already decides the account.
//   VERDA_BASE_URL, VERDA_API_KEY, VERDA_MODEL   OpenAI-compatible chat completions endpoint;
//                     read from the environment, else from <project>/.env. Keys are never printed.
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const AGENT_NAME = 'hotel-chain-agent';
const DEFAULT_REQUEST = 'I need 1,000 litres of lactose-free milk by Monday. Find an option that meets our requirements based on price and availability.';
const MAX_STEPS = 10;
const CALL_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;

// ---------- command line ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
function option(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const VALUE_FLAGS = ['--date', '--idempotency-key'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));

if (flag('--help') || flag('-h')) {
  console.log(`Usage: npx tsx scripts/external-agent.ts ["<request>"] [--no-llm] [--poll] [--date YYYY-MM-DD] [--idempotency-key <key>]

  <request>            what the buyer needs (default: "${DEFAULT_REQUEST}")
  --no-llm             scripted flow: get_authority → prepare_order → place_order | request_approval → get_order_status
  --poll               wait up to 3 minutes for a human decision, then print the final status and the audit trail
  --date               delivery date override (otherwise taken from the request; default: the coming Monday)
  --idempotency-key    reuse a key to prove that repeating a request never creates a second order

Environment: AIMO_MCP_URL (default http://localhost:8787/mcp), AIMO_AGENT_TOKEN (required: the agent's own token or the shared demo token),
             AIMO_ACCOUNT (shared demo token only: school|wedding|hotel, default hotel),
             VERDA_BASE_URL / VERDA_API_KEY / VERDA_MODEL (or <project>/.env).`);
  process.exit(0);
}

const request = positional[0]?.trim() || DEFAULT_REQUEST;
const noLlm = flag('--no-llm');
const poll = flag('--poll');
const dateOverride = option('--date');
if (dateOverride && !/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) die('--date must be YYYY-MM-DD');

const MCP_URL = process.env.AIMO_MCP_URL || 'http://localhost:8787/mcp';
// customer account the agent buys for: school | wedding | hotel (AIMO_ACCOUNT, default hotel — the hotel chain's own account)
const TOKEN = process.env.AIMO_AGENT_TOKEN;
if (!TOKEN) die('AIMO_AGENT_TOKEN is required (the agent\'s own token from the Aimo UI, or the shared demo token; see the Aimo UI or GET /api/agent-info).');
// a registered agent's token ("aimo-agt-…") already decides the account, so no account is asked for unless one is set
const ACCOUNT = process.env.AIMO_ACCOUNT || (TOKEN.startsWith('aimo-agt-') ? undefined : 'hotel');
const UI_URL = new URL(MCP_URL).origin + '/';
// The key is fetched from the origin this agent was configured with, not from an address given in an answer.
const JWKS_URL = new URL(MCP_URL).origin + '/.well-known/jwks.json';
// One key per purchase intent: place_order and request_approval share it, so a retry or a
// fallback after a failure can never create a second order.
const IDEMPOTENCY_KEY = option('--idempotency-key') || `hotel-${randomUUID()}`;

// ---------- small helpers ----------

function die(msg: string, code = 1): never {
  console.error(`Error: ${msg}`);
  process.exit(code);
}
const money = (n: unknown) => (typeof n === 'number' ? `${n.toFixed(2)} EUR` : '? EUR');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Next occurrence of a weekday strictly after today (local time). */
function nextWeekday(day: number, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
  d.setDate(d.getDate() + (((day - d.getDay() + 7) % 7) || 7));
  return iso(d);
}

/** LLM settings: environment first, then <project>/.env. The key is only ever used as a header. */
function llmConfig(): { baseUrl: string; apiKey: string; model: string } {
  const fromFile: Record<string, string> = {};
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../.env'), resolve(process.cwd(), '../.env'), resolve(process.cwd(), '.env')];
  const file = candidates.find(f => existsSync(f));
  if (file) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) fromFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const get = (k: string, d = '') => process.env[k] || fromFile[k] || d;
  return { baseUrl: get('VERDA_BASE_URL', 'https://inference.verda.com/v1').replace(/\/$/, ''), apiKey: get('VERDA_API_KEY'), model: get('VERDA_MODEL') };
}

// ---------- signatures ----------

let publishedKeys: Record<string, any>[] | undefined;

/** Verify a signed quote or order confirmation (JWS compact, EdDSA) with the server's published key and compare
 *  the signed content with the plain answer. A valid signature proves that this server issued exactly this
 *  content; it does not prove that the Valio Aimo mock data behind the figures is right. */
async function checkSignature(jws: unknown, expected: Record<string, unknown>, lines: Record<string, any>[] = []): Promise<string> {
  if (typeof jws !== 'string') return 'not signed';
  try {
    const [h, p, sig] = jws.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'EdDSA') return `NOT VERIFIED — unexpected algorithm ${header.alg}`;
    publishedKeys ??= (await (await fetch(JWKS_URL, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })).json()).keys;
    const jwk = publishedKeys?.find(k => k.kid === header.kid);
    if (!jwk) return `NOT VERIFIED — key ${header.kid} is not published at ${JWKS_URL}`;
    if (!verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))) return 'NOT VERIFIED — the signature does not match the content';
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const key = (ls: Record<string, any>[]) => JSON.stringify(ls.map(l => [l.product_id, l.quantity, l.unit_price_excl_vat]));
    const differs = Object.keys(expected).filter(k => claims[k] !== expected[k]);
    if (key(claims.lines ?? []) !== key(lines)) differs.push('lines');
    if (differs.length) return `NOT VERIFIED — the signed content differs from the answer in: ${differs.join(', ')}`;
    if (claims.exp && claims.exp * 1000 < Date.now()) return 'signature valid, but the signed quote has expired';
    return `verified with the published key ${String(header.kid).slice(0, 12)}… (EdDSA) — issued by ${claims.iss}, content unaltered`;
  } catch (e) {
    return `NOT VERIFIED — ${(e as Error).message}`;
  }
}

// ---------- MCP ----------

type Json = Record<string, any>;
interface ToolResult { ok: boolean; data: Json; text: string }
interface McpTool { name: string; description?: string; inputSchema: Json }

const client = new Client({ name: AGENT_NAME, version: '1.0.0' });
let step = 0;
/** What the agent has achieved so far — taken from server answers only, never from model text. */
const seen: { authority?: Json; quote?: Json; order?: Json; orderFromStatus: boolean; lastError?: string; quoteSignature?: string; orderSignature?: string } = { orderFromStatus: false };

function parseResult(res: Json): ToolResult {
  const text = (res.content ?? []).filter((c: Json) => c.type === 'text').map((c: Json) => c.text).join('\n');
  let data: Json = {};
  if (res.structuredContent && typeof res.structuredContent === 'object') data = res.structuredContent;
  else { try { data = JSON.parse(text); } catch { data = { message: text }; } }
  return { ok: !res.isError, data, text };
}

/** Execute one tool call over MCP, print it, and remember quotes/orders the server returned. */
async function callTool(name: string, args: Json, by: 'agent' | 'runtime' = 'agent'): Promise<ToolResult> {
  step++;
  const shown = JSON.stringify(args).replace(/"idempotency_key":"([^"]*)"/, (_m, k: string) => `"idempotency_key":"${clip(k, 15)}"`);
  console.log(`\n[${step}] → ${name}(${clip(shown, 400)})${by === 'runtime' ? '   (verification by the agent runtime)' : ''}`);
  let r: ToolResult;
  try {
    r = parseResult(await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }) as Json);
  } catch (e) {
    r = { ok: false, data: { error: 'mcp_call_failed', message: String((e as Error).message) }, text: String((e as Error).message) };
  }
  if (r.ok) {
    if (name === 'get_authority') seen.authority = r.data;
    if (name === 'prepare_order') seen.quote = r.data;
    if (r.data.order?.order_id) { seen.order = r.data.order; seen.orderFromStatus = name === 'get_order_status'; }
  } else seen.lastError = `${name}: ${r.data.error ?? 'error'} — ${r.data.message ?? r.text}`;
  console.log(`    ${r.ok ? '←' : '✗'} ${digest(name, r)}`);
  if (r.ok && name === 'prepare_order') {
    seen.quoteSignature = await checkSignature(r.data.signed_quote, { jti: r.data.quote_id, delivery_date: r.data.delivery_date, total_excl_vat: r.data.total_excl_vat, total_incl_vat: r.data.total_incl_vat }, r.data.lines);
    console.log(`    signed quote: ${seen.quoteSignature}`);
  }
  if (r.ok && r.data.order?.signed_confirmation) {
    const o = r.data.order;
    seen.orderSignature = await checkSignature(o.signed_confirmation, { order_id: o.order_id, confirmation: o.confirmation, delivery_date: o.delivery_date, total_excl_vat: o.total_excl_vat, total_incl_vat: o.total_incl_vat, submission: o.integration?.submission }, o.lines);
    console.log(`    signed confirmation: ${seen.orderSignature}`);
  }
  return r;
}

/** One readable line per tool result. */
function digest(name: string, r: ToolResult): string {
  const d = r.data;
  if (!r.ok) {
    const extra = [...(d.reasons ?? []), ...(d.blockers ?? []), ...(d.changes ?? [])];
    return clip(`${d.error ?? 'error'}: ${d.message ?? r.text}${extra.length ? ' — ' + extra.join(' ') : ''}`, 420);
  }
  const orderLine = (o: Json) => `order ${o.order_id} · ${o.status}${o.status_label ? ` (${o.status_label})` : ''} · ${money(o.total_excl_vat)} excl. VAT${o.confirmation ? ` · confirmation ${o.confirmation}` : ''}${o.approval?.required && o.status === 'pending_approval' ? ' · a human must approve' : ''}`;
  switch (name) {
    case 'get_authority':
      return `${d.agent} (identity: ${d.identity === 'registered' ? 'registered, from the token' : 'self-declared'}) on account ${d.account?.id} · may order alone up to ${money(d.per_order_limit_excl_vat)} excl. VAT per order${d.authorization?.weekly_limit_excl_vat != null ? `, ${money(d.authorization.weekly_remaining)} left of its weekly limit` : ''} · weekly budget ${money(d.weekly_budget)}, remaining ${money(d.remaining_this_week)} · ${(d.rules ?? []).filter((x: Json) => x.effect === 'human').length} rules need a human, ${(d.rules ?? []).filter((x: Json) => x.effect === 'never').length} can never be overridden`;
    case 'search_products': {
      const ps: Json[] = d.products ?? [];
      const suitable = ps.filter(p => p.suitable);
      const best = suitable.filter(p => p.offer?.price_eur_excl_vat_per_sales_unit != null).sort((a, b) => a.offer.price_eur_excl_vat_per_sales_unit - b.offer.price_eur_excl_vat_per_sales_unit)[0];
      return `${ps.length} products for "${d.query}", ${suitable.length} verified for [${(d.requirements ?? []).join(', ') || 'no requirements'}]${best ? ` · cheapest verified: ${clip(best.name, 60)} (${best.product_id}) ${money(best.offer.price_eur_excl_vat_per_sales_unit)}/${best.sales_unit}, availability ${best.offer.availability}` : ''}`;
    }
    case 'get_price_availability':
      return clip((d.offers ?? []).map((o: Json) => o.error ? `${o.product_id}: ${o.error}` : `${o.product_id} ${money(o.offer?.price_eur_excl_vat_per_sales_unit)} · ${o.offer?.availability}${o.offer?.available_sales_units != null ? ` (${o.offer.available_sales_units} units)` : ''}`).join(' | '), 420);
    case 'check_allergens':
      return clip(`${d.name} (${d.product_id}): ${(d.requirement_checks ?? []).map((c: Json) => `${c.requirement}=${c.verdict}`).join(', ')} → ${d.suitable ? 'suitable' : 'NOT suitable'}`, 420);
    case 'prepare_order': {
      const f = d.fulfilment;
      const lines = (d.lines ?? []).map((l: Json) => `${l.quantity} × ${clip(l.name, 70)} (${l.product_id}) @ ${money(l.unit_price_excl_vat)}`).join(' + ');
      return `quote ${d.quote_id}: ${lines} · total ${money(d.total_excl_vat)} excl. VAT`
        + (f ? ` · covers ${f.covered}/${f.requested} ${f.unit}${f.shortfall > 0 ? ` (SHORTFALL ${f.shortfall} ${f.unit})` : ''}` : '')
        + ` · within agent authority: ${d.within_agent_authority ? 'yes' : 'NO — ' + (d.approval_required_because ?? []).join(' ')} · next: ${d.next_step}`;
    }
    case 'place_order':
    case 'request_approval':
      return `${d.duplicate ? 'DUPLICATE prevented, existing ' : ''}${orderLine(d.order)}${d.order.approval?.reasons?.length && d.order.status === 'pending_approval' ? ` — ${clip(d.order.approval.reasons.join(' '), 300)}` : ''}`;
    case 'get_order_status':
      return `${orderLine(d.order)}${d.order.approval?.decidedBy ? ` · decided by ${d.order.approval.decidedBy}` : ''}`;
    case 'list_orders':
      return clip(`${(d.orders ?? []).length} orders: ${(d.orders ?? []).slice(0, 5).map((o: Json) => `${o.order_id} ${o.status} ${money(o.total_excl_vat)}`).join(' | ')}`, 420);
    case 'get_audit_log':
      return `${(d.entries ?? []).length} audit entries (${d.hash_chain ?? 'hash-chained'})`;
    default:
      return clip(r.text.replace(/\s+/g, ' '), 300);
  }
}

/** Compact view of a tool result for the model: same facts, without bulky free text. */
function forModel(r: ToolResult): string {
  const drop = new Set(['provenance', 'ingredients', 'evidence', 'content_sha256', 'gtin', 'events', 'declared_allergens', 'signed_quote', 'signed_confirmation', 'signature', 'signing']);
  const s = JSON.stringify(r.ok ? r.data : { is_error: true, ...r.data }, (k, v) => (drop.has(k) ? undefined : v));
  return s.length > 9000 ? s.slice(0, 9000) + '…(truncated)' : s;
}

// ---------- LLM tool-calling loop ----------

class LlmError extends Error {}

/** MCP tool → OpenAI function tool. The MCP inputSchema already is JSON Schema; only meta keys are dropped. */
function toFunctionTool(t: McpTool) {
  const clean = (v: any): any => Array.isArray(v) ? v.map(clean)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$schema' && k !== '$id').map(([k, x]) => [k, clean(x)]))
    : v;
  const parameters = clean(t.inputSchema ?? {});
  if (parameters.type !== 'object') parameters.type = 'object';
  if (!parameters.properties) parameters.properties = {};
  return { type: 'function', function: { name: t.name, description: t.description ?? '', parameters } };
}

async function chat(cfg: ReturnType<typeof llmConfig>, messages: Json[], tools: Json[]): Promise<Json> {
  if (!cfg.apiKey) throw new LlmError('no VERDA_API_KEY configured');
  if (!cfg.model) throw new LlmError('no VERDA_MODEL configured');
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, temperature: 0.1, max_tokens: 1500, messages, tools, tool_choice: 'auto' }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    throw new LlmError((e as Error).name === 'TimeoutError' ? 'model call timed out after 60 s' : `model unreachable (${(e as Error).message})`);
  }
  if (!res.ok) throw new LlmError(`model call failed with HTTP ${res.status}`);
  const data = await res.json().catch(() => undefined) as Json | undefined;
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new LlmError('model returned no message');
  return msg;
}

function systemPrompt(): string {
  const now = new Date();
  return `You are the autonomous purchasing agent of a hotel chain. You act for the BUYER and purchase food-service products from a wholesaler through the Aimo purchasing tools. You have no other way to act.

Today is ${WEEKDAYS[now.getDay()]} ${iso(now)}. The coming Monday is ${nextWeekday(1)}. Dates are YYYY-MM-DD.${dateOverride ? ` The buyer fixed the delivery date to ${dateOverride}.` : ''}

Procedure:
1. Call get_authority first, to learn what you may decide alone and what needs a human.
2. Turn the buyer's request into the exact dietary requirement values the tools accept. Add only requirements the buyer stated. lactose_free and milk_free are different things; so are gluten_free and wheat_free.
3. Call prepare_order with "need" (query, amount, unit), the requirements and the delivery date. It returns a fixed-price quote sourced by price and availability from products VERIFIED for the requirements. Use search_products / get_price_availability / check_allergens only if you need to compare options or the quote fails.
4. If the quote is within your authority, call place_order. If it is not, call request_approval with a short note (max 300 characters) telling the human approver why you chose this option: price per unit, availability, verified requirements, and why approval is needed. Never try to get around a limit or a rule, for example by splitting an order into smaller ones or dropping a requirement.
5. Call get_order_status, then answer with a brief final report: order id, status, what was ordered, total price, and whether a human still has to approve.

Rules: never invent product ids, prices, quantities or statuses — use only tool results. If no verified product exists or a tool rejects the request, say so plainly and do not order something else. The idempotency_key argument is supplied by your runtime; pass "runtime". Do not ask the buyer questions; decide from the request.`;
}

async function runLlm(tools: McpTool[], cfg: ReturnType<typeof llmConfig>): Promise<string> {
  const fnTools = tools.map(toFunctionTool);
  const known = new Set(tools.map(t => t.name));
  const messages: Json[] = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: request }];
  let nudged = false;
  for (let round = 0; round < MAX_STEPS && step < MAX_STEPS; round++) {
    const msg = await chat(cfg, messages, fnTools);
    const calls: Json[] = msg.tool_calls ?? [];
    const text = String(msg.content ?? '').trim();
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      if (!seen.order && !seen.lastError && !nudged) {
        nudged = true;
        messages.push({ role: 'user', content: 'No order has been placed and no approval requested yet. Continue with the tools, or state clearly why no order can be made.' });
        continue;
      }
      return text;
    }
    for (const tc of calls) {
      const name = String(tc.function?.name ?? '');
      let content: string;
      if (step >= MAX_STEPS) content = JSON.stringify({ is_error: true, error: 'step_limit', message: `The agent runtime allows at most ${MAX_STEPS} tool calls.` });
      else if (!known.has(name)) content = JSON.stringify({ is_error: true, error: 'unknown_tool', message: `No tool ${name}` });
      else {
        let args: Json;
        try { args = JSON.parse(tc.function?.arguments || '{}') ?? {}; } catch { args = {}; }
        if (name === 'place_order' || name === 'request_approval') args.idempotency_key = IDEMPOTENCY_KEY; // owned by the runtime, not the model
        content = forModel(await callTool(name, args));
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
    }
  }
  return `(stopped: the agent runtime allows at most ${MAX_STEPS} steps)`;
}

// ---------- deterministic flow (no model) ----------

const REQUIREMENT_WORDS: [string, RegExp][] = [
  ['lactose_free', /lactose[\s-]?free|laktoosit|laktosfri/i],
  ['milk_free', /(milk|dairy)[\s-]?free|maidot|mjölkfri/i],
  ['gluten_free', /gluten[\s-]?free|gluteenit|glutenfri/i],
  ['wheat_free', /wheat[\s-]?free|vehnät|vetefri/i],
  ['egg_free', /egg[\s-]?free|munat|äggfri/i],
  ['nut_free', /nut[\s-]?free|pähkinät|nötfri/i],
  ['soy_free', /soy(a)?[\s-]?free|soijat|sojafri/i],
  ['fish_free', /fish[\s-]?free|kalat|fiskfri/i],
];

/** Rule-based reading of "N litres/kg of X by <day>" — enough for the scripted demo flow. */
function parseRequest(text: string): { amount: number; unit: 'L' | 'kg'; query: string; productId?: string; requirements: string[]; date: string; dateAssumed: boolean } | undefined {
  const m = text.match(/(\d[\d.,\s ]*)\s*(litres?|liters?|litraa|liter|kilograms?|kilos?|kiloa|kg|l)\b\s*(.*)/i);
  if (!m) return undefined;
  const rawNum = m[1].trim();
  const amount = /^\d{1,3}([,.\s ]\d{3})+$/.test(rawNum) ? Number(rawNum.replace(/[,.\s ]/g, '')) : Number(rawNum.replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = /^k/i.test(m[2]) ? 'kg' : 'L';
  // an explicit "product 469363" pins the order to that product (a shortfall is then reported, not substituted)
  const productId = text.match(/\bproduct\s*(?:id\s*)?#?(\d{4,8})\b/i)?.[1];
  const query = m[3].replace(/^of\s+/i, '').replace(/\(?\bproduct\s*(?:id\s*)?#?\d{4,8}\)?/i, ' ').split(/\s+(?:by|for|on|before|until|to|delivered)\b|[.,;!?]/i)[0].trim();
  if (query.length < 2) return undefined;
  const requirements = REQUIREMENT_WORDS.filter(([, re]) => re.test(text)).map(([r]) => r);
  let date = dateOverride, dateAssumed = false;
  if (!date) date = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (!date) { const wd = WEEKDAYS.findIndex(w => new RegExp(`\\b${w}\\b`, 'i').test(text)); if (wd >= 0) date = nextWeekday(wd); }
  if (!date && /\btomorrow\b/i.test(text)) { const t = new Date(); t.setDate(t.getDate() + 1); date = iso(t); }
  if (!date) { date = nextWeekday(1); dateAssumed = true; }
  return { amount, unit, query, productId, requirements, date, dateAssumed };
}

async function runScripted(): Promise<string> {
  if (seen.order) return 'An order already exists from the earlier steps; verifying its status only.';
  const need = parseRequest(request);
  if (!need) { seen.lastError = 'The scripted flow understands requests like "40 litres of lactose-free milk by Monday" (amount + L/kg + product).'; return seen.lastError; }
  console.log(`\nUnderstood by rules: ${need.amount} ${need.unit} of "${need.query}"${need.productId ? ` (only product ${need.productId})` : ''} · requirements [${need.requirements.join(', ') || 'none stated'}] · delivery ${need.date}${need.dateAssumed ? ' (no day given: coming Monday assumed)' : ''}`);

  await callTool('get_authority', {});
  const q = await callTool('prepare_order', { delivery_date: need.date, requirements: need.requirements, need: { query: need.query, amount: need.amount, unit: need.unit, ...(need.productId ? { product_id: need.productId } : {}) } });
  if (!q.ok) return 'No quote could be prepared, so nothing was ordered.';

  let placed: ToolResult | undefined;
  if (q.data.within_agent_authority) {
    placed = await callTool('place_order', { quote_id: q.data.quote_id, idempotency_key: IDEMPOTENCY_KEY });
    if (!placed.ok && placed.data.error !== 'approval_required') return 'The order was rejected by the rules; nothing was ordered.';
  }
  if (!placed?.ok) {
    const first = q.data.lines?.[0];
    const perUnit = first?.pack?.amount ? ` (${(first.unit_price_excl_vat / first.pack.amount).toFixed(2)} EUR/${first.pack.unit})` : '';
    const f = q.data.fulfilment;
    const note = clip(`Cheapest option verified for [${need.requirements.join(', ') || 'no dietary requirement'}]: ${first?.name}${perUnit}`
      + `${(q.data.lines?.length ?? 1) > 1 ? `, split over ${q.data.lines.length} products because availability is partial` : ''}.`
      + `${f?.shortfall > 0 ? ` Covers ${f.covered} of ${f.requested} ${f.unit}.` : ''} Needed for ${need.date}. Total ${Number(q.data.total_excl_vat).toFixed(2)} EUR excl. VAT.`, 390);
    const asked = await callTool('request_approval', { quote_id: q.data.quote_id, idempotency_key: IDEMPOTENCY_KEY, note });
    if (!asked.ok) return 'The approval request was rejected by the rules; nothing was ordered.';
  }
  return '';
}

// ---------- final report ----------

function printSummary(agentText: string) {
  const line = '─'.repeat(72);
  if (agentText) console.log(`\nAgent report:\n${agentText.split('\n').map(l => '  ' + l).join('\n')}`);
  console.log(`\n${line}\nSUMMARY (from the Aimo server's answers)\n${line}`);
  const o = seen.order;
  if (!o) {
    console.log(`Result     : NO ORDER was created.`);
    if (seen.lastError) console.log(`Reason     : ${seen.lastError}`);
    if (seen.quote) console.log(`Open quote : ${seen.quote.quote_id} (${money(seen.quote.total_excl_vat)} excl. VAT, expires ${seen.quote.expires_at})`);
    return;
  }
  const f = seen.quote?.fulfilment;
  console.log(`Order      : ${o.order_id} — ${o.title}`);
  console.log(`Status     : ${o.status}${o.status_label ? ` (${o.status_label})` : ''}`);
  (o.lines ?? []).forEach((l: Json, i: number) => console.log(`${i === 0 ? 'Ordered    ' : '           '}: ${l.quantity} × ${l.name} (${l.product_id}) @ ${money(l.unit_price_excl_vat)} = ${money(l.line_total_excl_vat)}${l.why ? `\n             why: ${l.why}` : ''}`));
  if (f) console.log(`Fulfilment : ${f.covered} of ${f.requested} ${f.unit} covered${f.shortfall > 0 ? ` — SHORTFALL ${f.shortfall} ${f.unit}` : ''}${f.split_across_products > 1 ? `, split across ${f.split_across_products} products` : ''}`);
  console.log(`Delivery   : ${o.delivery_date}`);
  console.log(`Price      : ${money(o.total_excl_vat)} excl. VAT · VAT ${money(o.vat)} · ${money(o.total_incl_vat)} incl. VAT`);
  if (seen.authority) console.log(`Authority  : agent may order alone up to ${money(seen.authority.per_order_limit_excl_vat)} excl. VAT per order`);
  if (o.status === 'pending_approval') {
    console.log(`Approval   : REQUIRED — waiting for a human decision`);
    (o.approval?.reasons ?? []).forEach((r: string) => console.log(`             · ${r}`));
    console.log(`Approve at : ${UI_URL}  (Aimo kitchen UI → order ${o.order_id} → Approve / Reject)`);
    console.log(`             The agent cannot approve its own order. Follow it with get_order_status, or re-run with --poll.`);
  } else if (o.status === 'submitted') {
    console.log(`Approval   : ${o.approval?.required ? `approved by ${o.approval?.decidedBy ?? 'a human'}` : `not needed — within the agent's authority (decided by ${o.approval?.decidedBy ?? 'the rules'})`}`);
    console.log(`Confirmed  : ${o.confirmation ?? '-'}`);
  } else {
    console.log(`Approval   : ${o.status}${o.approval?.decidedBy ? ` by ${o.approval.decidedBy}` : ''}`);
  }
  if (o.recheck?.changes?.length) console.log(`Re-check   : ${o.recheck.changes.join(' ')}`);
  if (seen.quoteSignature) console.log(`Signatures : quote — ${seen.quoteSignature}`);
  if (seen.orderSignature) console.log(`             confirmation — ${seen.orderSignature}`);
  if (o.integration?.note) console.log(`Note       : ${o.integration.note}`);
}

async function pollDecision() {
  const id = seen.order?.order_id;
  if (!id) return;
  if (seen.order!.status === 'pending_approval') {
    console.log(`\nWaiting up to ${POLL_TIMEOUT_MS / 60_000} minutes for a human decision on ${id} — approve or reject it at ${UI_URL}`);
    const started = Date.now();
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      let r: ToolResult;
      try { r = parseResult(await client.callTool({ name: 'get_order_status', arguments: { order_id: id } }, undefined, { timeout: CALL_TIMEOUT_MS }) as Json); }
      catch (e) { console.log(`  … ${Math.round((Date.now() - started) / 1000)} s: status check failed (${(e as Error).message}), retrying`); continue; }
      if (r.ok && r.data.order) seen.order = r.data.order;
      const o = seen.order!;
      const blocked = o.recheck && o.recheck.ok === false ? ` — re-check blocked sending: ${(o.recheck.changes ?? []).join(' ')}` : '';
      console.log(`  … ${Math.round((Date.now() - started) / 1000)} s: ${o.status}${blocked}`);
      if (o.status !== 'pending_approval') break;
    }
  }
  const o = seen.order!;
  console.log(`\nFINAL STATUS: ${o.order_id} is ${o.status}${o.status_label ? ` (${o.status_label})` : ''}`
    + `${o.approval?.decidedBy ? ` · decided by ${o.approval.decidedBy}${o.approval.decidedAt ? ` at ${o.approval.decidedAt}` : ''}` : ''}`
    + `${o.confirmation ? ` · confirmation ${o.confirmation}` : ''}`
    + `${o.status === 'pending_approval' ? ' · no human decision within the waiting time; the order stays open and nothing was sent' : ''}`);
  const a = await callTool('get_audit_log', { order_id: id, limit: 50 });
  if (a.ok) {
    console.log(`\nAudit trail for ${id} (oldest first; ${a.data.hash_chain ?? 'hash-chained'}):`);
    for (const e of [...(a.data.entries ?? [])].reverse()) console.log(`  ${e.at}  ${String(e.actor).padEnd(34)} ${String(e.action).padEnd(18)} ${e.text}  #${e.hash ?? '-'}`);
  }
}

// ---------- main ----------

async function main() {
  const cfg = llmConfig();
  console.log(`Aimo external purchasing agent demo — "${AGENT_NAME}" (acts for the buyer, outside the Aimo UI)`);
  console.log(`Request    : ${request}`);
  console.log(`MCP server : ${MCP_URL}  (Model Context Protocol, Streamable HTTP, bearer token)`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Agent-Name': AGENT_NAME, ...(ACCOUNT ? { 'X-Aimo-Account': ACCOUNT } : {}) } } });
  try { await client.connect(transport); }
  catch (e) { die(`cannot connect to the Aimo MCP server at ${MCP_URL}: ${(e as Error).message}`); }
  const info = client.getServerVersion();
  const tools = (await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS })).tools as McpTool[];
  console.log(`Connected  : ${info?.name ?? 'server'} ${info?.version ?? ''} · ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  console.log(`Mode       : ${noLlm ? 'scripted flow (--no-llm), no model involved' : `LLM tool-calling loop, model ${cfg.model || '(not configured)'}; max ${MAX_STEPS} steps`}`);

  let agentText = '';
  if (noLlm) agentText = await runScripted();
  else {
    try { agentText = await runLlm(tools, cfg); }
    catch (e) {
      if (!(e instanceof LlmError)) throw e;
      console.log(`\n! ${e.message} — continuing with the scripted flow (same idempotency key, so no double order is possible).`);
      agentText = await runScripted();
    }
  }

  // The final report is built from what the server says, not from what the model says.
  if (seen.order && !seen.orderFromStatus) await callTool('get_order_status', { order_id: seen.order.order_id }, 'runtime');
  printSummary(agentText);
  if (poll) await pollDecision();
  await client.close().catch(() => undefined);
  process.exit(seen.order ? 0 : 2);
}

main().catch(e => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
