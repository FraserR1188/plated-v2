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

/** Strip under the plot for the x-axis date labels. */
export const X_LABEL_HEIGHT = 14;

// ── The axis font, MEASURED ────────────────────────────────────────────────
//
// Read out of the bundled file itself with fontTools --
// node_modules/@expo-google-fonts/jetbrains-mono/400Regular/
// JetBrainsMono_400Regular.ttf -- rather than assumed:
//
//   unitsPerEm       1000
//   advance width     600 for every glyph the labels use (digits, comma,
//                     full stop, space, and the letters in the weekday and
//                     month names). JetBrains Mono is monospaced by design,
//                     which is the whole reason a label's width can be
//                     COMPUTED from its length instead of measured.
//   OS/2 sCapHeight   730, cross-checked against the 'H' glyph bbox: 730
//   hhea descent     -300, which is what "Sep" hangs below the baseline
//
// Digits actually reach 740 -- round shapes overshoot the cap line -- which
// is 0.09px at 9px and not worth modelling.
//
// This matters twice over. The y labels are svg <Text> now, and svg text
// does NOT follow the system font scale, so these numbers stay true at the
// largest Dynamic Type setting. The RN <Text> they replaced DID scale,
// which is the second reason the old column could not hold its own width:
// its contents grew while the geometry positioning them did not.

export const AXIS_FONT_SIZE = 9;
export const MONO_ADVANCE_EM = 0.6;
export const MONO_CAP_HEIGHT_EM = 0.73;
export const MONO_DESCENDER_EM = 0.3;

/** One character of the axis font, in px. */
export const AXIS_CHAR_W = AXIS_FONT_SIZE * MONO_ADVANCE_EM;

/** Cap height of the axis font, in px: what a tick label is centred on. */
export const AXIS_CAP_HEIGHT = AXIS_FONT_SIZE * MONO_CAP_HEIGHT_EM;

/** Gap between the y labels and the plot they label. */
export const GUTTER_PAD = 4;

/** Gap between the x labels' baseline and the bottom of the canvas. */
export const X_LABEL_BASELINE_PAD = 3;

export interface ChartScaleInput {
  /**
   * The MEASURED width of the plot area -- the inside of the card, after
   * its padding and border, via onLayout. Never the window width minus an
   * assumed padding: that assumption is what put today's point outside the
   * card on the second device pass.
   */
  width: number;
  height: number;
  pointCount: number;
  /** The top of the scale. The bottom is ALWAYS zero -- see below. */
  max: number;
  /** The y-axis labels' column, at the left, inside the svg. */
  leftGutter?: number;
  /**
   * Room at BOTH ends for whatever is drawn at the first and last points.
   * Defaults to a point's own extent; the caller raises it to half an x
   * label's width when the labels are centred on their points, which is
   * what lets the end labels sit ON their points instead of beside them.
   */
  inset?: number;
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
  leftGutter = 0,
  inset = POINT_EXTENT,
}: ChartScaleInput): ChartScale {
  const plotLeft = leftGutter + inset;
  const plotRight = Math.max(width - inset, plotLeft + 1);
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

// ── Nice numbers ───────────────────────────────────────────────────────────
//
// The axis used to be labelled with the series' own maximum: Carbs read
// "339" at the top, Calories read "2,800" only because the goal happened to
// be higher than anything eaten. Two charts, two different KINDS of number
// in the same place, neither of them chosen by anyone.
//
// A round number means the same thing on every chart, and it is what makes
// gridlines worth drawing at all: a line at 300 lets you read a point off
// the chart, a line at 339 only tells you where the best day was.

const NICE_STEPS = [1, 2, 2.5, 5];

/** The most intervals a 150px-tall plot can carry and stay readable. */
const MAX_INTERVALS = 4;

export interface NiceTicks {
  /** 0, step, ... top. Rounded to the step's own precision. */
  ticks: number[];
  /** One label per tick, in the same order. */
  labels: string[];
  step: number;
  /** The last tick: strictly above the max, by less than one step. */
  top: number;
  /** Decimal places in the step, and so in every label. */
  decimals: number;
}

/** Round to a fixed number of decimals, so a tick is the number it prints
 *  as. See the float-noise note in niceTicks. */
function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/** The smallest {1, 2, 2.5, 5} x 10^k at or above `target`. */
function niceStep(target: number): { step: number; decimals: number } {
  const start = Math.floor(Math.log10(target)) - 1;
  for (let exp = start; exp <= start + 4; exp++) {
    for (const k of NICE_STEPS) {
      const candidate = k * Math.pow(10, exp);
      if (candidate >= target) {
        // 2.5 carries one decimal place of its own; every other nice number
        // is an integer, so the precision is the exponent's.
        return {
          step: candidate,
          decimals: Math.max(0, (k === 2.5 ? 1 : 0) - exp),
        };
      }
    }
  }
  // Unreachable for a finite positive target: the loop spans four decades
  // around it. Fail visibly rather than silently returning a zero step.
  return { step: target, decimals: 0 };
}

/**
 * The y-axis for one chart: round numbers from zero to just above the max.
 *
 * THE TOP IS STRICTLY ABOVE THE MAX. At-or-above would park the best day's
 * point exactly on the top gridline, where it reads as clipped rather than
 * as the highest value -- and on a goal-topped chart it would put the goal
 * line along the frame, where it stops looking like a line at all.
 *
 * TICK VALUES ARE ROUNDED TO THE STEP'S OWN PRECISION, which is not
 * cosmetic. 3 * 0.1 is 0.30000000000000004 in binary floating point. It
 * still FORMATS as "0.3", so nothing looks wrong, but it is no longer equal
 * to a goal of 0.3 -- and the gridline that should give way to the goal
 * line silently stops doing so. Rounding here makes the tick the number it
 * prints as.
 */
export function niceTicks(max: number): NiceTicks {
  // An empty window, or a day that genuinely totals zero. Matches what the
  // scale does with a max of 0, so the axis and the geometry agree.
  if (!(max > 0)) {
    return { ticks: [0, 1], labels: ["0", "1"], step: 1, top: 1, decimals: 0 };
  }

  const { step, decimals } = niceStep(max / MAX_INTERVALS);

  // How many whole steps fit under the max -- plus one, always, for the
  // headroom. The tolerance is for a max that IS a multiple of the step:
  // 0.3 / 0.1 is 2.9999999999999996, and Math.floor would hand back a top
  // of exactly 0.3, sitting the point on the frame.
  const quotient = max / step;
  const nearest = Math.round(quotient);
  const onATick =
    Math.abs(quotient - nearest) <= Math.max(1, Math.abs(quotient)) * 1e-9;
  const intervals = onATick ? nearest + 1 : Math.floor(quotient) + 1;

  const ticks: number[] = [];
  for (let i = 0; i <= intervals; i++) ticks.push(roundTo(i * step, decimals));

  return {
    ticks,
    // No unit: the unit is in the card header, once, beside the nutrient's
    // name. Repeating it down the axis is noise at 9px.
    labels: ticks.map((value) => withThousands(value.toFixed(decimals))),
    step,
    top: ticks[ticks.length - 1],
    decimals,
  };
}

// ── x-axis labels ──────────────────────────────────────────────────────────

/** Fixed tables rather than toLocaleDateString: the device's locale must
 *  not decide what a chart axis says, or whether a test passes. */
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "19 Sep" -- for the headline when the most recent value isn't today's. */
export function shortDay(key: string): string {
  const d = parseDateKey(key); // never new Date("2026-09-20") -- that is UTC
  return `${d.getDate()} ${MONTH[d.getMonth()]}`;
}

export interface AxisLabel {
  /** Index into the series' points, so the caller can reuse the x scale. */
  index: number;
  label: string;
}

/**
 * Which days to label, and how.
 *
 * A weekday on its own does not say WHICH Tuesday, and over 14 days it says
 * two different ones. So every label carries the day of the month:
 *
 *   7 days   every day, "Tue 15" -- the weekday is how people think about a
 *            week, the date is what pins it to one.
 *   14 days  every OTHER day, counting back from the last, so the odd day
 *            out falls at the old end where nothing depends on it. Just the
 *            date ("15"), because seven weekdays in a fortnight would
 *            repeat; the month appears on the first label and again
 *            wherever it changes, since "1" after "29" otherwise reads as a
 *            number going backwards.
 *
 * THE LAST LABEL IS ALWAYS "Today". It is the one day the reader can name
 * without counting, and the window always ends on it.
 */
export function xAxisLabels(dates: string[], range: TrendRange): AxisLabel[] {
  const last = dates.length - 1;
  if (last < 0) return [];

  const indices: number[] = [];
  if (range === 7) {
    for (let i = 0; i <= last; i++) indices.push(i);
  } else {
    for (let i = last; i >= 1; i -= 2) indices.unshift(i);
  }

  let previousMonth: number | null = null;

  return indices.map((index) => {
    const d = parseDateKey(dates[index]);
    const month = d.getMonth();
    const monthChanged = previousMonth === null || month !== previousMonth;
    previousMonth = month;

    if (index === last) return { index, label: "Today" };
    if (range === 7) {
      return { index, label: `${WEEKDAY[d.getDay()]} ${d.getDate()}` };
    }
    return {
      index,
      label: monthChanged
        ? `${d.getDate()} ${MONTH[month]}`
        : String(d.getDate()),
    };
  });
}

// ── The whole layout, in one place ─────────────────────────────────────────

export interface ChartLayoutInput {
  /** The MEASURED width of the card's inside, via onLayout. */
  width: number;
  height: number;
  /** One date key per point, oldest first. */
  dates: string[];
  range: TrendRange;
  /** One value per date, null for a gap. Same order as `dates`. */
  values: (number | null)[];
  /** Already gated on goalsState by buildTrendSeries -- see PL-026. */
  goal: number | null;
  /** Width of one character of the axis font, in px. */
  charW: number;
  /** Cap height of the axis font, in px. */
  capHeight: number;
}

export interface YTick {
  value: number;
  label: string;
  /** Where the line sits -- identical to scale.y(value), by construction. */
  y: number;
  /** Baseline for the label, so the text is centred on its own line. */
  baseline: number;
  /** False where the goal line already sits at exactly this value. */
  gridline: boolean;
}

export interface XLabel {
  index: number;
  text: string;
  /** Centre of the label: it is anchored "middle" on its own point. */
  x: number;
}

export interface ChartLayout {
  scale: ChartScale;
  yTicks: YTick[];
  xLabels: XLabel[];
  /** Width reserved at the left for the y labels, including their padding. */
  gutter: number;
  /** x for every y label, which is anchored "end" against it. */
  yLabelX: number;
  /** Baseline for every x label. */
  xLabelBaseline: number;
  /** Extent of the gridlines and the goal line. */
  gridLeft: number;
  gridRight: number;
  /** null when there is no goal to draw. */
  goalY: number | null;
  /** False when every point in the window is a gap. */
  hasData: boolean;
}

/**
 * Everything the chart needs to draw itself, computed once.
 *
 * The component maps these arrays to svg elements and does no arithmetic of
 * its own -- not because component code is untestable in principle, but
 * because this project has no React Native runtime under vitest, so the
 * only thing a test can do to TrendChart.tsx is read its source text. Four
 * separate times in this feature a source-text assertion has passed while
 * the thing it was written for was broken. Anything that can be got WRONG
 * rather than merely misspelled belongs here, where a test can run it.
 *
 * THE GUTTER IS THE REASON THIS FUNCTION EXISTS (PL-034). It was a fixed
 * 26px guess, which clipped "2,800" to ",800"; then an RN <Text> column
 * with no width, which measured ZERO because its labels were absolutely
 * positioned and so did not size their parent -- the same symptom, from the
 * opposite mistake. It is now the widest label's own width, in a font whose
 * advance is measured, plus a fixed gap: arithmetic, not a hope about Yoga.
 */
export function buildChartLayout({
  width,
  height,
  dates,
  range,
  values,
  goal,
  charW,
  capHeight,
}: ChartLayoutInput): ChartLayout {
  // A zero width reaches here on the frame before onLayout reports, and
  // through it into a division. The component doesn't draw then, but the
  // guard belongs with the geometry rather than at the call site.
  const canvas = Math.max(width, 1);

  const drawn = values.filter((v): v is number => v != null);
  const max = Math.max(...drawn, 0, ...(goal != null ? [goal] : []));
  const { ticks, labels, step, top } = niceTicks(max);

  const widestLabel = labels.reduce((w, l) => Math.max(w, l.length), 0);
  const gutter = widestLabel * charW + GUTTER_PAD;

  const axis = xAxisLabels(dates, range);
  const widestDate = axis.reduce((w, l) => Math.max(w, l.label.length), 0);
  // Half a label at each end, because every label is centred on its point.
  // The first and last points are always the ones at the edges.
  const inset = Math.max(POINT_EXTENT, (widestDate * charW) / 2);

  const scale = buildChartScale({
    width: canvas,
    height,
    pointCount: dates.length,
    // The TOP TICK, not the data max: the axis labels and the geometry must
    // be the same scale, or the top gridline sits below the top of the plot.
    max: top,
    leftGutter: gutter,
    inset,
  });

  const yTicks: YTick[] = ticks.map((value, i) => {
    const y = scale.y(value);
    return {
      value,
      label: labels[i],
      y,
      // Computed, not delegated to alignmentBaseline: that property is not
      // dependable across react-native-svg's two platform backends, and a
      // label half a line off its own gridline is worse than no label.
      baseline: y + capHeight / 2,
      // Two lines at the same y is just a thicker line, and the dashes stop
      // reading as dashes. The goal wins; the tick keeps its label.
      gridline: goal == null || Math.abs(goal - value) > step * 1e-6,
    };
  });

  return {
    scale,
    yTicks,
    xLabels: axis.map(({ index, label }) => ({
      index,
      text: label,
      x: scale.x(index),
    })),
    gutter,
    yLabelX: gutter - GUTTER_PAD,
    xLabelBaseline: height - X_LABEL_BASELINE_PAD,
    gridLeft: gutter,
    gridRight: canvas,
    goalY: goal != null ? scale.y(goal) : null,
    hasData: drawn.length > 0,
  };
}


// ── Number and goal formatting ─────────────────────────────────────────────
//
// Pure, and here rather than in the component, so the device's locale gets
// no vote. A chart that says 2,800 in one place and 2.800 in another is
// showing a different number, not a different style.

function withThousands(n: number | string): string {
  // Takes a string as well as a number so a tick label keeps the decimal
  // places its step calls for: String(0.30) is "0.3", but "0.30".
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Rounds for DISPLAY only. The stored value is never rounded -- rounding
 *  to display precision on a write was the defect in PL-028. */
export function formatNutrientValue(
  value: number,
  unit: "kcal" | "g",
): string {
  if (unit === "kcal") return withThousands(Math.round(value));
  return value >= 10 ? withThousands(Math.round(value)) : value.toFixed(1);
}

/**
 * The goal, as it reads in the card header: "goal 2,800", "goal 20 g".
 *
 * It moved out of the plot after the second device pass. Inside, it sat on
 * the dashed line -- and whenever the goal WAS the top of the scale, which
 * is common, the y-axis top label landed directly on top of it: "2,800"
 * over "goal 2,800". In the header it is read once, beside the nutrient it
 * belongs to, and the dashed line can stay unlabelled.
 *
 * Null for no goal, so the caller has nothing to render rather than an
 * empty string to hide. Zero means "no target set", never "a target of 0".
 */
export function goalCaption(
  goal: number | null,
  unit: "kcal" | "g",
): string | null {
  if (goal == null || goal <= 0) return null;
  const value = formatNutrientValue(goal, unit);
  return unit === "g" ? `goal ${value} g` : `goal ${value}`;
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
