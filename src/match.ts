// Pure matching logic: find the bank statement line that paid an invoice. No I/O, so it is unit-tested.

export interface BankLine {
  date: string; // YYYY-MM-DD
  description: string;
  reference: string;
  spent: number; // positive = money out
  reconciled: boolean;
}

export interface InvoiceFacts {
  supplier: string;
  date: string; // YYYY-MM-DD
  total: number;
  currency: string;
}

export interface MatchOptions {
  gbpPerUnit: number; // market rate on invoice date (1 for GBP)
  fxTolerance: number; // e.g. 0.06 = ±6% for foreign currency
  daysBefore: number;
  daysAfter: number;
  usedKeys: Set<string>;
}

export interface MatchResult {
  line: BankLine;
  key: string;
  expectedGbp: number;
  nameMatched: boolean;
  candidates: number;
}

const STOP = new Set(["inc", "ltd", "llc", "limited", "the", "com", "www", "corp", "co", "gmbh", "plc", "payment", "card", "pty", "bv"]);

export const lineKey = (l: BankLine) => `${l.date}|${l.spent.toFixed(2)}|${l.description.toLowerCase()}|${l.reference.toLowerCase()}`;

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.(com|io|ai|co|net|org|app)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

export function nameMatches(supplier: string, line: BankLine): boolean {
  const hay = `${line.description} ${line.reference}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const squashed = hay.replace(/\s+/g, "");
  return tokens(supplier).some((t) => hay.includes(t) || squashed.includes(t));
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * Picks the most likely bank line for an invoice, or null when nothing is safe to match.
 * GBP invoices need an exact amount, plus either the supplier name on the bank line or a single candidate.
 * Foreign invoices need an amount within the FX tolerance AND the supplier name on the bank line.
 */
export function findBankLine(inv: InvoiceFacts, lines: BankLine[], o: MatchOptions): MatchResult | null {
  const isGbp = inv.currency.toUpperCase() === "GBP";
  const expectedGbp = Math.round(inv.total * (isGbp ? 1 : o.gbpPerUnit) * 100) / 100;

  const fits = lines.filter((l) => {
    if (l.reconciled || l.spent <= 0 || o.usedKeys.has(lineKey(l))) return false;
    const d = dayDiff(l.date, inv.date);
    if (d < -o.daysBefore || d > o.daysAfter) return false;
    if (isGbp) return Math.abs(l.spent - expectedGbp) < 0.005;
    return Math.abs(l.spent - expectedGbp) <= expectedGbp * o.fxTolerance;
  });
  if (!fits.length) return null;

  const scored = fits
    .map((l) => ({ l, name: nameMatches(inv.supplier, l), diff: Math.abs(l.spent - expectedGbp), days: Math.abs(dayDiff(l.date, inv.date)) }))
    .sort((a, b) => Number(b.name) - Number(a.name) || a.diff - b.diff || a.days - b.days);

  const best = scored[0];
  // Without the supplier's name on the bank line, only accept a single exact-amount GBP candidate.
  if (!best.name && (!isGbp || fits.length !== 1)) return null;
  return { line: best.l, key: lineKey(best.l), expectedGbp, nameMatched: best.name, candidates: fits.length };
}

/** Accepts "2026-11-03", "2026-11-03T00:00:00", "/Date(1762128000000+0000)/" or "3 Nov 2026". */
export function toIsoDate(s: string): string {
  const ms = /\/Date\((\d+)/.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s.replace(/(\d+)\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/, "$2 $1 $3 UTC"));
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}
