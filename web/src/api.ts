import type { TFn } from './i18n';
import type { SigningKey } from './signatures';
import type {
  AgentInfo,
  Alternative,
  DashboardState,
  Lang,
  Requirement,
  TurnResponse,
  UiAction,
} from './types';

/** `message` is the server's already-localized text; empty when there is none (network/parse failure). */
export class ApiError extends Error {
  kind: 'server' | 'network';
  /** machine-readable reason, e.g. 'approver_required': the action needs a signed-in approver */
  code?: string;
  constructor(message: string, kind: 'server' | 'network', code?: string) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

/** The server's own (localized) message when it sent one, otherwise a gentle generic one. */
export function errorText(e: unknown, t: TFn): string {
  if (e instanceof ApiError) return e.message || t(e.kind === 'network' ? 'err.network' : 'err.generic');
  return t('err.generic');
}

/** Downloadable sample menus: a weekly lunch menu, or an event menu for accounts of kind 'event'. */
export function sampleFiles(kind: string | undefined): { xlsx: string; pdf: string } {
  const base = kind === 'event' ? '/demo/haamenu-kaisla' : '/demo/ruokalista-vko47';
  return { xlsx: `${base}.xlsx`, pdf: `${base}.pdf` };
}

/** The active customer account; sent with every request once known (undefined = the server's default). */
export type ProfileId = string | undefined;

const PROFILE_KEY = 'aimo.profile';

export function loadProfile(): ProfileId {
  try {
    return localStorage.getItem(PROFILE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function saveProfile(id: ProfileId): void {
  try {
    if (id) localStorage.setItem(PROFILE_KEY, id);
    else localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export const ACCEPTED_EXT = ['.xlsx', '.xls', '.pdf', '.csv'];

/** `?fixture=1` runs the UI against a local fixture (layout checks without a backend). */
const useFixture = new URLSearchParams(window.location.search).get('fixture') === '1';
const fixture = () => import('./devFixture');

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('', 'network');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '';
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : undefined;
    throw new ApiError(msg, 'server', code);
  }
  if (body === null || typeof body !== 'object') throw new ApiError('', 'server');
  return body as T;
}

/** The approver's session token. Kept in memory only: a reload signs the approver out. */
let session = '';
const auth = (): Record<string, string> => (session ? { Authorization: `Bearer ${session}` } : {});

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth() },
  body: JSON.stringify(payload),
});

/** Sign an approver in with name and PIN; resolves to the approver's name as the server knows it. */
export async function postLogin(name: string, pin: string, lang: Lang): Promise<string> {
  if (useFixture) return name;
  const res = await call<{ token: string; name: string }>('/api/login', json({ name, pin, lang }));
  session = res.token;
  return res.name;
}

export function signOut(): void {
  if (session && !useFixture) void fetch('/api/logout', { method: 'POST', headers: auth() }).catch(() => undefined);
  session = '';
}

const query = (lang: Lang, profile: ProfileId, extra: Record<string, string> = {}): string => {
  const params = new URLSearchParams({ ...extra, lang });
  if (profile) params.set('profile', profile);
  return params.toString();
};

export async function getState(lang: Lang, profile: ProfileId): Promise<DashboardState> {
  if (useFixture) return (await fixture()).fxState(lang, profile);
  return call<DashboardState>(`/api/state?${query(lang, profile)}`);
}

export async function postChat(message: string, lang: Lang, profile: ProfileId): Promise<TurnResponse> {
  if (useFixture) return (await fixture()).fxChat(message, lang, profile);
  return call<TurnResponse>('/api/chat', json({ message, lang, profile }));
}

export async function postImport(file: File, lang: Lang, profile: ProfileId): Promise<TurnResponse> {
  if (useFixture) return (await fixture()).fxAction({ type: 'load_demo_menu' }, lang, profile);
  const form = new FormData();
  form.append('file', file);
  form.append('lang', lang);
  if (profile) form.append('profile', profile);
  return call<TurnResponse>('/api/import', { method: 'POST', body: form });
}

export async function postAction(action: UiAction, lang: Lang, profile: ProfileId): Promise<TurnResponse> {
  if (useFixture) return (await fixture()).fxAction(action, lang, profile);
  return call<TurnResponse>('/api/action', json({ action, lang, profile }));
}

export async function searchProducts(
  q: string,
  req: Requirement[],
  lang: Lang,
  profile: ProfileId,
): Promise<Alternative[]> {
  if (useFixture) return (await fixture()).fxSearch(q);
  const params = new URLSearchParams(query(lang, profile, { q }));
  if (req.length) params.set('req', req.join(','));
  const res = await call<{ items: Alternative[] }>(`/api/products/search?${params.toString()}`);
  return Array.isArray(res.items) ? res.items : [];
}

let signingKeys: Promise<SigningKey[]> | undefined;
export function getSigningKeys(): Promise<SigningKey[]> {
  return signingKeys ??= call<{ keys: SigningKey[] }>('/.well-known/jwks.json')
    .then(set => { if (!Array.isArray(set.keys)) throw new Error('Invalid JWK Set'); return set.keys; })
    .catch(e => { signingKeys = undefined; throw e; });
}

export async function getAgentInfo(lang: Lang, profile: ProfileId): Promise<AgentInfo> {
  if (useFixture) return (await fixture()).fxAgentInfo();
  return call<AgentInfo>(`/api/agent-info?${query(lang, profile)}`, { headers: auth() });
}
