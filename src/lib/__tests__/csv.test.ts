// ============================================================
// PL-007 — the CSV export dated rows in UTC.
// PL-008 — it exported an unknown small-four value as 0.0.
//
// The whole suite runs pinned to Europe/London (vitest.setup.ts). That is
// load-bearing here: under UTC, dateKey() and toISOString().slice(0, 10)
// agree exactly, so every assertion below would pass against the broken
// code.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildCsv,
  last30Days,
  CSV_HEADER,
  SPENDING_CSV_HEADER,
  buildSpendingCsv,
  spendingCsvFilename,
} from "../csv";
import { dateKey } from "../time";
import { MealEntry } from "../../types";

function makeEntry(overrides: Partial<MealEntry> = {}): MealEntry {
  return {
    id: "e1",
    user_id: "u1",
    date: "2026-06-12",
    logged_at: "2026-06-12T08:00:00.000Z",
    eaten_at: "2026-06-12T08:00:00.000Z",
    name: "Porridge",
    calories: 437,
    protein: 12.5,
    carbs: 60,
    fat: 8,
    sat_fat: 2,
    salt: 1.25,
    fibre: 6,
    sugar: 4,
    source: "search",
    barcode: null,
    off_id: null,
    serving_g: 250,
    meal_type: "breakfast",
    brand: null,
    planned: false,
    confirmed_at: null,
    skipped_at: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    eaten_at_estimated: false,
    ...overrides,
  };
}

/** The data rows, split into cells. The export has no quoted commas in
 *  these fixtures, so a plain split is safe and keeps the assertions
 *  readable. */
function rows(csv: string): string[][] {
  return csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(","));
}

const COL = {
  date: 0,
  eatenTime: 1,
  satFat: 11,
  salt: 12,
  fibre: 13,
  sugar: 14,
} as const;

describe("buildCsv — the header", () => {
  it("keeps the header row and column order exactly as they were", () => {
    // Anyone with an existing spreadsheet keyed on these columns should not
    // have it break because the dates underneath got fixed.
    expect(CSV_HEADER).toBe(
      "date,eaten_time,logged_time,meal_type,ingredient,brand,serving_g," +
        "calories,protein_g,carbs_g,fat_g,sat_fat_g,salt_g,fibre_g,sugar_g,source",
    );
    expect(buildCsv([makeEntry()]).split("\n")[0]).toBe(CSV_HEADER);
  });
});

describe("PL-007 — the date column is the LOCAL day", () => {
  it("a meal eaten at 00:30 BST exports under that local date, not the UTC one", () => {
    // 2026-06-11T23:30Z is 00:30 on the 12th in London. The old code wrote
    // the 11th, so a late-night meal landed in the wrong day's row — and
    // the CSV disagreed with what Today had shown all along.
    const entry = makeEntry({
      eaten_at: "2026-06-11T23:30:00.000Z",
      date: "2026-06-12",
    });

    expect(rows(buildCsv([entry]))[0][COL.date]).toBe("2026-06-12");
  });

  it("the exported date always equals dateKey(eaten_at)", () => {
    // The invariant, stated directly: `date` is derived from eaten_at via
    // the one local dateKey() (CLAUDE.md), and the export is no exception.
    for (const iso of [
      "2026-06-11T23:30:00.000Z",
      "2026-06-12T00:30:00.000Z",
      "2026-01-15T23:45:00.000Z",
      "2026-10-24T23:30:00.000Z",
    ]) {
      const out = rows(buildCsv([makeEntry({ eaten_at: iso })]))[0][COL.date];
      expect(out).toBe(dateKey(new Date(iso)));
    }
  });

  it("falls back to logged_at's LOCAL day when eaten_at is missing", () => {
    const entry = makeEntry({
      eaten_at: null as unknown as string,
      logged_at: "2026-06-11T23:30:00.000Z",
    });

    expect(rows(buildCsv([entry]))[0][COL.date]).toBe("2026-06-12");
  });

  it("dates correctly on the night the clocks go back (25 Oct 2026)", () => {
    // 00:30 BST on the 25th is 23:30Z on the 24th. An hour later the clocks
    // go back, so the 25th has two 01:30s locally — both are still the 25th.
    const before = makeEntry({ eaten_at: "2026-10-24T23:30:00.000Z" });
    const firstOneThirty = makeEntry({ eaten_at: "2026-10-25T00:30:00.000Z" });
    const secondOneThirty = makeEntry({ eaten_at: "2026-10-25T01:30:00.000Z" });

    const out = rows(buildCsv([before, firstOneThirty, secondOneThirty]));
    expect(out.map((r) => r[COL.date])).toEqual([
      "2026-10-25",
      "2026-10-25",
      "2026-10-25",
    ]);
  });
});

describe("PL-008 — an unknown small-four value is an empty cell", () => {
  it("exports NULL sat_fat, salt, fibre and sugar as empty, not 0.0", () => {
    // A stored NULL means "we never knew this". Writing 0.0 asserts the
    // food contained none of it — the same fabrication PL-002 fixed in
    // saved_ingredients, arriving at the analysis by a different route.
    const entry = makeEntry({
      sat_fat: null,
      salt: null,
      fibre: null,
      sugar: null,
    });

    const row = rows(buildCsv([entry]))[0];
    expect(row[COL.satFat]).toBe("");
    expect(row[COL.salt]).toBe("");
    expect(row[COL.fibre]).toBe("");
    expect(row[COL.sugar]).toBe("");
  });

  it("exports an explicit 0 as 0.0 — a measured zero is not unknown", () => {
    const entry = makeEntry({ sat_fat: 0, salt: 0, fibre: 0, sugar: 0 });

    const row = rows(buildCsv([entry]))[0];
    expect(row[COL.satFat]).toBe("0.0");
    expect(row[COL.salt]).toBe("0.00");
    expect(row[COL.fibre]).toBe("0.0");
    expect(row[COL.sugar]).toBe("0.0");
  });

  it("treats undefined the same as null", () => {
    const entry = makeEntry();
    delete (entry as Partial<MealEntry>).sat_fat;

    expect(rows(buildCsv([entry]))[0][COL.satFat]).toBe("");
  });

  it("keeps real values, and their decimal places, unchanged", () => {
    const row = rows(buildCsv([makeEntry()]))[0];
    expect(row[COL.satFat]).toBe("2.0");
    expect(row[COL.salt]).toBe("1.25");
    expect(row[COL.fibre]).toBe("6.0");
    expect(row[COL.sugar]).toBe("4.0");
  });
});

describe("last30Days", () => {
  /** One entry per local day, ending on `endKey`. */
  function dailyEntries(endKey: string, days: number): MealEntry[] {
    const [y, m, d] = endKey.split("-").map(Number);
    const out: MealEntry[] = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(y, m - 1, d);
      day.setDate(day.getDate() - i);
      out.push(makeEntry({ id: `e${i}`, date: dateKey(day) }));
    }
    return out;
  }

  it("covers exactly 30 local days, inclusive of today", () => {
    const now = new Date(2026, 5, 20, 12, 0, 0); // 20 June 2026, local noon
    const entries = dailyEntries("2026-06-20", 40);

    const kept = last30Days(entries, now);

    expect(kept).toHaveLength(30);
    const keys = kept.map((e) => e.date).sort();
    expect(keys[keys.length - 1]).toBe("2026-06-20"); // today, included
    expect(keys[0]).toBe("2026-05-22"); // 29 days back
  });

  it("excludes the day just outside the window", () => {
    const now = new Date(2026, 5, 20, 12, 0, 0);
    const justOutside = makeEntry({ id: "old", date: "2026-05-21" });
    const justInside = makeEntry({ id: "new", date: "2026-05-22" });

    const kept = last30Days([justOutside, justInside], now);

    expect(kept.map((e) => e.id)).toEqual(["new"]);
  });

  it("is computed in LOCAL days — a 00:30 BST export still includes today", () => {
    // 2026-06-11T23:30Z is 00:30 on the 12th locally. Computing the range
    // in UTC gave `to` = the 11th, so the meals already logged "today"
    // were outside the export the user had just asked for.
    const now = new Date("2026-06-11T23:30:00.000Z");
    const today = makeEntry({ id: "today", date: "2026-06-12" });

    expect(last30Days([today], now).map((e) => e.id)).toEqual(["today"]);
  });

  // ── DST ──────────────────────────────────────────────────────────
  //
  // These two fixtures sit at OPPOSITE ends of the local day on purpose.
  // A first attempt used local noon on both sides of the autumn change and
  // a sabotage run (fixed-ms arithmetic, local keys) PASSED it: crossing a
  // transition shifts the wall clock by an hour, which only changes the
  // calendar DAY when the time of day is within an hour of midnight. At
  // noon the bug is invisible. The window is wrong in both directions, so
  // both are pinned.

  it("keeps 30 days across the BST→GMT change, from late in the evening", () => {
    // 23:30 GMT on 10 Nov. Fixed-millisecond arithmetic lands 29 × 24h
    // earlier at 00:30 BST on 13 Oct — an hour LATER on the wall clock,
    // so a day too late, and the window silently shrinks to 29.
    const now = new Date(2026, 10, 10, 23, 30, 0);
    const entries = dailyEntries("2026-11-10", 40);

    const kept = last30Days(entries, now);

    expect(kept).toHaveLength(30);
    const keys = kept.map((e) => e.date).sort();
    expect(keys[0]).toBe("2026-10-12");
    expect(keys[keys.length - 1]).toBe("2026-11-10");
  });

  it("keeps 30 days across the GMT→BST change, from just after midnight", () => {
    // 00:30 BST on 20 Apr. The same arithmetic lands at 23:30 GMT on
    // 21 Mar — an hour EARLIER, so a day too early, and the window
    // silently grows to 31.
    const now = new Date(2026, 3, 20, 0, 30, 0);
    const entries = dailyEntries("2026-04-20", 40);

    const kept = last30Days(entries, now);

    expect(kept).toHaveLength(30);
    const keys = kept.map((e) => e.date).sort();
    expect(keys[0]).toBe("2026-03-22");
    expect(keys[keys.length - 1]).toBe("2026-04-20");
  });
});

// ============================================================
// Receipt scanner: the spending export (findings §6). Written red in
// commit 2, green from commit 6.
//
// One row per receipt line; the receipt's columns repeat on each row. Money
// is "12.30" with an EMPTY cell for NULL (PL-008), and purchased_on is
// written as stored: it's already a local calendar date (PL-007).
// ============================================================

type SpendingCsvLine = {
  position: number;
  raw_text: string;
  qty: number | null;
  qty_unit: "each" | "kg" | null;
  unit_price_pence: number | null;
  line_total_pence: number | null;
  is_discount: boolean;
};
type SpendingCsvReceipt = {
  purchased_on: string;
  purchased_on_estimated: boolean;
  store: string | null;
  currency: string;
  printed_total_pence: number | null;
  lines: SpendingCsvLine[];
};
function spendLine(over: Partial<SpendingCsvLine> = {}): SpendingCsvLine {
  return {
    position: 0,
    raw_text: "JS CHICKPEAS",
    qty: null,
    qty_unit: null,
    unit_price_pence: null,
    line_total_pence: 41,
    is_discount: false,
    ...over,
  };
}

function spendReceipt(over: Partial<SpendingCsvReceipt> = {}): SpendingCsvReceipt {
  return {
    purchased_on: "2026-10-25",
    purchased_on_estimated: false,
    store: "Sainsbury's",
    currency: "GBP",
    printed_total_pence: 1230,
    lines: [spendLine()],
    ...over,
  };
}

describe("spending CSV (receipt scanner)", () => {
  it("pins the header", () => {
    expect(SPENDING_CSV_HEADER).toBe(
      "purchased_on,date_estimated,store,currency,receipt_total,line_no,item_text,qty,qty_unit,unit_price,line_total,is_discount",
    );
  });

  it("starts with the header and writes one row per line, receipt columns repeated", () => {
    const rows = buildSpendingCsv([
      spendReceipt({
        lines: [
          spendLine({ position: 0, raw_text: "MILK", line_total_pence: 150 }),
          spendLine({ position: 1, raw_text: "Nectar Price Saving", line_total_pence: -50, is_discount: true }),
        ],
      }),
    ]).trimEnd().split("\n");
    expect(rows[0]).toBe(SPENDING_CSV_HEADER);
    expect(rows).toHaveLength(3);
    for (const r of rows.slice(1)) {
      const c = r.split(",");
      expect(c[0]).toBe("2026-10-25"); // purchased_on as stored
      expect(c[3]).toBe("GBP");
      expect(c[4]).toBe("12.30"); // receipt_total
    }
    expect(rows[1].split(",")[10]).toBe("1.50");
    expect(rows[2].split(",")[10]).toBe("-0.50");
  });

  it("writes NULL money as an empty cell, never 0.00", () => {
    const row = buildSpendingCsv([
      spendReceipt({
        printed_total_pence: null,
        lines: [spendLine({ unit_price_pence: null, line_total_pence: null })],
      }),
    ]).trimEnd().split("\n")[1].split(",");
    expect(row[4]).toBe(""); // receipt_total
    expect(row[9]).toBe(""); // unit_price
    expect(row[10]).toBe(""); // line_total
  });

  it("a receipt with no lines is one row, with empty line cells", () => {
    const rows = buildSpendingCsv([spendReceipt({ lines: [] })]).trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    const c = rows[1].split(",");
    expect(c).toHaveLength(12);
    expect(c.slice(5)).toEqual(["", "", "", "", "", "", ""]);
    expect(c[4]).toBe("12.30"); // the receipt's own total is still there
  });

  it("quotes item text containing a comma", () => {
    const out = buildSpendingCsv([
      spendReceipt({ lines: [spendLine({ raw_text: "WINE, RED 75CL", line_total_pence: 650 })] }),
    ]);
    expect(out).toContain('"WINE, RED 75CL"');
  });

  it("names the file by LOCAL date: 00:30 BST on 25 Oct is the 25th, not the 24th", () => {
    expect(spendingCsvFilename(new Date(2026, 9, 25, 0, 30))).toBe(
      "plated_spending_2026-10-25.csv",
    );
  });
});
