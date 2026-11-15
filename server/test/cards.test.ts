// Order cards: several named lists per account, each with its own delivery date, one selected as the target for
// additions. Also the structured ingredient groups of an ingredient search and the stream rules the UI builds on
// them (web/src/stream.ts: what folds away, how a card is keyed).
//
// Offline like the other offline tests: a local stub of the Valio Aimo mock (test/mock-stub.ts), no language model,
// the real challenge catalog and a temporary state file. Dates are relative to today, so nothing here goes stale.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { Card, DashboardState, Draft, Lang, Order, TurnResponse, UiAction } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const stub = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-cards-'));
const STATE_FILE = join(dir, 'state.json');
Object.assign(process.env, {
  VALIO_BASE_URL: stub.url, VALIO_API_KEY: 'offline-test', STATE_FILE, DATA_DIR: dir, AGENT_TOKEN: 'offline-cards', CUTOFF_MODE: 'warn',
  VERDA_API_KEY: '', VERDA_BASE_URL: stub.url, APPROVERS: '', // no model: ingredient lists are read by the rules
});

const { loadCatalog } = await import('../src/catalog.ts');
const { handleAction, handleChat, stateView } = await import('../src/app.ts');
const { UserError } = await import('../src/planner.ts');
const { S, loadState, resetState, runAs } = await import('../src/store.ts');
const { addDays } = await import('../src/i18n.ts');
const { applyResponse, cardKey, isFoldable, keyCards, panelDraft, resyncTurns, seedTurns } = await import('../../web/src/stream.ts');

loadCatalog();
loadState();
after(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => runAs('school', () => resetState()));

const T = { timeout: 60_000 };
const PASTA = '474235';    // SamMills gluten-free macaroni 5 kg
const COFFEE = '460588';   // Paulig coffee, sold by the case
const FLOUR_GF = '460734'; // gluten-free flour mix with gluten-free wheat starch: fails wheat_free

const act = (action: UiAction, lang: Lang = 'en'): Promise<TurnResponse> => runAs('school', () => handleAction(action, lang));
const chat = (message: string, lang: Lang = 'en'): Promise<TurnResponse> => runAs('school', () => handleChat(message, lang));
const state = (lang: Lang = 'en'): Promise<DashboardState> => runAs('school', () => stateView(lang));
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(new Date());
const stored = () => JSON.parse(readFileSync(STATE_FILE, 'utf8')).profiles.school;
const cardOf = (r: TurnResponse): Draft => {
  const c = r.cards.find((x): x is Extract<Card, { type: 'draft' }> => x.type === 'draft');
  assert.ok(c, `response carries an order card (reply: ${r.reply})`);
  return c.draft;
};
const orderOf = (r: TurnResponse): Order => {
  const c = r.cards.find((x): x is Extract<Card, { type: 'order' }> => x.type === 'order');
  assert.ok(c, `response carries an order (reply: ${r.reply})`);
  return c.order;
};
const linesOf = (s: DashboardState, id: string) => s.drafts.find(d => d.id === id)!.lines.map(l => [l.product.id, l.qty]);
async function refused(run: () => Promise<unknown>): Promise<InstanceType<typeof UserError>> {
  try { await run(); } catch (e) { assert.ok(e instanceof UserError, `expected a UserError, got ${e}`); return e; }
  assert.fail('expected the request to be refused');
}

describe('order cards', () => {
  it('two cards with their own names and dates: additions go to the selected card, and the target can be switched', T, async () => {
    const d1 = addDays(today(), 3), d2 = addDays(today(), 5);
    const cake = cardOf(await act({ type: 'draft_create', name: '  Mansikka   kakku ', deliveryDate: d1 }));
    const coffee = cardOf(await act({ type: 'draft_create', name: 'Kahvit', deliveryDate: d2 }));
    let s = await state();
    assert.deepEqual(s.drafts.map(d => [d.name, d.deliveryDate, d.lines.length]), [['Mansikka kakku', d1, 0], ['Kahvit', d2, 0]]);
    assert.equal(s.activeDraft, coffee.id, 'a new card is the target at once');
    assert.equal(s.draft, undefined, 'state.draft stays the selected card with lines, as before');

    await act({ type: 'draft_set', productId: COFFEE, qty: 2 });
    await act({ type: 'draft_select', draftId: cake.id });
    const added = await act({ type: 'draft_set', productId: PASTA, qty: 1 }, 'fi');
    assert.match(added.reply, /^Luonnoksessa ”Mansikka kakku”: /, 'the reply names the draft the product went to');
    s = await state();
    assert.equal(s.activeDraft, cake.id);
    assert.deepEqual(linesOf(s, coffee.id), [[COFFEE, 2]]);
    assert.deepEqual(linesOf(s, cake.id), [[PASTA, 1]]);
    assert.equal(s.draft?.id, cake.id);

    // a card's own line changes that card, never the selected one
    await act({ type: 'draft_set', productId: COFFEE, qty: 3, draftId: coffee.id });
    s = await state();
    assert.deepEqual(linesOf(s, coffee.id), [[COFFEE, 3]]);
    assert.deepEqual(linesOf(s, cake.id), [[PASTA, 1]]);
    assert.deepEqual(s.drafts.map(d => d.totals.net), [2, 6], 'each card has its own total');
    // every card with lines is reachable from the summary
    assert.deepEqual(s.attention.filter(a => a.action?.type === 'show_draft').map(a => a.action), [{ type: 'show_draft', draftId: cake.id }, { type: 'show_draft', draftId: coffee.id }]);
    const shown = await act({ type: 'show_draft', draftId: coffee.id });
    assert.equal(cardOf(shown).id, coffee.id);
    assert.equal((await state()).activeDraft, coffee.id, 'opening a draft selects the target');
    const panel = { id: coffee.id, profile: shown.state.profile.id };
    assert.equal(panelDraft(shown.state, panel)?.id, coffee.id);
    assert.equal(panelDraft({ ...shown.state, activeDraft: cake.id }, panel), undefined);
    assert.equal(panelDraft({ ...shown.state, profile: { ...shown.state.profile, id: 'other' } }, panel), undefined);
    assert.equal(panelDraft({ ...shown.state, drafts: shown.state.drafts.filter(d => d.id !== coffee.id) }, panel), undefined);
    assert.equal(seedTurns(shown.state).flatMap(t => t.cards).some(c => c.card.type === 'draft'), false, 'reload never seeds draft cards');
    assert.equal(keyCards(shown.cards).some(c => c.card.type === 'draft'), false, 'show_draft never enters the stream');
    const chatShown = await chat('show order draft');
    assert.equal(chatShown.state.activeDraft, coffee.id);
    assert.equal(keyCards(chatShown.cards).some(c => c.card.type === 'draft'), false);

    await refused(() => act({ type: 'draft_select', draftId: 'd-unknown' }));
    await refused(() => act({ type: 'draft_set', productId: PASTA, qty: 1, draftId: 'd-unknown' }));
    assert.equal(S().audit.filter(a => a.action === 'draft_created').length, 2, 'creating a card is logged');
  });

  it('name and date can be changed; an empty name is the numbered default; a past or invalid date changes nothing', T, async () => {
    const c = cardOf(await act({ type: 'draft_create' }));
    assert.equal(c.name, 'Draft 1');
    assert.equal(cardOf(await act({ type: 'show_draft', draftId: c.id }, 'fi')).name, 'Luonnos 1');
    assert.equal(cardOf(await act({ type: 'show_draft', draftId: c.id }, 'sv')).name, 'Utkast 1');
    assert.ok(c.deliveryDate >= today(), 'the default delivery day is never in the past');

    const later = addDays(today(), 9);
    const changed = cardOf(await act({ type: 'draft_update', draftId: c.id, name: 'Juhlat', deliveryDate: later }));
    assert.deepEqual([changed.name, changed.deliveryDate], ['Juhlat', later]);
    assert.ok(S().audit.some(a => a.action === 'draft_updated' && /Juhlat/.test(a.text.en) && /delivery/.test(a.text.en)));

    const past = await refused(() => act({ type: 'draft_update', draftId: c.id, name: 'Muu', deliveryDate: addDays(today(), -1) }));
    assert.match(past.text.fi, /on jo mennyt/);
    assert.match(past.text.sv, /har redan passerat/);
    assert.match(past.text.en, /already passed/);
    const invalid = await refused(() => act({ type: 'draft_update', draftId: c.id, deliveryDate: '2027-02-30' }));
    assert.match(invalid.text.en, /not valid/);
    let s = await state();
    assert.deepEqual([s.drafts[0].name, s.drafts[0].deliveryDate], ['Juhlat', later], 'a refused change leaves the card as it was');

    const back = cardOf(await act({ type: 'draft_update', draftId: c.id, name: '   ' }));
    assert.equal(back.name, 'Draft 1');
    await refused(() => act({ type: 'draft_create', name: 'Eilen', deliveryDate: addDays(today(), -1) }));
    s = await state();
    assert.equal(s.drafts.length, 1, 'a refused card is not created');
  });

  it('deleting a card removes it and its lines, orders nothing, and the newest remaining card becomes the target', T, async () => {
    const a = cardOf(await act({ type: 'draft_create', name: 'A' }));
    await act({ type: 'draft_set', productId: PASTA, qty: 1 });
    const b = cardOf(await act({ type: 'draft_create', name: 'B' }));
    await act({ type: 'draft_set', productId: COFFEE, qty: 1 });
    const r = await act({ type: 'draft_delete', draftId: b.id });
    assert.deepEqual(r.cards, []);
    assert.deepEqual(r.state.drafts.map(d => d.id), [a.id]);
    assert.equal(r.state.activeDraft, a.id);
    assert.equal(r.state.orders.length, 0);
    assert.equal(S().quotes.length, 0);
    assert.ok(S().audit.some(a => a.action === 'draft_deleted' && /“B”/.test(a.text.en)));
    await refused(() => act({ type: 'draft_delete', draftId: b.id }));
  });

  it('ordering a card uses its name as the title and its date as the delivery date; then the card is gone', T, async () => {
    const date = addDays(today(), 4);
    const coffee = cardOf(await act({ type: 'draft_create', name: 'Kahvit', deliveryDate: date }));
    const other = cardOf(await act({ type: 'draft_create' }));
    await act({ type: 'draft_set', productId: COFFEE, qty: 2, draftId: coffee.id });
    await act({ type: 'draft_set', productId: PASTA, qty: 1 }); // to the selected card
    const r = await act({ type: 'draft_order', draftId: coffee.id });
    const o = orderOf(r);
    assert.equal(o.title, 'Kahvit');
    assert.equal(o.deliveryDate, date);
    assert.deepEqual(o.lines.map(l => [l.productId, l.qty]), [[COFFEE, 2]]);
    assert.equal(o.status, 'submitted', 'inside the kitchen user’s own authority');
    assert.equal(o.recheck?.ok, true);
    assert.ok(o.quote, 'the order came through the signed quote path');
    assert.deepEqual(r.state.drafts.map(d => d.id), [other.id], 'the ordered card is gone, the other one stays');
    assert.equal(r.state.activeDraft, other.id);
    assert.ok(r.state.deliveries.some(d => d.orderId === o.id && d.date === date), 'the order is an upcoming delivery');

    // a card without a name of its own: the numbered default is the title, in each language
    const fi = orderOf(await act({ type: 'draft_order' }, 'fi'));
    assert.equal(fi.title, 'Luonnos 2');
    assert.equal(orderOf(await act({ type: 'show_order', orderId: fi.id }, 'en')).title, 'Draft 2');
    const s = await state();
    assert.deepEqual([s.drafts.length, s.draft, s.activeDraft], [0, undefined, undefined]);
  });

  it('panel follows actual draft removal, not an order response or a refused request', T, async () => {
    const first = cardOf(await act({ type: 'draft_set', productId: PASTA, qty: 1 }));
    await act({ type: 'show_draft', draftId: first.id });
    const panel = { id: first.id, profile: 'school' };
    const ordered = await act({ type: 'draft_order', draftId: first.id });
    assert.equal(panelDraft(ordered.state, panel), undefined);
    assert.ok(ordered.cards.some(c => c.type === 'order'));
    const second = cardOf(await act({ type: 'draft_set', productId: PASTA, qty: 1 }));
    const current = { id: second.id, profile: 'school' };
    const duplicate = await act({ type: 'draft_order', draftId: second.id });
    assert.equal(orderOf(duplicate).id, orderOf(ordered).id);
    assert.equal(panelDraft(duplicate.state, current)?.id, second.id);
    stub.offers.set(PASTA, { amount: 500 });
    try {
      await act({ type: 'draft_set', draftId: second.id, productId: PASTA, qty: 2 });
      await refused(() => act({ type: 'draft_order', draftId: second.id }));
      assert.equal(panelDraft(await state(), current)?.id, second.id);
    } finally { stub.offers.delete(PASTA); }
  });

  it('a delivery date that has passed cannot be ordered: a three-language message asks for a new date, and the card stays', T, async () => {
    await act({ type: 'draft_set', productId: PASTA, qty: 1 });
    S().drafts![0].deliveryDate = addDays(today(), -2); // the card was left open while the days went by
    const s = await state();
    assert.equal(s.drafts[0].pastDate, true);
    assert.equal(s.attention.find(a => a.action?.type === 'show_draft')?.tone, 'warn');
    const quotes = S().quotes.length;
    for (const [lang, re] of [['fi', /on jo mennyt.*Vaihda luonnokselle uusi toimituspäivä/], ['sv', /har redan passerat.*Byt leveransdag/], ['en', /already passed.*Change the draft’s delivery date/]] as const) {
      const e = await refused(() => act({ type: 'draft_order' }, lang));
      assert.match(e.text[lang], re);
    }
    assert.equal(S().quotes.length, quotes, 'no quote was prepared for a past day');
    assert.equal((await state()).orders.length, 0);
    assert.equal((await state()).drafts[0].lines.length, 1, 'the card is kept so the date can be changed');

    const date = addDays(today(), 2);
    await act({ type: 'draft_update', draftId: S().drafts![0].id, deliveryDate: date });
    assert.equal(orderOf(await act({ type: 'draft_order' })).deliveryDate, date);
  });

  it('a product that fails a requirement never reaches a card and does not create one', T, async () => {
    const e = await refused(() => act({ type: 'draft_set', productId: FLOUR_GF, qty: 1, requirements: ['wheat_free'] }));
    assert.match(e.text.en, /wheat/i);
    assert.equal((await state()).drafts.length, 0, 'a refused product does not create a card');

    const c = cardOf(await act({ type: 'draft_create', name: 'Vehnätön' }));
    await refused(() => act({ type: 'draft_set', productId: FLOUR_GF, qty: 1, requirements: ['wheat_free'], draftId: c.id }));
    await act({ type: 'draft_set', productId: FLOUR_GF, qty: 1, requirements: ['gluten_free'], draftId: c.id });
    // the requirement it was added with stays on the line: a later wheat-free addition is still refused
    await refused(() => act({ type: 'draft_set', productId: FLOUR_GF, qty: 2, requirements: ['wheat_free'], draftId: c.id }));
    const s = await state();
    assert.deepEqual(linesOf(s, c.id), [[FLOUR_GF, 1]]);
    assert.deepEqual(s.drafts[0].lines[0].checks.map(x => [x.requirement, x.verdict]), [['gluten_free', 'ok']]);
  });

  it('draft_set, show_draft and draft_order without a card id still work: the first addition creates the card', T, async () => {
    assert.equal((await state()).drafts.length, 0);
    assert.match((await act({ type: 'show_draft' })).reply, /no order drafts/);
    const r = await act({ type: 'draft_set', productId: PASTA, qty: 1 });
    assert.deepEqual(r.cards.map(c => c.type), ['draft']);
    assert.deepEqual([r.state.drafts.length, r.state.activeDraft], [1, cardOf(r).id]);
    assert.deepEqual(r.state.draft?.lines.map(l => [l.product.id, l.qty]), [[PASTA, 1]]);
    assert.equal(cardOf(await act({ type: 'show_draft' })).id, cardOf(r).id);
    const o = orderOf(await act({ type: 'draft_order' }));
    assert.equal(o.lines[0].productId, PASTA);
    assert.equal((await state()).drafts.length, 0);
    assert.match((await refused(() => act({ type: 'draft_order' }))).text.en, /draft is empty/);
  });

  it('an older state file: its draft list loads as one selected card, and the selected card is saved back as draft', T, async () => {
    writeFileSync(STATE_FILE, JSON.stringify({ agentToken: 'offline-cards', orderSeq: 0, profiles: { school: { draft: [{ productId: PASTA, qty: 2, reqs: ['gluten_free'] }] } } }));
    loadState();
    const s = await state();
    assert.equal(s.drafts.length, 1);
    assert.equal(s.activeDraft, s.drafts[0].id);
    assert.equal(s.drafts[0].name, 'Draft 1');
    assert.ok(s.drafts[0].deliveryDate >= today());
    assert.deepEqual(s.draft?.lines.map(l => [l.product.id, l.qty, l.checks.map(c => c.verdict)]), [[PASTA, 2, ['ok']]]);
    assert.equal((await state()).drafts[0].id, s.drafts[0].id, 'migrated once, not on every read');
    assert.equal(stored().drafts[0].id, s.drafts[0].id, 'migration is persisted even before a write action');

    // the file keeps the selected card's lines under `draft`, so an older reader still finds them
    const second = cardOf(await act({ type: 'draft_create', name: 'Toinen' }));
    await act({ type: 'draft_set', productId: COFFEE, qty: 1 });
    assert.deepEqual(stored().draft.map((l: any) => [l.productId, l.qty]), [[COFFEE, 1]]);
    assert.equal(stored().drafts.length, 2);
    await act({ type: 'draft_select', draftId: s.drafts[0].id });
    assert.deepEqual(stored().draft.map((l: any) => [l.productId, l.qty]), [[PASTA, 2]]);
    assert.equal(stored().activeDraft, s.drafts[0].id);

    // a new-format file loads as it is: the cards come back, the mirrored draft does not become another card
    loadState();
    const again = await state();
    assert.deepEqual(again.drafts.map(d => d.id), [s.drafts[0].id, second.id]);
    assert.equal(again.activeDraft, s.drafts[0].id);
  });
});

it('an order in progress locks only its card: edits, deletion and another submission cannot race it', T, async () => {
  for (const type of ['draft_set', 'draft_update', 'draft_delete', 'draft_order'] as const) {
    resetState();
    const card = cardOf(await act({ type: 'draft_set', productId: PASTA, qty: 1 }));
    const other = cardOf(await act({ type: 'draft_create', name: 'Other' }));
    const ordering = act({ type: 'draft_order', draftId: card.id });
    try {
      const action: UiAction = type === 'draft_set' ? { type, draftId: card.id, productId: COFFEE, qty: 2 }
        : type === 'draft_update' ? { type, draftId: card.id, deliveryDate: addDays(today(), 8) }
        : { type, draftId: card.id };
      const e = await refused(() => act(action));
      assert.equal(e.code, 'card_busy', type);
      // A different card remains editable while the first waits for its supplier check.
      await act({ type: 'draft_set', draftId: other.id, productId: COFFEE, qty: 2 });
    } finally { await ordering; }
    assert.deepEqual(S().orders.map(o => o.lines.map(l => [l.productId, l.qty])), [[[PASTA, 1]]]);
    const s = await state();
    assert.deepEqual(s.drafts.map(d => d.id), [other.id]);
    assert.deepEqual(linesOf(s, other.id), [[COFFEE, 2]]);
  }
});

it('a refused order releases its card for correction and retry', T, async () => {
  const card = cardOf(await act({ type: 'draft_set', productId: PASTA, qty: 1 }));
  stub.offers.set(PASTA, { amount: 500 }); // a fresh quote cannot be prepared without a price
  try { await refused(() => act({ type: 'draft_order', draftId: card.id })); }
  finally { stub.offers.delete(PASTA); }
  const changed = await act({ type: 'draft_update', draftId: card.id, name: 'Retry' });
  assert.equal(cardOf(changed).name, 'Retry');
  assert.equal(orderOf(await act({ type: 'draft_order', draftId: card.id })).title, 'Retry');
});

it('recipe choices and blocking notes never fold into old search results', () => {
  const turn = (card: Card) => ({ id: 1, cards: [{ key: 'note:1', card }] });
  assert.equal(isFoldable(turn({ type: 'note', tone: 'info', text: 'Search suggestion' })), true);
  assert.equal(isFoldable(turn({ type: 'note', tone: 'block', text: 'Needs a decision' })), false);
  assert.equal(isFoldable(turn({ type: 'note', tone: 'info', text: 'Choose a recipe', recipeChoices: {
    date: '2026-11-16', options: [{ recipeId: 'lohikeitto', recipeName: 'Salmon soup', why: 'Approved recipe' }],
  } })), false);
});

describe('ingredient search: one structured group per ingredient', () => {
  it('found, choose and none come as data with the reasons; nothing is added or ordered', T, async () => {
    const r = await chat('Tarvitsen mansikkakakun raaka-aineet, kaikki gluteenittomia ja vehnättömiä: jauhoseos, kuohukerma, sokeri, mansikka ja kananmuna');
    const groups = r.cards.filter((c): c is Extract<Card, { type: 'products' }> => c.type === 'products');
    assert.deepEqual(groups.map(g => [g.ingredient?.name, g.ingredient?.status]), [
      ['jauhoseos', 'found'], ['kuohukerma', 'none'], ['sokeri', 'found'], ['mansikka', 'choose'], ['kananmuna', 'choose'],
    ]);
    for (const g of groups) {
      const i = g.ingredient!;
      assert.equal(i.status === 'none', g.items.length === 0, `${i.name}: none exactly when there is nothing verified to offer`);
      assert.ok(g.items.every(a => a.checks.length === 2 && a.checks.every(c => c.verdict === 'ok')), `${i.name}: only verified options`);
      if (i.status === 'found') assert.equal(i.reason, undefined);
      else assert.ok(i.reason && g.subtitle?.includes(i.reason.split('. ')[0]), `${i.name}: the reason is the one in the subtitle`);
    }
    const cream = groups.find(g => g.ingredient?.name === 'kuohukerma')!.ingredient!;
    assert.match(cream.reason!, /wheat-free/);
    assert.match(groups.find(g => g.ingredient?.name === 'mansikka')!.ingredient!.reason!, /Choose the intended product/);
    assert.match(groups.find(g => g.ingredient?.name === 'jauhoseos')!.ingredient!.excluded!, /wheat/, 'products left out by the check are named');
    assert.equal(r.state.drafts.length, 0);
    assert.equal(r.state.orders.length, 0);
    assert.match(r.reply, /selected order draft/);

    const amounts = await chat('Etsi raaka-aineet gluteenittomina ja vehnättöminä: 2 kg jauhoseosta, 1 kg sokeria', 'fi');
    const withAmounts = amounts.cards.filter((c): c is Extract<Card, { type: 'products' }> => c.type === 'products');
    assert.deepEqual(withAmounts.map(g => [g.ingredient?.amount, g.ingredient?.status]), [['2 kg', 'found'], ['1 kg', 'found']]);
    assert.deepEqual(withAmounts.map(g => g.title), ['2 kg · jauhoseosta', '1 kg · sokeria'], 'titles are unchanged');
  });
});

describe('workspace stream (web/src/stream.ts)', () => {
  const user = (cards: Card[], s: DashboardState, prev: ReturnType<typeof resyncTurns>, text = 'next request', inline = false) =>
    applyResponse(prev, { reply: 'ok', cards, state: s }, keyCards(cards), { turnId: prev.length + 100, inline, user: inline ? undefined : text });

  it('a new request folds earlier search turns; order cards, orders and plans never fold', T, async () => {
    const found = await chat('Tarvitsen mansikkakakun raaka-aineet, kaikki gluteenittomia ja vehnättömiä: jauhoseos, sokeri');
    let turns = user(found.cards, found.state, []);
    assert.equal(isFoldable(turns[0]), true);
    assert.equal(turns[0].folded, undefined, 'the newest turn is open');

    // an in-place action (adding to a card) is not a new request: nothing folds
    const sugar = found.cards.flatMap(c => (c.type === 'products' ? c.items : []))[0];
    const added = await act({ type: 'draft_set', productId: sugar.product.id, qty: 1, requirements: sugar.checks.map(c => c.requirement) });
    turns = user(added.cards, added.state, turns, '', true);
    assert.deepEqual(turns.map(t => t.folded), [undefined, undefined]);
    assert.equal(cardKey(added.cards[0]), `draft:${added.state.activeDraft}`, 'each order card has its own key');
    assert.ok(!turns.flatMap(t => t.cards).some(c => c.card.type === 'draft'), 'first add never enters the stream');

    const order = await chat('Tilaa 10 litraa laktoositonta maitoa maanantaiksi');
    turns = user(order.cards, order.state, turns, 'Tilaa 10 litraa laktoositonta maitoa maanantaiksi');
    assert.deepEqual(turns.map(t => t.folded), [true, undefined], 'only the search turn folded');
    assert.ok(order.state.orders.some(o => o.status === 'pending_approval'));

    const again = await chat('Etsi raaka-aineet: sokeri');
    turns = user(again.cards, again.state, turns, 'Etsi raaka-aineet: sokeri');
    assert.deepEqual(turns.map(t => [isFoldable(t), t.folded]), [[true, true], [false, undefined], [true, undefined]],
      'the order waiting for approval stays open; the draft is not in the stream');

    // an order card that was ordered or deleted leaves the stream on the next sync
    await act({ type: 'draft_delete', draftId: added.state.activeDraft! });
    const synced = resyncTurns(turns, await state());
    assert.ok(!synced.some(t => t.cards.some(c => c.card.type === 'draft')));
    assert.equal(synced.find(t => t.cards.some(c => c.card.type === 'order'))?.folded, undefined);
  });
});
