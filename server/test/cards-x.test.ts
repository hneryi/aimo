// Dishes as cards with an X: a dish card is removed with its X and comes back from the "removed dishes" list in its
// own place; the whole menu can be removed (clear_menu, undoable: the menu and its shopping list come back exactly,
// also with undo steps stored before this existed); removing the last dish takes the menu with it; the workspace drops
// everything of a removed menu and shows the welcome view when nothing else is left; closing a result only hides it;
// the picker's Enter rule; the kitchen's own dish orders nothing by itself and its wholesaler products keep the checked
// diet; event menus speak of dishes, not days; the new texts exist in three languages.
//
// Offline like the other tests: a local stub of the Valio Aimo mock, no language model, the real challenge catalog,
// the sample menus and a temporary state file.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { Card, Lang, TurnResponse, UiAction } from '../../shared/types.ts';
import type { Turn } from '../../web/src/stream.ts';
import { startStub } from './mock-stub.ts';

const supplier = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-cards-x-'));
const STATE_FILE = join(dir, 'state.json');
Object.assign(process.env, {
  VALIO_BASE_URL: supplier.url, VALIO_API_KEY: 'offline-test', STATE_FILE, DATA_DIR: dir, AGENT_TOKEN: 'offline-cards-x',
  VERDA_API_KEY: '', VERDA_BASE_URL: supplier.url, APPROVERS: '', CUTOFF_MODE: 'warn', // no model: keyword rules only
});

const { loadCatalog } = await import('../src/catalog.ts');
const { loadState, pick, resetState, S } = await import('../src/store.ts');
const { handleAction, handleChat, stateView } = await import('../src/app.ts');
const { lineAlternatives, searchWithChecks, UserError } = await import('../src/planner.ts');
const { UNDOABLE, snapshot } = await import('../src/undo.ts');
const { importMenu } = await import('../src/menuImport.ts');
const { filterRecipes, menuCardDays, pickerEnter, recipeOptions, shownDish } = await import('../../web/src/recipeOptions.ts');
const { MENU_EDITS, PLAN_EDITS } = await import('../../web/src/changes.ts');
const { applyResponse, closeTurn, isClosable, keyCards, resyncTurns, seedTurns, tidyTurns } = await import('../../web/src/stream.ts');
const { makeT } = await import('../../web/src/i18n.ts');

loadCatalog();
loadState();
after(async () => {
  await supplier.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => resetState());

const T = { timeout: 120_000 };
const act = (a: UiAction, lang: Lang = 'fi') => handleAction(a, lang);
const days = () => S().menu!.days;
const MON = 0, WED = 2, FRI = 4;
const lastAudit = () => S().audit[S().audit.length - 1];
const EVENT = 'Alkumalja: Alkoholiton kuohujuoma\nPääruoka: Karjalanpaisti\nJälkiruoka: Mansikkakakku';
async function refused(run: () => Promise<unknown>, re: RegExp) {
  await assert.rejects(run, (e: unknown) => e instanceof UserError && re.test(e.text.en));
}
/** sample menu, Friday's recipe confirmed, 350 portions with 20 gluten-free and 8 wheat-free */
async function demo(): Promise<TurnResponse> {
  await act({ type: 'load_demo_menu' });
  await act({ type: 'confirm_recipe', date: days()[FRI].id, recipeId: 'lohikeitto' });
  return act({ type: 'set_portions', total: 350, groups: [{ requirement: 'gluten_free', count: 20 }, { requirement: 'wheat_free', count: 8 }] });
}
/** everything clear_menu must leave as it was */
const kept = () => structuredClone({
  orders: S().orders, drafts: S().drafts, activeDraft: S().activeDraft, kitchen: S().kitchen, overrides: S().overrides, swaps: S().swaps,
  agents: S().agents, quotes: S().quotes, stock: S().stock,
});
/** a plan or menu without the moments it was computed or the offers observed */
const timeless = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'createdAt' || k === 'observedAt' ? undefined : v)));

describe('B1: clear_menu removes the menu; everything else stays', () => {
  it('removes the menu and its shopping-list edits; orders, drafts, portions, memory and approved replacements stay', T, async () => {
    const r0 = await demo();
    // an approved replacement and a product switch, both remembered by the kitchen
    const issue = r0.state.plan!.issues.find(i => !i.resolved && i.kind.startsWith('allergen') && i.alternatives?.length)!;
    await act({ type: 'resolve_issue', issueId: issue.id, productId: issue.alternatives![0].product.id });
    let plan = (await act({ type: 'show_plan' })).state.plan!;
    const macaroni = plan.lines.find(l => l.checks.length === 0 && l.ingredient === 'Makaroni')!;
    const to = (await lineAlternatives('fi', plan, macaroni.id))!.items[0].product.id;
    await act({ type: 'swap_line', lineId: macaroni.id, productId: to });
    // a hand-set quantity, a removed line and a left-out item belong to this menu's shopping list
    plan = (await act({ type: 'show_plan' })).state.plan!;
    const [a, b] = plan.lines.filter(l => l.orderQty > 0 && l.id !== to);
    await act({ type: 'set_line_qty', lineId: a.id, qty: a.orderQty + 2 });
    await act({ type: 'remove_line', lineId: b.id });
    const open = (await act({ type: 'show_plan' })).state.plan!.issues.find(i => !i.resolved && i.kind.startsWith('allergen'))!;
    await act({ type: 'skip_issue', issueId: open.id });
    assert.ok(S().skipped.length && S().edits.removed.length && Object.keys(S().edits.qty).length);
    // an order and an order draft
    await handleChat('Tilaa 20 kg riisiä perjantaiksi', 'fi');
    await act({ type: 'draft_set', productId: '460325', qty: 1, requirements: ['gluten_free', 'wheat_free'] });
    assert.equal(S().orders.length, 1); assert.equal(S().drafts?.length, 1);
    assert.ok(Object.keys(S().overrides).length && Object.keys(S().swaps).length && S().kitchen.memory.length);
    const keep = kept(), steps = S().undo.length;

    const r = await act({ type: 'clear_menu' });
    assert.equal(S().menu, undefined);
    assert.deepEqual(S().edits, { qty: {}, removed: [] });
    assert.deepEqual(S().skipped, [], 'left-out items go with the shopping list, as on an import');
    assert.deepEqual(kept(), keep, 'orders, drafts, portions and diet groups, memory, approved replacements, switches, agents and limits stay');
    assert.equal(r.state.menu, undefined); assert.equal(r.state.plan, undefined);
    assert.deepEqual(r.cards, [], 'nothing of the menu is shown');
    assert.equal(r.state.orders.length, 1); assert.equal(r.state.drafts.length, 1);
    assert.equal(r.reply, 'Poistin ruokalistan ja sen ostoslistan. Tilaukset, tilausluonnokset ja annosmäärät säilyvät. Voit kumota poiston.');
    assert.equal(S().undo.length, steps + 1, 'one undo step');
    assert.equal(r.state.undo!.label, 'Ruokalista poistettu');
    assert.equal(lastAudit().action, 'clear_menu');
    assert.match(lastAudit().text.fi, /^Ruokalista poistettu: Viikko 47.* \(5 ruokalajia\)\. Tilaukset, tilausluonnokset, annosmäärät ja keittiön muisti säilyivät\.$/);
    assert.match(lastAudit().text.en, /^Menu removed: .*\(5 dishes\)\. Orders, order drafts, portions and the kitchen’s memory were kept\.$/);
    // without a menu there is nothing to remove: refused, and no step is added
    const audits = S().audit.length;
    await refused(() => act({ type: 'clear_menu' }), /There is no menu to remove/);
    assert.equal(S().undo.length, steps + 1);
    assert.equal(S().audit.length, audits);
    assert.match((await act({ type: 'show_plan' }, 'sv')).state.undo!.label, /^Matsedeln borttagen$/);
  });

  it('undo brings back the whole menu and its shopping list exactly', T, async () => {
    await demo();
    await act({ type: 'skip_day', date: days()[WED].id });
    const r0 = await act({ type: 'set_custom_dish', date: days()[3].id, name: 'Pizza' });
    // line edits on lines that the remaining dishes still need
    const line = r0.state.plan!.lines.find(l => l.orderQty > 0)!;
    await act({ type: 'set_line_qty', lineId: line.id, qty: line.orderQty + 4 });
    await act({ type: 'remove_line', lineId: r0.state.plan!.lines.find(l => l.id !== line.id)!.id });
    const before = await act({ type: 'show_plan' });
    const menu = structuredClone(S().menu), snap = snapshot(), steps = S().undo.length, orders = structuredClone(S().orders);
    await act({ type: 'clear_menu' });
    const back = await act({ type: 'undo' });
    assert.deepEqual(S().menu, menu, 'the stored menu is exactly as it was');
    assert.deepEqual(snapshot(), snap, 'and the whole editing state');
    assert.equal(S().undo.length, steps);
    assert.deepEqual(S().orders, orders);
    assert.deepEqual(back.state.menu, before.state.menu, 'the menu card is the same');
    assert.deepEqual(timeless(back.state.plan), timeless(before.state.plan), 'the same shopping list: lines, quantities, removed lines, questions, not covered');
    assert.ok(back.state.plan!.removedLines?.length && back.state.plan!.lines.some(l => l.calculatedQty !== undefined));
    assert.match(back.reply, /^Kumottu: Ruokalista poistettu\./);
    assert.ok(back.cards.some(c => c.type === 'menu') && back.cards.some(c => c.type === 'plan'), 'the menu and its shopping list are shown again');
  });

  it('an undo step stored before menus could be removed (no whole menu in it) still restores; old state files load', T, async () => {
    await act({ type: 'load_demo_menu' });
    await act({ type: 'skip_day', date: days()[MON].id });
    // the step as an older version stored it: entry choices only
    const file = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    delete file.profiles.school.undo.at(-1).before.menu;
    writeFileSync(STATE_FILE, JSON.stringify(file));
    loadState();
    assert.equal(S().undo.at(-1)!.before.menu, undefined);
    // a new step on top of it (the whole menu removed), then both are taken back in turn
    await act({ type: 'clear_menu' });
    await act({ type: 'undo' });
    assert.equal(days()[MON].match, 'skipped', 'the menu is back as it was when it was removed');
    await act({ type: 'undo' });
    assert.equal(days()[MON].match, 'confirmed');
    assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
    assert.equal(days()[MON].removed, undefined);
    assert.equal(S().undo.length, 0);
  });
});

describe('A3: removing the last dish removes the whole menu', () => {
  it('says so, keeps orders and drafts, and undo brings back the menu as it was before the last removal', T, async () => {
    await importMenu(Buffer.from(EVENT), 'event.txt');
    const ids = days().map(d => d.id);
    const r1 = await act({ type: 'skip_day', date: ids[0] });
    assert.ok(r1.state.menu, 'dishes are left: the menu stays');
    await act({ type: 'skip_day', date: ids[1] });
    const beforeLast = structuredClone(S().menu), lastMatch = days()[2].match;
    const r = await act({ type: 'skip_day', date: ids[2] });
    assert.equal(S().menu, undefined); assert.equal(r.state.menu, undefined); assert.equal(r.state.plan, undefined);
    assert.deepEqual(r.cards, []);
    assert.equal(r.reply, 'Poistit viimeisen ruokalajin, joten poistin koko ruokalistan. Tilaukset, tilausluonnokset ja annosmäärät säilyvät. Voit kumota poiston.');
    assert.equal(r.state.undo!.label, 'Viimeinen ruokalaji ja ruokalista poistettu');
    assert.deepEqual(S().audit.slice(-2).map(x => x.action), ['skip_day', 'clear_menu']);
    assert.match(lastAudit().text.fi, /^Viimeinenkin ruokalaji poistettiin, joten ruokalista poistettiin: .* \(3 ruokalajia\)/);
    const back = await act({ type: 'undo' });
    assert.deepEqual(S().menu, beforeLast, 'the menu as it was before the last removal');
    assert.deepEqual(back.state.menu!.days.map(d => d.match), ['skipped', 'skipped', lastMatch]);
    assert.ok(back.cards.some(c => c.type === 'menu'));

    // the same in Swedish and English
    for (const [lang, reply, label] of [
      ['sv', /^Du tog bort den sista rätten, så jag tog bort hela matsedeln\. Order, beställningsutkast och portioner finns kvar\. Du kan ångra borttagningen\.$/, 'Sista rätten och matsedeln borttagna'],
      ['en', /^You removed the last dish, so I removed the whole menu\. Orders, order drafts and portions are kept\. You can undo the removal\.$/, 'Last dish and the menu removed'],
    ] as const) {
      const last = await act({ type: 'skip_day', date: ids[2] }, lang);
      assert.match(last.reply, reply); assert.equal(last.state.undo!.label, label);
      await act({ type: 'undo' }, lang);
    }
    // removing an already removed dish changes nothing, also when every dish is removed
    assert.ok(S().menu);
    await act({ type: 'skip_day', date: ids[0] });
    assert.ok(S().menu);
  });
});

describe('A2: a removed dish leaves the cards for the removed list and comes back to its own place', () => {
  it('lists it in menu order, keeps the not-covered note on the shopping list, and restores it in place', T, async () => {
    await act({ type: 'load_demo_menu' });
    const order = days().map(d => d.id);
    const wed = (await act({ type: 'show_menu' })).state.menu!.days[WED];
    const r = await act({ type: 'skip_day', date: order[WED] });
    const { shown, removed } = menuCardDays(r.state.menu!.days);
    assert.deepEqual(shown.map(d => d.id), [order[0], order[1], order[3], order[4]], 'the removed dish is not a card any more');
    assert.deepEqual(removed.map(d => [d.id, shownDish(d)]), [[order[WED], shownDish(wed)]], 'the list names the dish');
    assert.equal(r.reply.split('. ').slice(0, 2).join('. ') + '.', 'Selvä, poistin ruokalajin: tälle päivälle ei tilata mitään. Voit palauttaa sen ruokalistan lopusta.');
    assert.deepEqual(r.state.plan!.notCovered?.map(x => [x.date, x.kind]), [[order[WED], 'skipped']], 'the shopping list still says it');
    const back = await act({ type: 'restore_day', date: order[WED] });
    assert.deepEqual(menuCardDays(back.state.menu!.days).shown.map(d => d.id), order, 'back in its own place');
    assert.deepEqual(menuCardDays(back.state.menu!.days).removed, []);
    assert.equal(back.state.menu!.days[WED].match, wed.match);
  });
});

describe('B2/E: the workspace (web/src/stream.ts)', () => {
  it('drops the menu, its shopping list, questions, recipe choices and comparisons; searches and orders stay', T, async () => {
    const r0 = await demo();
    await handleChat('Tilaa 20 kg riisiä perjantaiksi', 'fi');
    const s0 = (await act({ type: 'show_plan' })).state;
    const plan = s0.plan!, menu = s0.menu!, order = s0.orders[0];
    const open = plan.issues.find(i => !i.resolved)!;
    const done = { ...open, resolved: true, resolution: 'ok' };
    const choices: Card = { type: 'note', tone: 'info', text: 'Valitse', recipeChoices: { date: menu.days[MON].id, options: [] } };
    const plain: Card = { type: 'note', tone: 'info', text: 'Hyvä tietää' };
    const cmp: Card = { type: 'comparison', title: 'Vaihtoehdot', lineId: plan.lines[0].id, items: [] };
    const products: Card = { type: 'products', title: 'Sokeri', items: [] };
    const turns: Turn[] = [
      { id: 1, user: 'Kokeile', reply: 'Luin', cards: keyCards([{ type: 'menu', menu }, { type: 'issue', issue: open }]) },
      { id: 2, reply: 'Ostoslista', cards: keyCards([{ type: 'issue', issue: done }, { type: 'plan', plan }]) },
      { id: 3, user: 'suosittele', reply: 'Ehdotus', cards: keyCards([choices]) },
      { id: 4, user: 'halvempi', reply: 'Vertailu', cards: keyCards([cmp]) },
      { id: 5, user: 'Etsi raaka-aineet: sokeri', reply: 'Haku', cards: keyCards([products, plain]) },
      { id: 6, user: 'Tilaa', reply: 'Tilaus', cards: keyCards([{ type: 'order', order }]) },
      { id: 7, reply: 'Selvä', cards: [], quiet: true },
    ];
    // before the removal every card is still current
    assert.deepEqual(resyncTurns(turns, s0).map(t => t.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(r0);

    const r = await act({ type: 'clear_menu' });
    const after = applyResponse(turns, r, keyCards(r.cards), { turnId: 8, inline: true });
    assert.deepEqual(after.map(t => t.id), [5, 6, 8], 'the search and the order stay; the new quiet reply replaces the old one');
    const types = after.flatMap(t => t.cards.map(c => c.card.type));
    assert.deepEqual(types, ['products', 'note', 'order']);
    assert.ok(!after.some(t => t.cards.some(c => c.card.type === 'note' && c.card.recipeChoices)), 'recipe choices for a removed menu go');

    // nothing else on the stream: the welcome view, no quiet reply left behind
    const menuOnly = turns.filter(t => t.id <= 4 || t.id === 7);
    assert.deepEqual(applyResponse(menuOnly, r, keyCards(r.cards), { turnId: 9, inline: true }), []);
    assert.deepEqual(resyncTurns(menuOnly, r.state), [], 'the same after a background refresh');
    assert.deepEqual(tidyTurns([{ id: 10, reply: 'x', cards: [], quiet: true }]), []);
    // after a reload only the order is there to resume
    assert.deepEqual(seedTurns(r.state)[0].cards.map(c => c.key), [`order:${order.id}`]);
  });

  it('closing hides a result only; the menu, its shopping list and questions have no X; the last close shows the welcome', T, async () => {
    const s = (await demo()).state;
    const plan = s.plan!, menu = s.menu!;
    const issue = plan.issues.find(i => !i.resolved)!;
    const t = (id: number, cards: Card[], extra: Partial<Turn> = {}): Turn => ({ id, reply: 'r', cards: keyCards(cards), ...extra });
    assert.equal(isClosable(t(1, [{ type: 'menu', menu }])), false);
    assert.equal(isClosable(t(2, [{ type: 'plan', plan }])), false);
    assert.equal(isClosable(t(3, [{ type: 'issue', issue }])), false);
    assert.equal(isClosable(t(4, [{ type: 'products', title: 'x', items: [] }, { type: 'issue', issue }])), false, 'a turn with a question in it stays');
    for (const card of [
      { type: 'products', title: 'x', items: [] }, { type: 'note', tone: 'info', text: 'x' }, { type: 'comparison', title: 'x', items: [] },
      { type: 'portions', kitchen: s.kitchen }, { type: 'audit', entries: [] },
    ] as Card[]) assert.ok(isClosable(t(5, [card])), card.type);
    assert.ok(isClosable({ id: 6, user: 'x', error: 'virhe', cards: [] }), 'a plain reply or an error');
    const turns = [t(1, [{ type: 'menu', menu }]), t(5, [{ type: 'products', title: 'x', items: [] }], { folded: true }), t(7, [], { quiet: true })];
    assert.deepEqual(closeTurn(turns, 5).map(x => x.id), [1, 7]);
    assert.deepEqual(closeTurn(turns, 1), turns, 'the menu cannot be closed');
    assert.deepEqual(closeTurn(turns.slice(1), 5), [], 'closing the last result shows the welcome view, also with a quiet reply left');
  });
});

describe('C: the picker and the kitchen’s own dish', () => {
  it('Enter: an exact name or the only match picks the recipe; no match searches the wholesaler; several do nothing', T, async () => {
    await act({ type: 'load_demo_menu' });
    const state = await stateView('fi');
    const options = recipeOptions(state, days()[MON].id);
    const enter = (q: string) => pickerEnter(filterRecipes(options, q), q);
    assert.deepEqual(enter('Lohikeitto'), { kind: 'recipe', id: 'lohikeitto' }, 'exact name');
    assert.deepEqual(enter('LAXSOPPA'), { kind: 'recipe', id: 'lohikeitto' }, 'exact name in another language');
    assert.deepEqual(enter('lohi'), { kind: 'recipe', id: 'lohikeitto' }, 'the only match');
    assert.deepEqual(enter('  Pizza \t margherita '), { kind: 'wholesale', name: 'Pizza margherita' }, 'no match: the wholesaler, tidied name');
    assert.equal(filterRecipes(options, 'Pizza margherita').exact, undefined, 'the button shows for the same name');
    assert.ok(filterRecipes(options, 'a').items.length > 1);
    assert.deepEqual(enter('a'), { kind: 'none' }, 'several matches: nothing happens');
    assert.deepEqual(enter('   '), { kind: 'none' });
    assert.equal((enter('x'.repeat(70)) as { name: string }).name.length, 60, 'at most the server’s 60 characters');
    // an event row without a role has no recipes to pick: Enter makes it an own dish, which needs no role
    resetState();
    await importMenu(Buffer.from(EVENT + '\nAlkuruoka: Tuntematon ruoka'), 'event.txt');
    const ev = await stateView('fi');
    assert.deepEqual(recipeOptions(ev, days()[3].id), []);
    assert.deepEqual(pickerEnter(filterRecipes([], 'Lohikeitto'), 'Lohikeitto'), { kind: 'wholesale', name: 'Lohikeitto' });
  });

  it('the own dish orders nothing by itself; wholesaler products carry the checked diet and an unverified one is refused', T, async () => {
    await demo();
    const r = await act({ type: 'set_custom_dish', date: days()[MON].id, name: 'Pizza' });
    assert.equal(days()[MON].match, 'custom');
    assert.equal(r.state.drafts.length, 0, 'nothing is added to a draft');
    assert.equal(r.state.orders.length, 0, 'nothing is ordered');
    assert.match(r.reply, /^Merkitsin oman ruokalajin\. Sille ei ole reseptiä, joten en laske sille määriä enkä tilaa tälle päivälle mitään automaattisesti\. Tuotteet voit hakea tukusta päivän kortissa\./);
    // the same search the dish card makes (GET /api/products/search uses searchWithChecks, at most 8 products)
    const week = S().menu!.weekStart;
    const items = await searchWithChecks('jauho', ['gluten_free'], 'fi', week);
    const wheat = await searchWithChecks('vehnäjauho', ['gluten_free'], 'fi', week);
    for (const list of [items, wheat]) {
      assert.ok(list.length > 0 && list.length <= 8);
      assert.ok(list.every(a => a.checks.length === 1 && a.checks[0].requirement === 'gluten_free'), 'every product is checked for the chosen diet');
    }
    const bad = wheat.find(a => a.checks[0].verdict !== 'ok');
    const good = items.find(a => a.checks[0].verdict === 'ok' && a.offer.price !== undefined);
    assert.ok(bad && good, [...items, ...wheat].map(a => `${a.product.name}: ${a.checks[0].verdict}`).join('; '));
    await refused(() => act({ type: 'draft_set', productId: bad.product.id, qty: bad.product.lotStep ?? 1, requirements: ['gluten_free'] }), /I cannot add/);
    assert.equal(S().drafts, undefined, 'a refused product never creates a draft');
    const added = await act({ type: 'draft_set', productId: good.product.id, qty: good.product.lotStep ?? 1, requirements: ['gluten_free'] });
    assert.deepEqual(added.state.drafts[0].lines.map(l => [l.product.id, l.checks.map(c => [c.requirement, c.verdict])]), [[good.product.id, [['gluten_free', 'ok']]]]);
    // without a chosen diet nothing is checked, and the product carries no requirement
    const plain = await searchWithChecks('jauho', [], 'fi', S().menu!.weekStart);
    assert.ok(plain.every(a => a.checks.length === 0));
  });
});

describe('D2: event menus speak of dishes, not days', () => {
  it('the replies, the log and the texts for an event row say dish; weekly menus keep the day', T, async () => {
    await importMenu(Buffer.from(EVENT + '\nAlkuruoka: Tuntematon ruoka'), 'event.txt');
    const row = days()[3];
    const expected = {
      fi: ['Selvä, poistin ruokalajin: sille ei tilata mitään. Voit palauttaa sen menun lopusta.', 'Tuotteet voit hakea tukusta ruokalajin kortissa.', 'sille ei tilata mitään'],
      sv: ['Okej, jag tog bort rätten: inget beställs för den. Du kan återställa den längst ner i menyn.', 'Produkter kan du söka i grossistens sortiment på rättens kort.', 'inget beställs för den'],
      en: ['Got it, I removed the dish: nothing will be ordered for it. You can restore it at the end of the menu.', 'You can find products from the wholesaler on the dish’s card.', 'nothing is ordered for it'],
    } as const;
    for (const lang of ['fi', 'sv', 'en'] as const) {
      const [removedText, customTail, auditText] = expected[lang];
      const custom = await act({ type: 'set_custom_dish', date: row.id, name: 'Graavilohileivät' }, lang);
      assert.ok(custom.reply.includes(customTail), `${lang}: ${custom.reply}`);
      assert.doesNotMatch(custom.reply, /tälle päivälle|för dagen|for that day/);
      const removed = await act({ type: 'skip_day', date: row.id }, lang);
      assert.ok(removed.reply.startsWith(removedText), `${lang}: ${removed.reply}`);
      assert.ok(pick(lang, lastAudit().text).endsWith(auditText), pick(lang, lastAudit().text));
      await act({ type: 'restore_day', date: row.id }, lang);
    }
    // the portions question of an event asks for guests, not lunches a day
    assert.match((await act({ type: 'show_plan' })).reply, /montako vierasta ja mitkä erityisruokavaliot\?/);
    await refused(() => act({ type: 'skip_day', date: 'nope' }), /^Dish not found\.$/);
    // the UI's texts for event rows
    for (const lang of ['fi', 'sv', 'en'] as const) {
      const t = makeT(lang);
      for (const text of [t('plan.notCoveredEvent'), t('custom.note'), t('picker.wholesaleHint')]) assert.doesNotMatch(text, /päiv|\bdag|\bday\b/i, text);
    }
    // a weekly menu keeps its day wording
    resetState();
    await act({ type: 'load_demo_menu' });
    await refused(() => act({ type: 'skip_day', date: 'nope' }), /^Day not found\.$/);
    const weekly = await act({ type: 'skip_day', date: days()[MON].id });
    assert.ok(weekly.reply.startsWith('Selvä, poistin ruokalajin: tälle päivälle ei tilata mitään.'));
    assert.equal(makeT('fi')('plan.notCovered'), 'Tämä tilaus ei kata näitä päiviä:');
  });
});

describe('the rules and texts the UI relies on', () => {
  it('clear_menu is an undoable menu edit that keeps the view in place', () => {
    assert.ok(UNDOABLE.includes('clear_menu') && PLAN_EDITS.has('clear_menu') && MENU_EDITS.has('clear_menu'));
  });

  it('the new texts exist in Finnish, Swedish and English with the same placeholders', () => {
    const KEYS = [
      'day.removeAria', 'menu.removeAria', 'menu.removeHint', 'menu.removed', 'menu.restoreAria', 'dishSearch.title', 'dishSearch.label',
      'dishSearch.go', 'dishSearch.diet', 'dishSearch.dietNone', 'dishSearch.dietHint', 'dishSearch.noDietCheck', 'dishSearch.searching',
      'dishSearch.none', 'dishSearch.results', 'dishSearch.resultsChecked', 'startOver', 'startOver.hint', 'startOver.done', 'startOver.cleared',
      'turn.closeWhat', 'turn.close.hint', 'picker.wholesale', 'picker.wholesaleHint', 'plan.notCoveredEvent', 'custom.note',
    ] as const;
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const key of KEYS) {
      const [fi, sv, en] = (['fi', 'sv', 'en'] as const).map(l => makeT(l)(key));
      assert.ok(fi && fi !== key, key);
      assert.ok(sv && en && sv !== fi && en !== fi && sv !== en, `${key}: translated`);
      assert.deepEqual(holes(sv), holes(fi), `${key} sv`); assert.deepEqual(holes(en), holes(fi), `${key} en`);
    }
    assert.equal(makeT('fi')('picker.wholesale', { name: 'Pizza' }), 'Hae tukusta: ”Pizza”');
    assert.equal(makeT('sv')('picker.wholesale', { name: 'Pizza' }), 'Sök hos grossisten: ”Pizza”');
    assert.equal(makeT('en')('picker.wholesale', { name: 'Pizza' }), 'Find from the wholesaler: “Pizza”');
    assert.equal(makeT('fi')('day.removeAria', { name: 'Maanantai 16.11.' }), 'Poista ruokalaji: Maanantai 16.11.');
    assert.equal(makeT('fi')('menu.removeAria'), 'Poista ruokalista');
    assert.equal(makeT('fi')('menu.removed', { n: 2 }), 'Poistetut ruokalajit (2)');
    assert.equal(makeT('fi')('startOver'), 'Aloita alusta');
  });
});
