// Verify only with keys fetched from our own origin, never a URL supplied by a signed document.
export interface SigningKey extends JsonWebKey { kid?: string; alg?: string }
export interface SignedClaims {
  type: string; jti: string; iss: string; account: string;
  iat: number; exp?: number;
  agent?: { id: string | null; name: string; identity: string };
  price_and_availability?: { source: string; fetched_at: string };
  quote_id?: string | null;
  lines: { product_id: string; quantity: number; unit_price_excl_vat: number }[];
  total_excl_vat: number; total_incl_vat: number; vat: number;
  [key: string]: unknown;
}
export type SignatureStatus = 'checking' | 'verified' | 'invalid' | 'unsupported' | 'unavailable';
export interface Verification { status: SignatureStatus; claims?: SignedClaims }

const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export function documentContent(jws: string): string {
  try { return JSON.stringify(JSON.parse(new TextDecoder().decode(bytes(jws.split('.')[1]))), null, 2); }
  catch { return jws; }
}

/** Decoding alone proves nothing. Used for displaying evidence even in unsupported browsers. */
export function documentClaims(jws: string): SignedClaims | undefined {
  try {
    const c = JSON.parse(new TextDecoder().decode(bytes(jws.split('.')[1]))) as SignedClaims;
    if (!c || ![c.total_excl_vat, c.vat, c.total_incl_vat].every(Number.isFinite) || !Array.isArray(c.lines)) return undefined;
    if (c.lines.some(l => !l || typeof l.product_id !== 'string' || !Number.isFinite(l.quantity) || !Number.isFinite(l.unit_price_excl_vat))) return undefined;
    return c;
  } catch { return undefined; }
}

export function priceDifferences(quote: SignedClaims, confirmation: SignedClaims) {
  return quote.lines.flatMap(l => {
    const sent = confirmation.lines.find(x => x.product_id === l.product_id);
    return sent && Math.abs(sent.unit_price_excl_vat - l.unit_price_excl_vat) > 0.005
      ? [{ id: l.product_id, quoted: l.unit_price_excl_vat, sent: sent.unit_price_excl_vat }] : [];
  });
}

/** Expiry is displayed separately: an expired, consumed quote remains verifiable evidence. */
export async function verifyDocument(jws: string, keys: SigningKey[], expected: Record<string, unknown>): Promise<Verification> {
  if (!globalThis.crypto?.subtle) return { status: 'unsupported' };
  try {
    const parts = jws.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return { status: 'invalid' };
    const [h, p, sig] = parts;
    const header = JSON.parse(new TextDecoder().decode(bytes(h)));
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || header.crit) return { status: 'invalid' };
    const jwk = keys.find(k => k.kid === header.kid && k.kty === 'OKP' && k.crv === 'Ed25519' && k.alg === 'EdDSA' && k.use === 'sig');
    if (!jwk) return { status: 'invalid' };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, bytes(sig), new TextEncoder().encode(`${h}.${p}`))) return { status: 'invalid' };
    const claims = documentClaims(jws);
    if (!claims || Object.entries(expected).some(([k, v]) => JSON.stringify(claims[k]) !== JSON.stringify(v))) return { status: 'invalid' };
    return { status: 'verified', claims };
  } catch (e) {
    return { status: e instanceof Error && e.name === 'NotSupportedError' ? 'unsupported' : 'invalid' };
  }
}
