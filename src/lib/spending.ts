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

export type LineCounts = { items: number; discounts: number };

/** What the review header shows instead of a line count (5b, revised
 *  2026-10-04: 61 lines read for 45 items bought). Items are the
 *  non-discount lines; discounts — multibuy savings, loyalty prices, void
 *  cancels — are counted separately. */
export function countLines(lines: { isDiscount: boolean }[]): LineCounts {
  const discounts = lines.filter((l) => l.isDiscount).length;
  return { items: lines.length - discounts, discounts };
}

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

// ─── The Grocery spending segment's view (commit 6) ─────────────────────────

export type CurrencySpend = { currency: string; pence: number; receipts: number };

export type SpendingRow<R extends SpendReceipt = SpendReceipt> = {
  receipt: R;
  id: string;
  /** Total, else lines, else null (unknown) — never 0. */
  amount: ReceiptAmount;
  /** Lines known, total printed, and they disagree: the row's badge. */
  mismatch: boolean;
  inPeriod: boolean;
};

export type SpendingOverview<R extends SpendReceipt = SpendReceipt> = {
  /** The currency with the most receipts in the period; null when none counted. */
  headline: CurrencySpend | null;
  /** Every other currency, each on its own line. Never added to the headline. */
  otherCurrencies: CurrencySpend[];
  /** In the period with no readable amount: listed, not counted. */
  unknown: R[];
  byStore: StoreSpend[];
  /** EVERY receipt, in the order given (newest first), so any can be edited. */
  rows: SpendingRow<R>[];
};

export function spendingOverview<R extends SpendReceipt>(
  receipts: R[],
  range: DateRange,
): SpendingOverview<R> {
  const summary = summariseSpending(receipts, range);
  const currencies = Object.entries(summary.byCurrency)
    .map(([currency, c]) => ({ currency, pence: c.pence, receipts: c.receipts }))
    .sort((a, z) => z.receipts - a.receipts || z.pence - a.pence || a.currency.localeCompare(z.currency));

  const rows = receipts.map((r) => {
    const amount = receiptAmount(r);
    const check = r.lines.length > 0 ? reconcile(r.lines, r.printed_total_pence, r.currency) : null;
    return {
      receipt: r,
      id: r.id,
      amount,
      mismatch: check != null && (check.status === "over" || check.status === "under"),
      inPeriod: inRange(r.purchased_on, range),
    };
  });

  return {
    headline: currencies[0] ?? null,
    otherCurrencies: currencies.slice(1),
    unknown: rows.filter((row) => row.inPeriod && row.amount == null).map((row) => row.receipt),
    byStore: summary.byStore,
    rows,
  };
}

// ─── Periods and chart buckets (commit 8b) ──────────────────────────────────

export type SpendPeriod = "week" | "month" | "3months";

/** Weeks in the "3 months" period: the last 13 Monday-to-Sunday weeks. */
export const THREE_MONTH_WEEKS = 13;

export function periodRange(period: SpendPeriod, todayKey: string): DateRange {
  if (period === "week") return weekRange(todayKey);
  if (period === "month") return monthRange(todayKey);
  const thisWeek = weekRange(todayKey);
  return { start: addDays(thisWeek.start, -7 * (THREE_MONTH_WEEKS - 1)), end: thisWeek.end };
}

export type SpendBucket = {
  start: string;
  end: string;
  label: string;
  /** The bucket's countable spend in the chart's currency; 0 is a real 0. */
  pence: number;
  receipts: number;
  /** Receipts in the bucket with no readable amount: counted, never added. */
  unknown: number;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "5 Oct", built by hand: no toLocale* (the Trends precedent). */
const dayMonth = (key: string) => `${Number(key.substring(8, 10))} ${MONTHS[Number(key.substring(5, 7)) - 1]}`;

/**
 * The chart's bars for a period, in ONE currency (never mixed):
 *   week    — a bar per day, Mon to Sun;
 *   month   — a bar per Mon–Sun week, clipped to the 1st and to today;
 *   3months — a bar per week, the last 13 weeks.
 * Amounts follow receiptAmount (total, else lines, else unknown), so the bars
 * add up to summariseSpending's total for that currency.
 */
export function spendingBuckets(
  receipts: SpendReceipt[],
  period: SpendPeriod,
  todayKey: string,
  currency: string,
): SpendBucket[] {
  const range = periodRange(period, todayKey);
  const spans: { start: string; end: string; label: string }[] = [];
  if (period === "week") {
    for (let i = 0; i < 7; i++) {
      const day = addDays(range.start, i);
      spans.push({ start: day, end: day, label: DAY_LABELS[i] });
    }
  } else {
    // Mon–Sun weeks from the Monday on or before the range's start, each
    // clipped to the range.
    for (let monday = weekRange(range.start).start; monday <= range.end; monday = addDays(monday, 7)) {
      const start = monday < range.start ? range.start : monday;
      const sunday = addDays(monday, 6);
      spans.push({ start, end: sunday > range.end ? range.end : sunday, label: dayMonth(start) });
    }
  }

  return spans.map((span) => {
    let pence = 0;
    let count = 0;
    let unknown = 0;
    for (const r of receipts) {
      if (r.currency !== currency || !inRange(r.purchased_on, span)) continue;
      const amount = receiptAmount(r);
      if (amount == null) {
        unknown++;
      } else {
        pence += amount.pence;
        count++;
      }
    }
    return { ...span, pence, receipts: count, unknown };
  });
}
