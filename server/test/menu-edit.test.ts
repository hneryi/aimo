// Menu editing: change a day's recipe, undo, and the chat phrasings (change dish, recommend, line alternatives).
// Runs on loopback stubs for the supplier and the language model, with the real challenge catalog and the sample menu.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';
import type { Card, Lang, Plan, TurnResponse, UiAction } from '../../shared/types.ts';
import { startStub } from './mock-stub.ts';

const supplier = await startStub();
const dir = mkdtempSync(join(tmpdir(), 'aimo-menu-edit-'));
let reply: (body: any) => { status?: number; content?: unknown; tool_calls?: unknown[] } = () => ({});
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', b => raw += b);
  req.on('end', () => {
    const r = reply(JSON.parse(raw));
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: r.content, tool_calls: r.tool_calls } }] }));
  });
});
await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  VALIO_BASE_URL: supplier.url, VALIO_API_KEY: 'offline-test', VERDA_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}`,
  VERDA_API_KEY: 'offline-test', VERDA_MODEL: 'test-chat', STATE_FILE: join(dir, 'state.json'), DATA_DIR: dir, AGENT_TOKEN: 'offline-test', APPROVERS: '',
});
const { loadCatalog } = await import('../src/catalog.ts');
const { loadState, S, resetState } = await import('../src/store.ts');
const { handleChat, handleAction } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { estimateRecipes, lineAlternatives } = await import('../src/planner.ts');
const { mainRecipes, matchRecipe, recipeById } = await import('../src/recipes.ts');
const { UNDO_LIMIT } = await import('../src/undo.ts');
loadCatalog(); loadState();
const T = { timeout: 180_000 };

const act = (a: UiAction, lang: Lang = 'fi') => handleAction(a, lang);
const chat = (m: string, lang: Lang = 'fi') => handleChat(m, lang);
const days = () => S().menu!.days;
const MON = 0, TUE = 1, WED = 2, FRI = 4; // sample menu: macaroni casserole, chicken sauce, carrot soup, pea soup, fish soup
const cards = <K extends Card['type']>(r: TurnResponse, type: K) => r.cards.filter((c): c is Extract<Card, { type: K }> => c.type === type);
const choices = (r: TurnResponse) => cards(r, 'note').flatMap(c => c.recipeChoices?.options ?? []);
/** the plan's editing state, as undo restores it */
const editState = () => structuredClone({
  days: days().map(d => ({ id: d.id, match: d.match, recipeId: d.recipeId, suggestion: d.suggestion })),
  portionsTotal: S().kitchen.portionsTotal, groups: S().kitchen.groups, portionsConfirmed: S().kitchen.portionsConfirmed,
  overrides: S().overrides, swaps: S().swaps, skipped: S().skipped, edits: S().edits, memory: S().kitchen.memory,
});
/** everything else the plan edit must not touch */
const untouched = () => structuredClone({ orders: S().orders, draft: S().draft, agents: S().agents, authority: S().kitchen.authority, quotes: S().quotes, stock: S().stock });

/** sample menu, Friday's recipe confirmed, 350 portions with 20 gluten-free and 8 wheat-free: the README demo state */
async function demo(): Promise<TurnResponse> {
  await act({ type: 'load_demo_menu' });
  await act({ type: 'confirm_recipe', date: days()[FRI].id, recipeId: 'lohikeitto' });
  return act({ type: 'set_portions', total: 350, groups: [{ requirement: 'gluten_free', count: 20 }, { requirement: 'wheat_free', count: 8 }] });
}
const open = (r: TurnResponse) => r.state.plan!.issues.filter(i => !i.resolved && i.kind.startsWith('allergen'));

beforeEach(() => {
  resetState();
  config.llm.apiKey = '';
  reply = () => ({});
});
after(async () => {
  model.closeAllConnections(); await new Promise<void>(r => model.close(() => r()));
  await supplier.close(); rmSync(dir, { recursive: true, force: true });
});

it('weekly import never auto-links or suggests drink and dessert recipes', T, async () => {
  const { importMenuText } = await import('../src/menuImport.ts');
  const { menu } = await importMenuText('maanantai: Alkoholiton kuohujuoma\ntiistai: Mansikkakakku');
  assert.equal(menu.kind, 'week');
  for (const day of menu.days) {
    assert.equal(day.match, 'missing');
    assert.ok(!['alkumalja', 'mansikkakakku'].includes(day.suggestion?.recipeId ?? ''));
  }
  assert.equal(menu.days.length, 2);
});

it('weekly menu rejects non-main recipes in API, chat and old stored state', T, async () => {
  await act({ type: 'load_demo_menu' });
  const id = days()[MON].id;
  assert.ok(!(await act({ type: 'show_menu' })).state.recipes.some(r => ['alkumalja', 'mansikkakakku'].includes(r.id)));
  for (const recipeId of ['alkumalja', 'mansikkakakku']) {
    await assert.rejects(() => act({ type: 'confirm_recipe', date: id, recipeId }), /does not match the course role/);
  }
  for (const model of [false, true]) {
    config.llm.apiKey = model ? 'offline-test' : '';
    reply = () => toolCall('change_dish', { new_dish: 'mansikkakakku', weekday: 'mon' });
    const r = await chat('Vaihda maanantain ruoka mansikkakakkuun');
    assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
    assert.ok(choices(r).every(o => !['alkumalja', 'mansikkakakku'].includes(o.recipeId)));
  }
  days()[MON].recipeId = 'alkumalja'; days()[MON].match = 'confirmed';
  const old = await act({ type: 'show_plan' });
  assert.equal(old.state.menu!.days[MON].match, 'missing');
  assert.ok(old.state.plan!.issues.some(i => i.kind === 'missing_recipe' && i.date === id));
  assert.ok(!old.state.plan!.lines.some(l => l.ingredient === 'Alkoholiton kuohujuoma'));
  assert.equal(days()[MON].recipeId, 'alkumalja', 'legacy data remains intact');
  await act({ type: 'confirm_recipe', date: id, recipeId: 'lohikeitto' });
  const undone = await act({ type: 'undo' });
  assert.equal(days()[MON].recipeId, 'alkumalja');
  assert.equal(undone.state.menu!.days[MON].match, 'missing');
  assert.ok(undone.state.plan!.issues.some(i => i.kind === 'missing_recipe' && i.date === id));
});

it('event roles survive import, reject cross-role changes and block ambiguous legacy entries', T, async () => {
  const { importMenu } = await import('../src/menuImport.ts');
  await importMenu(Buffer.from('Alkumalja: Alkoholiton kuohujuoma\nPääruoka: Karjalanpaisti\nJälkiruoka: Mansikkakakku\nAlkuruoka: Tuntematon ruoka'), 'event.txt');
  assert.equal(S().menu!.kind, 'event');
  assert.deepEqual(days().map(d => d.role), ['drink', 'main', 'dessert', undefined]);
  assert.deepEqual(days().slice(0, 3).map(d => d.match), ['confirmed', 'confirmed', 'confirmed']);
  const drink = days()[0], dessert = days()[2], unknown = days()[3];
  await assert.rejects(() => act({ type: 'confirm_recipe', date: drink.id, recipeId: 'lohikeitto' }), /course role/);
  await assert.rejects(() => act({ type: 'confirm_recipe', date: unknown.id, recipeId: 'lohikeitto' }), /course role/);
  // Route requests by dish name; recommendations must never offer another role.
  const noChange = await chat('saako alkoholiton kuohujuoma tilalle mansikkakakkua?');
  assert.equal(drink.recipeId, 'alkumalja');
  assert.ok(choices(noChange).every(o => o.recipeId !== 'mansikkakakku'));
  config.llm.apiKey = 'offline-test';
  for (const current_dish of ['Alkoholiton kuohujuoma', 'Mansikkakakku']) {
    reply = () => toolCall('recommend_dish', { current_dish });
    const recommendation = await chat('x');
    assert.equal(choices(recommendation).length, 0);
    assert.match(recommendation.reply, /Muita tämän roolin hyväksyttyjä reseptejä ei ole/);
  }
  reply = () => toolCall('change_dish', { current_dish: 'Tuntematon ruoka', new_dish: 'lohikeitto' });
  assert.match((await chat('x')).reply, /Valitse ensin ruokalajin rooli/);
  config.llm.apiKey = '';
  let state = (await act({ type: 'show_plan' })).state;
  const { recipeOptions } = await import('../../web/src/recipeOptions.ts');
  assert.deepEqual(recipeOptions(state, drink.id, drink.recipeId), []);
  assert.deepEqual(recipeOptions(state, dessert.id, dessert.recipeId), []);
  assert.deepEqual(recipeOptions(state, unknown.id), []);
  assert.ok(recipeOptions(state, days()[1].id).every(r => r.role === 'main'));
  assert.equal(state.menu!.days[3].role, undefined);
  assert.ok(state.plan!.issues.some(i => i.date === unknown.id && i.severity === 'block'));
  // Legacy labels establish their role, not the previously linked recipe.
  delete drink.role; drink.recipeId = 'lohikeitto'; drink.match = 'confirmed';
  state = (await act({ type: 'show_plan' })).state;
  assert.equal(state.menu!.days[0].role, 'drink');
  assert.match(state.menu!.days[0].roleProblem!, /Lohikeitto/);
  assert.equal(state.menu!.days[0].match, 'missing');
  assert.equal(drink.recipeId, 'lohikeitto');
  await act({ type: 'set_course', date: unknown.id, role: 'dessert' });
  assert.equal(unknown.role, 'dessert');
  await act({ type: 'undo' });
  assert.equal(unknown.role, undefined);
  assert.equal(dessert.recipeId, 'mansikkakakku');
});

// ---------- A: change the recipe of any day ----------

it('a day that was linked automatically can get another recipe; the plan is recalculated', T, async () => {
  await act({ type: 'load_demo_menu' });
  assert.equal(days()[MON].match, 'confirmed');
  const before = (await act({ type: 'show_plan' })).state.plan!;
  assert.ok(before.lines.some(l => l.ingredient === 'Makaroni'));
  const r = await act({ type: 'confirm_recipe', date: days()[MON].id, recipeId: 'lohikeitto' });
  assert.equal(days()[MON].recipeId, 'lohikeitto'); assert.equal(days()[MON].match, 'confirmed');
  assert.equal(r.state.menu!.days[MON].recipeName, 'Lohikeitto');
  assert.ok(!r.state.plan!.lines.some(l => l.ingredient === 'Makaroni'), 'macaroni is no longer needed');
  assert.ok(r.state.plan!.lines.some(l => l.ingredient === 'Lohikuutio'));
  assert.ok(r.state.undo); assert.match(r.state.undo!.label, /Lohikeitto/);
});

// ---------- B: undo ----------

it('undo takes back every kind of plan edit and restores exactly the earlier editing state', T, async () => {
  const cases: [string, (r: TurnResponse) => Promise<UiAction> | UiAction][] = [
    ['recipe change', () => ({ type: 'confirm_recipe', date: days()[TUE].id, recipeId: 'karjalanpaisti' })],
    ['skipped day', () => ({ type: 'skip_day', date: days()[WED].id })],
    ['portions and diet groups', () => ({ type: 'set_portions', total: 300, groups: [{ requirement: 'milk_free', count: 12 }] })],
    ['accepted alternative', r => { const i = open(r).find(x => x.alternatives?.length)!; return { type: 'resolve_issue', issueId: i.id, productId: i.alternatives![0].product.id }; }],
    ['left-out item', r => ({ type: 'skip_issue', issueId: open(r)[0].id })],
    ['product switch', async r => {
      const line = r.state.plan!.lines.find(l => l.checks.length === 0 && l.ingredient === 'Makaroni')!;
      const card = (await lineAlternatives('fi', r.state.plan!, line.id))!;
      assert.ok(card.items.length);
      return { type: 'swap_line', lineId: line.id, productId: card.items[0].product.id };
    }],
    ['line quantity', r => { const l = r.state.plan!.lines.find(x => x.orderQty > 0)!; return { type: 'set_line_qty', lineId: l.id, qty: l.orderQty + 3 }; }],
    ['removed line', r => ({ type: 'remove_line', lineId: r.state.plan!.lines[0].id })],
  ];
  for (const [name, make] of cases) {
    resetState();
    const r0 = await demo();
    const base = editState(), others = untouched(), steps = S().undo.length;
    const r1 = await act(await make(r0));
    assert.notDeepEqual(editState(), base, `${name}: the edit changed something`);
    assert.equal(S().undo.length, steps + 1, `${name}: one step recorded`);
    assert.equal(r1.state.undo!.steps, steps + 1);
    assert.ok(r1.state.undo!.label.length > 3);
    const r2 = await act({ type: 'undo' });
    assert.deepEqual(editState(), base, `${name}: undo restores the earlier state`);
    assert.deepEqual(untouched(), others, `${name}: undo leaves orders, draft, agents and limits alone`);
    assert.equal(S().undo.length, steps);
    assert.match(r2.reply, /Kumottu/);
    assert.ok(S().audit.some(a => a.action === 'undo'), `${name}: the undo is logged`);
  }
});

it('undo is a stack: steps come back in reverse order, an empty stack is refused, the log is never rewound', T, async () => {
  await demo();
  const e0 = editState();
  await act({ type: 'confirm_recipe', date: days()[TUE].id, recipeId: 'lohikeitto' });
  const e1 = editState();
  await act({ type: 'skip_day', date: days()[WED].id });
  const entries = S().audit.length;
  await act({ type: 'undo' }); assert.deepEqual(editState(), e1);
  await act({ type: 'undo' }); assert.deepEqual(editState(), e0);
  assert.equal(S().audit.length, entries + 2, 'two undo entries were added, nothing removed');
  const r = await handleAction({ type: 'show_plan' }, 'fi');
  assert.equal(r.state.undo?.steps, S().undo.length);
  assert.equal(S().undo.length, 2, 'the recipe and the portions of the demo setup are still on the stack');
  while (S().undo.length) await act({ type: 'undo' });
  await assert.rejects(() => act({ type: 'undo' }), /Nothing to undo/);
  assert.equal((await act({ type: 'show_plan' })).state.undo, undefined, 'no Undo button without a step');
});

it('the stack keeps at most 20 steps, skips changes that changed nothing, and is saved with the account', T, async () => {
  await act({ type: 'load_demo_menu' });
  await act({ type: 'confirm_recipe', date: days()[MON].id, recipeId: 'lihamakaronilaatikko' });
  assert.equal(S().undo.length, 0, 'linking the recipe the day already has is not a change');
  const line = (await act({ type: 'show_plan' })).state.plan!.lines.find(l => l.orderQty > 0)!;
  for (let i = 1; i <= UNDO_LIMIT + 5; i++) await act({ type: 'set_line_qty', lineId: line.id, qty: line.orderQty + i });
  assert.equal(S().undo.length, UNDO_LIMIT);
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).profiles.school;
  assert.equal(saved.undo.length, UNDO_LIMIT);
});

it('creating an order from the plan, importing a menu or resetting empties the stack; drafts and credit limit are not undone', T, async () => {
  const r0 = await demo();
  await act({ type: 'set_credit_limit', limit: 12345 });
  await act({ type: 'draft_set', productId: '460325', qty: 1, requirements: ['gluten_free', 'wheat_free'] });
  const draft = structuredClone(S().draft);
  await act({ type: 'confirm_recipe', date: days()[TUE].id, recipeId: 'lohikeitto' });
  await act({ type: 'undo' });
  assert.equal(S().kitchen.authority.creditLimit, 12345); assert.deepEqual(S().draft, draft);
  // make the plan ready by leaving out every unresolved allergen item, then order it
  let r = r0;
  for (const i of open(r0)) r = await act({ type: 'skip_issue', issueId: i.id });
  assert.ok(S().undo.length > 0);
  r = await act({ type: 'create_order' });
  assert.equal(r.state.orders.length, 1, r.reply);
  assert.equal(S().undo.length, 0); assert.equal(r.state.undo, undefined);
  await assert.rejects(() => act({ type: 'undo' }), /Nothing to undo/);
  assert.equal(S().orders.length, 1, 'the order stays');
  await act({ type: 'skip_day', date: days()[WED].id });
  assert.equal(S().undo.length, 1);
  await act({ type: 'load_demo_menu' });
  assert.equal(S().undo.length, 0, 'a new menu is a new starting point');
});

// ---------- C1: change a dish by chat ----------

it('exact recipe: the day changes, the list is recalculated, the answer shows the menu and open items, and it can be undone', T, async () => {
  await act({ type: 'load_demo_menu' });
  for (const [msg, key] of [['saako makaronilaatikon tilalle lohikeittoa?', 'a'], ['vaihda maanantain ruoka lohikeittoon', 'b'], ['saako maanantain ruoan tilalle lohikeittoa', 'c']]) {
    const before = editState();
    const r = await chat(msg);
    assert.equal(days()[MON].recipeId, 'lohikeitto', `${key}: ${r.reply}`);
    assert.match(r.reply, /Vaihdoin ma .*Lihamakaronilaatikko.*Lohikeitto/);
    assert.ok(r.cards.some(c => c.type === 'menu') && r.cards.some(c => c.type === 'plan'));
    assert.ok(!r.state.plan!.lines.some(l => l.ingredient === 'Makaroni'));
    assert.ok(r.state.plan!.issues.some(i => !i.resolved), 'open items are part of the answer');
    assert.ok(r.cards.some(c => c.type === 'issue'));
    assert.match(r.state.undo!.label, /Lohikeitto/);
    await act({ type: 'undo' });
    assert.deepEqual(editState(), before, `${key}: undone`);
  }
});

it('closest recipe: nothing changes until the user confirms with the button', T, async () => {
  await act({ type: 'load_demo_menu' });
  const before = JSON.stringify(S());
  const r = await chat('vaihda tiistain ruoka kalakeittoon');
  assert.equal(JSON.stringify(S()), before, 'state untouched');
  assert.match(r.reply, /ei ole täsmällistä hyväksyttyä reseptiä.*Lähin on Lohikeitto/);
  const note = cards(r, 'note')[0];
  assert.equal(note.recipeChoices!.date, days()[TUE].id);
  assert.deepEqual(note.recipeChoices!.options.map(o => o.recipeId), ['lohikeitto']);
  // the button sends confirm_recipe: that is the confirmation
  const done = await act({ type: 'confirm_recipe', date: note.recipeChoices!.date, recipeId: 'lohikeitto' });
  assert.equal(days()[TUE].recipeId, 'lohikeitto'); assert.ok(done.state.undo);
});

it('a dish without an approved recipe (hamburger) changes nothing, says so and lists the approved recipes', T, async () => {
  await act({ type: 'load_demo_menu' });
  const before = JSON.stringify(S());
  for (const [lang, re, list, search] of [['fi', /ei ole keittiön hyväksyttyä reseptiä/, /Lohikeitto/, /Etsi raaka-aineet/], ['sv', /inget av köket godkänt recept/, /Laxsoppa/, /Hitta ingredienser/], ['en', /no approved recipe/, /Salmon soup/, /Find ingredients/]] as const) {
    const r = await chat('saako makaronilaatikon tilalle hampurilaista?', lang);
    assert.equal(JSON.stringify(S()), before, `${lang}: state untouched`);
    assert.match(r.reply, re); assert.match(r.reply, list); assert.match(r.reply, search);
    assert.match(r.reply, /hampurilaista/);
    assert.equal(r.cards.length, 0); assert.equal(r.state.undo, undefined);
    assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
  }
  const en = await chat('can I get burgers instead of the macaroni casserole?', 'en');
  assert.match(en.reply, /no approved recipe for “burgers”/); assert.equal(JSON.stringify(S()), before);
});

it('ambiguous or unknown days are asked about, never guessed', T, async () => {
  await act({ type: 'load_demo_menu' });
  days()[TUE].dishName = 'Lihamakaronilaatikko'; days()[TUE].recipeId = 'lihamakaronilaatikko';
  const before = JSON.stringify(S());
  const two = await chat('saako makaronilaatikon tilalle lohikeittoa?');
  assert.match(two.reply, /Mikä päivä tarkoitetaan/); assert.equal(JSON.stringify(S()), before);
  const none = await chat('saako pizzan tilalle lohikeittoa?');
  assert.match(none.reply, /En löytänyt ruokalistalta/); assert.equal(JSON.stringify(S()), before);
  const which = await chat('vaihda ruoka lohikeittoon');
  assert.match(which.reply, /Minkä päivän ruokaa tarkoitat/); assert.equal(JSON.stringify(S()), before);
});

it('the change works in Swedish and English, replies in the requested language and logs it', T, async () => {
  for (const [lang, msg, re] of [['sv', 'kan jag få lohikeitto i stället för makaronilådan', /Jag bytte/], ['en', 'can I have lohikeitto instead of the macaroni casserole?', /I changed/]] as const) {
    resetState(); await act({ type: 'load_demo_menu' });
    const r = await chat(msg, lang);
    assert.match(r.reply, re, r.reply);
    assert.equal(days()[MON].recipeId, 'lohikeitto');
    assert.ok(S().audit.some(a => a.action === 'confirm_recipe'));
    assert.ok(r.state.undo!.label.length);
  }
});

// ---------- C2: recommendation ----------

it('recommend: at most three approved main dishes not on the week, with reasons; it changes nothing', T, async () => {
  await act({ type: 'load_demo_menu' });
  S().menu!.weekStart = '2030-03-04'; // a delivery date no other test used: the browse cache of offers is keyed by date
  supplier.offers.set('470261', { price: undefined }); // the strawberry cake product has no price: that recipe cannot be ordered
  try {
    const before = JSON.stringify(S());
    const r = await chat('Saatko suositeltua maanantaille jotain mitä tilattavissa?');
    assert.equal(JSON.stringify(S()), before, 'recommending changes no state, not even the log');
    const options = choices(r);
    assert.ok(options.length >= 1 && options.length <= 3);
    const week = new Set(days().filter(d => d.match === 'confirmed').map(d => d.recipeId));
    for (const o of options) {
      assert.ok(!week.has(o.recipeId), `${o.recipeId} is already on the week`);
      assert.notEqual(o.recipeId, 'lisukkeet');
      assert.ok(o.why.length > 20 && o.facts!.some(f => /€/.test(f)));
    }
    assert.ok(!options.some(o => o.recipeId === 'mansikkakakku' && options.length === 3), 'a recipe with a missing price is not among the best three');
    assert.equal(cards(r, 'note')[0].recipeChoices!.date, days()[MON].id);
    assert.match(r.reply, /Mitään ei ole vaihdettu/);
    // the button: confirm_recipe for that day, undoable
    const pick = options[0];
    const done = await act({ type: 'confirm_recipe', date: cards(r, 'note')[0].recipeChoices!.date, recipeId: pick.recipeId });
    assert.equal(days()[MON].recipeId, pick.recipeId); assert.ok(done.state.undo);
    const again = await chat('Suosittele maanantaille jotain muuta');
    assert.ok(cards(again, 'note')[0].text!.includes(`Nyt: ”${pick.recipeName}”.`), 'current dish is the chosen recipe, not the original import');
    await act({ type: 'undo' }); assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
  } finally { supplier.offers.delete('470261'); }
});

it('recommend says how many items would be left to resolve when the supplier cannot deliver', T, async () => {
  await act({ type: 'load_demo_menu' });
  S().menu!.weekStart = '2031-01-06'; // unused delivery date, see above
  supplier.fallback = { price: 2, amount: undefined }; // no availability data for any product
  try {
    const r = await chat('suggest something for Monday that we can order', 'en');
    const options = choices(r);
    assert.ok(options.length && options.every(o => /items would be left to resolve/.test(o.why)), JSON.stringify(options.map(o => o.why)));
    assert.match(r.reply, /None has fully ready ingredients for the day/);
  } finally { supplier.fallback = { price: 2, amount: 500, closingTime: '2099-01-01T17:00:00+0200' }; }
});

// ---------- C3: alternatives for a shopping-list line ----------

it('"saako makaronin tilalle jotain muuta": verified alternatives on the existing card, switched with swap_line, undoable', T, async () => {
  await act({ type: 'load_demo_menu' });
  const before = JSON.stringify(S());
  const r = await chat('saako makaronin tilalle jotain muuta?');
  assert.equal(JSON.stringify(S()), before, 'asking changes nothing');
  const card = cards(r, 'comparison')[0];
  assert.equal(card.lineId, '460001'); assert.equal(card.current!.product.id, '460001');
  assert.ok(card.items.length >= 1);
  for (const a of card.items) { assert.equal(a.suitable, true); assert.ok(a.offer.price != null); assert.ok(a.checks.every(c => c.verdict === 'ok')); assert.notEqual(a.product.id, '460001'); }
  const swapped = await act({ type: 'swap_line', lineId: card.lineId!, productId: card.items[0].product.id });
  assert.equal(S().swaps['460001'], card.items[0].product.id);
  assert.ok(swapped.state.plan!.lines.some(l => l.id === card.items[0].product.id));
  await act({ type: 'undo' });
  assert.deepEqual(S().swaps, {});
});

it('a word that is on several lines or on none is reported, not guessed', T, async () => {
  await demo();
  const plan = (await act({ type: 'show_plan' })).state.plan as Plan;
  const makaroni = plan.lines.filter(l => l.ingredient === 'Makaroni');
  const r = await chat('saako makaronin tilalle jotain muuta?');
  if (makaroni.length > 1) { assert.match(r.reply, /useammalta riviltä/); assert.equal(cards(r, 'comparison').length, 0); }
  else assert.equal(cards(r, 'comparison').length, 1);
  const none = await chat('saako kahvin tilalle jotain muuta?');
  assert.match(none.reply, /En löytänyt ostoslistalta riviä/); assert.equal(cards(none, 'comparison').length, 0);
  // a dish name is not an ingredient: it leads to a recommendation for that day
  const dish = await chat('saako makaronilaatikon tilalle jotain muuta?');
  assert.equal(cards(dish, 'comparison').length, 0); assert.ok(choices(dish).length);
});

// ---------- accounts without a menu, and the three languages ----------

it('an account without a menu is told so, in every language', T, async () => {
  for (const [lang, re] of [['fi', /ei ole ruokalistaa/], ['sv', /ingen matsedel/], ['en', /no menu/]] as const) {
    for (const msg of ['saako makaronilaatikon tilalle hampurilaista?', 'suosittele maanantaille jotain mitä on tilattavissa', 'saako makaronin tilalle jotain muuta?']) {
      const before = JSON.stringify(S());
      const r = await chat(msg, lang);
      assert.match(r.reply, re, `${lang}: ${msg}`);
      assert.equal(r.cards.length, 0); assert.equal(JSON.stringify(S()), before);
    }
  }
});

it('recommendation and undo texts exist in Swedish and English too', T, async () => {
  await act({ type: 'load_demo_menu' });
  const sv = await chat('suosittele maanantaille jotain mitä on tilattavissa', 'sv');
  assert.match(sv.reply, /Jag rekommenderar/); assert.match(cards(sv, 'note')[0].title!, /Rekommendationer/);
  const en = await chat('suosittele maanantaille jotain mitä on tilattavissa', 'en');
  assert.match(en.reply, /I recommend/); assert.ok(choices(en).every(o => /Estimated price/.test(o.facts![0])));
  await act({ type: 'skip_day', date: days()[MON].id });
  assert.match((await act({ type: 'undo' }, 'sv')).reply, /Ångrat/);
  await act({ type: 'skip_day', date: days()[MON].id });
  const state = (await act({ type: 'show_plan' }, 'en')).state;
  assert.match(state.undo!.label, /Dish removed/); // skip_day is "Remove dish" in the UI; the undo label uses the same verb
  assert.match((await act({ type: 'undo' }, 'en')).reply, /Undone/);
});

// ---------- routing: with and without a model ----------

const toolCall = (name: string, args: unknown) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });

it('the model picks the new tools; the code does the rest', T, async () => {
  await act({ type: 'load_demo_menu' });
  config.llm.apiKey = 'offline-test';
  reply = () => toolCall('change_dish', { new_dish: 'lohikeitto', current_dish: 'makaronilaatikko' });
  assert.match((await chat('x')).reply, /Vaihdoin/); assert.equal(days()[MON].recipeId, 'lohikeitto');
  reply = () => toolCall('change_dish', { new_dish: 'hampurilainen', weekday: 'tue' });
  const before = JSON.stringify(S());
  assert.match((await chat('y')).reply, /ei ole keittiön hyväksyttyä reseptiä/); assert.equal(JSON.stringify(S()), before);
  reply = () => toolCall('recommend_dish', { weekday: 'wed' });
  assert.ok(choices(await chat('z')).length); assert.equal(JSON.stringify(S()), before);
  reply = () => toolCall('ingredient_alternatives', { ingredient: 'riisi' });
  assert.equal(cards(await chat('q'), 'comparison').length, 1);
  // a model that answers with text only does not take the phrasings away
  reply = () => ({ content: 'Voin auttaa ostoksissa.' });
  assert.ok(choices(await chat('Saatko suositeltua maanantaille jotain mitä tilattavissa?')).length);
});

it('the earlier chat routing is unchanged, with the model stub and without a model', T, async () => {
  const messages: [string, (r: TurnResponse) => void, unknown][] = [
    ['Tilaa 20 kg riisiä ja 10 l ruokakermaa perjantaiksi', r => { assert.equal(r.state.orders.length, 1); assert.equal(r.state.orders[0].status, 'pending_approval'); },
      toolCall('quick_order', { items: [{ product: 'riisi', amount: 20, unit: 'kg' }, { product: 'ruokakerma', amount: 10, unit: 'l' }], weekday: 'fri' })],
    ['I need 1,000 litres of lactose-free milk by Monday. Find an option that meets our requirements based on price and availability.', r => { assert.equal(r.state.orders.length, 1); assert.ok(r.state.orders[0].lines.every(l => l.checks.some(c => c.requirement === 'lactose_free'))); },
      toolCall('quick_order', { items: [{ product: 'maitojuoma', amount: 1000, unit: 'l', requirements: [] }], weekday: 'mon' })],
    ['Etsi raaka-aineet: sokeri, jauhoseos', r => { assert.equal(r.state.orders.length, 0); assert.equal(cards(r, 'products').length, 2); }, {}],
    ['Meillä on 350 lounasta päivässä, joista 20 gluteenitonta ja 8 vehnätöntä', r => { assert.equal(r.state.kitchen.portionsTotal, 350); assert.deepEqual(r.state.kitchen.groups.map(g => g.count), [20, 8]); },
      toolCall('set_portions', { total: 350, gluten_free: 20, wheat_free: 8 })],
    ['Etsi halvempi vaihtoehto muuttamatta ruokavaliovaatimuksia', r => { assert.ok(r.cards.length); assert.equal(r.state.undo, undefined); }, toolCall('find_cheaper', {})],
  ];
  for (const key of ['', 'offline-test']) for (const [msg, check, call] of messages) {
    resetState(); await act({ type: 'load_demo_menu' });
    config.llm.apiKey = key; reply = () => (key ? call as any : {});
    const r = await chat(msg);
    check(r);
  }
});

it('model and keyword paths agree on the three new phrasings', T, async () => {
  const phrases = ['saako makaronilaatikon tilalle hampurilaista?', 'Saatko suositeltua maanantaille jotain mitä tilattavissa?', 'saako makaronin tilalle jotain muuta?'];
  for (const msg of phrases) {
    await act({ type: 'load_demo_menu' });
    config.llm.apiKey = '';
    const kw = await chat(msg);
    config.llm.apiKey = 'offline-test';
    reply = () => (/hampuri/.test(msg) ? toolCall('change_dish', { new_dish: 'hampurilainen', current_dish: 'makaronilaatikko' }) : /suosit/.test(msg) ? toolCall('recommend_dish', { weekday: 'mon' }) : toolCall('ingredient_alternatives', { ingredient: 'makaroni' }));
    const withModel = await chat(msg);
    assert.equal(withModel.cards.map(c => c.type).join(), kw.cards.map(c => c.type).join(), msg);
    assert.equal(choices(withModel).map(o => o.recipeId).join(), choices(kw).map(o => o.recipeId).join(), msg);
  }
});

// ---------- review round: diet requirement, refusals, left-out needs, main dishes ----------

/** the model stub picks this tool, whatever the message says */
const asModel = (name: string, args: unknown) => { config.llm.apiKey = 'offline-test'; reply = () => toolCall(name, args); };

it('a diet group without a matching line is asked about; another group’s products are never shown as checked', T, async () => {
  await act({ type: 'load_demo_menu' }); // no special groups: "Makaroni" serves standard portions only
  const before = JSON.stringify(S());
  const asked = (r: TurnResponse, why: string) => {
    assert.equal(cards(r, 'comparison').length, 0, `${why}: no comparison card`);
    assert.equal(JSON.stringify(S()), before, `${why}: nothing changed`);
  };
  const kw = await chat('Saako gluteenittoman makaronin tilalle jotain muuta?');
  asked(kw, 'keyword');
  assert.match(kw.reply, /ei ole riviä .* joka palvelisi ruokavaliota gluteeniton/); assert.match(kw.reply, /muuttanut mitään/);
  for (const [lang, msg, ingredient, re] of [
    ['fi', 'Saako gluteenittoman makaronin tilalle jotain muuta?', 'makaroni', /palvelisi ruokavaliota/],
    ['sv', 'Kan den glutenfria makaronen bytas mot något annat?', 'makaroner', /tjänar kosten/],
    ['en', 'Can the gluten-free macaroni be replaced with something else?', 'macaroni', /serves gluten-free/],
  ] as const) {
    asModel('ingredient_alternatives', { ingredient });
    const r = await chat(msg, lang);
    asked(r, `model ${lang}`); assert.match(r.reply, re);
  }
  // the same words with a matching group still work
  resetState(); await act({ type: 'load_demo_menu' });
  await act({ type: 'set_portions', total: 350, groups: [{ requirement: 'gluten_free', count: 20 }] });
  config.llm.apiKey = '';
  const after = JSON.stringify(S());
  const gf = await chat('Saako gluteenittoman makaronin tilalle jotain muuta?');
  assert.equal(JSON.stringify(S()), after);
  const card = cards(gf, 'comparison')[0];
  assert.ok(card?.items.length, gf.reply);
  assert.ok(card.current!.checks.some(c => c.requirement === 'gluten_free'));
  for (const a of card.items) assert.ok(a.checks.some(c => c.requirement === 'gluten_free' && c.verdict === 'ok'));
  // two requirements: a line that serves only one of them does not count
  const both = await chat('Saako gluteenittoman ja vehnättömän makaronin tilalle jotain muuta?');
  assert.equal(cards(both, 'comparison').length, 0); assert.match(both.reply, /palvelisi ruokavaliota gluteeniton \+ vehnätön/);
  assert.equal(JSON.stringify(S()), after);
});

it('"do not change" in fi/sv/en changes nothing, with and without a model, and leaves the log alone', T, async () => {
  await act({ type: 'load_demo_menu' });
  const before = JSON.stringify(S()), entries = S().audit.length;
  const messages: [Lang, string, RegExp][] = [
    ['fi', 'Älä vaihda maanantain ruokaa lohikeittoon', /en vaihtanut mitään/],
    ['en', 'Do not change Monday\'s dish to salmon soup', /I changed nothing/],
    ['sv', 'Byt inte måndagens mat till laxsoppa', /jag bytte ingenting/],
    ['fi', 'Makaronilaatikkoa ei saa vaihtaa lohikeittoon', /en vaihtanut mitään/],
    ['en', 'Please don\'t replace the macaroni casserole with salmon soup', /I changed nothing/],
    ['sv', 'Vi vill inte byta måndagens rätt till laxsoppa', /jag bytte ingenting/],
  ];
  for (const key of ['', 'offline-test']) for (const [lang, msg, re] of messages) {
    config.llm.apiKey = key;
    reply = () => (key ? toolCall('change_dish', { new_dish: 'lohikeitto', current_dish: 'makaronilaatikko', weekday: 'mon' }) : {});
    const r = await chat(msg, lang);
    const why = `${key ? 'model' : 'keywords'}: ${msg}`;
    assert.match(r.reply, re, why); assert.equal(r.cards.length, 0, why);
    assert.equal(JSON.stringify(S()), before, `${why}: state untouched`);
    assert.equal(S().audit.length, entries, `${why}: log untouched`); assert.equal(S().undo.length, 0, why);
    assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko', why);
  }
  // the phrasings that are not refusals still change the day
  config.llm.apiKey = '';
  for (const msg of ['Change Monday\'s dish to salmon soup', 'Don\'t worry, change Monday\'s dish to salmon soup']) {
    const r = await chat(msg, 'en');
    assert.match(r.reply, /I changed/, msg); assert.equal(days()[MON].recipeId, 'lohikeitto', msg);
    await act({ type: 'undo' }, 'en'); assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
  }
});

it('needs the user left out are shown in a recommendation, which is limited to the day’s ingredients', T, async () => {
  const r0 = await demo();
  for (const i of open(r0)) await act({ type: 'skip_issue', issueId: i.id });
  assert.deepEqual([...S().skipped].sort(), ['jauho|wheat_free', 'leipa|wheat_free', 'liemi|wheat_free']);
  const before = JSON.stringify(S());
  const [e] = await estimateRecipes([recipeById('lohikeitto')!], days()[MON].id, 'fi');
  assert.equal(e.openCount, 0, 'no open question, but ...');
  assert.equal(e.skipped.length, 2, `... two left-out needs: ${e.skipped}`);
  assert.ok(e.skipped.some(x => /Kasvisliemi/.test(x)) && e.skipped.some(x => /Leipä/.test(x)));
  for (const [lang, msg, left, scope, notReady] of [
    ['fi', 'suosittele maanantaille jotain mitä on tilattavissa', /Aiemmin pois jätetyt tarpeet .*Leipä/, /vain tämän päivän raaka-aineita: koko viikon saatavuus ja tilausvaltuus tarkistetaan erikseen/, /Yhdenkään päivän raaka-aineet eivät ole täysin valmiit/],
    ['sv', 'suosittele maanantaille jotain mitä on tilattavissa', /Tidigare utelämnade behov .*Bröd/, /bara dagens råvaror/, /Inget av dem har helt klara råvaror/],
    ['en', 'suggest something for Monday that we can order', /Needs left out earlier .*Bread/, /only this day’s ingredients: availability for the whole week and the ordering authority/, /None has fully ready ingredients/],
  ] as const) {
    const r = await chat(msg, lang);
    const options = choices(r);
    assert.ok(options.length, lang);
    for (const o of options) { assert.match(o.why, left, `${lang}: ${o.recipeId}`); assert.doesNotMatch(o.why, /Ei ratkaistavia|Inget att lösa|Nothing to resolve/); }
    assert.match(r.reply, scope, lang); assert.match(r.reply, notReady, lang);
  }
  assert.equal(JSON.stringify(S()), before, 'recommending and estimating change nothing');
  // without left-out needs the same recommendation does say that the day's ingredients are ready
  resetState(); await act({ type: 'load_demo_menu' });
  const clean = await chat('suosittele maanantaille jotain mitä on tilattavissa');
  assert.ok(choices(clean).some(o => /Ei ratkaistavia asioita päivän osalta/.test(o.why)));
  assert.match(clean.reply, /on päivän raaka-aineiden osalta valmis/);
});

it('a main-dish recommendation never offers a drink or a dessert, which stay in the approved book', T, async () => {
  await act({ type: 'load_demo_menu' });
  const before = JSON.stringify(S());
  const notMain = ['alkumalja', 'mansikkakakku', 'lisukkeet'];
  for (const [lang, msg] of [['fi', 'suosittele maanantaille jotain mitä on tilattavissa'], ['sv', 'föreslå något för måndag som går att beställa'], ['en', 'suggest something for Monday that we can order']] as const) {
    const options = choices(await chat(msg, lang));
    assert.ok(options.length, lang);
    assert.ok(options.every(o => !notMain.includes(o.recipeId)), `${lang}: ${options.map(o => o.recipeId)}`);
  }
  for (const wd of ['mon', 'tue', 'wed', 'thu', 'fri']) {
    asModel('recommend_dish', { weekday: wd });
    const options = choices(await chat('x'));
    assert.ok(options.every(o => !notMain.includes(o.recipeId)), `${wd}: ${options.map(o => o.recipeId)}`);
  }
  assert.equal(JSON.stringify(S()), before, 'only reading');
  // The approved book still contains event courses, but weekly selection rejects them.
  assert.ok(['alkumalja', 'mansikkakakku'].every(id => mainRecipes().some(r => r.id === id)));
  assert.equal(matchRecipe('Alkoholiton kuohujuoma').recipe?.id, 'alkumalja'); assert.equal(matchRecipe('Mansikkakakku').recipe?.id, 'mansikkakakku');
  config.llm.apiKey = '';
  await assert.rejects(() => act({ type: 'confirm_recipe', date: days()[MON].id, recipeId: 'alkumalja' }), /does not match the course role/);
  const named = await chat('saako makaronilaatikon tilalle mansikkakakkua?');
  assert.equal(days()[MON].recipeId, 'lihamakaronilaatikko');
  assert.ok(choices(named).every(o => !notMain.includes(o.recipeId)));
});
