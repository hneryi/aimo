// Layout fixture, only loaded when the URL has ?fixture=1 (no backend needed). Not a model of the server.
import type {
  AgentInfo,
  AllergenCheck,
  Alternative,
  Card,
  DashboardState,
  Draft,
  DraftLine,
  Issue,
  Lang,
  MenuDay,
  Offer,
  Order,
  Plan,
  PlanLine,
  ProfileInfo,
  ProductView,
  TurnResponse,
  UiAction,
  WeekMenu,
} from './types';

const NOW = '2026-11-14T10:12:00+02:00';

const product = (id: string, name: string, p: Partial<ProductView> = {}): ProductView => ({
  id,
  name,
  salesUnit: 'SK',
  unitLabel: 'säkki',
  packSize: { value: 5, unit: 'kg' },
  packLabel: '5 kg / säkki',
  declared: { contains: [], mayContain: [], freeFrom: [] },
  claims: [],
  hasIngredientList: true,
  hasAllergenDeclaration: true,
  dataUpdated: '2026-10-02',
  ...p,
});

const offer = (price: number | undefined, cmp: number | undefined, o: Partial<Offer> = {}): Offer => ({
  source: 'valio_mock',
  observedAt: NOW,
  price,
  comparisonPrice: cmp,
  comparisonUnit: 'kg',
  vatRate: 14,
  availability: 'available',
  availabilityLabel: 'Saatavilla ma 16.11.',
  ...o,
});

const wheatFail: AllergenCheck = {
  requirement: 'wheat_free',
  requirementLabel: 'Vehnätön',
  verdict: 'fail',
  summary: 'Ei sovi vehnättömään: sisältää gluteenitonta vehnätärkkelystä.',
  evidence: [
    { kind: 'ingredient', tone: 'fail', text: 'Ainesosissa: gluteeniton vehnätärkkelys' },
    { kind: 'declared', tone: 'fail', text: 'Toimittaja ilmoittaa: sisältää vehnää' },
    { kind: 'claim', tone: 'info', text: 'Pakkauksessa merkintä "Gluteeniton" – ei tarkoita vehnätöntä' },
  ],
};
const wheatOk: AllergenCheck = {
  requirement: 'wheat_free',
  requirementLabel: 'Vehnätön',
  verdict: 'ok',
  summary: 'Sopii vehnättömään: ei vehnää ainesosissa eikä allergeeni-ilmoituksessa.',
  evidence: [
    { kind: 'ingredient', tone: 'ok', text: 'Ainesosat: maissijauho, riisijauho' },
    { kind: 'declared', tone: 'ok', text: 'Ei ilmoitettua vehnää' },
  ],
};
const glutenOk: AllergenCheck = {
  requirement: 'gluten_free',
  requirementLabel: 'Gluteeniton',
  verdict: 'ok',
  summary: 'Sopii gluteenittomaan.',
  evidence: [{ kind: 'claim', tone: 'ok', text: 'Merkintä: Gluteeniton' }],
};
const wheatUnknown: AllergenCheck = {
  requirement: 'wheat_free',
  requirementLabel: 'Vehnätön',
  verdict: 'unknown',
  summary: 'Tieto puuttuu: toimittaja ei ole ilmoittanut ainesosaluetteloa.',
  evidence: [{ kind: 'missing', tone: 'unknown', text: 'Ainesosaluettelo puuttuu toimittajan tiedoista' }],
};

const pMacGf = product('p-mac-gf', 'Gluteeniton makaroni vehnätärkkelyksestä, suurkeittiöpakkaus', {
  brand: 'Pastamestari',
  ingredients: 'Gluteeniton VEHNÄtärkkelys, maissitärkkelys, emulgointiaine (E471).',
  declared: { contains: ['vehnä'], mayContain: [], freeFrom: ['gluteeni'] },
  claims: ['Gluteeniton'],
});
const pMacCorn = product('p-mac-corn', 'Maissi-riisimakaroni, gluteeniton ja vehnätön', {
  brand: 'Luontaistila',
  ingredients: 'Maissijauho (70 %), riisijauho.',
  declared: { contains: [], mayContain: [], freeFrom: ['gluteeni', 'vehnä'] },
  claims: ['Gluteeniton', 'Vehnätön'],
  deliveryReliability: 0.98,
  co2PerKg: 1.4,
});
const pMacLentil = product('p-mac-lentil', 'Linssipasta fusilli', {
  brand: 'Palko',
  packSize: { value: 3, unit: 'kg' },
  packLabel: '3 kg / laatikko',
  unitLabel: 'laatikko',
  ingredients: 'Punainen linssijauho.',
});
const pMacNoData = product('p-mac-x', 'Riisipasta penne (tiedot puutteelliset)', {
  hasIngredientList: false,
  hasAllergenDeclaration: false,
  packSize: undefined,
  packLabel: 'pakkauskoko ei tiedossa',
});
const pMac = product('p-mac', 'Makaroni, tumma 10 kg', {
  packSize: { value: 10, unit: 'kg' },
  packLabel: '10 kg / säkki',
  ingredients: 'Durumvehnä, vesi.',
  declared: { contains: ['vehnä', 'gluteeni'], mayContain: ['kananmuna'], freeFrom: [] },
});
const pMilk = product('p-milk', 'Valio Eila laktoositon kevytmaitojuoma 10 L hanapakkaus', {
  brand: 'Valio',
  unitLabel: 'laatikko',
  packSize: { value: 10, unit: 'L' },
  packLabel: '10 L / laatikko',
  ingredients: 'Laktoositon kevytMAITO, D-vitamiini.',
  declared: { contains: ['maito'], mayContain: [], freeFrom: ['laktoosi'] },
  claims: ['Laktoositon'],
});
const pMince = product('p-mince', 'Naudan jauheliha 10 % pakaste', {
  unitLabel: 'laatikko',
  packLabel: '5 kg / laatikko',
  ingredients: 'Naudanliha (Suomi).',
});

const alts: Alternative[] = [
  { product: pMacCorn, offer: offer(18.4, 3.68), checks: [wheatOk, glutenOk], suitable: true, note: '0,62 €/kg halvempi' },
  {
    product: pMacLentil,
    offer: offer(15.9, 5.3, { availability: 'limited', availabilityLabel: 'Rajoitetusti: 4 laatikkoa' }),
    checks: [wheatOk, glutenOk],
    suitable: true,
  },
  {
    product: pMacNoData,
    offer: offer(undefined, undefined, { availability: 'no_data', availabilityLabel: 'Saatavuustieto puuttuu' }),
    checks: [wheatUnknown],
    suitable: false,
  },
];

const eventMenu = (): WeekMenu => ({
  kind: 'event',
  weekStart: '2026-11-21',
  weekLabel: 'Häät Kaislassa · 120 vierasta',
  source: { filename: 'haamenu-kaisla.xlsx', kind: 'xlsx', importedAt: NOW },
  warnings: [],
  days: [
    { id: '2026-11-21#1', label: 'Alkuruoka', date: '2026-11-21', weekday: 'sat', weekdayLabel: 'Lauantai', dishName: 'Graavilohi ja mallasleipä', match: 'confirmed', recipeId: 'r3', recipeName: 'Graavilohi', portions: 120 },
    { id: '2026-11-21#2', label: 'Pääruoka', date: '2026-11-21', weekday: 'sat', weekdayLabel: 'Lauantai', dishName: 'Karitsan paisti ja juurekset', match: 'suggested', suggestion: { recipeId: 'r2', recipeName: 'Karitsanpaisti', why: 'lähin hyväksytty resepti' }, portions: 120 },
    { id: '2026-11-21#3', label: 'Jälkiruoka', date: '2026-11-21', weekday: 'sat', weekdayLabel: 'Lauantai', dishName: 'Mustikkapannacotta', match: 'missing', portions: 120 },
  ],
});

const menu = (): WeekMenu => ({
  kind: 'week',
  weekStart: '2026-11-16',
  weekLabel: 'Viikko 47 · 16.–20.11.',
  source: { filename: 'ruokalista-vko47.xlsx', kind: 'xlsx', importedAt: NOW },
  warnings: ['Perjantain riviltä puuttui annosmäärä – käytin keittiön oletusta.'],
  days: [
    { id: '2026-11-16', date: '2026-11-16', weekday: 'mon', weekdayLabel: 'Maanantai', dishName: 'Makaronilaatikko', match: 'confirmed', recipeId: 'r1', recipeName: 'Makaronilaatikko (koulu)', portions: 350, dietNotes: ['G', 'VE'] },
    { id: '2026-11-17', date: '2026-11-17', weekday: 'tue', weekdayLabel: 'Tiistai', dishName: 'Broileri-kasviskiusaus', match: 'suggested', suggestion: { recipeId: 'r2', recipeName: 'Broilerikiusaus', why: 'nimi vastaa lähes täysin ja pääraaka-aineet ovat samat' }, portions: 350, importedPortions: 340 },
    { id: '2026-11-18', date: '2026-11-18', weekday: 'wed', weekdayLabel: 'Keskiviikko', dishName: 'Kalapuikot ja perunasose', match: 'confirmed', recipeId: 'r3', recipeName: 'Kalapuikot ja perunasose', portions: 350 },
    { id: '2026-11-19', date: '2026-11-19', weekday: 'thu', weekdayLabel: 'Torstai', dishName: 'Kasvissosekeitto ja ohrarieska', match: 'missing', portions: 350 },
    { id: '2026-11-20', date: '2026-11-20', weekday: 'fri', weekdayLabel: 'Perjantai', dishName: 'Jauhelihakastike ja perunat', match: 'skipped', removedDish: 'Jauhelihakastike ja perunat', portions: 350 },
  ],
});

const line = (id: string, p: ProductView, o: Offer, l: Partial<PlanLine>): PlanLine => ({
  id,
  product: p,
  offer: o,
  ingredient: 'Makaroni',
  needed: 27.4,
  unit: 'kg',
  fromStock: 0,
  orderQty: 3,
  orderedAmount: 30,
  lineTotal: (o.price ?? 0) * 3,
  groupLabels: ['Perusannokset'],
  uses: [
    { date: '2026-11-16', weekdayLabel: 'Maanantai', recipeName: 'Makaronilaatikko (koulu)', ingredient: 'Makaroni', groupLabel: 'Perusannokset', amount: 27.4, unit: 'kg' },
  ],
  checks: [],
  status: 'ok',
  why: 'Keittiön vakiotuote tälle raaka-aineelle, edullisin kilohinta.',
  ...l,
});

const issue1 = (): Issue => ({
  id: 'al|makaroni|wheat_free',
  kind: 'allergen_fail',
  severity: 'block',
  title: 'Gluteeniton makaroni ei sovi vehnättömille',
  detail: 'Maanantain makaronilaatikon vehnättömiin annoksiin valittu tuote sisältää vehnätärkkelystä.',
  date: '2026-11-16',
  recipeName: 'Makaronilaatikko (koulu)',
  ingredient: 'Makaroni',
  groupLabel: 'Vehnätön · 8 annosta',
  product: pMacGf,
  check: wheatFail,
  alternatives: alts,
  resolved: false,
});
const issue2 = (): Issue => ({
  id: 'i2',
  kind: 'suggested_recipe',
  severity: 'warn',
  title: 'Tiistain resepti odottaa vahvistusta',
  detail: 'Broileri-kasviskiusaus ei löytynyt sellaisenaan keittiön resepteistä.',
  date: '2026-11-17',
  recipeOptions: [{ recipeId: 'r2', recipeName: 'Broilerikiusaus', why: 'Nimi vastaa lähes täysin.' }],
  resolved: false,
});

const plan = (): Plan => ({
  id: 'plan-1',
  weekStart: '2026-11-16',
  weekLabel: 'Viikko 47 · 16.–20.11.',
  createdAt: NOW,
  deliveryDate: '2026-11-16',
  deliveryLabel: 'ma 16.11.',
  lines: [
    line('l1', pMacGf, offer(21.5, 4.3), { status: 'blocked', groupLabels: ['Gluteeniton', 'Vehnätön'], checks: [glutenOk, wheatFail], needed: 2.2, orderQty: 1, orderedAmount: 5, lineTotal: 21.5, why: 'Keittiön aiemmin käyttämä gluteeniton makaroni.' }),
    line('l2', pMilk, offer(11.2, 1.12, { comparisonUnit: 'L', availability: 'limited', availabilityLabel: 'Rajoitetusti: 6 laatikkoa', closingTime: '2026-11-15T12:00:00+02:00' }), { status: 'warning', ingredient: 'Maito', unit: 'L', needed: 64, fromStock: 10, orderQty: 6, orderedAmount: 60, lineTotal: 67.2, groupLabels: ['Perusannokset', 'Laktoositon'], changed: 'Vaihdettu 1 L tölkeistä 10 L hanapakkaukseen: sama tuote, halvempi litrahinta.' }),
    line('l3', pMac, offer(14.9, 1.49), { lineTotal: 44.7 }),
    line('l4', pMince, offer(42.0, 8.4, { cutoffPassed: true, closingTime: '2026-11-13T12:00:00+02:00' }), { ingredient: 'Jauheliha', needed: 38, orderQty: 8, orderedAmount: 40, lineTotal: 336 }),
  ],
  issues: [issue1(), issue2()],
  totals: { net: 469.4, vat: 65.72, gross: 535.12, lineCount: 4 },
  ready: false,
});

// Intentionally a legacy order without a quote: layout fixtures must not fake a verified signature.
const order = (): Order => ({
  id: 'AIMO-2026-0012',
  status: 'pending_approval',
  statusLabel: 'Odottaa hyväksyntää',
  createdAt: NOW,
  createdBy: 'Keittiö (UI)',
  source: 'ui',
  title: 'Viikon 47 tilaus',
  deliveryDate: '2026-11-16',
  deliveryLabel: 'ma 16.11.',
  lines: [
    { productId: 'p-mac-corn', name: pMacCorn.name, qty: 1, unitLabel: 'säkki', packLabel: '5 kg / säkki', unitPrice: 18.4, lineTotal: 18.4, groupLabels: ['Gluteeniton', 'Vehnätön'], checks: [glutenOk, wheatOk], why: 'Korvaa gluteenittoman vehnätärkkelysmakaronin.' },
    { productId: 'p-milk', name: pMilk.name, qty: 6, unitLabel: 'laatikko', packLabel: '10 L / laatikko', unitPrice: 11.2, lineTotal: 67.2, groupLabels: ['Perusannokset'], checks: [] },
  ],
  totals: { net: 466.3, vat: 65.28, gross: 531.58, lineCount: 4 },
  approval: { required: true, reasons: ['Summa 466,30 € ylittää omavaltuuden 400,00 €.', 'Tilauksessa on erityisruokavaliotuote, joka vaihdettiin.'] },
  recheck: { at: NOW, ok: true, changes: ['Maitojuoman hinta nousi 0,10 € / laatikko.'] },
  integration: { prices: 'valio_mock', availability: 'valio_mock', submission: 'local_simulation', note: 'Hinnat ja saatavuus haettiin Valio Aimon mock-rajapinnasta. Tilausta ei lähetetä oikeaan järjestelmään – se kirjataan paikalliseen simulaatioon.' },
  events: [
    { at: NOW, actor: 'Aimo', text: 'Tilausehdotus luotu ostoslistasta.' },
    { at: NOW, actor: 'Aimo', text: 'Tarvitsee hyväksynnän: summa ylittää omavaltuuden.' },
  ],
});

interface Db {
  menu?: WeekMenu;
  plan?: Plan;
  orders: Order[];
  confirmed: boolean;
  credit: number | null;
  /** the menu (null: none) and plan as they were before each edit (the fixture's undo stack) */
  undo?: { label: string; menu: WeekMenu | null; plan?: Plan }[];
  /** removed entries as they were before the removal, for restore_day */
  removedDays?: Record<string, MenuDay>;
  /** lines removed from the plan, for restore_line */
  removedLines?: PlanLine[];
  /** open order cards; `active` is the one additions go to */
  drafts: FxDraft[];
  active?: string;
}

interface FxDraft {
  id: string;
  name: string;
  deliveryDate: string;
  lines: DraftLine[];
}

const PROFILES: ProfileInfo[] = [
  { id: 'school', name: 'Kivimäen koulun keittiö', kind: 'school', description: 'Koululounas, 350 annosta päivässä' },
  { id: 'wedding', name: 'Pitopalvelu Kaisla', kind: 'event', description: 'Häät ja juhlat, menu tilaisuuden mukaan' },
  { id: 'hotel', name: 'Hotelli Satama, ravintola', kind: 'restaurant', description: 'Lounas ja aamiainen, viikkolista' },
];

// each account has its own menu, plan, orders and limits
const dbs: Record<string, Db> = {};
let active = 'school';
let db: Db = { orders: [], confirmed: false, credit: null, drafts: [] };
function use(profile: string | undefined): void {
  active = PROFILES.some((p) => p.id === profile) ? (profile as string) : 'school';
  db = dbs[active] ??= { orders: [], confirmed: false, credit: active === 'wedding' ? 5000 : null, drafts: [] };
}

function state(lang: Lang): DashboardState {
  const open = db.plan?.issues.filter((i) => !i.resolved) ?? [];
  const profile = PROFILES.find((p) => p.id === active) ?? PROFILES[0];
  const used = db.orders.reduce((sum, o) => sum + (o.status === 'rejected' || o.status === 'cancelled' ? 0 : o.totals.net), 0);
  return {
    profile,
    profiles: PROFILES,
    lang,
    now: NOW,
    kitchen: {
      name: profile.name,
      kind: profile.kind,
      portionLabel: profile.kind === 'event' ? 'vierasta' : 'annosta päivässä',
      portionsTotal: profile.kind === 'event' ? 120 : 350,
      standardCount: 322,
      groups: [
        { id: 'gluten_free', label: 'Gluteeniton', requirements: ['gluten_free'], count: 20 },
        { id: 'wheat_free', label: 'Vehnätön', requirements: ['wheat_free'], count: 8 },
      ],
      portionsConfirmed: db.confirmed,
      authority: {
        autoApproveLimit: 400,
        agentAutoLimit: 150,
        weeklyBudget: 1200,
        spentThisWeek: 310,
        creditLimit: db.credit ?? undefined,
        creditUsed: used,
        creditAvailable: db.credit === null ? undefined : db.credit - used,
        rules: [
          { id: 'r-auto', effect: 'auto', text: 'Agentti saa tilata itse, kun summa on enintään 150 € ja kaikki allergeenit on varmistettu.' },
          { id: 'r-human1', effect: 'human', text: 'Yli 400 € tilaus tarvitsee keittiön hyväksynnän.' },
          { id: 'r-human2', effect: 'human', text: 'Erityisruokavaliotuotteen vaihto vahvistetaan aina ihmisellä.' },
          { id: 'r-never', effect: 'never', text: 'Tuotetta, jonka allergeenitieto puuttuu, ei koskaan tilata erityisruokavalioon.' },
        ],
      },
      memory: db.plan ? [{ id: 'm1', text: 'Vehnättömille käytetään maissi-riisimakaronia.', at: NOW }] : [],
    },
    menu: db.menu ? { ...db.menu, days: db.menu.days.map(d => ({ ...d, role: d.role ?? (db.menu?.kind === 'week' ? 'main' : undefined) })) } : undefined,
    plan: db.plan,
    draft: db.drafts.filter((d) => d.id === db.active && d.lines.length).map(draftView)[0],
    drafts: db.drafts.map(draftView),
    activeDraft: db.active,
    orders: db.orders,
    deliveries: db.orders.map((o) => ({ date: o.deliveryDate, label: o.deliveryLabel, orderId: o.id, status: o.status, statusLabel: o.statusLabel, lineCount: o.lines.length, total: o.totals.net })),
    attention: [
      ...db.orders
        .filter((o) => o.status === 'pending_approval')
        .map((o) => ({ id: `ord-${o.id}`, tone: 'block' as const, text: `Tilaus ${o.id} odottaa hyväksyntääsi`, action: { type: 'show_order', orderId: o.id } as UiAction })),
      ...open.map((i) => ({ id: i.id, tone: i.severity, text: i.title, action: { type: 'show_plan' } as UiAction })),
      ...(db.confirmed ? [] : [{ id: 'a-p', tone: 'info' as const, text: 'Annosmääriä ei ole vielä vahvistettu tälle viikolle.' }]),
    ],
    stock: [],
    recipes: [
      { id: 'r1', name: 'Makaronilaatikko (koulu)', ingredientCount: 7, role: 'main', names: ['makaronilaatikko koulu', 'makaronilaatikko', 'macaroni casserole'], hints: ['makaroni'] },
      { id: 'r2', name: 'Broilerikiusaus', ingredientCount: 8, role: 'main', names: ['broilerikiusaus', 'kycklinggratang', 'chicken gratin'], hints: ['broileri', 'kana'] },
      { id: 'r3', name: 'Kalapuikot ja perunasose', ingredientCount: 5, role: 'main', names: ['kalapuikot ja perunasose', 'fish fingers and mash'], hints: ['kala'] },
    ],
    agents: [],
    audit: db.menu ? [{ id: 'au1', at: NOW, actor: 'Keittiö (UI)', action: 'import', text: 'Ruokalista ruokalista-vko47.xlsx tuotu.', hash: '9f2c41ab' }] : [],
    integration: {
      valioMock: { ok: true, label: 'Hinnat ja saatavuus: Valio Aimo ‑mock-rajapinta (yhteys kunnossa)', checkedAt: NOW },
      llm: { ok: true, label: 'Kielimalli käytössä' },
      ordering: { label: 'Tilaus kirjataan paikalliseen simulaatioon' },
      access: { open: true, label: 'Avoin demotila: hyväksyjiä ei ole määritetty' },
    },
    undo: db.undo?.length ? { label: db.undo[db.undo.length - 1].label, steps: db.undo.length } : undefined,
    suggestions:
      profile.kind === 'event'
        ? ['Tee ostoslista häämenusta', 'Tilaa 70 alkoholitonta olutta lauantaiksi', 'Näytä tapahtumaloki']
        : ['Tee ostoslista', 'Näytä halvemmat vaihtoehdot', 'Mitä vehnättömille tilataan?', 'Näytä tapahtumaloki'],
  };
}

// Simulate an order arriving from an external agent (picked up by the UI's background poll): run
// `__fxAgentOrder()` in the browser console.
(window as unknown as { __fxAgentOrder: () => void }).__fxAgentOrder = () => {
  db.orders.push({ ...order(), id: 'AIMO-2026-0099', source: 'mcp', createdBy: 'Agentti: hotel-chain-agent', title: 'Agentin tilaus: laktoositon maito' });
};

function draftView(d: FxDraft): Draft {
  const net = d.lines.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0);
  const deliveryLabel = new Date(`${d.deliveryDate}T12:00:00`).toLocaleDateString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric' });
  return { id: d.id, name: d.name, deliveryDate: d.deliveryDate, deliveryLabel, lines: d.lines, totals: { net, vat: net * 0.14, gross: net * 1.14, lineCount: d.lines.length } };
}

let draftSeq = 0;
function newDraft(name?: string, date?: string): FxDraft {
  const d: FxDraft = { id: `fx-${++draftSeq}`, name: name || `Kortti ${draftSeq}`, deliveryDate: date || '2026-11-16', lines: [] };
  db.drafts.push(d);
  db.active = d.id;
  return d;
}
const findDraft = (id?: string) => db.drafts.find((d) => d.id === (id ?? db.active));
const draftCard = (d: FxDraft | undefined): Card[] => (d ? [{ type: 'draft', draft: draftView(d) }] : []);

const wait = () => new Promise((r) => setTimeout(r, 700));
/** record the fixture's undo step before an edit */
const remember = (label: string) => (db.undo ??= []).push({ label, menu: db.menu ? structuredClone(db.menu) : null, plan: db.plan ? structuredClone(db.plan) : undefined });
const fxRecipes = () => state('fi').recipes;
const syncPlanExtras = () => {
  if (!db.plan) return;
  db.plan.removedLines = db.removedLines?.length ? db.removedLines.map((l) => ({ id: l.id, name: l.product.name, ingredient: l.ingredient })) : undefined;
  const off = db.menu?.days.filter((d) => d.match === 'skipped' || d.match === 'custom') ?? [];
  db.plan.notCovered = off.length ? off.map((d) => ({ date: d.id, day: d.label ?? d.weekdayLabel, name: d.customName ?? d.removedDish ?? d.dishName, kind: d.match as 'skipped' | 'custom' })) : undefined;
  db.plan.ready = db.plan.issues.every((x) => x.resolved || x.severity !== 'block');
};
const turn = (reply: string, cards: Card[], lang: Lang): TurnResponse => ({ reply, cards, state: state(lang) });

export async function fxState(lang: Lang, profile?: string): Promise<DashboardState> {
  use(profile);
  return state(lang);
}

export async function fxAgentInfo(): Promise<AgentInfo> {
  return {
    mcpUrl: 'http://localhost:8787/mcp',
    token: 'aimo-demo-token-4f9c2a71b3',
    tokenNote: 'Yhteinen demotunnus: agentin nimi on itse ilmoitettu.',
    jwksUrl: 'http://localhost:8787/.well-known/jwks.json',
    tools: [
      { name: 'get_week_plan', description: 'Hakee viikon ostoslistan ja avoimet ongelmat.' },
      { name: 'propose_order', description: 'Tekee tilausehdotuksen; yli 150 € menee keittiön hyväksyttäväksi.' },
    ],
    note: 'Hinnat ja saatavuus tulevat Valio Aimon mock-rajapinnasta. Tilauksen lähetys on paikallinen simulaatio.',
  };
}

export async function fxSearch(q: string): Promise<Alternative[]> {
  await wait();
  return q.toLowerCase().includes('x') ? [] : [alts[1], alts[2]];
}

export async function fxChat(message: string, lang: Lang, profile?: string): Promise<TurnResponse> {
  await wait();
  use(profile);
  const m = message.toLowerCase();
  if (m.includes('olut')) {
    const beer = product('p-beer', 'Alkoholiton lager-olut 0,33 l tölkki', { packSize: undefined, packLabel: '', unitLabel: 'kpl', hasIngredientList: false, hasAllergenDeclaration: false });
    return turn('Löysin alkoholittoman oluen. Tässä vaihtoehto.', [
      { type: 'products', title: '70 alkoholitonta olutta lauantaiksi', items: [{ product: beer, offer: offer(0.95, undefined, { comparisonUnit: undefined }), checks: [], suitable: true, note: '0,95 €/kpl · 24 kpl / laatikko' }] },
    ], lang);
  }
  if (m.includes('virhe')) throw new Error('fixture error');
  if (m.includes('raaka')) {
    return turn('Etsin tuotteet omasta raaka-ainelistastasi. Lisää haluamasi tarkistetut tuotteet valitulle tilauskortille.', [
      { type: 'note', tone: 'info', title: 'Oma raaka-ainelistasi', text: 'Mitään ei ole tilattu eikä lisätty tilauskortille.' },
      { type: 'products', title: '2 kg · makaroni', subtitle: 'Gluteeniton, Vehnätön', items: [alts[0], alts[1]], ingredient: { name: 'makaroni', amount: '2 kg', status: 'found' } },
      { type: 'products', title: 'pasta', subtitle: '”pasta” vastaa 4 eri tuotetyyppiä. Valitse tarkoittamasi tuote; mitään ei tilattu.', items: [alts[0], alts[1]], ingredient: { name: 'pasta', status: 'choose', reason: '”pasta” vastaa 4 eri tuotetyyppiä. Valitse tarkoittamasi tuote; mitään ei tilattu.' } },
      { type: 'products', title: 'kuohukerma', subtitle: 'Valio kuohukerma: Tieto puuttuu: vehnätön.', items: [], ingredient: { name: 'kuohukerma', status: 'none', reason: 'Valio kuohukerma: Tieto puuttuu: vehnätön. Ilmoituksessa ei kerrota vehnästä.' } },
    ], lang);
  }
  if (m.includes('loki')) return fxAction({ type: 'show_audit' }, lang, profile);
  if (m.includes('ostoslista') || m.includes('tilaus')) return fxAction({ type: 'build_plan' }, lang, profile);
  if (m.includes('halv')) return fxAction({ type: 'find_cheaper', lineId: 'l3' }, lang, profile);
  return turn('Tässä sopivat tuotteet. Merkitsin, mitkä on varmistettu toimittajan tiedoista.', [
    { type: 'products', title: 'Makaronit vehnättömille', subtitle: 'Tarkistettu: vehnätön, gluteeniton', items: alts },
    { type: 'note', tone: 'info', title: 'Hyvä tietää', text: 'Gluteeniton ei aina tarkoita vehnätöntä: gluteeniton vehnätärkkelys on yhä vehnää.' },
  ], lang);
}

export async function fxAction(action: UiAction, lang: Lang, profile?: string): Promise<TurnResponse> {
  await wait();
  use(profile);
  switch (action.type) {
    case 'agent_create':
    case 'agent_update':
    case 'agent_revoke':
      return turn('Agenttien hallinta ei ole mukana asettelunäkymässä.', [], lang);
    case 'set_credit_limit':
      db.credit = action.limit;
      return turn(action.limit === null ? 'Luottoraja poistettu.' : 'Luottoraja päivitetty.', [], lang);
    case 'skip_issue': {
      const i = db.plan?.issues.find((x) => x.id === action.issueId);
      if (db.plan && i) {
        i.resolved = true;
        i.resolution = 'Jätetty pois tilauksesta. Keittiö hoitaa tuotteen erikseen.';
        db.plan.lines = db.plan.lines.filter((l) => l.product.id !== i.product?.id);
        db.plan.ready = db.plan.issues.every((x) => x.resolved || x.severity !== 'block');
      }
      return turn('Jätin tuotteen pois tilauksesta.', db.plan && i ? [{ type: 'issue', issue: i }, { type: 'plan', plan: db.plan }] : [], lang);
    }
    case 'reset_demo':
      db.menu = undefined;
      db.plan = undefined;
      db.orders = [];
      db.drafts = [];
      db.active = undefined;
      db.confirmed = false;
      return turn('Demo on nollattu.', [], lang);
    case 'load_demo_menu':
    case 'show_menu':
      db.menu ??= active === 'wedding' ? eventMenu() : menu();
      return turn('Luin ruokalistan. Kaksi kohtaa kaipaa vielä katsettasi.', [
        { type: 'menu', menu: db.menu },
        { type: 'portions', kitchen: state(lang).kitchen },
      ], lang);
    case 'undo': {
      const before = db.undo?.pop();
      if (before) db.menu = before.menu ?? undefined;
      if (before?.plan) db.plan = before.plan;
      return turn('Kumosin viimeisimmän muutoksen.', [...(db.menu ? [{ type: 'menu', menu: db.menu } as Card] : []), ...(db.plan ? [{ type: 'plan', plan: db.plan } as Card] : [])], lang);
    }
    case 'clear_menu': {
      if (!db.menu) throw new Error('fixture: no menu');
      remember('Ruokalista poistettu');
      db.menu = undefined;
      db.plan = undefined;
      db.removedLines = undefined;
      return turn('Poistin ruokalistan ja sen ostoslistan. Tilaukset, tilausluonnokset ja annosmäärät säilyvät. Voit kumota poiston.', [], lang);
    }
    case 'set_course': {
      const d = db.menu?.days.find(x => x.id === action.date);
      if (d) d.role = action.role;
      return turn('Rooli valittu.', db.menu ? [{ type: 'menu', menu: db.menu }] : [], lang);
    }
    case 'confirm_recipe':
    case 'skip_day':
    case 'restore_day':
    case 'set_custom_dish': {
      const d = db.menu?.days.find((x) => x.id === action.date);
      // removing the last dish removes the whole menu, as on the server
      const last = action.type === 'skip_day' && !!d && d.match !== 'skipped' && !!db.menu?.days.every((x) => x === d || x.match === 'skipped');
      remember(last ? 'Viimeinen ruokalaji ja ruokalista poistettu' : action.type === 'skip_day' ? 'Ruokalaji poistettu' : action.type === 'restore_day' ? 'Ruokalaji palautettu' : action.type === 'set_custom_dish' ? 'Oma ruokalaji' : 'Resepti valittu');
      if (last) {
        db.menu = undefined;
        db.plan = undefined;
        db.removedLines = undefined;
        return turn('Poistit viimeisen ruokalajin, joten poistin koko ruokalistan. Tilaukset, tilausluonnokset ja annosmäärät säilyvät. Voit kumota poiston.', [], lang);
      }
      if (d && action.type === 'skip_day') {
        (db.removedDays ??= {})[d.id] = structuredClone(d);
        d.removedDish = d.customName ?? (d.match === 'confirmed' ? d.recipeName : undefined) ?? d.dishName;
        Object.assign(d, { match: 'skipped', recipeId: undefined, recipeName: undefined, customName: undefined, suggestion: undefined });
      } else if (d && action.type === 'restore_day') {
        Object.assign(d, db.removedDays?.[d.id] ?? { match: 'missing', removedDish: undefined });
        d.removedDish = undefined;
      } else if (d && action.type === 'set_custom_dish') {
        Object.assign(d, { match: 'custom', customName: action.name.trim().slice(0, 60), recipeId: undefined, recipeName: undefined, suggestion: undefined, removedDish: undefined });
      } else if (d && action.type === 'confirm_recipe') {
        const r = fxRecipes().find((x) => x.id === action.recipeId);
        Object.assign(d, { match: 'confirmed', recipeId: action.recipeId, recipeName: r?.name ?? 'Broilerikiusaus', customName: undefined, suggestion: undefined, removedDish: undefined });
      }
      syncPlanExtras();
      const i = db.plan?.issues.find((x) => x.date === action.date && x.kind === 'suggested_recipe');
      if (i) {
        i.resolved = true;
        i.resolution = 'Resepti vahvistettu.';
      }
      return turn('Selvä, päivitin päivän.', [...(db.menu ? [{ type: 'menu', menu: db.menu } as Card] : []), ...(db.plan ? [{ type: 'plan', plan: db.plan } as Card] : [])], lang);
    }
    case 'reopen_issue': {
      const i = db.plan?.issues.find((x) => x.id === action.issueId);
      if (db.plan && i) {
        remember('Valinta avattu uudelleen');
        db.plan.issues = db.plan.issues.map((x) => (x.id === i.id ? issue1() : x));
        syncPlanExtras();
      }
      return turn('Avasin valinnan uudelleen. Asia estää taas tilauksen, kunnes valitset uudelleen.', db.plan ? [{ type: 'plan', plan: db.plan }] : [], lang);
    }
    case 'restore_line': {
      const l = db.removedLines?.find((x) => x.id === action.lineId);
      if (db.plan && l) {
        remember('Rivi palautettu');
        db.removedLines = db.removedLines?.filter((x) => x !== l);
        db.plan.lines.push(l);
        syncPlanExtras();
      }
      return turn('Rivi palautettu ostoslistalle laskettuun määrään.', db.plan ? [{ type: 'plan', plan: db.plan }] : [], lang);
    }
    case 'reset_line_qty':
    case 'restore_product':
      return turn('Asettelunäkymä ei laske määriä eikä vaihda tuotteita.', db.plan ? [{ type: 'plan', plan: db.plan }] : [], lang);
    case 'set_portions':
      db.confirmed = true;
      return turn('Annokset vahvistettu: 350 päivässä.', [], lang);
    case 'build_plan':
    case 'show_plan': {
      db.menu ??= active === 'wedding' ? eventMenu() : menu();
      if (!db.plan) {
        db.plan = plan();
        if (db.credit !== null && db.credit < db.plan.totals.net) {
          db.plan.issues.push({ id: 'credit', kind: 'credit', severity: 'block', title: 'Tilaus ylittäisi luottorajan', detail: 'Ostoslistan summa 469,40 € ylittää tilin vapaan luoton. Pienennä tilausta tai pyydä tukkuria nostamaan rajaa.', resolved: false });
        }
      }
      return turn('Ostoslista on valmis. Yksi asia estää vielä tilauksen.', [
        ...db.plan.issues.map((issue): Card => ({ type: 'issue', issue })),
        { type: 'plan', plan: db.plan },
      ], lang);
    }
    case 'resolve_issue': {
      const p = db.plan;
      const i = p?.issues.find((x) => x.id === action.issueId);
      if (p && i) {
        i.resolved = true;
        i.resolution = 'Vaihdettu tuotteeseen Maissi-riisimakaroni, gluteeniton ja vehnätön.';
        p.lines[0] = line('l1', pMacCorn, offer(18.4, 3.68), { groupLabels: ['Gluteeniton', 'Vehnätön'], checks: [glutenOk, wheatOk], needed: 2.2, orderQty: 1, orderedAmount: 5, lineTotal: 18.4, changed: 'Vaihdettu: aiempi tuote sisälsi vehnätärkkelystä.' });
        p.ready = p.issues.every((x) => x.resolved || x.severity !== 'block');
        p.totals = { net: 466.3, vat: 65.28, gross: 531.58, lineCount: 4 };
      }
      return turn('Vaihdoin tuotteen ja tarkistin sen vehnättömille. Muistan tämän jatkossa.', p && i ? [{ type: 'issue', issue: i }, { type: 'plan', plan: p }] : [], lang);
    }
    case 'set_line_qty': {
      const l = db.plan?.lines.find((x) => x.id === action.lineId);
      if (l) {
        l.orderQty = action.qty;
        l.orderedAmount = action.qty * (l.product.packSize?.value ?? 0);
        l.lineTotal = action.qty * (l.offer.price ?? 0);
      }
      return turn('Päivitin määrän.', db.plan ? [{ type: 'plan', plan: db.plan }] : [], lang);
    }
    case 'remove_line': {
      const l = db.plan?.lines.find((x) => x.id === action.lineId);
      if (db.plan && l) {
        remember('Rivi poistettu');
        db.plan.lines = db.plan.lines.filter((x) => x !== l);
        (db.removedLines ??= []).push(l);
        syncPlanExtras();
      }
      return turn('Poistin rivin listalta. Sen voi palauttaa ostoslistan lopusta.', db.plan ? [{ type: 'plan', plan: db.plan }] : [], lang);
    }
    case 'find_cheaper':
      return turn('Löysin kaksi vaihtoehtoa. Toisen sopivuutta ei voi varmistaa.', [
        { type: 'comparison', title: 'Halvempi vaihtoehto makaronille', subtitle: 'Vertailu kilohinnan mukaan', lineId: action.lineId ?? 'l3', current: { product: pMac, offer: offer(14.9, 1.49), checks: [], suitable: true }, items: [alts[0], alts[2]] },
      ], lang);
    case 'swap_line':
      return turn('Vaihdoin tuotteen ostoslistalle.', db.plan ? [{ type: 'plan', plan: db.plan }] : [], lang);
    case 'create_order': {
      const o = order();
      db.orders = [o];
      if (db.plan) db.plan.orderId = o.id;
      return turn('Tein tilausehdotuksen. Se tarvitsee vielä hyväksyntäsi.', [{ type: 'order', order: o }], lang);
    }
    case 'approve_order':
    case 'reject_order':
    case 'cancel_order': {
      const o = db.orders.find((x) => x.id === action.orderId);
      if (o) {
        const ok = action.type === 'approve_order';
        o.status = ok ? 'submitted' : action.type === 'reject_order' ? 'rejected' : 'cancelled';
        o.statusLabel = ok ? 'Lähetetty' : action.type === 'reject_order' ? 'Hylätty' : 'Peruttu';
        o.approval.decidedBy = 'Keittiö (UI)';
        o.approval.decidedAt = NOW;
        if (ok) o.confirmation = 'SIM-778201';
        o.events.push({ at: NOW, actor: 'Keittiö (UI)', text: ok ? 'Hyväksytty ja kirjattu simulaatioon.' : 'Tilaus pysäytetty.' });
      }
      return turn(o?.status === 'submitted' ? 'Tilaus on lähetetty (simulaatio). Toimitus ma 16.11.' : 'Selvä, tilausta ei lähetetä.', o ? [{ type: 'order', order: o }] : [], lang);
    }
    case 'show_order': {
      const o = db.orders.find((x) => x.id === action.orderId);
      return turn('Tässä tilaus.', o ? [{ type: 'order', order: o }] : [], lang);
    }
    case 'show_audit':
      return turn('Tässä viimeisimmät tapahtumat.', [{ type: 'audit', entries: state(lang).audit }], lang);
    case 'draft_set': {
      const alt = alts.find((a) => a.product.id === action.productId);
      const d = findDraft(action.draftId) ?? (action.qty > 0 ? newDraft() : undefined);
      if (d) {
        const at = d.lines.findIndex((l) => l.product.id === action.productId);
        const line = alt && action.qty > 0 ? { product: alt.product, offer: alt.offer, qty: action.qty, lineTotal: action.qty * (alt.offer.price ?? 0), checks: alt.checks } : undefined;
        if (at >= 0) d.lines.splice(at, 1, ...(line ? [line] : []));
        else if (line) d.lines.push(line);
      }
      return turn(action.qty > 0 ? `Kortilla ”${d?.name}”: tuote lisätty.` : 'Rivi poistettu kortilta.', draftCard(d), lang);
    }
    case 'show_draft': {
      const d = findDraft(action.draftId);
      if (d) db.active = d.id;
      return turn(d ? `Tässä tilauskortti ”${d.name}”.` : 'Tilauskortteja ei vielä ole.', draftCard(d), lang);
    }
    case 'draft_create': {
      const d = newDraft(action.name, action.deliveryDate);
      return turn(`Loin tilauskortin ”${d.name}”.`, draftCard(d), lang);
    }
    case 'draft_update': {
      const d = findDraft(action.draftId);
      if (d && action.name !== undefined) d.name = action.name.trim() || d.name;
      if (d && action.deliveryDate) d.deliveryDate = action.deliveryDate;
      return turn('Kortti päivitetty.', draftCard(d), lang);
    }
    case 'draft_delete':
      db.drafts = db.drafts.filter((d) => d.id !== action.draftId);
      if (db.active === action.draftId) db.active = db.drafts[db.drafts.length - 1]?.id;
      return turn('Poistin kortin. Mitään ei tilattu.', [], lang);
    case 'draft_select':
      db.active = action.draftId;
      return turn('Lisäykset tulevat nyt tälle kortille.', [], lang);
    case 'draft_order': {
      const d = findDraft(action.draftId);
      const o = { ...order(), title: d?.name ?? 'Tilaus', deliveryDate: d?.deliveryDate ?? '2026-11-16' };
      db.orders = [o];
      db.drafts = db.drafts.filter((x) => x !== d);
      if (db.active === d?.id) db.active = db.drafts[db.drafts.length - 1]?.id;
      return turn('Tein tilauksen kortilta. Se tarvitsee vielä hyväksyntäsi.', [{ type: 'order', order: o }], lang);
    }
  }
}
