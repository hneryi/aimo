// Who may approve. Without APPROVERS the UI and /api are open (demo mode) and decisions are logged as the
// kitchen manager. With APPROVERS ("Name:PIN,Name:PIN"), deciding an order and changing authority need a
// signed-in approver, whose name goes into the log. PINs are never written anywhere: only their SHA-256 is
// kept in memory, compared in constant time, and wrong attempts are limited. Sessions live in memory only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { UserError } from './planner.ts';
import { l3 } from './store.ts';

const sha = (s: string) => createHash('sha256').update(s).digest();

const approvers = config.approvers.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
  const i = entry.lastIndexOf(':');
  const name = entry.slice(0, i).trim(), pin = entry.slice(i + 1).trim();
  // fail closed: a broken list must not start the server in open mode (the message never echoes a PIN)
  if (i < 1 || !name || pin.length < 4) throw new Error('APPROVERS must be "Name:PIN,Name:PIN", each PIN at least 4 characters.');
  return { name, pin: sha(pin) };
});
export const approversConfigured = () => approvers.length > 0;

const SESSION_MS = 30 * 60_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const sessions = new Map<string, { name: string; expires: number }>(); // key: SHA-256 of the session token
const fails = new Map<string, { n: number; until: number }>();         // key: the name that was tried

/** Check name and PIN. Five wrong PINs for a name lock that name for 15 minutes, also for the right PIN. */
export function login(nameIn: unknown, pinIn: unknown): { token: string; name: string; expiresAt: string } {
  if (!approversConfigured()) throw new UserError(l3('Hyväksyjiä ei ole määritetty: palvelu on avoimessa demotilassa.', 'Inga godkännare har angetts: tjänsten är i öppet demoläge.', 'No approvers are configured: the service is in open demo mode.'));
  const key = String(nameIn ?? '').trim().toLowerCase().slice(0, 80);
  const now = Date.now();
  const f = fails.get(key);
  if (f && f.until > now) {
    const wait = Math.ceil((f.until - now) / 1000);
    throw new UserError(l3(`Liian monta väärää PIN-koodia. Yritä uudelleen ${Math.ceil(wait / 60)} minuutin päästä.`, `För många felaktiga PIN-koder. Försök igen om ${Math.ceil(wait / 60)} minuter.`, `Too many wrong PINs. Try again in ${Math.ceil(wait / 60)} minutes.`), 'too_many_attempts', { retry_after_seconds: wait });
  }
  const a = approvers.find(x => x.name.toLowerCase() === key);
  // an unknown name is compared too, so the answer takes the same time and reads the same
  const right = timingSafeEqual(sha(String(pinIn ?? '')), a?.pin ?? sha('')) && !!a;
  if (!a || !right) {
    if (fails.size > 5000) for (const [k, v] of fails) if (v.until <= now) fails.delete(k);
    const n = (f && !f.until ? f.n : 0) + 1;
    fails.set(key, { n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
    throw new UserError(l3('Nimi tai PIN-koodi ei täsmää.', 'Namnet eller PIN-koden stämmer inte.', 'The name or PIN is not right.'), 'login_failed');
  }
  fails.delete(key);
  const token = randomBytes(24).toString('base64url');
  const expires = now + SESSION_MS;
  sessions.set(sha(token).toString('hex'), { name: a.name, expires });
  return { token, name: a.name, expiresAt: new Date(expires).toISOString() };
}

/** The approver a session token belongs to; undefined when there is none or it has expired. */
export function approverOf(token: string): string | undefined {
  if (!token) return undefined;
  const key = sha(token).toString('hex');
  const s = sessions.get(key);
  if (s && s.expires <= Date.now()) sessions.delete(key);
  return sessions.get(key)?.name;
}

export const logout = (token: string) => { sessions.delete(sha(token).toString('hex')); };
