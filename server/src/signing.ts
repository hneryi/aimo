// Signed quotes and order confirmations. An agent can check that an answer really came from this server and
// was not altered on the way: JWS compact serialization (RFC 7515) with EdDSA over Ed25519 (RFC 8037), the
// public key published as a JWK Set (RFC 7517), the key id being the JWK thumbprint (RFC 7638).
// The signature says nothing about whether the Valio Aimo mock data behind the figures is right.
import { type KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';

let loaded: { key: KeyObject; x: string; kid: string } | undefined;

/** The server's key: from SIGNING_KEY, else from the data directory, where it is created on first use. */
function signingKey() {
  if (loaded) return loaded;
  let key: KeyObject;
  if (config.signingKey) key = createPrivateKey({ key: Buffer.from(config.signingKey, 'base64'), format: 'der', type: 'pkcs8' });
  else {
    const file = resolve(config.dataDir, 'signing-key.pem');
    if (!existsSync(file)) {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(file, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    }
    key = createPrivateKey(readFileSync(file, 'utf8'));
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be an Ed25519 private key.');
  const x = String(createPublicKey(key).export({ format: 'jwk' }).x);
  const kid = createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');
  return (loaded = { key, x, kid });
}

export const ISSUER = config.publicUrl.replace(/\/$/, '');
export const JWKS_URL = ISSUER + '/.well-known/jwks.json';
export const signingKid = () => signingKey().kid;
/** how to verify, returned next to every signed document */
export const signatureInfo = () => ({ format: 'JWS compact serialization (RFC 7515)', alg: 'EdDSA', kid: signingKid(), jwks_url: JWKS_URL });

/** The public key as a JWK Set, served at /.well-known/jwks.json. */
export function jwks() {
  const { x, kid } = signingKey();
  return { keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid, use: 'sig', alg: 'EdDSA' }] };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Sign claims as a compact JWS: base64url(header).base64url(payload).base64url(signature). */
export function signJws(claims: Record<string, unknown>): string {
  const { key, kid } = signingKey();
  const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid })}.${b64(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}
