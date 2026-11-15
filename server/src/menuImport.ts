// Menu import: Excel / PDF / CSV -> week menu. Parsing is deterministic first; the LLM is only a
// fallback for unusual layouts and its output is rejected unless every dish name literally
// appears in the file. Dishes are linked to approved recipes; nothing is guessed silently.
import * as XLSX from 'xlsx';
import type { Weekday } from '../../shared/types.ts';
import { norm } from './catalog.ts';
import { addDays, WEEKDAYS, weekdayOf } from './i18n.ts';
import { llmJson } from './llm.ts';
import { UserError } from './planner.ts';
import { linkRecipe, roleFromLabel } from './recipes.ts';
import { ACTOR, type L3, S, type StoredDay, type StoredMenu, audit, currentProfile, l3 } from './store.ts';

type Grid = string[][];

const WD_WORDS: [RegExp, Weekday][] = [
  [/^(maanantai|ma|måndag|mån|monday|mon)\b/i, 'mon'], [/^(tiistai|ti|tisdag|tis|tuesday|tue)\b/i, 'tue'],
  [/^(keskiviikko|ke|onsdag|ons|wednesday|wed)\b/i, 'wed'], [/^(torstai|to|torsdag|tors|thursday|thu)\b/i, 'thu'],
  [/^(perjantai|pe|fredag|fre|friday|fri)\b/i, 'fri'],
];
const DATE_RE = /(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?/;

function weekdayIn(cell: string): { wd: Weekday; rest: string; date?: [number, number] } | undefined {
  const t = cell.trim();
  for (const [re, wd] of WD_WORDS) {
    const m = t.match(re);
    if (!m) continue;
    let rest = t.slice(m[0].length).replace(/^[\s:.,–-]+/, '');
    let date: [number, number] | undefined;
    const dm = rest.match(DATE_RE);
    if (dm && rest.indexOf(dm[0]) < 3) { date = [Number(dm[1]), Number(dm[2])]; rest = rest.slice(rest.indexOf(dm[0]) + dm[0].length).replace(/^[\s:.,–-]+/, ''); }
    return { wd, rest, date };
  }
  return undefined;
}

const isNumber = (s: string) => /^\d{1,5}$/.test(s.trim());
const isDateOnly = (s: string) => /^\d{1,2}\.\d{1,2}\.?(\d{2,4})?$/.test(s.trim());
const DIET_RE = /gluteenit|vehnät|laktoosit|maidot|glutenfri|vetefri|laktosfri|mjölkfri|gluten[- ]free|wheat[- ]free|lactose[- ]free|milk[- ]free|\b(G|L|M|VL|VE|KA)\b/;
const HEADER_RE = /^(päivä|pvm|päivämäärä|lounas|ruoka|ruokalaji|annokset|annosmäärä|huom|huomiot|dag|datum|lunch|rätt|portioner|day|date|dish|portions|notes?)\.?$/i;

async function pdfGrid(buf: Buffer): Promise<Grid> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const grid: Grid = [];
  for (let n = 1; n <= Math.min(doc.numPages, 6); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = (content.items as any[]).filter(i => i.str && i.str.trim()).map(i => ({ s: i.str as string, x: i.transform[4] as number, y: i.transform[5] as number, w: i.width as number }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let row: typeof items = [];
    const flush = () => {
      if (!row.length) return;
      row.sort((a, b) => a.x - b.x);
      const cells: string[] = [];
      let cur = row[0].s, end = row[0].x + row[0].w;
      for (const it of row.slice(1)) {
        if (it.x - end > 14) { cells.push(cur.trim()); cur = it.s; } else cur += (it.x - end > 1.5 ? ' ' : '') + it.s;
        end = it.x + it.w;
      }
      cells.push(cur.trim());
      grid.push(cells);
      row = [];
    };
    let y = Infinity;
    for (const it of items) {
      if (Math.abs(it.y - y) > 3) { flush(); y = it.y; }
      row.push(it);
    }
    flush();
  }
  return grid;
}

function sheetGrid(buf: Buffer): Grid {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const grid: Grid = [];
  for (const name of wb.SheetNames.slice(0, 3)) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    for (const r of rows) grid.push(r.map(c => String(c ?? '').trim()));
  }
  return grid;
}

function textGrid(text: string): Grid {
  return text.split(/\r?\n/).map(l => l.split(/[;\t]|,(?=\S)|\s{3,}/).map(c => c.trim()));
}

interface Found { wd: Weekday; dish: string; date?: [number, number]; portions?: number; notes: string[] }

function extract(grid: Grid): Found[] {
  const found = new Map<Weekday, Found>();
  const put = (f: Found) => { if (f.dish && !found.has(f.wd)) found.set(f.wd, f); };
  for (let r = 0; r < grid.length; r++) {
    const marks = grid[r].map((c, i) => ({ i, w: weekdayIn(c) })).filter(x => x.w);
    if (marks.length >= 3) {
      // column layout: weekdays across, dishes below
      for (const m of marks) {
        for (let k = r + 1; k < Math.min(grid.length, r + 7); k++) {
          const c = (grid[k][m.i] ?? '').trim();
          if (!c || isNumber(c) || isDateOnly(c)) continue;
          const dm = c.match(DATE_RE);
          put({ wd: m.w!.wd, dish: c, date: m.w!.date ?? (dm && isDateOnly(c) ? [Number(dm[1]), Number(dm[2])] : undefined), notes: [] });
          break;
        }
      }
      continue;
    }
    for (const m of marks) {
      const w = m.w!;
      const rest = grid[r].slice(m.i + 1).filter(c => c.trim());
      let date = w.date;
      let dish = w.rest;
      let portions: number | undefined;
      const notes: string[] = [];
      for (const c of rest) {
        if (isDateOnly(c)) { const dm = c.match(DATE_RE)!; date ??= [Number(dm[1]), Number(dm[2])]; }
        else if (isNumber(c)) { const n = Number(c); if (n >= 5 && n <= 20000) portions ??= n; }
        else if (!dish) dish = c;
        else if (DIET_RE.test(c) || c.length < 60) notes.push(c);
      }
      if (!dish) {
        // dish on the following line(s)
        for (let k = r + 1; k < Math.min(grid.length, r + 3); k++) {
          const c = grid[k].find(x => x.trim() && !isNumber(x) && !isDateOnly(x) && !weekdayIn(x) && !HEADER_RE.test(x));
          if (c) { dish = c; break; }
        }
      }
      put({ wd: w.wd, dish: dish.replace(/\s+/g, ' ').trim(), date, portions, notes });
    }
  }
  return WEEKDAYS.map(w => found.get(w)).filter((f): f is Found => !!f);
}

// ---------- event menus: courses instead of weekdays ----------
const COURSE_RE = /^(alkumalja|tervetuliaismalja|alkuruoka|alkupalat?|salaatti|keitto|pääruoka|lämmin ruoka|jälkiruoka|kakku|kahvi|juomat?|iltapala|välkomstskål|förrätt|varmrätt|huvudrätt|efterrätt|dessert|kaffe|dryck(?:er)?|welcome drink|starters?|main course|mains?|drinks?)\b[\s:.–-]*(.*)$/i;
const GUESTS_RE = /(\d{1,5})\s*(hlö|henkilöä|henkeä|vierasta|vieraalle|gäster|personer|guests|persons|pax)\b/i;

interface Course { label: string; dish: string }
function extractCourses(grid: Grid): { courses: Course[]; date?: string; guests?: number } {
  const courses: Course[] = [];
  let date: string | undefined, guests: number | undefined;
  for (const row of grid) {
    for (const cell of row) {
      const g = cell.match(GUESTS_RE);
      if (g && !guests) guests = Number(g[1]);
      const d = cell.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
      if (d && !date) {
        const year = d[3] ? Number(d[3]) : new Date().getFullYear();
        const iso = `${year}-${String(Number(d[2])).padStart(2, '0')}-${String(Number(d[1])).padStart(2, '0')}`;
        if (!Number.isNaN(new Date(iso + 'T12:00:00Z').getTime())) date = iso;
      }
    }
    const i = row.findIndex(c => COURSE_RE.test(c.trim()));
    if (i < 0) continue;
    const m = row[i].trim().match(COURSE_RE)!;
    const dish = (m[2] || row.slice(i + 1).find(c => c.trim() && !isNumber(c) && !HEADER_RE.test(c.trim())) || '').replace(/\s+/g, ' ').trim();
    if (dish && !HEADER_RE.test(dish) && !/^(menu|ruokalaji|rätt|dish)$/i.test(dish)) courses.push({ label: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), dish });
  }
  return { courses, date, guests };
}

function nextSaturday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12));
  d.setUTCDate(d.getUTCDate() + ((5 - ((d.getUTCDay() + 6) % 7) + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function nextMonday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12));
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() + (7 - day));
  return d.toISOString().slice(0, 10);
}

function resolveWeekStart(found: Found[]): { weekStart: string; fromFile: boolean } {
  const withDate = found.find(f => f.date);
  if (withDate) {
    const [dd, mm] = withDate.date!;
    const now = new Date();
    let year = now.getFullYear();
    if (mm < now.getMonth() + 1 - 6) year++;
    const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    if (!Number.isNaN(new Date(iso + 'T12:00:00Z').getTime())) {
      const offset = WEEKDAYS.indexOf(weekdayOf(iso));
      return { weekStart: addDays(iso, -offset), fromFile: true };
    }
  }
  return { weekStart: nextMonday(), fromFile: false };
}

export interface ImportResult { menu: StoredMenu; usedAi: boolean }

export async function importMenu(buf: Buffer, filename: string): Promise<ImportResult> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  let grid: Grid;
  let kind: StoredMenu['source']['kind'];
  try {
    if (ext === 'pdf' || buf.subarray(0, 4).toString() === '%PDF') { grid = await pdfGrid(buf); kind = 'pdf'; }
    else if (ext === 'csv' || ext === 'txt') { grid = textGrid(buf.toString('utf8')); kind = 'xlsx'; }
    else { grid = sheetGrid(buf); kind = 'xlsx'; }
  } catch {
    throw new UserError(l3('En saanut tiedostoa auki. Kokeile Excel- (.xlsx) tai PDF-tiedostoa.', 'Jag kunde inte öppna filen. Prova en Excel- (.xlsx) eller PDF-fil.', 'I could not open the file. Try an Excel (.xlsx) or PDF file.'));
  }
  grid = grid.filter(r => r.some(c => c.trim()));
  let found = extract(grid);
  let usedAi = false;
  const fullText = grid.map(r => r.join(' | ')).join('\n').slice(0, 6000);
  if (found.length < 2 && fullText.trim().length > 20) {
    // unusual layout: let the model point at the rows, then verify each dish literally exists in the file
    const ai = await llmJson<{ days?: { weekday?: string; dish?: string }[] }>(
      'You extract a weekly lunch menu from raw spreadsheet/PDF text. Reply with JSON only: {"days":[{"weekday":"mon|tue|wed|thu|fri","dish":"<main lunch dish text copied EXACTLY from the input>"}]}. Never invent or translate dish names. If a weekday has no dish, leave it out.',
      fullText);
    const hay = norm(fullText);
    const out: Found[] = [];
    for (const d of ai?.days ?? []) {
      const wd = WEEKDAYS.find(w => w === String(d.weekday).toLowerCase().slice(0, 3));
      const dish = String(d.dish ?? '').trim();
      if (wd && dish && hay.includes(norm(dish)) && !out.some(o => o.wd === wd)) out.push({ wd, dish, notes: [] });
    }
    if (out.length > found.length) { found = WEEKDAYS.map(w => out.find(o => o.wd === w)).filter((f): f is Found => !!f); usedAi = true; }
  }
  // event menu (wedding, party): courses for one date and a guest count
  const ev = extractCourses(grid);
  if (ev.courses.length >= 2 && (currentProfile().kind === 'event' || found.length < 2)) {
    const date = ev.date ?? nextSaturday();
    const warnings: L3[] = [];
    if (!ev.date) warnings.push(l3('Tiedostossa ei ollut tapahtuman päivämäärää, joten oletin ensi lauantain.', 'Filen hade inget datum för evenemanget, så jag antog nästa lördag.', 'The file had no event date, so I assumed next Saturday.'));
    const st = S();
    if (ev.guests && !st.kitchen.portionsConfirmed) st.kitchen.portionsTotal = ev.guests;
    if (ev.guests) warnings.push(l3(`Tiedostossa mainitaan ${ev.guests} vierasta – käytän sitä, kunnes vahvistat määrän ja erityisruokavaliot.`, `Filen nämner ${ev.guests} gäster – jag använder det tills du bekräftar antalet och specialkosterna.`, `The file mentions ${ev.guests} guests – I use that until you confirm the number and the special diets.`));
    const days = ev.courses.map((c, i) => linkRecipe({ id: `${date}#${i + 1}`, label: c.label, role: roleFromLabel(c.label), date, dishName: c.dish, match: 'missing' }, true));
    const menu: StoredMenu = { kind: 'event', weekStart: addDays(date, -WEEKDAYS.indexOf(weekdayOf(date))), source: { filename, kind, importedAt: new Date().toISOString() }, days, warnings };
    st.menu = menu;
    st.edits = { qty: {}, removed: [] };
    st.skipped = [];
    audit(ACTOR.kitchen, 'menu_imported', l3(`Tapahtuman menu tuotu tiedostosta ${filename}: ${days.length} ruokalajia, ${days.filter(d => d.match === 'confirmed').length} yhdistetty hyväksyttyyn reseptiin.`, `Evenemangsmeny importerad från ${filename}: ${days.length} rätter, ${days.filter(d => d.match === 'confirmed').length} kopplade till godkänt recept.`, `Event menu imported from ${filename}: ${days.length} courses, ${days.filter(d => d.match === 'confirmed').length} linked to an approved recipe.`));
    return { menu, usedAi: false };
  }
  if (!found.length) throw new UserError(l3('En löytänyt tiedostosta viikonpäiviä ja ruokalajeja. Varmista, että listassa on päivät (ma–pe) ja ruokalajit, tai kirjoita ruokalista minulle suoraan.', 'Jag hittade inga veckodagar och rätter i filen. Kontrollera att listan har dagar (mån–fre) och rätter, eller skriv matsedeln direkt till mig.', 'I could not find weekdays and dishes in the file. Make sure it lists days (Mon–Fri) and dishes, or type the menu to me directly.'));

  const { weekStart, fromFile } = resolveWeekStart(found);
  const warnings: L3[] = [];
  if (!fromFile) warnings.push(l3('Tiedostossa ei ollut päivämääriä, joten oletin ensi viikon.', 'Filen hade inga datum, så jag antog nästa vecka.', 'The file had no dates, so I assumed next week.'));
  if (usedAi) warnings.push(l3('Taulukon rakenne oli epätavallinen: tunnistin rivit tekoälyn avulla ja varmistin, että jokainen ruokalaji löytyy tiedostosta sanasta sanaan. Tarkista päivät.', 'Tabellens struktur var ovanlig: jag identifierade raderna med AI och kontrollerade att varje rätt finns ordagrant i filen. Kontrollera dagarna.', 'The layout was unusual: I located the rows with AI and verified that every dish appears verbatim in the file. Please check the days.'));
  const missingDays = WEEKDAYS.slice(0, 5).filter(w => !found.some(f => f.wd === w));
  if (missingDays.length) warnings.push(l3(`Näille päiville ei löytynyt ruokalajia: ${missingDays.join(', ')}.`, `Ingen rätt hittades för: ${missingDays.join(', ')}.`, `No dish found for: ${missingDays.join(', ')}.`));

  const days: StoredDay[] = found.map(f => {
    const date = addDays(weekStart, WEEKDAYS.indexOf(f.wd));
    return linkRecipe({ id: date, date, dishName: f.dish, match: 'missing', importedPortions: f.portions, dietNotes: f.notes.length ? f.notes : undefined });
  });
  const menu: StoredMenu = { kind: 'week', weekStart, source: { filename, kind, importedAt: new Date().toISOString() }, days, warnings };
  const st = S();
  st.menu = menu;
  st.edits = { qty: {}, removed: [] };
  st.skipped = [];
  audit(ACTOR.kitchen, 'menu_imported', l3(`Ruokalista tuotu tiedostosta ${filename}: ${days.length} päivää, ${days.filter(d => d.match === 'confirmed').length} yhdistetty hyväksyttyyn reseptiin.`, `Matsedel importerad från ${filename}: ${days.length} dagar, ${days.filter(d => d.match === 'confirmed').length} kopplade till godkänt recept.`, `Menu imported from ${filename}: ${days.length} days, ${days.filter(d => d.match === 'confirmed').length} linked to an approved recipe.`));
  return { menu, usedAi };
}

/** Menu typed in chat, e.g. "ma lihamakaronilaatikko, ti broilerikastike". */
export async function importMenuText(text: string): Promise<ImportResult> {
  return importMenu(Buffer.from(text.replace(/[,;]\s*(?=(ma|ti|ke|to|pe|maanantai|tiistai|keskiviikko|torstai|perjantai|mån|tis|ons|tors|fre|mon|tue|wed|thu|fri)\b)/gi, '\n'), 'utf8'), 'viesti.txt');
}
