import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');

// minimal .env loader (no dependency); real environment variables win
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const env = (k: string, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8787')),
  /** interface to listen on; set HOST=127.0.0.1 to keep a local instance off the network */
  host: env('HOST', '0.0.0.0'),
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '8787')}`),
  dataDir: resolve(ROOT, env('DATA_DIR', 'data')),
  catalogFile: resolve(ROOT, env('CATALOG_FILE', 'data/catalog.json')),
  stateFile: resolve(ROOT, env('STATE_FILE', 'data/state.json')),
  webDist: resolve(ROOT, 'web/dist'),
  demoDir: resolve(ROOT, 'demo'),
  valio: {
    baseUrl: env('VALIO_BASE_URL', 'https://junction26.valioaimo.fi'),
    apiKey: env('VALIO_API_KEY'),
    customer: env('VALIO_CUSTOMER', 'demo-hotel-001'),
  },
  llm: {
    baseUrl: env('VERDA_BASE_URL', 'https://inference.verda.com/v1'),
    apiKey: env('VERDA_API_KEY'),
    model: env('VERDA_MODEL', 'deepseek-4-1-flash-1017'),
    recipeModel: env('VERDA_RECIPE_MODEL', 'kimi-k3-1-pro'),
  },
  /** bearer token for the external purchasing agent (MCP). Generated on first start if unset. */
  agentToken: env('AGENT_TOKEN'),
  /** Ed25519 private key for signed quotes and order confirmations (PKCS#8 DER, base64).
   *  If unset, a key is generated on first start and kept in dataDir/signing-key.pem (mode 600). */
  signingKey: env('SIGNING_KEY'),
  /** People who may approve, as "Name:PIN,Name:PIN". Unset = open demo mode: anyone using the UI can approve. */
  approvers: env('APPROVERS'),
  /** The challenge mock serves a fixed snapshot whose order cutoffs may already be in the past.
   *  'warn' = flag it and require human approval; 'enforce' = refuse to submit. */
  cutoffMode: env('CUTOFF_MODE', 'warn') as 'warn' | 'enforce',
};
