// Adapter for the Valio Aimo challenge mock API (price + availability). This is the REAL mock
// integration. The mock exposes no order endpoint, so order submission is simulated locally (orders.ts).
import type { Lang, Offer } from '../../shared/types.ts';
import { config } from './config.ts';
import { dayLabel, num, tr } from './i18n.ts';

interface RawOffer {
  observedAt: string;
  price?: number; priceWithTax?: number; vatRate?: number; comparisonPrice?: number; comparisonUnit?: string;
  hasAvailability: boolean;
  amount?: number; unknownQty?: boolean; availableDate?: string; closingTime?: string; salesBlock?: boolean;
  error?: string;
  /** set with `error` when the mock rate-limited us: epoch ms before which it must not be called again */
  retryAt?: number;
}

const cache = new Map<string, { at: number; offer: RawOffer }>();
// Browsing uses a short cache so screens stay fast and the mock API is not hammered (it rate-limits);
// anything that commits an order passes fresh=true and never reads this cache.
const TTL = 60_000; // the freshness promised to agents in docs/agent-interface.md
let downUntil = 0;
export const valioStatus = { ok: false, checkedAt: undefined as string | undefined, lastError: undefined as string | undefined };

// Call budget, confirmed by Valio Aimo: more than 10 calls per second returns HTTP 429 and blocks the caller
// for 30 seconds. Every call to the mock in this process goes through call(): at most 5 per second, and after
// a 429 no call at all until the cooldown has passed.
const MAX_PER_SECOND = 5;
const RATE_LIMITED = 'rate_limited';
const slots: number[] = []; // start times of the latest calls, reserved before waiting
let limitedUntil = 0;

/** Seconds left of the 429 cooldown; 0 when the mock may be called. */
export const valioCooldown = (until = limitedUntil) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

/** Retry-After as seconds or an HTTP date. Default 30 s (the block Valio Aimo stated), at most 300 s. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number {
  const h = (header ?? '').trim();
  const s = /^\d+$/.test(h) ? Number(h) : Math.ceil((Date.parse(h) - now) / 1000);
  return Number.isFinite(s) && s > 0 ? Math.min(s, 300) : 30;
}

export const rateLimitText = (seconds: number) => ({
  fi: `Valio Aimon rajapinnan kutsuraja tuli vastaan. Yritä uudelleen ${seconds} sekunnin päästä.`,
  sv: `Valio Aimos API begränsade anropen. Försök igen om ${seconds} sekunder.`,
  en: `The Valio Aimo API rate limit was hit. Try again in ${seconds} seconds.`,
});

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (Date.now() < limitedUntil) throw new Error(RATE_LIMITED);
  const now = Date.now();
  const at = slots.length < MAX_PER_SECOND ? now : Math.max(now, slots[slots.length - MAX_PER_SECOND] + 1000);
  slots.push(at);
  if (slots.length > MAX_PER_SECOND) slots.shift();
  while (Date.now() < at) await new Promise(r => setTimeout(r, at - Date.now()));
  if (Date.now() < limitedUntil) throw new Error(RATE_LIMITED); // a 429 arrived while this call was queued
  const res = await fetch(config.valio.baseUrl + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429) {
    limitedUntil = Date.now() + retryAfterSeconds(res.headers.get('retry-after')) * 1000;
    throw new Error(RATE_LIMITED);
  }
  return res;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await call(path, { method: 'POST', headers: { 'X-API-Key': config.valio.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 15_000);
  if (!res.ok) throw new Error(`Valio mock ${path} HTTP ${res.status}`);
  return res.json();
}

export async function pingValio(): Promise<boolean> {
  try {
    const res = await call('/api/ping', { headers: { 'X-API-Key': config.valio.apiKey } }, 8000);
    valioStatus.ok = res.ok;
    valioStatus.lastError = res.ok ? undefined : `HTTP ${res.status}`;
  } catch (e) {
    valioStatus.ok = false;
    valioStatus.lastError = String((e as Error).message);
  }
  valioStatus.checkedAt = new Date().toISOString();
  return valioStatus.ok;
}

/** Fetch price + availability for product ids. `fresh` bypasses the short browse cache (used before submission). */
export async function fetchOffers(ids: string[], date: string, fresh = false): Promise<Map<string, RawOffer>> {
  const out = new Map<string, RawOffer>();
  const want = [...new Set(ids)];
  const missing: string[] = [];
  const now = Date.now();
  for (const id of want) {
    const c = cache.get(`${date}|${id}`);
    if (!fresh && c && now - c.at < TTL) out.set(id, c.offer);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 40) {
    const batch = missing.slice(i, i + 40);
    const observedAt = new Date().toISOString();
    const body = { customer: config.valio.customer, requestedDate: date, products: batch };
    let prices: any, avail: any, error: string | undefined;
    if (Date.now() < limitedUntil) error = RATE_LIMITED;
    else if (Date.now() < downUntil) error = valioStatus.lastError ?? 'Valio mock unreachable';
    else try {
      [prices, avail] = await Promise.all([post('/api/price', body), post('/api/availability', body)]);
      valioStatus.ok = true; valioStatus.checkedAt = observedAt; valioStatus.lastError = undefined;
    } catch (e) {
      error = String((e as Error).message);
      valioStatus.ok = false; valioStatus.checkedAt = observedAt; valioStatus.lastError = error;
      if (error !== RATE_LIMITED) downUntil = Date.now() + 15_000; // do not make every screen refresh wait for a dead upstream
    }
    const retryAt = error === RATE_LIMITED ? limitedUntil : undefined;
    const pm = new Map<string, any>((prices?.products ?? []).map((p: any) => [String(p.productId), p]));
    const am = new Map<string, any>((avail?.products ?? []).map((p: any) => [String(p.productId), p]));
    for (const id of batch) {
      const p = pm.get(id), a = am.get(id);
      const offer: RawOffer = { observedAt, hasAvailability: false, error, retryAt };
      if (p && !p.error && p.catalogPrice?.value != null) {
        offer.price = p.catalogPrice.value;
        offer.priceWithTax = p.priceWithTax?.value ?? p.catalogPrice.valueWithTax;
        offer.vatRate = p.tax?.taxRate;
        offer.comparisonPrice = p.comparisonPrice?.value;
        offer.comparisonUnit = p.comparisonUnit ?? undefined;
      }
      if (a) {
        offer.closingTime = a.closingTime || undefined;
        offer.salesBlock = !!a.salesBlock;
        const lines = (a.scheduleLines ?? []).filter((l: any) => !l.salesBlock);
        if (lines.length && !a.salesBlock) {
          const l = lines[0];
          offer.hasAvailability = true;
          offer.availableDate = l.availableDate;
          // the mock uses 999999 (and larger) for "quantity not stated", not for confirmed stock
          if (l.availableAmount >= 999_999) offer.unknownQty = true;
          else offer.amount = l.availableAmount;
        }
      }
      if (!error) cache.set(`${date}|${id}`, { at: Date.now(), offer });
      // browsing only: if the mock is briefly unavailable, show the last observed offer (it carries its observedAt)
      const stale = error && !fresh ? cache.get(`${date}|${id}`)?.offer : undefined;
      out.set(id, stale ?? offer);
    }
  }
  return out;
}

export function toOffer(raw: RawOffer | undefined, lang: Lang, wantQty = 0): Offer {
  const o: Offer = {
    source: 'valio_mock', observedAt: raw?.observedAt ?? new Date().toISOString(),
    availability: 'no_data', availabilityLabel: '',
  };
  if (!raw || raw.error) {
    o.error = raw?.error ?? 'no data';
    const wait = rateLimitText(valioCooldown(raw?.retryAt));
    o.availabilityLabel = raw?.retryAt ? tr(lang, wait.fi, wait.sv, wait.en) : tr(lang, 'Valio Aimo -mockrajapinta ei vastannut – tietoa ei voitu tarkistaa', 'Valio Aimos mock-API svarade inte – uppgiften kunde inte kontrolleras', 'Valio Aimo mock API did not respond – could not check');
    return o;
  }
  Object.assign(o, { price: raw.price, priceWithTax: raw.priceWithTax, vatRate: raw.vatRate, comparisonPrice: raw.comparisonPrice, comparisonUnit: raw.comparisonUnit, availableDate: raw.availableDate, closingTime: raw.closingTime });
  if (raw.closingTime) o.cutoffPassed = new Date(raw.closingTime).getTime() < Date.now();
  const on = raw.availableDate ? dayLabel(lang, raw.availableDate) : '';
  if (!raw.hasAvailability) {
    o.availability = raw.salesBlock ? 'unavailable' : 'no_data';
    o.availabilityLabel = raw.salesBlock
      ? tr(lang, 'Myyntiesto – ei tilattavissa', 'Försäljningsspärr – kan inte beställas', 'Sales block – cannot be ordered')
      : tr(lang, 'Ei saatavuustietoa toimittajalta', 'Ingen tillgänglighetsuppgift från leverantören', 'No availability information from the supplier');
  } else if (raw.unknownQty) {
    o.availability = 'unknown_qty';
    o.availabilityLabel = tr(lang, `Tilattavissa ${on} · määrää ei ilmoiteta (terminaalituote)`, `Kan beställas ${on} · mängd anges inte (terminalprodukt)`, `Orderable for ${on} · quantity not stated (terminal product)`);
  } else {
    o.availableAmount = raw.amount;
    if (wantQty > 0 && (raw.amount ?? 0) < wantQty) {
      o.availability = 'limited';
      o.availabilityLabel = tr(lang, `Vain ${num(lang, raw.amount ?? 0, 0)} saatavilla ${on}`, `Endast ${num(lang, raw.amount ?? 0, 0)} tillgängliga ${on}`, `Only ${num(lang, raw.amount ?? 0, 0)} available for ${on}`);
    } else {
      o.availability = 'available';
      o.availabilityLabel = tr(lang, `Saatavilla ${on} · ${num(lang, raw.amount ?? 0, 0)} varastossa`, `Tillgänglig ${on} · ${num(lang, raw.amount ?? 0, 0)} i lager`, `Available for ${on} · ${num(lang, raw.amount ?? 0, 0)} in stock`);
    }
  }
  return o;
}
export type { RawOffer };
