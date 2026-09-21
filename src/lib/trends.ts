// ============================================================
// Part 4 — Trends: the pure aggregation behind the small-multiple charts.
//
// A line chart is a confident-looking object. A point at y=0 asserts "you
// ate nothing"; a point at y=1800 asserts "you ate 1800". This module's one
// job is to never make a claim it cannot support:
//
//   unlogged day          → a GAP. Never a zero.
//   nutrient unknown on
//     SOME eaten rows     → a value, flagged INCOMPLETE (it is an undercount)
//   nutrient unknown on
//     EVERY eaten row     → a gap, still flagged incomplete (the day WAS
//                           logged; we just know nothing about this nutrient)
//   today                 → flagged SO FAR; the day has not finished
//   goals not loaded      → NO goal line (PL-026)
//
// It plots the `eaten` bucket, never `towardGoal`. `towardGoal` folds
// unconfirmed plans into an unsettled day because plans count toward daily
// goals (CLAUDE.md) — correct for a ring that asks "am I on track today",
// wrong for a line that records what happened. On towardGoal, today's point
// would jump the moment a plan was added and drop again at midnight when the
// day settled: a line that moves without anyone eating anything.
//
// No clock is read in here. `now` is always a parameter, so every window and
// every "is this today" decision is testable across a DST boundary.
// ============================================================

import { MealEntry, Goals } from "../types";
import { GoalsState } from "../store/useStore";
import { DayBucket, getDaySummary } from "./entries";
import { dateKey } from "./time";

/** The eight tracked nutrients, keyed as DayBucket and Goals key them. */
export type TrendNutrient = keyof Omit<DayBucket, "count">;

/** The ranges the toggle offers, in the order it offers them. */
export const RANGE_DAYS = [7, 14] as const;
export type TrendRange = (typeof RANGE_DAYS)[number];

/** At most three charts at once — beyond that the small multiples stop being
 *  readable at 360dp, which is the width that has to work. */
export const MAX_SELECTED = 3;

/** Opens on the three that answer "how am I eating" first. Fibre is
 *  deliberately not among them: it is the nutrient most often unknown, so it
 *  would open the tab on a chart full of gaps. */
export const DEFAULT_NUTRIENTS: TrendNutrient[] = ["calories", "protein", "carbs"];

/**
 * The only nutrients that can ever be INCOMPLETE.
 *
 * calories/protein/carbs/fat are NOT NULL DEFAULT 0 on meal_entries —
 * 20260818140000_meal_entries_null_not_zero.sql made the small four nullable
 * and deliberately left the big four alone. So there is no such thing as a
 * partially-known calories day: the column cannot hold "unknown".
 *
 * Which means the three DEFAULT nutrients can never show an incomplete
 * point. Incomplete is a real state, but only sat fat, salt, fibre and sugar
 * can reach it — and PL-028's repair made it more common, not less, by
 * restoring chia's salt to the NULL it always should have been.
 */
export const NULLABLE_NUTRIENTS: TrendNutrient[] = [
  "satFat",
  "salt",
  "fibre",
  "sugar",
];

/** The MealEntry column each bucket field sums, for the per-row completeness
 *  check. Only the nullable four need one; the big four cannot be unknown. */
const ENTRY_COLUMN: Partial<Record<TrendNutrient, keyof MealEntry>> = {
  satFat: "sat_fat",
  salt: "salt",
  fibre: "fibre",
  sugar: "sugar",
};

export interface TrendNutrientMeta {
  key: TrendNutrient;
  label: string;
  unit: "kcal" | "g";
}

/**
 * Display metadata, in the order the picker lists them.
 *
 * NO COLOURS HERE, deliberately. src/theme/tokens.ts imports React
 * Navigation and react-native-safe-area-context, neither of which survives
 * being loaded in vitest's node environment — so a lib module that reaches
 * for a colour drags the whole native surface into the pure-logic layer and
 * takes its tests down with it. The per-macro colour language lives in the
 * component that draws the chart; see TrendChart's NUTRIENT_COLOR.
 */
export const TREND_NUTRIENTS: TrendNutrientMeta[] = [
  { key: "calories", label: "Calories", unit: "kcal" },
  { key: "protein", label: "Protein", unit: "g" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fat", label: "Fat", unit: "g" },
  { key: "satFat", label: "Sat fat", unit: "g" },
  { key: "salt", label: "Salt", unit: "g" },
  { key: "fibre", label: "Fibre", unit: "g" },
  { key: "sugar", label: "Sugar", unit: "g" },
];

export interface TrendPoint {
  /** Local date key, "YYYY-MM-DD". */
  date: string;
  /** null means DRAW NO POINT. Either the day has no eaten rows at all, or
   *  this nutrient is unknown on every one of them. `unlogged` tells the two
   *  apart, and they must be told apart: one means "you ate nothing", the
   *  other means "we don't know what you ate". */
  value: number | null;
  /** No eaten rows on this day at all. */
  unlogged: boolean;
  /** At least one eaten row on this day has no value for this nutrient, so
   *  `value` is an undercount — or, when `value` is null, a total unknown. */
  incomplete: boolean;
  /** This is today and the day has not settled: the value is partial by
   *  definition, not because anything is missing. */
  soFar: boolean;
}

export interface TrendSeries {
  nutrient: TrendNutrient;
  meta: TrendNutrientMeta;
  /** Oldest → newest, one per day in the window, gaps included. */
  points: TrendPoint[];
  /** The user's target, or null when goals are not loaded or none is set.
   *  Never a default — see PL-026. */
  goal: number | null;
}

export interface BuildTrendSeriesInput {
  entries: MealEntry[];
  nutrients: TrendNutrient[];
  range: TrendRange;
  now: Date;
  goals: Goals;
  goalsState: GoalsState;
}

/**
 * The N local dates ending on `now`'s local day, oldest first.
 *
 * Calendar arithmetic via setDate(), never `now - i * 86_400_000`. On the
 * BST→GMT Sunday the local day is 25 hours long, so a fixed-millisecond step
 * lands on the same calendar date twice and drops a day off the window; on
 * the GMT→BST Sunday it is 23 hours and skips one. setDate() asks the
 * calendar, which is the thing the user is actually looking at.
 */
export function trendWindowDates(range: TrendRange, now: Date): string[] {
  const dates: string[] = [];
  for (let back = range - 1; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - back);
    dates.push(dateKey(d));
  }
  return dates;
}

/**
 * Toggle one nutrient in the selection.
 *
 * Refuses to exceed MAX_SELECTED, and refuses to empty the selection — an
 * empty Trends tab is a blank screen with no way to explain itself. Both
 * refusals return the input unchanged so the caller can compare identity to
 * decide whether to show a "3 at a time" hint.
 */
export function toggleNutrient(
  selected: TrendNutrient[],
  nutrient: TrendNutrient,
): TrendNutrient[] {
  if (selected.includes(nutrient)) {
    if (selected.length === 1) return selected;
    return selected.filter((n) => n !== nutrient);
  }
  if (selected.length >= MAX_SELECTED) return selected;
  return [...selected, nutrient];
}

/** Does any EATEN row on this day lack a value for this nutrient? Pending and
 *  skipped rows are irrelevant: they are not part of what was eaten, so their
 *  unknowns say nothing about the completeness of what was. */
function hasUnknownRow(
  entries: MealEntry[],
  date: string,
  nutrient: TrendNutrient,
): boolean {
  const column = ENTRY_COLUMN[nutrient];
  if (!column) return false; // big four: NOT NULL, cannot be unknown
  return entries.some(
    (e) =>
      e.date === date &&
      !e.skipped_at &&
      (!e.planned || !!e.confirmed_at) && // isEaten, inlined to keep this pure
      e[column] == null,
  );
}

/**
 * The SVG path segments for a series, broken at every gap.
 *
 * Pure, and here rather than in the chart component, because a source-text
 * assertion cannot tell a line that breaks at a gap from one that runs
 * straight through it. A sabotage run proved exactly that: removing the
 * break left every token the structural test looked for in place, and the
 * test passed while the chart drew a straight line across an unlogged day.
 * This is the version that can be checked against real input.
 *
 * A straight line from Monday to Wednesday is a DRAWN CLAIM about Tuesday.
 * If Tuesday has no value, no ink may cross it.
 *
 * A run of one point produces no segment: a path needs two points. The dot
 * is still drawn by the caller, so an isolated day is visible as a point
 * with no line, which is the truth about it.
 */
export function buildPathSegments(
  points: TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 1) segments.push(current.join(" "));
    current = [];
  };

  points.forEach((p, i) => {
    if (p.value == null) {
      flush();
      return;
    }
    current.push(`${current.length === 0 ? "M" : "L"}${x(i)} ${y(p.value)}`);
  });
  flush();

  return segments;
}

export function buildTrendSeries({
  entries,
  nutrients,
  range,
  now,
  goals,
  goalsState,
}: BuildTrendSeriesInput): TrendSeries[] {
  const dates = trendWindowDates(range, now);
  const today = dateKey(now);

  // One getDaySummary per day, shared across every selected nutrient. This
  // is THE shared aggregation (lib/entries.ts D7) — Trends does not get its
  // own answer to "what happened on this day", because that divergence is
  // the bug getDaySummary was extracted to end.
  const summaries = new Map(
    dates.map((date) => [date, getDaySummary(entries, date, now)]),
  );

  return nutrients.map((nutrient) => {
    const meta = TREND_NUTRIENTS.find((m) => m.key === nutrient)!;

    const points: TrendPoint[] = dates.map((date) => {
      const eaten = summaries.get(date)!.eaten;
      const unlogged = eaten.count === 0;
      const raw = eaten[nutrient];

      return {
        date,
        // A gap when the day is unlogged, and also when the nutrient is
        // null — sumBucket returns null only when every contributing row
        // was null, which is "unknown", not "zero".
        value: unlogged ? null : raw,
        unlogged,
        incomplete: unlogged ? false : hasUnknownRow(entries, date, nutrient),
        soFar: date === today,
      };
    });

    // PL-026: only a loaded goal is the user's own. `loading`, `absent` and
    // `error` all leave the store holding DEFAULT_GOALS, and drawing a line
    // across the chart at a number nobody chose is the most confident
    // possible version of that mistake. A 0 means "no target set".
    const goal =
      goalsState === "loaded" && goals[nutrient] > 0 ? goals[nutrient] : null;

    return { nutrient, meta, points, goal };
  });
}
