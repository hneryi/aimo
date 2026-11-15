import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { AgentInfo, Lang, Requirement, UiAction } from '../../shared/types.ts';
import { approverOf, approversConfigured, login, logout } from './approvers.ts';
import { REQUIREMENTS } from './allergens.ts';
import { auditView, handleAction, handleChat, handleImport, stateView } from './app.ts';
import { loadCatalog } from './catalog.ts';
import { config } from './config.ts';
import { parseLang, tr } from './i18n.ts';
import { pingLlm } from './llm.ts';
import { MCP_TOOLS, handleMcp } from './mcp.ts';
import { ordersView } from './orders.ts';
import { UserError, searchWithChecks } from './planner.ts';
import { JWKS_URL, jwks, signingKid } from './signing.ts';
import { S, agentToken, loadState, pick, runAs } from './store.ts';
import { pingValio } from './valio.ts';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

// tiny fixed-window rate limit for the endpoints that cost model calls or parse uploads
const hits = new Map<string, { n: number; t: number }>();
function limit(max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}|${req.path}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.t > 60_000) hits.set(key, { n: 1, t: now });
    else if (++h.n > max) { res.status(429).json({ error: tr(langOf(req), 'Hetkinen – liian monta pyyntöä. Yritä kohta uudelleen.', 'Ett ögonblick – för många förfrågningar. Försök igen strax.', 'One moment – too many requests. Try again shortly.') }); return; }
    next();
  };
}

const langOf = (req: Request): Lang => parseLang(req.body?.lang ?? req.query.lang);
/** which customer account the request is for: ?profile=, body.profile or the X-Aimo-Profile header (default: school) */
const profileOf = (req: Request) => req.query.profile ?? req.body?.profile ?? req.headers['x-aimo-profile'];
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  runAs(profileOf(req), () => fn(req, res)).catch(e => {
    // the supplier API rate-limited us: tell the client when to come back; everything else is a refused request
    if (e instanceof UserError && e.code === 'supplier_rate_limited') { res.status(503).set('Retry-After', String(e.extra?.retry_after_seconds ?? 30)).json({ error: pick(langOf(req), e.text) }); return; }
    // sign-in: the code tells the UI to ask for the approver's name and PIN, or to wait
    if (e instanceof UserError && e.code === 'too_many_attempts') { res.status(429).set('Retry-After', String(e.extra?.retry_after_seconds ?? 60)).json({ error: pick(langOf(req), e.text), code: e.code }); return; }
    if (e instanceof UserError && (e.code === 'approver_required' || e.code === 'login_failed')) { res.status(401).json({ error: pick(langOf(req), e.text), code: e.code }); return; }
    if (e instanceof UserError) { res.status(422).json({ error: pick(langOf(req), e.text) }); return; }
    console.error(e);
    res.status(500).json({ error: tr(langOf(req), 'Jokin meni pieleen. Mitään ei tilattu. Yritä uudelleen.', 'Något gick fel. Inget beställdes. Försök igen.', 'Something went wrong. Nothing was ordered. Please try again.') });
  });
};

/** the signed-in approver of a request: Authorization: Bearer <session token from POST /api/login> */
const approverOfReq = (req: Request) => approverOf(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));

app.get('/health', (_req, res) => res.json({ ok: true }));
// public key for verifying signed quotes and order confirmations (RFC 7517)
app.get('/.well-known/jwks.json', (_req, res) => { res.type('application/jwk-set+json').set('Cache-Control', 'public, max-age=300').send(JSON.stringify(jwks())); });
app.post('/api/login', limit(20), wrap(async (req, res) => res.json(login(req.body?.name, req.body?.pin))));
app.post('/api/logout', wrap(async (req, res) => { logout(String(req.headers.authorization ?? '').replace(/^Bearer /, '')); res.json({ ok: true }); }));
app.get('/api/state', wrap(async (req, res) => res.json(await stateView(langOf(req)))));
app.post('/api/chat', limit(30), wrap(async (req, res) => res.json(await handleChat(String(req.body?.message ?? ''), langOf(req)))));
app.post('/api/action', limit(90), wrap(async (req, res) => res.json(await handleAction(req.body?.action as UiAction, langOf(req), approverOfReq(req)))));
app.post('/api/import', limit(12), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new UserError({ fi: 'Tiedosto puuttuu.', sv: 'Filen saknas.', en: 'No file received.' });
  // multer decodes filenames as latin1
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.json(await handleImport(req.file.buffer, name, langOf(req)));
}));
app.get('/api/products/search', limit(60), wrap(async (req, res) => {
  const reqs = String(req.query.req ?? '').split(',').filter((r): r is Requirement => (REQUIREMENTS as string[]).includes(r));
  const date = S().menu?.weekStart ?? new Date().toISOString().slice(0, 10);
  res.json({ items: await searchWithChecks(String(req.query.q ?? ''), reqs, langOf(req), date) });
}));
app.get('/api/orders', wrap(async (req, res) => res.json({ orders: ordersView(langOf(req)) })));
app.get('/api/audit', wrap(async (req, res) => res.json({ entries: auditView(langOf(req), 200) })));
app.get('/api/agent-info', wrap(async (req, res) => {
  const lang = langOf(req);
  // open demo mode shows the shared demo token to everyone, as before; with approvers configured only to one of them
  const showToken = !approversConfigured() || !!approverOfReq(req);
  const info: AgentInfo = {
    mcpUrl: config.publicUrl.replace(/\/$/, '') + '/mcp', token: showToken ? agentToken() : undefined, jwksUrl: JWKS_URL, tools: MCP_TOOLS,
    tokenNote: tr(lang,
      `Yhteinen demotunnus: agentin nimi on itse ilmoitettu (X-Agent-Name) eikä sitä todenneta, ja tili valitaan otsakkeella X-Aimo-Account. Rekisteröity agentti saa oman tunnuksen ja omat rajat valikon kohdasta Tilausvaltuudet.${showToken ? '' : ' Demotunnus näytetään vain kirjautuneelle hyväksyjälle.'}`,
      `Delad demotoken: agentens namn är självdeklarerat (X-Agent-Name) och verifieras inte, och kontot väljs med rubriken X-Aimo-Account. En registrerad agent får en egen token och egna gränser under Beställningsrätt i menyn.${showToken ? '' : ' Demotoken visas bara för en inloggad godkännare.'}`,
      `Shared demo token: the agent name is self-declared (X-Agent-Name) and not verified, and the account is chosen with the X-Aimo-Account header. A registered agent gets its own token and limits under Ordering limits in the menu.${showToken ? '' : ' The demo token is shown only to a signed-in approver.'}`),
    note: tr(lang,
      'Ulkoinen ostoagentti käyttää samaa palvelua MCP-rajapinnan kautta (Model Context Protocol, Streamable HTTP, Bearer-tunniste) ilman tätä käyttöliittymää. Tuotteet, hinnat ja saatavuus tulevat Valio Aimon haasterajapinnasta (mock) – oikea integraatio. Tilauksen lähetys on paikallinen simulaatio. Agentti saa tilata itse vain valtuutensa sisällä; muu menee sinulle hyväksyttäväksi.',
      'En extern inköpsagent använder samma tjänst via MCP-gränssnittet (Model Context Protocol, Streamable HTTP, Bearer-token) utan det här användargränssnittet. Produkter, priser och tillgänglighet kommer från Valio Aimos utmanings-API (mock) – riktig integration. Orderläggningen är en lokal simulering. Agenten får bara beställa själv inom sin befogenhet; resten går till dig för godkännande.',
      'An external purchasing agent uses the same service through the MCP interface (Model Context Protocol, Streamable HTTP, bearer token) without this UI. Products, prices and availability come from the Valio Aimo challenge API (mock) – a real integration. Order submission is a local simulation. The agent may only order on its own within its authority; everything else comes to you for approval.'),
  };
  res.json(info);
}));

app.all('/mcp', (req, res) => { handleMcp(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }); }); });

app.use('/demo', express.static(config.demoDir));
app.use('/docs', express.static(resolve(config.demoDir, '../docs')));
if (existsSync(config.webDist)) {
  app.use(express.static(config.webDist, { maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.get(/^\/(?!api|mcp|demo|docs|\.well-known).*/, (_req, res) => res.sendFile(resolve(config.webDist, 'index.html')));
}

const n = loadCatalog();
loadState();
const kid = signingKid(); // loads the signing key, or creates it on the first start
app.listen(config.port, config.host, () => {
  console.log(`Aimo listening on :${config.port} · ${n} catalog products · MCP at ${config.publicUrl}/mcp`);
  console.log(`Signing key ${kid} · ${approversConfigured() ? 'approvers configured' : 'open demo mode (no approvers)'}`);
  pingValio().then(ok => console.log('Valio mock API:', ok ? 'ok' : 'unreachable'));
  pingLlm().then(ok => console.log('LLM:', ok ? 'ok' : 'unreachable'));
});
