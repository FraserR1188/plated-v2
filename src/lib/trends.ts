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
import { dateKey, parseDateKey } from "./time";

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
 * Why a toggle was refused, or null when it was not.
 *
 * Pairs with toggleNutrient and is defined to agree with it exactly: a
 * message exists precisely when toggleNutrient returns its input unchanged.
 * A test asserts that correspondence over every combination, so the rule
 * and the explanation of the rule cannot drift.
 *
 * It exists because a tap that does nothing reads as a broken button
 * rather than as a rule -- device pass feedback, 2026-09-20. The text is
 * here rather than in the component so it can be checked against real
 * input; a source-text assertion could not tell a live call from a dead
 * one, which a sabotage run demonstrated.
 */
export function capMessageFor(
  selected: TrendNutrient[],
  nutrient: TrendNutrient,
): string | null {
  if (toggleNutrient(selected, nutrient) !== selected) return null;
  return selected.includes(nutrient)
    ? "Keep at least one."
    : `That's ${MAX_SELECTED} already — tap one to swap it out.`;
}

// ── Chart geometry ─────────────────────────────────────────────────────────
//
// Here, not in the component, so "nothing falls off the canvas" can be
// asserted against real numbers. The device pass found today's hollow point
// cut in half by the right-hand edge: the padding had been sized for the
// LINE, and a hollow dot is wider than its centre by its radius plus half
// its stroke -- and it is always the last point in the window, which is
// always the one at the edge.

export const POINT_RADIUS = 3;
export const POINT_STROKE = 1.5;

/** How far a drawn point extends beyond its centre, in any direction. */
export const POINT_EXTENT = POINT_RADIUS + POINT_STROKE / 2;

/** Gutter for the y-axis labels (0 and the top of the scale). */
export const Y_LABEL_WIDTH = 26;

/** Strip under the plot for the x-axis date labels. */
export const X_LABEL_HEIGHT = 14;

export interface ChartScaleInput {
  width: number;
  height: number;
  pointCount: number;
  /** The top of the scale. The bottom is ALWAYS zero -- see below. */
  max: number;
}

export interface ChartScale {
  x: (index: number) => number;
  y: (value: number) => number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
}

/**
 * The scale for one chart.
 *
 * THE Y-AXIS ALWAYS STARTS AT ZERO. A min-based scale is the classic chart
 * lie: 2,400 and 2,450 kcal become a dramatic climb because the axis starts
 * at 2,395. Anchored at zero, the height of a point is proportional to what
 * was actually eaten, and a 2% difference looks like 2%.
 *
 * Each nutrient still gets its own MAX, which is the small-multiples
 * decision -- protein is read against protein, not against calories.
 */
export function buildChartScale({
  width,
  height,
  pointCount,
  max,
}: ChartScaleInput): ChartScale {
  const plotLeft = Y_LABEL_WIDTH + POINT_EXTENT;
  const plotRight = Math.max(width - POINT_EXTENT, plotLeft + 1);
  const plotTop = POINT_EXTENT;
  const plotBottom = Math.max(
    height - X_LABEL_HEIGHT - POINT_EXTENT,
    plotTop + 1,
  );

  const span = plotRight - plotLeft;
  const rise = plotBottom - plotTop;
  // An all-zero series has max 0; dividing by it would put every point at
  // NaN and draw nothing at all, with no clue as to why.
  const top = max > 0 ? max : 1;

  return {
    x: (index) =>
      pointCount <= 1
        ? plotLeft + span / 2
        : plotLeft + (index / (pointCount - 1)) * span,
    y: (value) => plotBottom - (value / top) * rise,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
  };
}

// ── x-axis labels ──────────────────────────────────────────────────────────

/** A fixed table rather than toLocaleDateString: the device's locale must
 *  not decide what a chart axis says, or whether a test passes. */
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface AxisLabel {
  /** Index into the series' points, so the caller can reuse the x scale. */
  index: number;
  label: string;
}

/**
 * Which days to label, and how.
 *
 * Over 7 days every day is labelled with a short weekday, which is how
 * people actually think about a week. Over 14 a weekday would appear twice
 * and mean two different days, so it switches to d/M and thins out: the
 * first, the last, and roughly every third in between, never two adjacent.
 * At 360dp with the largest system font a d/M label is about a fifth of the
 * chart width, so neighbouring labels would collide.
 */
export function xAxisLabels(dates: string[], range: TrendRange): AxisLabel[] {
  const format = (key: string) => {
    const d = parseDateKey(key); // never new Date("2026-09-20") -- that is UTC
    return range === 7
      ? WEEKDAY[d.getDay()]
      : `${d.getDate()}/${d.getMonth() + 1}`;
  };

  if (range === 7) {
    return dates.map((key, index) => ({ index, label: format(key) }));
  }

  const last = dates.length - 1;
  const indices: number[] = [];
  // Stop two short of the end so the final label never lands next to the
  // one before it -- the gap that would actually overlap.
  for (let i = 0; i <= last - 2; i += 3) indices.push(i);
  if (indices[indices.length - 1] !== last) indices.push(last);

  return indices.map((index) => ({ index, label: format(dates[index]) }));
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
 * THE LEG INTO TODAY IS DASHED and returned as its own segment. Today is a
 * partial day, and a solid line dropping into a low point reads as a
 * collapse rather than as a day that is only half over -- device pass
 * feedback, 2026-09-20.
 *
 * A run of one point produces no segment: a path needs two points. The dot
 * is still drawn by the caller, so an isolated day is visible as a point
 * with no line, which is the truth about it.
 */
export interface PathSegment {
  d: string;
  /** Rendered dashed: this leg arrives at a day that has not finished. */
  dashed: boolean;
}

export function buildPathSegments(
  points: TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): PathSegment[] {
  const segments: PathSegment[] = [];
  let current: string[] = [];
  let previous: { i: number; value: number } | null = null;

  const flush = () => {
    if (current.length > 1) segments.push({ d: current.join(" "), dashed: false });
    current = [];
  };

  points.forEach((p, i) => {
    if (p.value == null) {
      flush();
      previous = null;
      return;
    }

    if (p.soFar && previous) {
      // Close the solid run at the previous day, then join to today with a
      // segment of its own so it can be dashed. The two share a coordinate,
      // so the line still reads as continuous.
      flush();
      segments.push({
        d: `M${x(previous.i)} ${y(previous.value)} L${x(i)} ${y(p.value)}`,
        dashed: true,
      });
      previous = { i, value: p.value };
      return;
    }

    current.push(`${current.length === 0 ? "M" : "L"}${x(i)} ${y(p.value)}`);
    previous = { i, value: p.value };
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
