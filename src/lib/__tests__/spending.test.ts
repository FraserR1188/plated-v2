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
import { receiptAmount, weekRange, monthRange, summariseSpending, reconcile } from "../spending";

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
