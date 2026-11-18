// ============================================================
// PL-058 — History's daily average must not fabricate zeros.
//
// HistoryScreen coalesced a day's unknown small-four total to 0 and then
// averaged it, so a week of foods with no fibre data dragged the average
// towards 0 — a number the user reads directly, and one Trends contradicts:
// Trends draws a GAP for the same day (lib/trends.ts, TrendPoint.value).
//
// The rule, matching Trends:
//   - a day where the nutrient is unknown on every eaten row (bucket null)
//     is excluded from that nutrient's average — "we don't know", not 0;
//   - a partly-known day counts at its known sum (Trends draws that point);
//   - a real, measured 0 counts as 0;
//   - the big four are NOT NULL and keep averaging over every logged day.
// ============================================================

import { describe, it, expect } from "vitest";
import { dailyAverages } from "../historyAverages";
import { averageNote, averageText } from "../incompleteNutrients";
import type { DayBucket } from "../entries";

function day(over: Partial<DayBucket> = {}): DayBucket {
  return {
    calories: 2000,
    protein: 100,
    carbs: 200,
    fat: 70,
    satFat: 20,
    salt: 5,
    fibre: 25,
    sugar: 50,
    count: 5,
    lowerBound: [],
    hasNullRow: [],
    ...over,
  };
}

const UNLOGGED = day({
  calories: 0, protein: 0, carbs: 0, fat: 0,
  satFat: null, salt: null, fibre: null, sugar: null, count: 0,
});

describe("dailyAverages (PL-058)", () => {
  it("averages a small-four nutrient over the days it is known, not over every logged day", () => {
    // 3 known-fibre days and 4 where fibre is unknown on every row.
    const days = [
      day({ fibre: 10 }), day({ fibre: 20 }), day({ fibre: 30 }),
      day({ fibre: null }), day({ fibre: null }), day({ fibre: null }), day({ fibre: null }),
    ];
    const avg = dailyAverages(days)!;
    expect(avg.fibre).toEqual({ value: 20, knownDays: 3, loggedDays: 7, lowerBoundDays: 0 });
  });

  it("is null, not 0, when the nutrient is unknown on every logged day", () => {
    const avg = dailyAverages([day({ salt: null }), day({ salt: null })])!;
    expect(avg.salt).toEqual({ value: null, knownDays: 0, loggedDays: 2, lowerBoundDays: 0 });
  });

  it("keeps a measured zero as a zero", () => {
    const avg = dailyAverages([day({ sugar: 0 }), day({ sugar: 10 })])!;
    expect(avg.sugar).toEqual({ value: 5, knownDays: 2, loggedDays: 2, lowerBoundDays: 0 });
  });

  it("counts a partly-known day at its known sum, as Trends draws it — and as a minimum (PL-061)", () => {
    // sumBucket gives 6 for a day with rows {6, unknown}: known, an undercount.
    const avg = dailyAverages([day({ satFat: 6, hasNullRow: ["sat_fat"] }), day({ satFat: 10 })])!;
    expect(avg.satFat).toEqual({ value: 8, knownDays: 2, loggedDays: 2, lowerBoundDays: 1 });
    expect(averageText(avg.satFat)).toBe("≥ 8g");
    expect(averageNote(avg.satFat)).toBe("1 of 2 days is a minimum");
  });

  it("PL-061: a partly-NULL day and a flagged day are each one minimum day, never two", () => {
    const avg = dailyAverages([
      day({ fibre: 10, hasNullRow: ["fibre"] }),
      day({ fibre: 20, hasNullRow: ["fibre"], lowerBound: ["fibre"] }),
      day({ fibre: 30 }),
      day({ fibre: null, hasNullRow: ["fibre"] }),
    ])!;
    expect(avg.fibre).toEqual({ value: 20, knownDays: 3, loggedDays: 4, lowerBoundDays: 2 });
    expect(averageText(avg.fibre)).toBe("≥ 20g");
    expect(averageNote(avg.fibre)).toBe("3 of 4 days · 2 are minimums");
    // A NULL row in fibre says nothing about salt.
    expect(avg.salt.lowerBoundDays).toBe(0);
  });

  it("PL-059: includes a day with a lower-bound entry in the average, and counts it as a minimum day", () => {
    // Excluding it would understate the average further; it is included at
    // its known sum and the average is marked as a minimum instead.
    const avg = dailyAverages([
      day({ fibre: 10, lowerBound: ["fibre"] }),
      day({ fibre: 20 }),
      day({ fibre: 30, lowerBound: ["salt", "fibre"] }),
    ])!;
    expect(avg.fibre).toEqual({ value: 20, knownDays: 3, loggedDays: 3, lowerBoundDays: 2 });
    // salt is flagged on day 3 only; sat fat and sugar on none.
    expect(avg.salt.lowerBoundDays).toBe(1);
    expect(avg.satFat.lowerBoundDays).toBe(0);
    expect(avg.sugar.lowerBoundDays).toBe(0);
  });

  it("PL-059: a day where the nutrient is unknown is left out, so it can't be a minimum day either", () => {
    const avg = dailyAverages([day({ fibre: null, lowerBound: [] }), day({ fibre: 8 })])!;
    expect(avg.fibre).toEqual({ value: 8, knownDays: 1, loggedDays: 2, lowerBoundDays: 0 });
  });

  it("averages the big four over every logged day and ignores unlogged days entirely", () => {
    const avg = dailyAverages([
      day({ calories: 1800, protein: 90, carbs: 180, fat: 60 }),
      day({ calories: 2200, protein: 110, carbs: 220, fat: 80 }),
      UNLOGGED,
    ])!;
    expect(avg.loggedDays).toBe(2);
    expect(avg.calories).toBe(2000);
    expect(avg.protein).toBe(100);
    expect(avg.carbs).toBe(200);
    expect(avg.fat).toBe(70);
    expect(avg.fibre.loggedDays).toBe(2);
  });

  it("is null when no day in the window was logged", () => {
    expect(dailyAverages([UNLOGGED, UNLOGGED])).toBeNull();
    expect(dailyAverages([])).toBeNull();
  });

  it("rounds as History always has: calories to 1, salt to 0.01, the rest to 0.1", () => {
    const avg = dailyAverages([
      day({ calories: 2001, protein: 100.04, salt: 1.004, fibre: 1.04 }),
      day({ calories: 2002, protein: 100.0, salt: 1.0, fibre: 1.0 }),
    ])!;
    expect(avg.calories).toBe(2002); // 2001.5 → 2002
    expect(avg.protein).toBe(100); // 100.02 → 100.0
    expect(avg.salt.value).toBe(1); // 1.002 → 1.00
    expect(avg.fibre.value).toBe(1); // 1.02 → 1.0
  });
});
