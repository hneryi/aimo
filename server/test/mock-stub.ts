// Local stand-in for the Valio Aimo challenge mock API, for tests that must run without network or keys.
// It answers POST /api/price, POST /api/availability and GET /api/ping in the shape of the recorded responses
// in data/raw/price-2026-11-16.json and data/raw/avail-2026-11-16.json, and records every call it receives.
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubOffer {
  price?: number;        // EUR excl. VAT per sales unit; undefined = the mock returns no price
  amount?: number;       // available sales units; 999999 and above mean "quantity not stated"
  closingTime?: string;  // order cutoff
  salesBlock?: boolean;
}

export interface Stub {
  url: string;
  /** every request received, in arrival order */
  calls: { at: number; path: string; ids: string[] }[];
  /** per-product answers; products not listed get `fallback` */
  offers: Map<string, StubOffer>;
  fallback: StubOffer;
  /** 'ok' answers normally, 'limited' answers HTTP 429, 'down' answers HTTP 500 */
  mode: 'ok' | 'limited' | 'down';
  /** Retry-After header sent with a 429; undefined = no header */
  retryAfter?: string;
  close(): Promise<void>;
}

export async function startStub(): Promise<Stub> {
  const stub: Stub = {
    url: '', calls: [], offers: new Map(), mode: 'ok',
    fallback: { price: 2, amount: 500, closingTime: '2099-01-01T17:00:00+0200' },
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const ids: string[] = (body.products ?? []).map(String);
      stub.calls.push({ at: Date.now(), path: req.url ?? '', ids });
      const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (stub.mode === 'limited') return send(429, { error: 'rate limit exceeded' }, stub.retryAfter === undefined ? {} : { 'retry-after': stub.retryAfter });
      if (stub.mode === 'down') return send(500, { error: 'unavailable' });
      const of = (id: string) => stub.offers.get(id) ?? stub.fallback;
      if (req.url === '/api/ping') return send(200, { ok: true });
      if (req.url === '/api/price') {
        return send(200, { customerId: body.customer, currency: 'EUR', pricingDate: body.requestedDate, products: ids.map(id => {
          const price = of(id).price;
          if (price === undefined) return { productId: id, error: true };
          const withTax = Math.round(price * 113.5) / 100;
          return { productId: id, quantity: 1, catalogPrice: { value: price, valueWithTax: withTax, currency: 'EUR' }, priceWithTax: { value: withTax, currency: 'EUR' }, comparisonPrice: { value: price }, comparisonUnit: 'KG', tax: { taxRate: 13.5 }, netPriceFound: false, error: false };
        }) });
      }
      if (req.url === '/api/availability') {
        return send(200, { timeNow: new Date().toISOString(), requestedDate: body.requestedDate, products: ids.map(id => {
          const o = of(id);
          return { productId: id, closingTime: o.closingTime, salesBlock: !!o.salesBlock, logisticModel: 'Stock', scheduleLines: o.amount === undefined ? [] : [{ salesBlock: false, availableAmount: o.amount, availableDate: body.requestedDate, salesUnit: 'ST' }] };
        }) });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}
