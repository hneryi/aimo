// "You can always change your mind": every plan choice has its own way back before the order is placed. Removing and
// restoring a menu dish (recipe, own dish, suggestion, missing, and entries removed by an older version), the kitchen's
// own dish, the picker's search rule, removed shopping-list lines, reopening resolved allergen items, removing a diet
// group, undo for every new edit, and the order card's buttons (only what the server allows).
//
// Offline like the other tests: a local stub of the Valio Aimo mock, no language model, the real challenge catalog,
// the sample menu and a temporary state file.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { DashboardState, Issue, Lang, Order, TurnResponse, UiAction } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const supplier = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-change-'));
const STATE_FILE = join(dir, 'state.json');
Object.assign(process.env, {
  VALIO_BASE_URL: supplier.url, VALIO_API_KEY: 'offline-test', STATE_FILE, DATA_DIR: dir, AGENT_TOKEN: 'offline-change',
  VERDA_API_KEY: '', VERDA_BASE_URL: supplier.url, APPROVERS: '', CUTOFF_MODE: 'warn', // no model: keyword rules only
});

const { loadCatalog } = await import('../src/catalog.ts');
const { loadState, resetState, S } = await import('../src/store.ts');
const { handleAction, handleChat, stateView } = await import('../src/app.ts');
const { lineAlternatives, UserError } = await import('../src/planner.ts');
const { matchRecipe, recipesForRole } = await import('../src/recipes.ts');
const { UNDOABLE, snapshot } = await import('../src/undo.ts');
const { importMenu } = await import('../src/menuImport.ts');
const { isIngredientRequest } = await import('../../shared/ingredientIntent.ts');
const { filterRecipes, normText, recipeOptions, shownDish, tidyDishName } = await import('../../web/src/recipeOptions.ts');
const { MENU_EDITS, PLAN_EDITS, canReopen, orderActions, portionGroups, undoRecorded } = await import('../../web/src/changes.ts');
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
const chat = (m: string, lang: Lang = 'fi') => handleChat(m, lang);
const days = () => S().menu!.days;
const MON = 0, FRI = 4; // sample menu: macaroni casserole … ; Friday "Kalakeitto" is a suggestion (salmon soup)
const viewDay = (r: TurnResponse, i: number) => r.state.menu!.days[i];
const openBlocking = (r: TurnResponse) => r.state.plan!.issues.filter(i => !i.resolved && i.severity === 'block');
const allergenOpen = (r: TurnResponse) => openBlocking(r).filter(i => i.kind.startsWith('allergen'));
const issuesFor = (r: TurnResponse, entry: string) => r.state.plan!.issues.filter(i => i.date === entry);
const lastAudit = () => S().audit[S().audit.length - 1];
async function refused(run: () => Promise<unknown>, re: RegExp) {
  await assert.rejects(run, (e: unknown) => e instanceof UserError && re.test(e.text.en));
}
/** sample menu, Friday's recipe confirmed, 350 portions with 20 gluten-free and 8 wheat-free */
async function demo(): Promise<TurnResponse> {
  await act({ type: 'load_demo_menu' });
  await act({ type: 'confirm_recipe', date: days()[FRI].id, recipeId: 'lohikeitto' });
  return act({ type: 'set_portions', total: 350, groups: [{ requirement: 'gluten_free', count: 20 }, { requirement: 'wheat_free', count: 8 }] });
}

describe('A: a menu dish can be removed and restored exactly as it was', () => {
  it('a confirmed recipe comes back with its recipe and lines; the removed day orders nothing and is not blocking', T, async () => {
    await act({ type: 'load_demo_menu' });
    const id = days()[MON].id;
    const removed = await act({ type: 'skip_day', date: id });
    assert.equal(days()[MON].match, 'skipped');
    assert.equal(days()[MON].recipeId, undefined, 'a removed day links no recipe');
    assert.deepEqual(days()[MON].removed, { match: 'confirmed', recipeId: 'lihamakaronilaatikko' }, 'the earlier choice is kept');
    assert.equal(viewDay(removed, MON).removedDish, 'Lihamakaronilaatikko', 'the restore button can name what comes back');
    assert.ok(!removed.state.plan!.lines.some(l => l.ingredient === 'Makaroni'), 'nothing is ordered for the removed day');
    assert.equal(issuesFor(removed, id).length, 0, 'removing is never a blocking question');
    assert.deepEqual(removed.state.plan!.notCovered, [{ date: id, day: 'ma 16.11.', name: 'Lihamakaronilaatikko', kind: 'skipped' }]);
    assert.equal(lastAudit().action, 'skip_day');
    assert.match(lastAudit().text.fi, /poistettu, tälle päivälle ei tilata mitään/);
    // removing twice keeps what the restore brings back
    await act({ type: 'skip_day', date: id });
    assert.equal(days()[MON].removed?.recipeId, 'lihamakaronilaatikko');

    const back = await act({ type: 'restore_day', date: id });
    assert.equal(days()[MON].match, 'confirmed');
    assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
    assert.equal(days()[MON].removed, undefined);
    assert.ok(back.state.plan!.lines.some(l => l.ingredient === 'Makaroni'), 'the recipe’s lines are back');
    assert.equal(back.state.plan!.notCovered, undefined);
    assert.match(back.reply, /Palautin ruokalajin: Lihamakaronilaatikko/);
    assert.equal(lastAudit().action, 'restore_day');
    await refused(() => act({ type: 'restore_day', date: id }), /has not been removed/);
  });

  it('the kitchen’s own dish, a suggestion and a missing dish each come back as they were', T, async () => {
    await act({ type: 'load_demo_menu' });
    const mon = days()[MON].id, fri = days()[FRI].id;
    await act({ type: 'set_custom_dish', date: mon, name: 'Hampurilainen' });
    await act({ type: 'skip_day', date: mon });
    const r = await act({ type: 'skip_day', date: fri });
    assert.equal(viewDay(r, MON).removedDish, 'Hampurilainen');
    assert.equal(viewDay(r, FRI).removedDish, 'Kalakeitto', 'a suggestion is named by the imported dish');
    assert.ok(!issuesFor(r, fri).length, 'the removed suggestion asks nothing');
    await act({ type: 'restore_day', date: mon });
    assert.equal(days()[MON].match, 'custom'); assert.equal(days()[MON].customName, 'Hampurilainen');
    const sug = await act({ type: 'restore_day', date: fri });
    assert.equal(days()[FRI].match, 'suggested'); assert.equal(days()[FRI].suggestion?.recipeId, 'lohikeitto');
    assert.ok(issuesFor(sug, fri).some(i => i.kind === 'suggested_recipe' && i.severity === 'block' && !i.resolved), 'the question is back');

    resetState();
    await importMenu(Buffer.from('maanantai: Tuntematon ruoka\ntiistai: Lohikeitto'), 'menu.txt');
    const unknown = days()[0].id;
    await act({ type: 'skip_day', date: unknown });
    const missing = await act({ type: 'restore_day', date: unknown });
    assert.equal(days()[0].match, 'missing');
    assert.ok(issuesFor(missing, unknown).some(i => i.kind === 'missing_recipe' && i.severity === 'block'), 'still needs an answer');
  });

  it('an entry removed by an older version (no stored choice) is linked again like the import does, with the role rules', T, async () => {
    await act({ type: 'load_demo_menu' });
    // an older state file: skipped, recipe forgotten, no stored choice
    const file = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const day = file.profiles.school.menu.days[MON];
    day.match = 'skipped'; delete day.recipeId; delete day.removed; delete day.customName;
    // (an older step has no whole menu either: `menu: undefined` is dropped when the file is written)
    file.profiles.school.undo = [{ at: day.date, label: { fi: 'vanha', sv: 'gammal', en: 'old' }, before: { ...snapshot(), menu: undefined, days: [{ id: day.id, match: 'confirmed', recipeId: 'lihamakaronilaatikko' }] } }];
    writeFileSync(STATE_FILE, JSON.stringify(file));
    loadState();
    const loaded = await act({ type: 'show_plan' });
    assert.equal(viewDay(loaded, MON).match, 'skipped');
    assert.equal(viewDay(loaded, MON).removedDish, 'Lihamakaronilaatikko', 'the imported dish is named');
    const back = await act({ type: 'restore_day', date: days()[MON].id });
    assert.equal(days()[MON].match, 'confirmed'); assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
    assert.ok(back.state.plan!.lines.some(l => l.ingredient === 'Makaroni'));
    // an old undo step (without the new fields) still restores
    while (S().undo.length) await act({ type: 'undo' });
    assert.equal(days()[MON].match, 'confirmed'); assert.equal(days()[MON].customName, undefined); assert.equal(days()[MON].removed, undefined);

    // event menu: roles decide, an exact recipe of another role is never linked for quantities
    resetState();
    await importMenu(Buffer.from('Alkumalja: Alkoholiton kuohujuoma\nPääruoka: Karjalanpaisti\nJälkiruoka: Mansikkakakku\nAlkuruoka: Lohikeitto'), 'event.txt');
    for (const d of days()) { d.match = 'skipped'; d.recipeId = undefined; d.suggestion = undefined; d.removed = undefined; }
    for (const d of [...days()]) await act({ type: 'restore_day', date: d.id });
    assert.deepEqual(days().map(d => [d.match, d.recipeId]), [['confirmed', 'alkumalja'], ['confirmed', 'karjalanpaisti'], ['confirmed', 'mansikkakakku'], ['missing', 'lohikeitto']]);
    const plan = (await act({ type: 'show_plan' })).state.plan!;
    assert.ok(!plan.lines.some(l => l.ingredient === 'Lohikuutio'), 'the unknown-role row links no salmon soup quantities');
    assert.ok(plan.issues.some(i => i.date === days()[3].id && i.severity === 'block'), 'and it still asks for the role');
  });
});

describe('A2: the kitchen’s own dish', () => {
  it('names the day, orders nothing, blocks nothing and is listed as not covered by this order', T, async () => {
    await demo();
    const id = days()[MON].id;
    const r = await act({ type: 'set_custom_dish', date: id, name: '  Hampurilainen \n ja  ranskikset ' });
    assert.equal(days()[MON].match, 'custom'); assert.equal(days()[MON].customName, 'Hampurilainen ja ranskikset');
    assert.equal(days()[MON].recipeId, undefined);
    const d = viewDay(r, MON);
    assert.equal(d.customName, 'Hampurilainen ja ranskikset'); assert.equal(shownDish(d), 'Hampurilainen ja ranskikset');
    assert.deepEqual(d.importRecipe, { recipeId: 'lihamakaronilaatikko', exact: true }, 'the picker can mark the imported dish');
    assert.ok(!r.state.plan!.lines.some(l => l.uses.some(u => u.date === days()[MON].date)), 'no line is calculated for the day');
    assert.equal(issuesFor(r, id).length, 0, 'no blocking question for the own dish');
    assert.deepEqual(r.state.plan!.notCovered, [{ date: id, day: 'ma 16.11.', name: 'Hampurilainen ja ranskikset', kind: 'custom' }]);
    assert.match(r.reply, /en laske sille määriä enkä tilaa tälle päivälle mitään automaattisesti/);
    assert.equal(lastAudit().action, 'set_custom_dish');
    assert.match(lastAudit().text.fi, /oma ruokalaji ”Hampurilainen ja ranskikset” .* ei reseptiä/);
    // the chat finds the day by the own dish's name
    await act({ type: 'set_custom_dish', date: id, name: 'Pizza' });
    const changed = await chat('saako pizzan tilalle lohikeittoa?');
    assert.equal(days()[MON].recipeId, 'lohikeitto', changed.reply);
    assert.equal(days()[MON].customName, undefined, 'a recipe replaces the own dish');
  });

  it('refuses an empty or too long name; an exact recipe name of the role links the recipe; another role’s recipe stays a name', T, async () => {
    await act({ type: 'load_demo_menu' });
    const id = days()[MON].id;
    const before = JSON.stringify(S().menu);
    await refused(() => act({ type: 'set_custom_dish', date: id, name: ' \n ' }), /Type the name/);
    await refused(() => act({ type: 'set_custom_dish', date: id, name: 'x'.repeat(61) }), /at most 60/);
    assert.equal(JSON.stringify(S().menu), before);
    await act({ type: 'set_custom_dish', date: id, name: 'x'.repeat(60) });
    assert.equal(days()[MON].customName?.length, 60);
    for (const [name, lang] of [['Laxsoppa', 'sv'], ['salmon soup', 'en'], ['LOHIKEITTO', 'fi']] as const) {
      resetState(); await act({ type: 'load_demo_menu' });
      const r = await act({ type: 'set_custom_dish', date: id, name }, lang);
      assert.equal(days()[MON].match, 'confirmed', name); assert.equal(days()[MON].recipeId, 'lohikeitto', name);
      assert.match(r.reply, /Lohikeitto|Laxsoppa|Salmon soup/);
      assert.match(r.state.undo!.label, /Lohikeitto|Laxsoppa|Salmon soup/);
    }
    // a dessert's name on a weekday is the kitchen's own dish: no dessert quantities are linked
    resetState(); await act({ type: 'load_demo_menu' });
    const cake = await act({ type: 'set_custom_dish', date: id, name: 'Mansikkakakku' });
    assert.equal(days()[MON].match, 'custom'); assert.equal(days()[MON].recipeId, undefined);
    assert.ok(!cake.state.plan!.lines.some(l => l.ingredient === 'Mansikkakakku'));
  });

  it('works on an event row whose role is unknown, and removing it works too', T, async () => {
    await importMenu(Buffer.from('Alkumalja: Alkoholiton kuohujuoma\nPääruoka: Karjalanpaisti\nAlkuruoka: Tuntematon ruoka'), 'event.txt');
    const row = days()[2];
    assert.equal(row.role, undefined);
    let r = await act({ type: 'show_plan' });
    assert.ok(issuesFor(r, row.id).some(i => i.severity === 'block'), 'unknown role asks first');
    r = await act({ type: 'set_custom_dish', date: row.id, name: 'Graavilohileivät' });
    assert.equal(days()[2].match, 'custom');
    assert.equal(issuesFor(r, row.id).length, 0, 'an own dish needs no role');
    assert.deepEqual(r.state.plan!.notCovered?.map(x => [x.day, x.kind]), [['Alkuruoka', 'custom']]);
    r = await act({ type: 'skip_day', date: row.id });
    assert.equal(issuesFor(r, row.id).length, 0);
    r = await act({ type: 'restore_day', date: row.id });
    assert.equal(viewDay(r, 2).customName, 'Graavilohileivät');
  });

  it('"Find ingredients" sends a browse-only ingredient search in the UI language', T, async () => {
    await act({ type: 'load_demo_menu' });
    for (const lang of ['fi', 'sv', 'en'] as const) {
      const message = makeT(lang)('custom.findMessage', { name: 'Hampurilainen' });
      assert.ok(isIngredientRequest(message), message);
      const r = await chat(message, lang);
      assert.equal(r.state.orders.length, 0, `${lang}: nothing ordered`);
      assert.equal(r.state.drafts.length, 0, `${lang}: nothing added to a draft`);
    }
    assert.equal(makeT('fi')('custom.findMessage', { name: 'X' }), 'Etsi raaka-aineet ruokalajille X');
    assert.equal(makeT('sv')('custom.findMessage', { name: 'X' }), 'Hitta ingredienser till X');
    assert.equal(makeT('en')('custom.findMessage', { name: 'X' }), 'Find ingredients for X');
  });
});

describe('A1: the picker’s search rule (web/src/recipeOptions.ts)', () => {
  it('filters by name, other languages, aliases and hints, keeps the role rule and agrees with the server on exact names', T, async () => {
    await act({ type: 'load_demo_menu' });
    const state = await stateView('fi');
    const mon = days()[MON].id;
    const options = recipeOptions(state, mon);
    assert.deepEqual(filterRecipes(options, '').items, options, 'empty input shows every option');
    assert.ok(options.length >= 6 && options.every(r => r.role === 'main'));
    const ids = (q: string) => filterRecipes(options, q).items.map(r => r.id);
    assert.deepEqual(ids('lohi'), ['lohikeitto']);
    assert.deepEqual(ids('LAXSOPPA'), ['lohikeitto'], 'Swedish name');
    assert.deepEqual(ids('salmon'), ['lohikeitto'], 'English name');
    assert.ok(ids('kala').includes('lohikeitto'), 'hint word');
    assert.ok(ids('kalakeitto').includes('lohikeitto'), 'a hint inside the typed dish');
    assert.equal(filterRecipes(options, 'kalakeitto').exact, undefined, 'a close name is not exact: own dish stays possible');
    assert.equal(filterRecipes(options, ' Lohikeitto ').exact?.id, 'lohikeitto');
    assert.equal(filterRecipes(options, 'makaronilaatikko').exact?.id, 'lihamakaronilaatikko', 'alias');
    assert.deepEqual(filterRecipes(options, 'pizza'), { items: [], exact: undefined });
    assert.equal(normText('Köttfärssås'), 'kottfarssas'); assert.equal(tidyDishName(' a \t b\n'), 'a b');
    // the UI's exact match is the server's exact match, for every name and alias
    for (const r of recipesForRole('main')) for (const n of [r.name.fi, r.name.sv, r.name.en, ...r.aliases]) {
      assert.equal(filterRecipes(options, n).exact?.id, matchRecipe(n, recipesForRole('main')).recipe?.id, n);
    }
    // an event drink row offers drinks only, whatever is typed
    resetState();
    await importMenu(Buffer.from('Alkumalja: Alkoholiton kuohujuoma\nPääruoka: Karjalanpaisti\nJälkiruoka: Mansikkakakku'), 'event.txt');
    const ev = await stateView('fi');
    const drinks = recipeOptions(ev, days()[0].id);
    assert.deepEqual(drinks.map(r => r.id), ['alkumalja']);
    assert.deepEqual(filterRecipes(drinks, 'lohikeitto').items, []);
    assert.equal(filterRecipes(drinks, 'karjalanpaisti').exact, undefined, 'another role’s recipe is never exact here');
  });
});

describe('B: shopping list lines and allergen choices can be taken back', () => {
  it('a removed line is listed and comes back at the calculated quantity', T, async () => {
    const r0 = await demo();
    const line = r0.state.plan!.lines.find(l => l.orderQty > 0 && l.checks.length === 0)!;
    const calculated = line.orderQty;
    const edited = await act({ type: 'set_line_qty', lineId: line.id, qty: calculated + 3 });
    assert.equal(edited.state.plan!.lines.find(l => l.id === line.id)!.calculatedQty, calculated, 'the hand-set line knows the calculation');
    const removed = await act({ type: 'remove_line', lineId: line.id });
    assert.ok(!removed.state.plan!.lines.some(l => l.id === line.id));
    assert.deepEqual(removed.state.plan!.removedLines, [{ id: line.id, name: line.product.name, ingredient: line.ingredient }]);
    const back = await act({ type: 'restore_line', lineId: line.id });
    const again = back.state.plan!.lines.find(l => l.id === line.id)!;
    assert.equal(again.orderQty, calculated, 'restored at the calculated quantity');
    assert.equal(again.calculatedQty, undefined);
    assert.equal(back.state.plan!.removedLines, undefined);
    assert.equal(lastAudit().action, 'restore_line');
    await refused(() => act({ type: 'restore_line', lineId: line.id }), /has not been removed/);
  });

  it('a hand-set quantity can go back to the calculated one', T, async () => {
    const r0 = await demo();
    const line = r0.state.plan!.lines.find(l => l.orderQty > 0)!;
    await act({ type: 'set_line_qty', lineId: line.id, qty: line.orderQty + 5 });
    const reset = await act({ type: 'reset_line_qty', lineId: line.id });
    const now = reset.state.plan!.lines.find(l => l.id === line.id)!;
    assert.equal(now.orderQty, line.orderQty); assert.equal(now.calculatedQty, undefined);
    await refused(() => act({ type: 'reset_line_qty', lineId: line.id }), /not been changed by hand/);
  });

  it('a switched product can be switched back; the memory of the switch goes with it', T, async () => {
    const r0 = await demo();
    const line = r0.state.plan!.lines.find(l => l.checks.length === 0 && l.ingredient === 'Makaroni')!;
    const card = (await lineAlternatives('fi', r0.state.plan!, line.id))!;
    const to = card.items[0].product.id;
    const swapped = await act({ type: 'swap_line', lineId: line.id, productId: to });
    assert.equal(swapped.state.plan!.lines.find(l => l.id === to)!.swappedFrom, line.product.name);
    assert.ok(S().kitchen.memory.some(m => m.id === `sw|${line.id}`));
    const back = await act({ type: 'restore_product', lineId: to });
    assert.deepEqual(S().swaps, {});
    assert.ok(!S().kitchen.memory.some(m => m.id.startsWith('sw|')));
    assert.ok(back.state.plan!.lines.some(l => l.id === line.id && !l.swappedFrom));
    await refused(() => act({ type: 'restore_product', lineId: to }), /not been switched/);
  });

  it('an accepted alternative and a left-out item can be opened again: memory goes, the item blocks again', T, async () => {
    const r0 = await demo();
    const [first, ...rest] = allergenOpen(r0);
    assert.ok(first?.alternatives?.length && rest.length, 'the demo has several allergen items');
    const altIds = first.alternatives!.map(a => a.product.id);
    const key = first.id.slice(3);
    for (const i of rest) await act({ type: 'skip_issue', issueId: i.id });
    const resolved = await act({ type: 'resolve_issue', issueId: first.id, productId: altIds[0] });
    const done = resolved.state.plan!.issues.find(i => i.id === first.id)!;
    assert.ok(done.resolved && canReopen(done));
    assert.ok(resolved.state.plan!.ready, resolved.state.plan!.issues.filter(i => !i.resolved).map(i => i.id).join());
    assert.ok(S().kitchen.memory.some(m => m.id === `ov|${key}`));

    const reopened = await act({ type: 'reopen_issue', issueId: first.id });
    assert.equal(S().overrides[key], undefined);
    assert.ok(!S().kitchen.memory.some(m => m.id === `ov|${key}`), 'the kitchen forgets the choice');
    const again = reopened.state.plan!.issues.find(i => i.id === first.id)!;
    assert.equal(again.resolved, false); assert.equal(again.severity, 'block');
    assert.deepEqual(again.alternatives!.map(a => a.product.id), altIds, 'the same checked options');
    assert.equal(reopened.state.plan!.ready, false, 'the check does not loosen');
    await refused(() => act({ type: 'create_order' }), /still has open items/);
    assert.equal(S().orders.length, 0);
    assert.equal(lastAudit().action, 'reopen_issue');
    await refused(() => act({ type: 'reopen_issue', issueId: first.id }), /already open/);

    // a left-out item opens again the same way
    const left = rest[0];
    const r = await act({ type: 'reopen_issue', issueId: left.id });
    assert.ok(!S().skipped.includes(left.id.slice(3)));
    const open = r.state.plan!.issues.find(i => i.id === left.id)!;
    assert.equal(open.resolved, false); assert.equal(open.severity, 'block');
    // only allergen items can be reopened
    await refused(() => act({ type: 'reopen_issue', issueId: 'portions' }), /cannot be opened again/);
    assert.equal(canReopen({ id: 'rc|2026-11-20', resolved: true, kind: 'suggested_recipe' } as Issue), false);
  });
});

describe('C: a diet group can be removed', () => {
  it('a removed row is sent as count 0, because rows that are not sent are kept', T, async () => {
    await demo();
    const saved = [{ requirement: 'gluten_free' as const, count: 20 }, { requirement: 'wheat_free' as const, count: 8 }];
    const rows = [{ requirement: 'gluten_free' as const, count: 20 }];
    const groups = portionGroups(rows, saved);
    assert.deepEqual(groups, [{ requirement: 'gluten_free', count: 20 }, { requirement: 'wheat_free', count: 0 }]);
    assert.deepEqual(portionGroups([{ requirement: null, count: 3 }], [{ requirement: null }]), [], 'custom groups are not addressable');
    // without the zero the server keeps the group (why the form sends it)
    await act({ type: 'set_portions', total: 350, groups: rows });
    assert.deepEqual(S().kitchen.groups.map(g => g.requirement), ['gluten_free', 'wheat_free']);
    const r = await act({ type: 'set_portions', total: 350, groups });
    assert.deepEqual(r.state.kitchen.groups.map(g => g.id), ['gluten_free']);
    assert.ok(!r.state.plan!.lines.some(l => l.groupLabels.includes('Vehnätön')));
    const undone = await act({ type: 'undo' });
    assert.deepEqual(undone.state.kitchen.groups.map(g => [g.id, g.count]), [['gluten_free', 20], ['wheat_free', 8]]);
  });
});

describe('D: every new edit can be undone exactly', () => {
  it('remove, restore, own dish, reopen, restore line, reset quantity and switch back are each one undo step', T, async () => {
    const cases: [string, (r: TurnResponse) => Promise<UiAction> | UiAction, RegExp][] = [
      ['remove dish', () => ({ type: 'skip_day', date: days()[MON].id }), /Ruokalaji poistettu/],
      ['restore dish', async () => { await act({ type: 'skip_day', date: days()[MON].id }); return { type: 'restore_day', date: days()[MON].id }; }, /Ruokalaji palautettu/],
      ['own dish', () => ({ type: 'set_custom_dish', date: days()[MON].id, name: 'Pizza' }), /Oma ruokalaji: .*Pizza/],
      ['reopen', async r => { const i = allergenOpen(r)[0]; await act({ type: 'resolve_issue', issueId: i.id, productId: i.alternatives![0].product.id }); return { type: 'reopen_issue', issueId: i.id }; }, /Valinta avattu uudelleen/],
      ['restore line', async r => { const l = r.state.plan!.lines[0]; await act({ type: 'remove_line', lineId: l.id }); return { type: 'restore_line', lineId: l.id }; }, /Rivi palautettu/],
      ['reset quantity', async r => { const l = r.state.plan!.lines.find(x => x.orderQty > 0)!; await act({ type: 'set_line_qty', lineId: l.id, qty: l.orderQty + 2 }); return { type: 'reset_line_qty', lineId: l.id }; }, /Laskettu määrä palautettu/],
      ['switch back', async r => {
        const l = r.state.plan!.lines.find(x => x.checks.length === 0 && x.ingredient === 'Makaroni')!;
        const to = (await lineAlternatives('fi', r.state.plan!, l.id))!.items[0].product.id;
        await act({ type: 'swap_line', lineId: l.id, productId: to });
        return { type: 'restore_product', lineId: to };
      }, /Tuotevaihto kumottu/],
    ];
    for (const [name, make, label] of cases) {
      resetState();
      const r0 = await demo();
      const action = await make(r0);
      const before = snapshot(), steps = S().undo.length, orders = structuredClone(S().orders);
      const r1 = await act(action);
      assert.notDeepEqual(snapshot(), before, `${name}: something changed`);
      assert.equal(S().undo.length, steps + 1, `${name}: one step`);
      assert.match(r1.state.undo!.label, label, name);
      assert.ok(undoRecorded({ label: 'x', steps }, r1.state.undo), `${name}: the UI sees the new step`);
      const r2 = await act({ type: 'undo' });
      assert.deepEqual(snapshot(), before, `${name}: undo restores the editing state`);
      assert.deepEqual(S().orders, orders, `${name}: orders untouched`);
      assert.match(r2.reply, /Kumottu/);
    }
  });

  it('labels exist in Swedish and English; a change that changed nothing adds no step', T, async () => {
    await act({ type: 'load_demo_menu' });
    await act({ type: 'skip_day', date: days()[MON].id });
    assert.match((await act({ type: 'show_plan' }, 'sv')).state.undo!.label, /Rätt borttagen/);
    assert.match((await act({ type: 'show_plan' }, 'en')).state.undo!.label, /Dish removed/);
    const steps = S().undo.length;
    await act({ type: 'skip_day', date: days()[MON].id });
    assert.equal(S().undo.length, steps, 'removing a removed dish is not a new step');
    const same = await act({ type: 'show_plan' });
    assert.equal(undoRecorded(same.state.undo, same.state.undo), false, 'no Undo is offered for a no-op');
    assert.equal(undoRecorded(undefined, undefined), false);
    assert.equal(undoRecorded({ label: 'a', steps: 20 }, { label: 'a', steps: 20 }), true, 'a full stack still records');
    assert.deepEqual([...PLAN_EDITS].sort(), [...UNDOABLE].sort(), 'the UI offers Undo for exactly the edits the server records');
  });
});

describe('E: the order card offers only what the server does', () => {
  it('pending kitchen order: approve or cancel; agent order: approve or reject; sent: nothing to cancel', T, async () => {
    assert.deepEqual(orderActions({ status: 'pending_approval', source: 'ui' }), { approve: true, cancel: true, reject: false, final: false });
    assert.deepEqual(orderActions({ status: 'pending_approval', source: 'mcp' }), { approve: true, cancel: false, reject: true, final: false });
    for (const status of ['submitted', 'approved'] as const) assert.deepEqual(orderActions({ status, source: 'ui' }), { approve: false, cancel: false, reject: false, final: true });
    for (const status of ['rejected', 'cancelled'] as const) assert.deepEqual(orderActions({ status, source: 'mcp' }), { approve: false, cancel: false, reject: false, final: false });

    // the same rule on the server: a pending kitchen order can be cancelled, a sent one cannot
    const orderOf = (r: TurnResponse) => r.state.orders[0] as Order;
    const quick = await chat('Tilaa 20 kg riisiä perjantaiksi');
    const pending = orderOf(quick);
    assert.equal(pending.status, 'pending_approval'); assert.equal(pending.source, 'ui');
    assert.ok(orderActions(pending).cancel);
    const cancelled = await act({ type: 'cancel_order', orderId: pending.id });
    assert.equal(cancelled.state.orders.find(o => o.id === pending.id)!.status, 'cancelled');
    const second = await chat('Tilaa 25 kg riisiä torstaiksi');
    const id = second.state.orders.find(o => o.status === 'pending_approval')!.id;
    const sent = await act({ type: 'approve_order', orderId: id });
    const order = sent.state.orders.find(o => o.id === id)!;
    assert.equal(order.status, 'submitted', sent.reply);
    assert.deepEqual(orderActions(order), { approve: false, cancel: false, reject: false, final: true });
    await refused(() => act({ type: 'cancel_order', orderId: id }), /Only an order waiting for approval/);
    assert.ok(makeT('fi')('order.final').includes('simulaatio'));
  });
});

describe('state view stays readable for the UI', () => {
  it('recipes carry their search words; every menu entry says what it shows', T, async () => {
    await act({ type: 'load_demo_menu' });
    const s: DashboardState = await stateView('en');
    const salmon = s.recipes.find(r => r.id === 'lohikeitto')!;
    assert.ok(salmon.names!.includes('laxsoppa') && salmon.names!.includes('salmon soup') && salmon.hints!.includes('kala'));
    assert.equal(shownDish(s.menu!.days[MON]), 'Beef macaroni casserole');
    assert.deepEqual(s.menu!.days[FRI].importRecipe, { recipeId: 'lohikeitto', exact: false }, 'closest by name only');
  });
});

describe('nothing changes silently or moves the user away', () => {
  it('a portions change that resets removed lines and hand-set quantities says so, in every language', T, async () => {
    await demo();
    const plain = await act({ type: 'set_portions', total: 340 });
    assert.doesNotMatch(plain.reply, /palautettiin laskettuihin/, 'no notice when there was nothing to reset');
    const id = plain.state.plan!.lines[0].id;
    for (const [lang, re] of [['fi', /Poistamasi rivit ja käsin muuttamasi määrät palautettiin laskettuihin/], ['sv', /återställdes till de beräknade/], ['en', /went back to the calculated ones/]] as const) {
      const removed = await act({ type: 'remove_line', lineId: id });
      assert.equal(removed.state.plan!.removedLines?.length, 1);
      const r = await act({ type: 'set_portions', total: 350 }, lang);
      assert.match(r.reply, re);
      assert.equal(r.state.plan!.removedLines, undefined, 'the line is back, as the notice says');
      assert.ok(r.state.undo, 'and the change can be undone');
    }
    await act({ type: 'set_line_qty', lineId: id, qty: 99 });
    assert.match((await act({ type: 'set_portions', total: 345 })).reply, /palautettiin laskettuihin/, 'a hand-set quantity counts too');
  });

  it('edits made on a menu entry are confirmed in place; they are all plan edits with an undo step', () => {
    assert.deepEqual([...MENU_EDITS].sort(), ['clear_menu', 'confirm_recipe', 'restore_day', 'set_course', 'set_custom_dish', 'skip_day']);
    for (const a of MENU_EDITS) assert.ok(PLAN_EDITS.has(a) && UNDOABLE.includes(a), a);
  });
});
