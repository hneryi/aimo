// Registered external agents. A person grants an agent its own bearer token, bound to one account, with its own
// per-order and weekly limits and an expiry, and can change the limits or revoke the grant. The token is shown
// once, when it is created; after that only its SHA-256 exists. The shared AGENT_TOKEN is a separate demo
// credential with a self-declared name (see mcp.ts).
import { createHash, randomBytes } from 'node:crypto';
import type { AgentView, Lang } from '../../shared/types.ts';
import { eur, tr } from './i18n.ts';
import { UserError } from './planner.ts';
import { type L3, S, type StoredAgent, audit, currentProfile, l3 } from './store.ts';

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const round2 = (n: number) => Math.round(n * 100) / 100;
const WEEK_MS = 7 * 86_400_000;

export function agentStatus(a: StoredAgent): AgentView['status'] {
  return a.revokedAt ? 'revoked' : new Date(a.expiresAt).getTime() <= Date.now() ? 'expired' : 'active';
}
export const findAgent = (id: string) => S().agents.find(a => a.id === id);

/** What the agent has ordered on its own authority in the last 7 days (EUR excl. VAT). Orders a person approved
 *  were that person's decision and do not use up the agent's weekly limit. */
export function agentWeekSpend(id: string): number {
  const since = Date.now() - WEEK_MS;
  return round2(S().orders.filter(o => o.agentId === id && o.status === 'submitted' && !o.approval.required && new Date(o.approval.decidedAt ?? o.createdAt).getTime() > since).reduce((a, o) => a + o.net, 0));
}

export function agentsView(lang: Lang): AgentView[] {
  return S().agents.map(a => {
    const status = agentStatus(a);
    return {
      id: a.id, name: a.name, perOrderLimit: a.authority.perOrderLimit, weeklyLimit: a.authority.weeklyLimit, spentThisWeek: agentWeekSpend(a.id),
      createdAt: a.createdAt, expiresAt: a.expiresAt, revokedAt: a.revokedAt, status,
      statusLabel: status === 'active' ? tr(lang, 'Voimassa', 'Giltig', 'Active') : status === 'expired' ? tr(lang, 'Vanhentunut', 'Utgången', 'Expired') : tr(lang, 'Peruttu', 'Återkallad', 'Revoked'),
    };
  });
}

function limits(perOrder: unknown, weekly: unknown): StoredAgent['authority'] {
  const perOrderLimit = Number(perOrder), weeklyLimit = Number(weekly);
  const ok = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1_000_000;
  if (perOrder == null || weekly == null || !ok(perOrderLimit) || !ok(weeklyLimit)) throw new UserError(l3('Anna tilauskohtainen raja ja viikkoraja väliltä 0–1 000 000 €.', 'Ange en gräns per order och en veckogräns mellan 0 och 1 000 000 €.', 'Give a per-order limit and a weekly limit between €0 and €1,000,000.'));
  return { perOrderLimit: round2(perOrderLimit), weeklyLimit: round2(weeklyLimit) };
}
const limitText = (lang: Lang, a: StoredAgent['authority']) => tr(lang, `${eur(lang, a.perOrderLimit)} / tilaus, ${eur(lang, a.weeklyLimit)} / viikko (alv 0 %)`, `${eur(lang, a.perOrderLimit)} / order, ${eur(lang, a.weeklyLimit)} / vecka (moms 0 %)`, `${eur(lang, a.perOrderLimit)} per order, ${eur(lang, a.weeklyLimit)} per week (excl. VAT)`);

/** Register an agent for the active account. Returns the bearer token: the only time it exists in clear text. */
export function createAgent(nameIn: unknown, perOrder: unknown, weekly: unknown, validDaysIn: unknown, by: L3): { agent: StoredAgent; token: string } {
  const st = S();
  const name = String(nameIn ?? '').trim();
  if (!/^[\w .-]{2,40}$/.test(name)) throw new UserError(l3('Agentin nimessä saa olla 2–40 merkkiä: kirjaimia (a–z), numeroita, välilyöntejä, pisteitä ja viivoja.', 'Agentens namn ska ha 2–40 tecken: bokstäver (a–z), siffror, mellanslag, punkter och streck.', 'The agent name must be 2–40 characters: letters (a–z), digits, spaces, dots and dashes.'));
  if (st.agents.some(a => agentStatus(a) === 'active' && a.name.toLowerCase() === name.toLowerCase())) throw new UserError(l3(`Tilillä on jo voimassa oleva agentti nimeltä ${name}.`, `Kontot har redan en giltig agent med namnet ${name}.`, `The account already has an active agent named ${name}.`));
  const authority = limits(perOrder, weekly);
  const days = Number(validDaysIn);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new UserError(l3('Voimassaolon pitää olla 1–365 päivää.', 'Giltighetstiden ska vara 1–365 dagar.', 'The validity must be 1–365 days.'));
  if (st.agents.length >= 50) throw new UserError(l3('Tilillä on jo 50 agenttia.', 'Kontot har redan 50 agenter.', 'The account already has 50 agents.'));
  const token = 'aimo-agt-' + randomBytes(24).toString('base64url');
  const now = Date.now();
  const agent: StoredAgent = { id: 'ag-' + randomBytes(4).toString('hex'), name, tokenHash: tokenHash(token), authority, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86_400_000).toISOString() };
  st.agents.push(agent);
  const until = agent.expiresAt.slice(0, 10);
  audit(by, 'agent_created', l3(
    `Agentti ${name} (${agent.id}) rekisteröity tilille ${currentProfile().name}: ${limitText('fi', authority)}, voimassa ${until} asti.`,
    `Agenten ${name} (${agent.id}) registrerad för kontot ${currentProfile().name}: ${limitText('sv', authority)}, giltig till ${until}.`,
    `Agent ${name} (${agent.id}) registered for the account ${currentProfile().name}: ${limitText('en', authority)}, valid until ${until}.`));
  return { agent, token };
}

function activeAgent(id: unknown): StoredAgent {
  const a = findAgent(String(id));
  if (!a) throw new UserError(l3('Agenttia ei löytynyt.', 'Agenten hittades inte.', 'Agent not found.'));
  if (agentStatus(a) !== 'active') throw new UserError(l3('Agentin valtuus ei ole enää voimassa.', 'Agentens befogenhet gäller inte längre.', 'The agent’s authorisation is no longer valid.'));
  return a;
}

export function updateAgent(id: unknown, perOrder: unknown, weekly: unknown, by: L3): StoredAgent {
  const a = activeAgent(id);
  const before = a.authority;
  a.authority = limits(perOrder, weekly);
  audit(by, 'agent_updated', l3(
    `Agentin ${a.name} (${a.id}) rajat muutettu: ${limitText('fi', before)} → ${limitText('fi', a.authority)}.`,
    `Gränserna för agenten ${a.name} (${a.id}) ändrade: ${limitText('sv', before)} → ${limitText('sv', a.authority)}.`,
    `Limits of agent ${a.name} (${a.id}) changed: ${limitText('en', before)} → ${limitText('en', a.authority)}.`));
  return a;
}

export function revokeAgent(id: unknown, by: L3): StoredAgent {
  const a = activeAgent(id);
  a.revokedAt = new Date().toISOString();
  audit(by, 'agent_revoked', l3(
    `Agentin ${a.name} (${a.id}) valtuus peruttu. Sen tunnus ei enää kelpaa.`,
    `Befogenheten för agenten ${a.name} (${a.id}) återkallad. Dess token gäller inte längre.`,
    `Authorisation of agent ${a.name} (${a.id}) revoked. Its token no longer works.`));
  return a;
}
