// ============================================================
// src/lib/historyAverages.ts — History's "Daily average" card (PL-058).
//
// HistoryScreen used to coalesce a day's unknown small-four total to 0 and
// average it, so days with no fibre data dragged the fibre average towards
// zero — while Trends drew a GAP for the same days. This is the one place
// the average is computed, and it follows Trends' rule (lib/trends.ts,
// TrendPoint):
//
//   - a day where the nutrient is unknown on every eaten row (the bucket's
//     null — see sumBucket in lib/entries.ts) is LEFT OUT of that
//     nutrient's average: "we don't know", not "none";
//   - a partly-known day counts at its known sum, as Trends draws it;
//   - a measured 0 is a real 0;
//   - no known day at all is null, rendered "—", never 0.
//
// The big four are NOT NULL (PL-011) and average over every logged day, as
// before. Rounding is unchanged from the screen's: calories to the unit,
// salt to 0.01, everything else to 0.1.
// ============================================================

import type { DayBucket } from "./entries";

export type KnownAverage = {
  /** Mean over the days the nutrient is known, or null if it is known on none. */
  value: number | null;
  /** Logged days where the nutrient is known (the average's denominator). */
  knownDays: number;
  /** Logged days in the window, known or not. knownDays < loggedDays means
   *  some days were left out, and the screen says so. */
  loggedDays: number;
};

export type DailyAverages = {
  loggedDays: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  satFat: KnownAverage;
  salt: KnownAverage;
  fibre: KnownAverage;
  sugar: KnownAverage;
};

type SmallFour = "satFat" | "salt" | "fibre" | "sugar";

function round(v: number, places: number): number {
  return +v.toFixed(places);
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function knownAverage(logged: DayBucket[], key: SmallFour, places: number): KnownAverage {
  const known = logged
    .map((d) => d[key])
    .filter((v): v is number => v != null);
  return {
    value: known.length ? round(mean(known), places) : null,
    knownDays: known.length,
    loggedDays: logged.length,
  };
}

/** Days with no eaten rows are not "days you ate nothing"; they are left
 *  out of every average. Null when no day in the window was logged. */
export function dailyAverages(days: DayBucket[]): DailyAverages | null {
  const logged = days.filter((d) => d.count > 0);
  if (logged.length === 0) return null;

  return {
    loggedDays: logged.length,
    calories: Math.round(mean(logged.map((d) => d.calories))),
    protein: round(mean(logged.map((d) => d.protein)), 1),
    carbs: round(mean(logged.map((d) => d.carbs)), 1),
    fat: round(mean(logged.map((d) => d.fat)), 1),
    satFat: knownAverage(logged, "satFat", 1),
    salt: knownAverage(logged, "salt", 2),
    fibre: knownAverage(logged, "fibre", 1),
    sugar: knownAverage(logged, "sugar", 1),
  };
}
