import type { Lang, Weekday } from '../../shared/types.ts';

/** Inline three-language string: tr(lang, fi, sv, en). */
export function tr(lang: Lang, fi: string, sv: string, en: string): string {
  return lang === 'sv' ? sv : lang === 'en' ? en : fi;
}

export function parseLang(v: unknown): Lang {
  return v === 'sv' || v === 'en' ? v : 'fi';
}

const LOCALE: Record<Lang, string> = { fi: 'fi-FI', sv: 'sv-FI', en: 'en-GB' };

export function eur(lang: Lang, n: number): string {
  return new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency: 'EUR' }).format(n);
}
export function num(lang: Lang, n: number, digits = 1): string {
  return new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: digits }).format(n);
}

const WD: Record<Weekday, [string, string, string]> = {
  mon: ['Maanantai', 'Måndag', 'Monday'], tue: ['Tiistai', 'Tisdag', 'Tuesday'], wed: ['Keskiviikko', 'Onsdag', 'Wednesday'],
  thu: ['Torstai', 'Torsdag', 'Thursday'], fri: ['Perjantai', 'Fredag', 'Friday'], sat: ['Lauantai', 'Lördag', 'Saturday'],
  sun: ['Sunnuntai', 'Söndag', 'Sunday'],
};
const WD_SHORT: Record<Weekday, [string, string, string]> = {
  mon: ['ma', 'mån', 'Mon'], tue: ['ti', 'tis', 'Tue'], wed: ['ke', 'ons', 'Wed'], thu: ['to', 'tors', 'Thu'],
  fri: ['pe', 'fre', 'Fri'], sat: ['la', 'lör', 'Sat'], sun: ['su', 'sön', 'Sun'],
};
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const weekdayLabel = (lang: Lang, w: Weekday) => tr(lang, ...WD[w]);
export const weekdayShort = (lang: Lang, w: Weekday) => tr(lang, ...WD_SHORT[w]);

export function weekdayOf(date: string): Weekday {
  const d = new Date(date + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(d + 6) % 7];
}
/** "ma 16.11." */
export function dayLabel(lang: Lang, date: string): string {
  const [, m, d] = date.split('-').map(Number);
  const wd = weekdayShort(lang, weekdayOf(date));
  return lang === 'en' ? `${wd} ${d} Nov`.replace('Nov', MONTHS_EN[m - 1]) : `${wd} ${d}.${m}.`;
}
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isoWeek(date: string): number {
  const d = new Date(date + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** "Viikko 47 · 16.–20.11." */
export function weekLabel(lang: Lang, weekStart: string): string {
  const end = addDays(weekStart, 4);
  const [, m1, d1] = weekStart.split('-').map(Number);
  const [, m2, d2] = end.split('-').map(Number);
  const range = lang === 'en'
    ? `${d1} ${MONTHS_EN[m1 - 1]} – ${d2} ${MONTHS_EN[m2 - 1]}`
    : m1 === m2 ? `${d1}.–${d2}.${m2}.` : `${d1}.${m1}.–${d2}.${m2}.`;
  return `${tr(lang, 'Viikko', 'Vecka', 'Week')} ${isoWeek(weekStart)} · ${range}`;
}

const UNITS: Record<string, [string, string, string]> = {
  ST: ['kpl', 'st', 'pcs'], KI: ['laatikko', 'kartong', 'case'], KG: ['kg', 'kg', 'kg'], PAK: ['pakkaus', 'förp.', 'pack'],
  BAG: ['pussi', 'påse', 'bag'], RAS: ['rasia', 'ask', 'box'], PRK: ['purkki', 'burk', 'tub'], BOT: ['pullo', 'flaska', 'bottle'],
  SK: ['säkki', 'säck', 'sack'], CS: ['laatikko', 'kartong', 'case'], KLE: ['kenno', 'bricka', 'tray'], KRT: ['kartonki', 'kartong', 'carton'],
  KAN: ['kanisteri', 'dunk', 'canister'], PAL: ['lava', 'pall', 'pallet'],
};
export const unitLabel = (lang: Lang, su: string) => (UNITS[su] ? tr(lang, ...UNITS[su]) : su.toLowerCase());
