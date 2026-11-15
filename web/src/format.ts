import type { Lang } from './types';

const LOCALE: Record<Lang, string> = { fi: 'fi-FI', sv: 'sv-FI', en: 'en-IE' };

export const SPEECH_LOCALE: Record<Lang, string> = { fi: 'fi-FI', sv: 'sv-SE', en: 'en-US' };

/** "YYYY-MM-DD" is a calendar day (no timezone shifting); anything else is an ISO instant. */
function toDate(iso: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Comparison units arrive as raw codes ("KG", "LTR"); show them the way people write them. */
export function unitText(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (u === 'kg' || u === 'kgm') return 'kg';
  if (u === 'l' || u === 'ltr' || u === 'lt') return 'l';
  return unit;
}

export interface Fmt {
  eur(n: number | undefined | null): string;
  /** whole euros without decimals ("5 000 €"), otherwise like eur */
  eurShort(n: number): string;
  num(n: number, maxFractionDigits?: number): string;
  /** 0..1 -> "98 %" */
  pct(n: number): string;
  /** physical amount, e.g. "12,5 kg" */
  amount(n: number, unit: string): string;
  /** "ma 16.11." */
  day(iso: string): string;
  /** "16.11." */
  dayMonth(iso: string): string;
  weekdayShort(iso: string): string;
  /** "lauantai 14. marraskuuta" */
  longDay(iso: string): string;
  /** "14.11. klo 9.30" */
  dateTime(iso: string): string;
  time(iso: string): string;
}

export function makeFmt(lang: Lang): Fmt {
  const locale = LOCALE[lang];
  const eur = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const eur0 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const dayFmt = new Intl.DateTimeFormat(
    locale,
    lang === 'en'
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { weekday: 'short', day: 'numeric', month: 'numeric' },
  );
  const dayMonthFmt = new Intl.DateTimeFormat(
    locale,
    lang === 'en' ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'numeric' },
  );
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const longFmt = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const dateTimeFmt = new Intl.DateTimeFormat(
    locale,
    lang === 'en'
      ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });

  const safe = (iso: string, f: Intl.DateTimeFormat) => {
    const d = toDate(iso);
    return d ? f.format(d) : iso;
  };

  return {
    eur: (n) => (typeof n === 'number' && Number.isFinite(n) ? eur.format(n) : '–'),
    eurShort: (n) => (Number.isInteger(n) ? eur0.format(n) : eur.format(n)),
    num: (n, maxFractionDigits = 2) =>
      new Intl.NumberFormat(locale, { maximumFractionDigits: maxFractionDigits }).format(n),
    pct: (n) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(n),
    amount: (n, unit) =>
      `${new Intl.NumberFormat(locale, { maximumFractionDigits: n >= 100 ? 0 : n >= 10 ? 1 : 2 }).format(n)} ${unit}`,
    day: (iso) => safe(iso, dayFmt),
    dayMonth: (iso) => safe(iso, dayMonthFmt),
    weekdayShort: (iso) => safe(iso, weekdayFmt),
    longDay: (iso) => safe(iso, longFmt),
    dateTime: (iso) => safe(iso, dateTimeFmt),
    time: (iso) => safe(iso, timeFmt),
  };
}
