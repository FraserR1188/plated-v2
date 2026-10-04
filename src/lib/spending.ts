// ============================================================
// src/lib/spending.ts — Grocery spending: amounts, ranges, totals and the
// lines-vs-total reconcile (receipt-scanner findings §2, §3, §6)
//
// Rules:
//   • A receipt's amount is its printed total; else the sum of its lines if
//     EVERY line total is known; else it's unknown, listed and counted as
//     such — never £0.
//   • Totals are per currency. GBP and EUR are never added together.
//   • purchased_on is a calendar date, never an instant. It's compared as a
//     YYYY-MM-DD string and never parsed with new Date("YYYY-MM-DD"), which
//     is UTC midnight (the PL-007 bug class). Week and month arithmetic goes
//     through time.ts's local-calendar helpers, so the 23- and 25-hour days
//     at the BST changes can't shift a range.
// ============================================================

import { addDays, parseDateKey } from "./time";
import { formatPence, sumPence } from "./money";

export type DateRange = { start: string; end: string };

type HasLineTotal = { line_total_pence: number | null };

export type SpendReceipt = {
  id: string;
  store: string | null;
  purchased_on: string;
  currency: string;
  printed_total_pence: number | null;
  lines: HasLineTotal[];
};

export type ReceiptAmount = { pence: number; source: "total" | "lines" } | null;

export type StoreSpend = { store: string; currency: string; pence: number; receipts: number };

export type SpendingSummary = {
  byCurrency: Record<string, { pence: number; receipts: number }>;
  /** Receipts in range whose amount is unknown: listed, never added as 0. */
  unknownTotals: number;
  /** Highest total first. A null store is "Unknown store". */
  byStore: StoreSpend[];
};

export type ReconcileStatus = "equal" | "over" | "under" | "unknown";

export type Reconcile = {
  status: ReconcileStatus;
  /** Lines minus printed total, in pence; null when either side is unknown. */
  diffPence: number | null;
  /** What the review screen's banner says; null when there's nothing to say. */
  message: string | null;
};

export const UNKNOWN_STORE = "Unknown store";

/** The printed total, else the sum of lines if every line total is known. */
export function receiptAmount(
  r: Pick<SpendReceipt, "printed_total_pence" | "lines">,
): ReceiptAmount {
  if (r.printed_total_pence != null) return { pence: r.printed_total_pence, source: "total" };
  if (r.lines.length === 0 || r.lines.some((l) => l.line_total_pence == null)) return null;
  return { pence: sumPence(r.lines.map((l) => l.line_total_pence)) ?? 0, source: "lines" };
}

/** Monday to Sunday, in the local calendar, containing `todayKey`. */
export function weekRange(todayKey: string): DateRange {
  // getDay(): 0 is Sunday. Days since Monday: Monday 0 … Sunday 6.
  const sinceMonday = (parseDateKey(todayKey).getDay() + 6) % 7;
  const start = addDays(todayKey, -sinceMonday);
  return { start, end: addDays(start, 6) };
}

/** The calendar month to date. */
export function monthRange(todayKey: string): DateRange {
  return { start: `${todayKey.substring(0, 8)}01`, end: todayKey };
}

const inRange = (day: string, range: DateRange) => day >= range.start && day <= range.end;

export function summariseSpending(receipts: SpendReceipt[], range: DateRange): SpendingSummary {
  const byCurrency: SpendingSummary["byCurrency"] = {};
  const stores = new Map<string, StoreSpend>();
  let unknownTotals = 0;

  for (const r of receipts) {
    if (!inRange(r.purchased_on, range)) continue;
    const amount = receiptAmount(r);
    if (!amount) {
      unknownTotals++;
      continue;
    }
    const cur = (byCurrency[r.currency] ??= { pence: 0, receipts: 0 });
    cur.pence += amount.pence;
    cur.receipts++;

    const store = r.store ?? UNKNOWN_STORE;
    const key = `${r.currency}\u0000${store}`;
    const s = stores.get(key) ?? { store, currency: r.currency, pence: 0, receipts: 0 };
    s.pence += amount.pence;
    s.receipts++;
    stores.set(key, s);
  }

  const byStore = [...stores.values()].sort(
    (a, z) => z.pence - a.pence || a.store.localeCompare(z.store),
  );
  return { byCurrency, unknownTotals, byStore };
}

/**
 * The review screen's safety net (findings §3): a line dropped at a photo
 * join shows as "under", a repeat the seam flag missed as "over". When the
 * excess is EXACTLY the flagged possible repeats, the banner says so, which
 * makes removing a real seam echo one well-evidenced tap.
 */
export function reconcile(
  lines: HasLineTotal[],
  printedTotalPence: number | null,
  currency: string,
  flaggedPence?: number,
): Reconcile {
  if (printedTotalPence == null || lines.some((l) => l.line_total_pence == null)) {
    return { status: "unknown", diffPence: null, message: null };
  }
  const diff = (sumPence(lines.map((l) => l.line_total_pence)) ?? 0) - printedTotalPence;
  if (diff === 0) return { status: "equal", diffPence: 0, message: null };

  const amount = formatPence(Math.abs(diff), currency);
  if (diff > 0) {
    const message =
      flaggedPence != null && flaggedPence > 0 && diff === flaggedPence
        ? `Lines are ${amount} over the total — the same as the flagged possible repeat.`
        : `Lines are ${amount} over the total`;
    return { status: "over", diffPence: diff, message };
  }
  return { status: "under", diffPence: diff, message: `Lines are ${amount} under the total` };
}
