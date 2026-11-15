// The call budget towards the Valio Aimo mock API (src/valio.ts), tested against a local stub: no network,
// no key. Valio Aimo confirmed: more than 10 calls per second returns HTTP 429 and blocks the caller for 30 s.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Lang } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const stub = await startStub();
process.env.VALIO_BASE_URL = stub.url;
process.env.VALIO_API_KEY = 'offline-test';
const { fetchOffers, pingValio, rateLimitText, retryAfterSeconds, toOffer, valioCooldown, valioStatus } = await import('../src/valio.ts');

const DATE = '2026-11-16';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
after(() => stub.close());

describe('Retry-After', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  it('reads seconds', () => assert.equal(retryAfterSeconds('12', now), 12));
  it('reads an HTTP date', () => assert.equal(retryAfterSeconds('Sat, 14 Nov 2026 12:00:45 GMT', now), 45));
  it('defaults to 30 s without a usable header', () => {
    for (const h of [null, '', 'soon', '0', '-5', 'Sat, 14 Nov 2026 11:00:00 GMT']) assert.equal(retryAfterSeconds(h, now), 30, String(h));
  });
  it('never waits longer than 300 s', () => {
    assert.equal(retryAfterSeconds('86400', now), 300);
    assert.equal(retryAfterSeconds('Sun, 15 Nov 2026 12:00:00 GMT', now), 300);
  });
  it('the message names the wait in three languages', () => {
    const t = rateLimitText(17);
    for (const lang of ['fi', 'sv', 'en'] as Lang[]) assert.match(t[lang], /17/);
  });
});

describe('pacing and 429 cooldown', () => {
  it('at most 5 calls reach the mock in any second, and every offer still arrives', { timeout: 20_000 }, async () => {
    const start = stub.calls.length;
    // 7 lookups of one product each = 14 calls (price + availability), all requested at once
    const results = await Promise.all(['1', '2', '3', '4', '5', '6', '7'].map(id => fetchOffers([id], DATE, true)));
    const calls = stub.calls.slice(start);
    assert.equal(calls.length, 14);
    for (let i = 0; i + 5 < calls.length; i++) {
      const gap = calls[i + 5].at - calls[i].at;
      assert.ok(gap >= 950, `calls ${i} and ${i + 5} arrived ${gap} ms apart: more than 5 calls within one second`);
    }
    results.forEach((r, i) => assert.equal(r.get(String(i + 1))?.price, 2));
    assert.equal(valioStatus.ok, true);
  });

  it('the browse cache still answers repeated lookups without a call; fresh lookups always call', { timeout: 20_000 }, async () => {
    const start = stub.calls.length;
    await fetchOffers(['1', '2'], DATE);
    assert.equal(stub.calls.length, start, 'cached offers are served without calling the mock');
    await fetchOffers(['1', '2'], DATE, true);
    assert.equal(stub.calls.length, start + 2);
  });

  it('a 429 starts a cooldown from Retry-After during which the mock is not called', { timeout: 20_000 }, async () => {
    stub.mode = 'limited';
    stub.retryAfter = '2';
    const start = stub.calls.length;
    const first = await fetchOffers(['8'], DATE, true);
    const hit = stub.calls.length;
    assert.ok(hit > start, 'the 429 itself was received');
    const raw = first.get('8')!;
    assert.equal(raw.error, 'rate_limited');
    assert.equal(raw.price, undefined);
    assert.ok(raw.retryAt && raw.retryAt > Date.now());
    assert.ok(valioCooldown() >= 1 && valioCooldown() <= 2, `cooldown ${valioCooldown()} s`);
    assert.equal(valioStatus.ok, false);

    // fresh lookups, cached lookups of unknown products and the ping all stay local during the cooldown
    stub.mode = 'ok';
    const again = await fetchOffers(['8', '9'], DATE, true);
    assert.equal(again.get('9')?.error, 'rate_limited');
    assert.equal((await fetchOffers(['10'], DATE)).get('10')?.error, 'rate_limited');
    assert.equal(await pingValio(), false);
    assert.equal(stub.calls.length, hit, 'no call during the cooldown');

    // the offer shown to people and agents says what happened and for how long, in every language
    for (const lang of ['fi', 'sv', 'en'] as Lang[]) {
      const o = toOffer(again.get('9'), lang);
      assert.equal(o.error, 'rate_limited');
      assert.equal(o.availability, 'no_data');
      assert.equal(o.price, undefined);
      assert.match(o.availabilityLabel, /[12] (sekunnin|sekunder|seconds)/);
    }
    // browsing may still show the last offer it saw (with its own observedAt); a fresh check may not
    assert.equal((await fetchOffers(['1'], DATE)).get('1')?.price, 2);
    assert.equal((await fetchOffers(['1'], DATE, true)).get('1')?.error, 'rate_limited');

    await sleep(2100);
    assert.equal(valioCooldown(), 0);
    const back = await fetchOffers(['8'], DATE, true);
    assert.equal(back.get('8')?.price, 2);
    assert.ok(stub.calls.length > hit);
    assert.equal(valioStatus.ok, true);
  });

  it('a 429 without Retry-After blocks for the 30 s Valio Aimo stated', { timeout: 20_000 }, async () => {
    stub.mode = 'limited';
    stub.retryAfter = undefined;
    const r = await fetchOffers(['12'], DATE, true);
    assert.equal(r.get('12')?.error, 'rate_limited');
    assert.ok(valioCooldown() >= 29 && valioCooldown() <= 30, `cooldown ${valioCooldown()} s`);
    const n = stub.calls.length;
    await fetchOffers(['13'], DATE, true);
    assert.equal(stub.calls.length, n);
  });
});
