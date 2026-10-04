// ============================================================
// Receipt scanner, written red in commit 2, green from commit 4b: src/lib/spending.ts
// (findings §2, §6).
//
// The suite runs pinned to Europe/London (vitest.setup.ts). That matters
// for the week cases: BST ends on Sunday 25 Oct 2026 and starts on Sunday
// 29 Mar 2026, so a 25-hour or 23-hour day sits inside those weeks, and
// fixed-millisecond date arithmetic lands on the wrong calendar day.
//
// purchased_on is a calendar date, never an instant: it's compared as a
// YYYY-MM-DD string and never parsed with new Date("YYYY-MM-DD"), which is
// UTC midnight (the PL-007 bug class).
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import {
  receiptAmount,
  weekRange,
  monthRange,
  summariseSpending,
  reconcile,
  spendingOverview,
  periodRange,
  spendingBuckets,
} from "../spending";

type Range = { start: string; end: string };
type Line = { line_total_pence: number | null };
type SpendReceipt = {
  id: string;
  store: string | null;
  purchased_on: string;
  currency: string;
  printed_total_pence: number | null;
  lines: Line[];
};

function receipt(over: Partial<SpendReceipt> = {}): SpendReceipt {
  return {
    id: "r1",
    store: "Sainsbury's",
    purchased_on: "2026-10-20",
    currency: "GBP",
    printed_total_pence: 1000,
    lines: [],
    ...over,
  };
}

describe("receiptAmount — total, then lines, then unknown (never 0)", () => {
  it("uses the printed total when there is one", async () => {
    expect(
      receiptAmount({ printed_total_pence: 1234, lines: [{ line_total_pence: 1 }] }),
    ).toEqual({ pence: 1234, source: "total" });
  });

  it("falls back to the sum of lines when every line total is known", async () => {
    expect(
      receiptAmount({
        printed_total_pence: null,
        lines: [{ line_total_pence: 150 }, { line_total_pence: -50 }],
      }),
    ).toEqual({ pence: 100, source: "lines" });
  });

  it("is unknown when the total is unreadable and any line total is too", async () => {
    expect(
      receiptAmount({
        printed_total_pence: null,
        lines: [{ line_total_pence: 150 }, { line_total_pence: null }],
      }),
    ).toBeNull();
  });

  it("is unknown, not 0, with no total and no lines", async () => {
    expect(receiptAmount({ printed_total_pence: null, lines: [] })).toBeNull();
  });

  it("a printed 0.00 is a real 0", async () => {
    expect(receiptAmount({ printed_total_pence: 0, lines: [] })).toEqual({
      pence: 0,
      source: "total",
    });
  });
});

describe("weekRange — Monday to Sunday, local calendar", () => {
  it.each([
    // BST ends Sunday 25 Oct 2026 (a 25-hour day).
    ["2026-10-25", { start: "2026-10-19", end: "2026-10-25" }],
    ["2026-10-19", { start: "2026-10-19", end: "2026-10-25" }],
    ["2026-10-26", { start: "2026-10-26", end: "2026-11-01" }],
    // BST starts Sunday 29 Mar 2026 (a 23-hour day).
    ["2026-03-29", { start: "2026-03-23", end: "2026-03-29" }],
    ["2026-03-30", { start: "2026-03-30", end: "2026-04-05" }],
    // Across a month and a year end.
    ["2026-12-31", { start: "2026-12-28", end: "2027-01-03" }],
  ])("%s → %j", async (today, range) => {
    expect(weekRange(today)).toEqual(range);
  });
});

describe("monthRange — the calendar month to date", () => {
  it.each([
    ["2026-10-04", { start: "2026-10-01", end: "2026-10-04" }],
    ["2026-10-01", { start: "2026-10-01", end: "2026-10-01" }],
    ["2026-02-28", { start: "2026-02-01", end: "2026-02-28" }],
  ])("%s → %j", async (today, range) => {
    expect(monthRange(today)).toEqual(range);
  });
});

describe("summariseSpending", () => {
  const week: Range = { start: "2026-10-19", end: "2026-10-25" };

  it("counts total, then lines, and lists unknown totals instead of adding £0", async () => {
    const s = summariseSpending(
      [
        receipt({ id: "a", printed_total_pence: 1000 }),
        receipt({
          id: "b",
          printed_total_pence: null,
          lines: [{ line_total_pence: 200 }, { line_total_pence: 50 }],
        }),
        receipt({ id: "c", printed_total_pence: null, lines: [{ line_total_pence: null }] }),
      ],
      week,
    );
    expect(s.byCurrency).toEqual({ GBP: { pence: 1250, receipts: 2 } });
    expect(s.unknownTotals).toBe(1);
  });

  it("never adds one currency to another", async () => {
    const s = summariseSpending(
      [
        receipt({ id: "a", printed_total_pence: 1000, currency: "GBP" }),
        receipt({ id: "b", printed_total_pence: 500, currency: "EUR" }),
      ],
      week,
    );
    expect(s.byCurrency).toEqual({
      GBP: { pence: 1000, receipts: 1 },
      EUR: { pence: 500, receipts: 1 },
    });
  });

  it("includes both ends of the range and nothing outside it", async () => {
    const s = summariseSpending(
      [
        receipt({ id: "before", purchased_on: "2026-10-18", printed_total_pence: 1 }),
        receipt({ id: "mon", purchased_on: "2026-10-19", printed_total_pence: 10 }),
        receipt({ id: "sun", purchased_on: "2026-10-25", printed_total_pence: 100 }),
        receipt({ id: "after", purchased_on: "2026-10-26", printed_total_pence: 1000 }),
      ],
      week,
    );
    expect(s.byCurrency).toEqual({ GBP: { pence: 110, receipts: 2 } });
  });

  it("groups by store, sorted by total, with a null store as \"Unknown store\"", async () => {
    const s = summariseSpending(
      [
        receipt({ id: "a", store: "Tesco", printed_total_pence: 300 }),
        receipt({ id: "b", store: null, printed_total_pence: 900 }),
        receipt({ id: "c", store: "Tesco", printed_total_pence: 400 }),
        receipt({ id: "d", store: "Sainsbury's", printed_total_pence: 500 }),
      ],
      week,
    );
    expect(s.byStore).toEqual([
      { store: "Unknown store", currency: "GBP", pence: 900, receipts: 1 },
      { store: "Tesco", currency: "GBP", pence: 700, receipts: 2 },
      { store: "Sainsbury's", currency: "GBP", pence: 500, receipts: 1 },
    ]);
  });

  describe("never parses purchased_on with new Date(\"YYYY-MM-DD\")", () => {
    const RealDate = Date;
    afterEach(() => {
      globalThis.Date = RealDate;
    });

    it("summarising and ranging work with a Date that refuses date-only strings", async () => {
      // Installed after loading, so only the functions' own calls see it.
      globalThis.Date = class extends RealDate {
        constructor(...args: ConstructorParameters<typeof Date> | []) {
          if (typeof args[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
            throw new Error(`new Date("${args[0]}") is UTC midnight — compare the string`);
          }
          super(...(args as ConstructorParameters<typeof Date>));
        }
      } as DateConstructor;
      expect(() => weekRange("2026-10-25")).not.toThrow();
      expect(() =>
        summariseSpending([receipt({ purchased_on: "2026-10-25" })], week),
      ).not.toThrow();
    });
  });
});

describe("reconcile — lines against the printed total", () => {
  it("equal", async () => {
    const r = reconcile([{ line_total_pence: 150 }, { line_total_pence: -50 }], 100, "GBP");
    expect(r).toEqual({ status: "equal", diffPence: 0, message: null });
  });

  it("over", async () => {
    const r = reconcile([{ line_total_pence: 600 }], 500, "GBP");
    expect(r.status).toBe("over");
    expect(r.diffPence).toBe(100);
    expect(r.message).toBe("Lines are £1.00 over the total");
  });

  it("under — a line dropped at a seam shows here", async () => {
    const r = reconcile([{ line_total_pence: 400 }], 500, "GBP");
    expect(r.status).toBe("under");
    expect(r.diffPence).toBe(-100);
    expect(r.message).toBe("Lines are £1.00 under the total");
  });

  it("unknown when the total or any line total is unreadable", async () => {
    expect(reconcile([{ line_total_pence: 100 }], null, "GBP").status).toBe("unknown");
    expect(reconcile([{ line_total_pence: null }], 100, "GBP").status).toBe("unknown");
  });

  it("over by exactly the flagged seam lines names them (findings §3)", async () => {
    const r = reconcile(
      [{ line_total_pence: 500 }, { line_total_pence: 85 }],
      500,
      "GBP",
      85,
    );
    expect(r.status).toBe("over");
    expect(r.message).toBe(
      "Lines are £0.85 over the total — the same as the flagged possible repeat.",
    );
  });

  it("over by a different amount than the flagged lines doesn't blame them", async () => {
    const r = reconcile([{ line_total_pence: 700 }], 500, "GBP", 85);
    expect(r.message).toBe("Lines are £2.00 over the total");
  });
});

// ============================================================
// Commit 6 — the Grocery spending segment's view, pure (findings §2).
// ============================================================

describe("spendingOverview — what the Spending segment shows", () => {
  const week: Range = { start: "2026-10-19", end: "2026-10-25" };

  it("headlines the currency with the most receipts; another currency is its own line, never added", () => {
    const o = spendingOverview(
      [
        receipt({ id: "a", printed_total_pence: 1000 }),
        receipt({ id: "b", printed_total_pence: 2000 }),
        receipt({ id: "c", printed_total_pence: 500, currency: "EUR" }),
      ],
      week,
    );
    expect(o.headline).toEqual({ currency: "GBP", pence: 3000, receipts: 2 });
    expect(o.otherCurrencies).toEqual([{ currency: "EUR", pence: 500, receipts: 1 }]);
  });

  it("no countable receipt in the period: no headline (not a £0 that implies one)", () => {
    const o = spendingOverview([receipt({ purchased_on: "2026-09-01" })], week);
    expect(o.headline).toBeNull();
    expect(o.otherCurrencies).toEqual([]);
  });

  it("UNKNOWN-TOTAL RECEIPTS ARE LISTED, NOT COUNTED — in the period only", () => {
    const unknownIn = receipt({ id: "u1", printed_total_pence: null, lines: [{ line_total_pence: null }] });
    const unknownOut = receipt({ id: "u2", purchased_on: "2026-10-01", printed_total_pence: null, lines: [] });
    const o = spendingOverview([receipt({ id: "a", printed_total_pence: 1000 }), unknownIn, unknownOut], week);
    expect(o.headline).toEqual({ currency: "GBP", pence: 1000, receipts: 1 });
    expect(o.unknown.map((r) => r.id)).toEqual(["u1"]);
  });

  it("by store comes from the period's countable receipts", () => {
    const o = spendingOverview(
      [
        receipt({ id: "a", store: "Tesco", printed_total_pence: 300 }),
        receipt({ id: "b", store: "Tesco", printed_total_pence: 200, purchased_on: "2026-01-01" }),
      ],
      week,
    );
    expect(o.byStore).toEqual([{ store: "Tesco", currency: "GBP", pence: 300, receipts: 1 }]);
  });

  it("lists EVERY receipt, in the order given (newest first from fetchReceipts), so older ones stay editable", () => {
    const o = spendingOverview(
      [receipt({ id: "new", purchased_on: "2026-10-24" }), receipt({ id: "old", purchased_on: "2025-12-01" })],
      week,
    );
    expect(o.rows.map((r) => [r.id, r.inPeriod])).toEqual([
      ["new", true],
      ["old", false],
    ]);
  });

  it("a row's amount is total, else lines, else unknown — never 0", () => {
    const o = spendingOverview(
      [
        receipt({ id: "t", printed_total_pence: 1230 }),
        receipt({ id: "l", printed_total_pence: null, lines: [{ line_total_pence: 100 }] }),
        receipt({ id: "u", printed_total_pence: null, lines: [{ line_total_pence: null }] }),
      ],
      week,
    );
    expect(o.rows.map((r) => r.amount)).toEqual([
      { pence: 1230, source: "total" },
      { pence: 100, source: "lines" },
      null,
    ]);
  });

  it("badges a receipt whose lines don't add up to its printed total, and only then", () => {
    const o = spendingOverview(
      [
        receipt({ id: "over", printed_total_pence: 100, lines: [{ line_total_pence: 150 }] }),
        receipt({ id: "ok", printed_total_pence: 150, lines: [{ line_total_pence: 150 }] }),
        receipt({ id: "cant", printed_total_pence: 100, lines: [{ line_total_pence: null }] }),
        receipt({ id: "nolines", printed_total_pence: 100, lines: [] }),
      ],
      week,
    );
    expect(o.rows.map((r) => [r.id, r.mismatch])).toEqual([
      ["over", true],
      ["ok", false],
      ["cant", false],
      ["nolines", false],
    ]);
  });
});

// ============================================================
// Commit 8b — spending charts and the 3-month period (2026-10-04, Robbie).
// This week: a bar per day. This month: a bar per week (clipped to the
// month and to today). 3 months: a bar per week for the last 13 weeks.
// Same rules as the totals: one currency per chart, unknown totals counted
// per bucket and never added as £0. Wed 21 Oct 2026; BST ends Sun 25 Oct.
// ============================================================

describe("periodRange", () => {
  it("week and month are weekRange and monthRange", () => {
    expect(periodRange("week", "2026-10-21")).toEqual(weekRange("2026-10-21"));
    expect(periodRange("month", "2026-10-21")).toEqual(monthRange("2026-10-21"));
  });

  it("3 months is the last 13 Monday-to-Sunday weeks, ending this week", () => {
    expect(periodRange("3months", "2026-10-21")).toEqual({ start: "2026-07-27", end: "2026-10-25" });
  });

  it("3 months across the spring clock change still starts on a Monday", () => {
    // Wed 1 Apr 2026: this week is Mon 30 Mar – Sun 5 Apr; BST began Sun 29 Mar.
    expect(periodRange("3months", "2026-04-01")).toEqual({ start: "2026-01-05", end: "2026-04-05" });
  });
});

describe("spendingBuckets", () => {
  const today = "2026-10-21";
  const pence = (b: { pence: number }[]) => b.map((x) => x.pence);

  it("this week: a bar per day, Mon to Sun, in the chart's currency only", () => {
    const b = spendingBuckets(
      [
        receipt({ id: "mon", purchased_on: "2026-10-19", printed_total_pence: 500 }),
        receipt({ id: "mon2", purchased_on: "2026-10-19", printed_total_pence: 250 }),
        receipt({ id: "sun", purchased_on: "2026-10-25", printed_total_pence: 100 }),
        receipt({ id: "eur", purchased_on: "2026-10-20", printed_total_pence: 999, currency: "EUR" }),
        receipt({ id: "lastweek", purchased_on: "2026-10-18", printed_total_pence: 7777 }),
      ],
      "week",
      today,
      "GBP",
    );
    expect(b.map((x) => x.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(pence(b)).toEqual([750, 0, 0, 0, 0, 0, 100]);
    expect(b[0].receipts).toBe(2);
  });

  it("UNKNOWN TOTALS ARE COUNTED PER BAR, NEVER ADDED AS £0; the lines fallback counts", () => {
    const b = spendingBuckets(
      [
        receipt({ id: "u", purchased_on: "2026-10-20", printed_total_pence: null, lines: [{ line_total_pence: null }] }),
        receipt({ id: "l", purchased_on: "2026-10-20", printed_total_pence: null, lines: [{ line_total_pence: 300 }] }),
      ],
      "week",
      today,
      "GBP",
    );
    expect(b[1]).toMatchObject({ pence: 300, receipts: 1, unknown: 1 });
  });

  it("this month: a bar per week, clipped to the 1st and to today", () => {
    const b = spendingBuckets(
      [
        receipt({ id: "a", purchased_on: "2026-10-01", printed_total_pence: 100 }),
        receipt({ id: "b", purchased_on: "2026-10-11", printed_total_pence: 200 }),
        receipt({ id: "c", purchased_on: "2026-10-21", printed_total_pence: 400 }),
        receipt({ id: "sep", purchased_on: "2026-09-30", printed_total_pence: 9999 }),
      ],
      "month",
      today,
      "GBP",
    );
    expect(b.map((x) => [x.start, x.end, x.label])).toEqual([
      ["2026-10-01", "2026-10-04", "1 Oct"],
      ["2026-10-05", "2026-10-11", "5 Oct"],
      ["2026-10-12", "2026-10-18", "12 Oct"],
      ["2026-10-19", "2026-10-21", "19 Oct"],
    ]);
    expect(pence(b)).toEqual([100, 200, 0, 400]);
  });

  it("3 months: 13 weekly bars from the period's first Monday", () => {
    const b = spendingBuckets(
      [
        receipt({ id: "first", purchased_on: "2026-07-27", printed_total_pence: 10 }),
        receipt({ id: "before", purchased_on: "2026-07-26", printed_total_pence: 9999 }),
        receipt({ id: "last", purchased_on: "2026-10-25", printed_total_pence: 20 }),
      ],
      "3months",
      today,
      "GBP",
    );
    expect(b).toHaveLength(13);
    expect(b[0]).toMatchObject({ start: "2026-07-27", end: "2026-08-02", label: "27 Jul", pence: 10 });
    expect(b[12]).toMatchObject({ start: "2026-10-19", end: "2026-10-25", label: "19 Oct", pence: 20 });
  });

  it("the bars add up to the period's total for that currency (the headline)", () => {
    const receipts = [
      receipt({ id: "a", purchased_on: "2026-08-03", printed_total_pence: 1234 }),
      receipt({ id: "b", purchased_on: "2026-09-15", printed_total_pence: null, lines: [{ line_total_pence: 66 }] }),
      receipt({ id: "c", purchased_on: "2026-10-21", printed_total_pence: 500 }),
      receipt({ id: "d", purchased_on: "2026-10-02", printed_total_pence: 70, currency: "EUR" }),
    ];
    for (const period of ["week", "month", "3months"] as const) {
      const total = summariseSpending(receipts, periodRange(period, today)).byCurrency.GBP?.pence ?? 0;
      expect(spendingBuckets(receipts, period, today, "GBP").reduce((n, x) => n + x.pence, 0)).toBe(total);
    }
  });
});
