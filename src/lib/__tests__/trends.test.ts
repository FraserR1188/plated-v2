// ============================================================
// Part 4 — Trends: the pure aggregation behind the small-multiple charts.
//
// Everything here is about NOT LYING with a chart. A line chart is a very
// confident-looking thing: a point at y=0 says "you ate nothing", a point
// at y=1800 says "you ate 1800". Both are claims. The whole point of this
// module is that it only ever makes a claim it can support:
//
//   - a day with no entries is a GAP, never a zero
//   - a day whose nutrient is unknown on some rows is flagged INCOMPLETE
//   - today is flagged SO FAR, because the day hasn't finished
//   - a goal line appears only when the goals are actually loaded (PL-026)
//
// See src/lib/entries.ts's DayBucket comment for the null-vs-zero rule this
// inherits, and testing/2026-09-20-internal.md's PL-028 for what happens
// when a "we don't know" is quietly stored as a 0.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  AXIS_CAP_HEIGHT,
  AXIS_CHAR_W,
  AXIS_FONT_SIZE,
  DEFAULT_NUTRIENTS,
  MONO_DESCENDER_EM,
  POINT_EXTENT,
  X_LABEL_HEIGHT,
  buildChartLayout,
  buildChartScale,
  buildPathSegments,
  capMessageFor,
  formatNutrientValue,
  goalCaption,
  niceTicks,
  xAxisLabels,
  MAX_SELECTED,
  NULLABLE_NUTRIENTS,
  RANGE_DAYS,
  TREND_NUTRIENTS,
  buildTrendSeries,
  toggleNutrient,
  trendWindowDates,
} from "../trends";
import { getDaySummary } from "../entries";
import { MealEntry, Goals } from "../../types";

function makeEntry(overrides: Partial<MealEntry> = {}): MealEntry {
  return {
    id: "e1",
    user_id: "u1",
    date: "2026-09-20",
    logged_at: "2026-09-20T12:00:00.000Z",
    name: "Porridge",
    calories: 400,
    protein: 20,
    carbs: 40,
    fat: 10,
    source: "search",
    barcode: null,
    off_id: null,
    serving_g: 250,
    meal_type: "breakfast",
    brand: null,
    salt: 1,
    fibre: 5,
    sugar: 8,
    sat_fat: 3,
    eaten_at: "2026-09-20T08:00:00.000Z",
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

const GOALS: Goals = {
  calories: 2000,
  protein: 150,
  carbs: 200,
  fat: 70,
  satFat: 20,
  salt: 6,
  fibre: 30,
  sugar: 50,
};

/** Noon on the given local day — never an ISO string with a Z. dateKey()
 *  reads local Y/M/D, so a UTC instant can land on a different local day
 *  depending on the runner's timezone. vitest.setup.ts pins TZ to
 *  Europe/London, which is what makes the BST cases below mean anything. */
const noonLocal = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d, 12, 0, 0);

// ────────────────────────────────────────────────────────────
// The window
// ────────────────────────────────────────────────────────────

describe("trendWindowDates", () => {
  it("offers exactly the 7- and 14-day ranges", () => {
    expect([...RANGE_DAYS]).toEqual([7, 14]);
  });

  it("returns N local dates, oldest first, ending on today", () => {
    const dates = trendWindowDates(7, noonLocal(2026, 9, 20));
    expect(dates).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ]);
  });

  it("spans a month boundary without skipping or repeating a day", () => {
    const dates = trendWindowDates(14, noonLocal(2026, 10, 3));
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe("2026-09-20");
    expect(dates[13]).toBe("2026-10-03");
    expect(new Set(dates).size).toBe(14);
  });

  // ── The two DST fixtures, and why they are at these exact times ────────
  //
  // THE TIME OF DAY IS THE WHOLE TEST. A sabotage run that replaced
  // setDate() with `now.getTime() - back * 86_400_000` passed a midday
  // fixture cleanly: an hour of drift cannot move noon onto another
  // calendar date, so the broken implementation and the correct one agree
  // all the way across the transition. The same mistake was made, and
  // caught the same way, in csv.test.ts's DST fixtures earlier in this
  // session — see testing/2026-09-20-internal.md.
  //
  // These two anchors were found by running both implementations over every
  // hour around both UK transitions and keeping the ones that disagree.
  // Both are within 30 minutes of local midnight, which is the only place
  // a one-hour shift can change the date.

  // BST→GMT: the local day is 25 hours long, so a fixed-millisecond step
  // lands on the 25th TWICE and loses the oldest day off the far end.
  it("crosses BST→GMT (2026-10-25) with no duplicated day", () => {
    const dates = trendWindowDates(7, new Date(2026, 9, 25, 23, 30, 0));
    expect(dates).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25", // clocks went back at 02:00 this morning
    ]);
    expect(new Set(dates).size).toBe(7);
  });

  // GMT→BST: the local day is 23 hours long, so a fixed-millisecond step
  // SKIPS the 29th entirely and reaches an extra day further back. A missing
  // day is the worse failure of the two: Trends renders it as a gap, which
  // is the chart's notation for "you logged nothing that day".
  it("crosses GMT→BST (2026-03-29) without skipping the transition day", () => {
    const dates = trendWindowDates(7, new Date(2026, 2, 30, 0, 30, 0));
    expect(dates).toEqual([
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29", // clocks went forward at 01:00
      "2026-03-30",
    ]);
    expect(dates).toContain("2026-03-29");
    expect(new Set(dates).size).toBe(7);
  });

  it("crosses a transition correctly at 14 days too", () => {
    const dates = trendWindowDates(14, new Date(2026, 9, 25, 23, 30, 0));
    expect(dates).toHaveLength(14);
    expect(new Set(dates).size).toBe(14);
    expect(dates[0]).toBe("2026-10-12");
    expect(dates[13]).toBe("2026-10-25");
  });

  it("is stable regardless of the time of day it is called at", () => {
    const early = trendWindowDates(14, new Date(2026, 8, 20, 0, 1, 0));
    const late = trendWindowDates(14, new Date(2026, 8, 20, 23, 59, 0));
    expect(early).toEqual(late);
  });
});

// ────────────────────────────────────────────────────────────
// Gaps, never zeros
// ────────────────────────────────────────────────────────────

describe("a day with nothing logged is a gap, not a zero", () => {
  const NOW = noonLocal(2026, 9, 20);

  it("gives an unlogged day a null value and marks it unlogged", () => {
    const entries = [makeEntry({ date: "2026-09-18", calories: 500 })];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["calories"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });

    const byDate = Object.fromEntries(series.points.map((p) => [p.date, p]));
    expect(byDate["2026-09-18"].value).toBe(500);
    expect(byDate["2026-09-18"].unlogged).toBe(false);

    // Every other day in the window has no entries at all.
    expect(byDate["2026-09-17"].value).toBeNull();
    expect(byDate["2026-09-17"].unlogged).toBe(true);
  });

  it("never emits 0 for a day that simply has no rows", () => {
    const [series] = buildTrendSeries({
      entries: [],
      nutrients: ["calories"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    expect(series.points).toHaveLength(7);
    expect(series.points.every((p) => p.value === null)).toBe(true);
    expect(series.points.some((p) => p.value === 0)).toBe(false);
  });

  it("DOES emit 0 for a day that was logged and genuinely totals zero", () => {
    // A real zero is a measurement. Black coffee has 0 g of fat, and the
    // chart must say so rather than pretending the day wasn't logged.
    const entries = [
      makeEntry({ date: "2026-09-20", name: "Black coffee", fat: 0, calories: 2 }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["fat"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const today = series.points.find((p) => p.date === "2026-09-20")!;
    expect(today.value).toBe(0);
    expect(today.unlogged).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// Incomplete
// ────────────────────────────────────────────────────────────

describe("incomplete days", () => {
  const NOW = noonLocal(2026, 9, 20);

  it("flags a day where one eaten row has no value for that nutrient", () => {
    const entries = [
      makeEntry({ id: "a", date: "2026-09-19", salt: 1.5 }),
      makeEntry({ id: "b", date: "2026-09-19", salt: null }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["salt"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const day = series.points.find((p) => p.date === "2026-09-19")!;
    expect(day.value).toBe(1.5);
    expect(day.incomplete).toBe(true);
    expect(day.unlogged).toBe(false);
  });

  it("does not flag a day where every eaten row has a value", () => {
    const entries = [
      makeEntry({ id: "a", date: "2026-09-19", salt: 1.5 }),
      makeEntry({ id: "b", date: "2026-09-19", salt: 0.5 }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["salt"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const day = series.points.find((p) => p.date === "2026-09-19")!;
    expect(day.value).toBe(2);
    expect(day.incomplete).toBe(false);
  });

  it("treats a day where the nutrient is unknown on EVERY row as a gap, still flagged incomplete", () => {
    // This is the post-PL-028 chia case: the day was logged, but nothing in
    // it knows its salt. "You ate 0 g of salt" would be a fabrication; so
    // would drawing a point. It is a gap that knows why it is a gap.
    const entries = [
      makeEntry({ id: "a", date: "2026-09-19", salt: null }),
      makeEntry({ id: "b", date: "2026-09-19", salt: null }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["salt"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const day = series.points.find((p) => p.date === "2026-09-19")!;
    expect(day.value).toBeNull();
    expect(day.incomplete).toBe(true);
    expect(day.unlogged).toBe(false); // the day WAS logged
  });

  it("can never flag calories, protein, carbs or fat as incomplete", () => {
    // Those four are NOT NULL on meal_entries (see
    // 20260818140000_meal_entries_null_not_zero.sql, which deliberately left
    // them alone), so there is no such thing as a partially-known big-four
    // day. Only the small four can be incomplete.
    expect(NULLABLE_NUTRIENTS).toEqual(["satFat", "salt", "fibre", "sugar"]);
    expect(NULLABLE_NUTRIENTS).not.toContain("calories");

    const entries = [makeEntry({ date: "2026-09-19" })];
    const series = buildTrendSeries({
      entries,
      nutrients: ["calories", "protein", "carbs", "fat"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    expect(
      series.every((s) => s.points.every((p) => p.incomplete === false)),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Today is "so far"
// ────────────────────────────────────────────────────────────

describe("today", () => {
  it("marks today as soFar and no other day", () => {
    const NOW = noonLocal(2026, 9, 20);
    const entries = [
      makeEntry({ date: "2026-09-19" }),
      makeEntry({ id: "t", date: "2026-09-20" }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["calories"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const soFar = series.points.filter((p) => p.soFar).map((p) => p.date);
    expect(soFar).toEqual(["2026-09-20"]);
  });

  it("marks today soFar even when nothing has been logged yet", () => {
    const NOW = noonLocal(2026, 9, 20);
    const [series] = buildTrendSeries({
      entries: [],
      nutrients: ["calories"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const today = series.points.find((p) => p.date === "2026-09-20")!;
    expect(today.soFar).toBe(true);
    expect(today.value).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// eaten, NOT towardGoal
// ────────────────────────────────────────────────────────────

describe("Trends plots the eaten bucket, never towardGoal", () => {
  const NOW = noonLocal(2026, 9, 20);

  it("a pending planned meal today does not raise today's point", () => {
    // towardGoal folds unconfirmed plans into an unsettled day (CLAUDE.md:
    // "Plans count toward daily goals"). A trend line is a record of what
    // happened, so an intention must not move it. If this ever plots
    // towardGoal, today's point jumps the moment a plan is added and drops
    // again at midnight when the day settles -- a line that moves without
    // anyone eating anything.
    const eatenOnly = [makeEntry({ id: "real", date: "2026-09-20", calories: 400 })];
    const withPlan = [
      ...eatenOnly,
      makeEntry({
        id: "plan",
        date: "2026-09-20",
        planned: true,
        confirmed_at: null,
        skipped_at: null,
        calories: 900,
      }),
    ];

    const pointFor = (entries: MealEntry[]) =>
      buildTrendSeries({
        entries,
        nutrients: ["calories"],
        range: 7,
        now: NOW,
        goals: GOALS,
        goalsState: "loaded",
      })[0].points.find((p) => p.date === "2026-09-20")!;

    expect(pointFor(eatenOnly).value).toBe(400);
    expect(pointFor(withPlan).value).toBe(400);

    // And prove the fixture would actually have moved towardGoal, so this
    // test fails if the buckets are swapped rather than passing by accident.
    const summary = getDaySummary(withPlan, "2026-09-20", NOW);
    expect(summary.towardGoal.calories).toBe(1300);
    expect(summary.eaten.calories).toBe(400);
  });

  it("a confirmed plan DOES count, because it was eaten", () => {
    const entries = [
      makeEntry({
        id: "confirmed",
        date: "2026-09-20",
        planned: true,
        confirmed_at: "2026-09-20T09:00:00.000Z",
        calories: 350,
      }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["calories"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    expect(series.points.find((p) => p.date === "2026-09-20")!.value).toBe(350);
  });

  it("a skipped plan counts toward nothing and leaves the day unlogged", () => {
    const entries = [
      makeEntry({
        id: "skipped",
        date: "2026-09-19",
        planned: true,
        confirmed_at: null,
        skipped_at: "2026-09-19T20:00:00.000Z",
        calories: 700,
      }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["calories"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const day = series.points.find((p) => p.date === "2026-09-19")!;
    expect(day.value).toBeNull();
    expect(day.unlogged).toBe(true);
  });

  it("incomplete is computed on eaten too — a pending row's NULL does not flag the day", () => {
    const entries = [
      makeEntry({ id: "real", date: "2026-09-19", salt: 1.5 }),
      makeEntry({
        id: "plan",
        date: "2026-09-19",
        planned: true,
        confirmed_at: null,
        skipped_at: null,
        salt: null,
      }),
    ];
    const [series] = buildTrendSeries({
      entries,
      nutrients: ["salt"],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });
    const day = series.points.find((p) => p.date === "2026-09-19")!;
    expect(day.value).toBe(1.5);
    expect(day.incomplete).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// The aggregation agrees with Today
// ────────────────────────────────────────────────────────────

describe("the aggregation matches Today's totals", () => {
  it("every point equals getDaySummary(...).eaten for that nutrient", () => {
    // Trends must not grow its own answer to "what happened on this day" --
    // that divergence is exactly what getDaySummary was extracted to end
    // (see lib/entries.ts's D7 comment: History and Today's ring disagreed).
    const NOW = noonLocal(2026, 9, 20);
    const entries = [
      makeEntry({ id: "a", date: "2026-09-18", calories: 400, protein: 20, salt: 1 }),
      makeEntry({ id: "b", date: "2026-09-18", calories: 250, protein: 11, salt: null }),
      makeEntry({ id: "c", date: "2026-09-19", calories: 700, protein: 40, salt: 2.5 }),
      makeEntry({
        id: "d",
        date: "2026-09-19",
        planned: true,
        confirmed_at: null,
        calories: 999,
      }),
      makeEntry({ id: "e", date: "2026-09-20", calories: 120, protein: 3, salt: 0 }),
    ];

    const nutrients = ["calories", "protein", "salt"] as const;
    const series = buildTrendSeries({
      entries,
      nutrients: [...nutrients],
      range: 7,
      now: NOW,
      goals: GOALS,
      goalsState: "loaded",
    });

    for (const s of series) {
      for (const point of s.points) {
        const eaten = getDaySummary(entries, point.date, NOW).eaten;
        if (eaten.count === 0) {
          expect(point.value).toBeNull();
        } else {
          expect(point.value).toBe(eaten[s.nutrient]);
        }
      }
    }
  });
});

// ────────────────────────────────────────────────────────────
// The drawn line
// ────────────────────────────────────────────────────────────

describe("buildPathSegments", () => {
  // This lives in the pure layer BECAUSE a structural test could not tell
  // a broken line from an unbroken one. The sabotage that removed the break
  // kept every token trendsUi.test.ts was matching on, and passed, while
  // the chart drew straight across an unlogged day. See the note on
  // buildPathSegments itself.
  const x = (i: number) => i * 10;
  const y = (v: number) => 100 - v;

  const pt = (date: string, value: number | null) => ({
    date,
    value,
    unlogged: value == null,
    incomplete: false,
    soFar: false,
  });

  // The segment arriving at today is DASHED: today is a partial day, and a
  // solid line into a low point reads as a collapse rather than as a day
  // that is only half over. Device pass feedback, 2026-09-20.
  it("splits the leg into a so-far point into its own dashed segment", () => {
    const pts = [pt("a", 30), pt("b", 40), { ...pt("today", 12), soFar: true }];
    const segs = buildPathSegments(pts, x, y);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ d: "M0 70 L10 60", dashed: false });
    expect(segs[1]).toEqual({ d: "M10 60 L20 88", dashed: true });
  });

  it("does not dash anything when the last point is a finished day", () => {
    const segs = buildPathSegments([pt("a", 30), pt("b", 40)], x, y);
    expect(segs.every((s) => !s.dashed)).toBe(true);
  });

  it("emits no dashed leg when today is the only point after a gap", () => {
    // Nothing to join it to. The dot is still drawn; a dash from nowhere
    // would be a line to a day we have no value for.
    const segs = buildPathSegments(
      [pt("a", 30), pt("g", null), { ...pt("today", 12), soFar: true }],
      x,
      y,
    );
    expect(segs).toEqual([]);
  });

  it("makes one segment from an unbroken run", () => {
    const segs = buildPathSegments(
      [pt("a", 10), pt("b", 20), pt("c", 30)],
      x,
      y,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].d).toBe("M0 90 L10 80 L20 70");
  });

  // THE test. Two runs either side of a gap, and no ink between them.
  it("breaks into two segments across a gap and draws nothing over it", () => {
    const segs = buildPathSegments(
      [pt("a", 10), pt("b", 20), pt("gap", null), pt("d", 40), pt("e", 50)],
      x,
      y,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0].d).toBe("M0 90 L10 80");
    expect(segs[1].d).toBe("M30 60 L40 50");

    // The gap sits at x=20. No segment may contain a coordinate there, and
    // no segment may span it: the first ends at 10, the second starts at 30.
    expect(segs.map((s) => s.d).join(" ")).not.toContain("20 ");
  });

  it("breaks at several gaps", () => {
    const segs = buildPathSegments(
      [pt("a", 10), pt("g", null), pt("c", 30), pt("d", 40), pt("g2", null), pt("f", 60), pt("g3", 70)],
      x,
      y,
    );
    expect(segs).toHaveLength(2); // the lone first point makes no path
    expect(segs[0].d).toBe("M20 70 L30 60");
    expect(segs[1].d).toBe("M50 40 L60 30");
  });

  it("produces no segment for a single isolated point", () => {
    // A path needs two points. The dot is still drawn by the chart, so the
    // day shows as a point with no line — which is exactly what it is.
    expect(buildPathSegments([pt("a", 10)], x, y)).toEqual([]);
    expect(
      buildPathSegments([pt("g", null), pt("b", 20), pt("g2", null)], x, y),
    ).toEqual([]);
  });

  it("produces nothing at all when every day is a gap", () => {
    expect(
      buildPathSegments([pt("a", null), pt("b", null)], x, y),
    ).toEqual([]);
  });

  it("does not drop a run that ends at the last point", () => {
    // The flush after the loop. Without it the final run is silently lost.
    const segs = buildPathSegments(
      [pt("g", null), pt("b", 20), pt("c", 30)],
      x,
      y,
    );
    expect(segs).toEqual([{ d: "M10 80 L20 70", dashed: false }]);
  });

  it("treats a real zero as a point, not a gap", () => {
    const segs = buildPathSegments([pt("a", 0), pt("b", 10)], x, y);
    expect(segs).toEqual([{ d: "M0 100 L10 90", dashed: false }]);
  });
});

describe("capMessageFor", () => {
  // A tap that does nothing reads as a broken button rather than a rule.
  it("explains a refused fourth selection", () => {
    const msg = capMessageFor(["calories", "protein", "carbs"], "fibre");
    expect(msg).toContain("3 already");
  });

  it("explains a refused attempt to deselect the last one", () => {
    expect(capMessageFor(["calories"], "calories")).toBe("Keep at least one.");
  });

  it("says nothing when the toggle succeeds", () => {
    expect(capMessageFor(["calories"], "protein")).toBeNull();
    expect(capMessageFor(["calories", "protein"], "calories")).toBeNull();
  });

  // The correspondence, stated as a property over every combination: a
  // message exists EXACTLY when toggleNutrient refuses. This is what stops
  // the rule and the explanation of the rule drifting apart.
  it("produces a message precisely when toggleNutrient refuses", () => {
    const all = TREND_NUTRIENTS.map((n) => n.key);
    const selections: (typeof all)[] = [];
    for (const a of all) {
      selections.push([a]);
      for (const b of all) {
        if (b === a) continue;
        selections.push([a, b]);
        for (const c of all) {
          if (c === a || c === b) continue;
          selections.push([a, b, c]);
        }
      }
    }
    for (const selected of selections) {
      for (const nutrient of all) {
        const refused = toggleNutrient(selected, nutrient) === selected;
        const message = capMessageFor(selected, nutrient);
        expect(message == null).toBe(!refused);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────
// Geometry: nothing drawn may fall off the canvas
// ────────────────────────────────────────────────────────────

describe("buildChartScale", () => {
  // Device pass, 2026-09-20: today's hollow point sat on the right-hand
  // edge and was cut in half. The padding has to leave room for the POINT,
  // not just for the line -- a hollow dot is wider than its centre by the
  // radius plus half its stroke, and it is the LAST point in the window,
  // which is always the one at the edge.
  const WIDTH = 320;
  const HEIGHT = 96;

  it("keeps the first and last points fully inside the canvas", () => {
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 7, max: 2500 });
    expect(s.x(0) - POINT_EXTENT).toBeGreaterThanOrEqual(0);
    expect(s.x(6) + POINT_EXTENT).toBeLessThanOrEqual(WIDTH);
  });

  it("keeps a value at the very top of the scale fully inside the canvas", () => {
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 7, max: 2500 });
    expect(s.y(2500) - POINT_EXTENT).toBeGreaterThanOrEqual(0);
  });

  it("keeps a zero fully inside the canvas, above the axis labels", () => {
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 7, max: 2500 });
    expect(s.y(0) + POINT_EXTENT).toBeLessThanOrEqual(HEIGHT);
  });

  it("holds at 360dp with 14 points", () => {
    const s = buildChartScale({ width: 360 - 32, height: HEIGHT, pointCount: 14, max: 180 });
    expect(s.x(0) - POINT_EXTENT).toBeGreaterThanOrEqual(0);
    expect(s.x(13) + POINT_EXTENT).toBeLessThanOrEqual(360 - 32);
  });

  it("centres a lone point rather than pinning it to the left edge", () => {
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 1, max: 100 });
    expect(s.x(0)).toBeGreaterThan(WIDTH / 4);
    expect(s.x(0)).toBeLessThan((WIDTH * 3) / 4);
  });

  // ── The y-axis floor ──────────────────────────────────────────────────
  //
  // A min-based scale is the classic chart lie: 2,400 and 2,450 kcal become
  // a dramatic climb because the axis starts at 2,395. Every nutrient here
  // is read against zero, so the height of a point is proportional to what
  // was eaten.
  it("always puts zero at the bottom of the scale", () => {
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 7, max: 2500 });
    expect(s.y(0)).toBe(s.plotBottom);
  });

  it("does not zoom in on a narrow range", () => {
    // Two values 2% apart must render 2% apart, not fill the chart.
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 7, max: 2450 });
    const span = s.plotBottom - s.plotTop;
    const gap = s.y(2400) - s.y(2450);
    expect(gap / span).toBeLessThan(0.05);
  });

  it("survives an all-zero series without dividing by zero", () => {
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 7, max: 0 });
    expect(Number.isFinite(s.y(0))).toBe(true);
    expect(s.y(0)).toBe(s.plotBottom);
  });

  // The two insets. leftGutter is the y-axis labels' column, INSIDE the svg
  // now; inset is the room a centred x label needs at either end. They are
  // separate because only one of them applies to the right-hand edge.
  it("insets the plot past the y-axis gutter", () => {
    const s = buildChartScale({
      width: WIDTH, height: HEIGHT, pointCount: 7, max: 100, leftGutter: 30,
    });
    expect(s.plotLeft).toBeGreaterThanOrEqual(30);
  });

  it("defaults to no gutter and a point-sized inset at both ends", () => {
    const s = buildChartScale({ width: WIDTH, height: HEIGHT, pointCount: 7, max: 100 });
    expect(s.plotLeft).toBe(POINT_EXTENT);
    expect(s.plotRight).toBe(WIDTH - POINT_EXTENT);
  });

  it("takes an inset wide enough for a centred label at both ends", () => {
    const s = buildChartScale({
      width: WIDTH, height: HEIGHT, pointCount: 7, max: 100,
      leftGutter: 30, inset: 16.2,
    });
    expect(s.plotLeft).toBe(30 + 16.2);
    expect(s.plotRight).toBe(WIDTH - 16.2);
  });
});

// ────────────────────────────────────────────────────────────
// Nice numbers: an axis reads in round numbers, not in maxima
// ────────────────────────────────────────────────────────────
//
// The axis used to be labelled with the series' own maximum, so Carbs read
// "339" at the top and Calories read "2,800" only because the goal happened
// to be higher than anything eaten: a number nobody chose, at the top of
// every chart, meaning something different on each one.

describe("niceTicks", () => {
  it("puts 339 on a 0-400 axis, in hundreds", () => {
    expect(niceTicks(339).ticks).toEqual([0, 100, 200, 300, 400]);
  });

  it("puts 2,800 on a 0-3,000 axis, in thousands", () => {
    expect(niceTicks(2800).ticks).toEqual([0, 1000, 2000, 3000]);
  });

  it("leaves headroom above a max that lands on a tick", () => {
    // A step of 50 must not stop the axis at 150, below the data, nor sit
    // the highest point exactly on the frame.
    expect(niceTicks(160).ticks).toEqual([0, 50, 100, 150, 200]);
  });

  it("uses whole numbers for a small gram series", () => {
    expect(niceTicks(4.2).ticks).toEqual([0, 2, 4, 6]);
  });

  it("uses tenths for a very small series, with no float noise", () => {
    const { ticks, labels } = niceTicks(0.26);
    expect(ticks).toEqual([0, 0.1, 0.2, 0.3]);
    expect(labels).toEqual(["0.0", "0.1", "0.2", "0.3"]);
    // The whole point of the case: 3 * 0.1 is 0.30000000000000004 in binary
    // floating point. A tick that is off by 4e-17 still FORMATS as "0.3", so
    // nothing looks wrong, but it is no longer equal to a goal of 0.3 and
    // the gridline dedupe below silently stops matching.
    expect(ticks[3]).toBe(0.3);
  });

  it("gives an empty or all-zero series a 0-1 axis rather than dividing by zero", () => {
    expect(niceTicks(0).ticks).toEqual([0, 1]);
    expect(niceTicks(-5).ticks).toEqual([0, 1]);
  });

  it("labels to the step's own precision, and groups thousands", () => {
    expect(niceTicks(2800).labels).toEqual(["0", "1,000", "2,000", "3,000"]);
    expect(niceTicks(10).labels).toEqual(["0.0", "2.5", "5.0", "7.5", "10.0", "12.5"]);
    expect(niceTicks(339).labels).toEqual(["0", "100", "200", "300", "400"]);
  });

  it("carries no unit — the unit is in the card header", () => {
    for (const label of niceTicks(4.2).labels) {
      expect(label).not.toMatch(/[a-z]/i);
    }
  });
});

describe("niceTicks holds as a property, not only on the examples", () => {
  // Every nice number, the value just above it, and the awkward ones in
  // between. The values just above matter most: they are what a "top at or
  // above max" rule gets wrong, and they are a hundredth away from the
  // values that make that rule look right.
  const MAXIMA = [
    0.01, 0.099, 0.1, 0.26, 1, 1.0001, 2.4, 2.5, 4.2, 5, 5.0001, 9.99, 10,
    12.5, 25, 50, 99.99, 100, 100.01, 160, 200, 250, 339, 500, 1000, 1999,
    2500, 2800, 9999, 10000, 12345,
  ];
  const NICE = [1, 2, 2.5, 5];

  it.each(MAXIMA)("gives %p a readable axis", (max) => {
    const { ticks, labels, step, top } = niceTicks(max);

    expect(ticks[0]).toBe(0);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }

    // The step is one of {1, 2, 2.5, 5} times a power of ten.
    const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
    expect(NICE.some((n) => Math.abs(n - mantissa) < 1e-9)).toBe(true);

    // Headroom, and not too much of it: the top is STRICTLY above the max,
    // by less than one whole step.
    expect(top).toBe(ticks[ticks.length - 1]);
    expect(top).toBeGreaterThan(max);
    expect(top - step).toBeLessThanOrEqual(max);

    // Enough lines to read a level off, few enough to stay legible at 150px.
    const intervals = ticks.length - 1;
    expect(intervals).toBeGreaterThanOrEqual(3);
    expect(intervals).toBeLessThanOrEqual(5);

    expect(labels).toHaveLength(ticks.length);
  });
});

// ────────────────────────────────────────────────────────────
// buildChartLayout — the one place a chart's geometry is decided
// ────────────────────────────────────────────────────────────

const CHART_H = 150;
const WIDTHS = [270, 280, 296, 320, 328, 360, 412];

/** A 7- or 14-day window ending on Sunday 2026-09-20. */
const windowOf = (range: 7 | 14) => trendWindowDates(range, noonLocal(2026, 9, 20));

/** Calories-shaped values: thousands, one gap, whole numbers. */
const caloriesValues = (range: number): (number | null)[] =>
  Array.from({ length: range }, (_, i) =>
    i === 2 ? null : 1200 + ((i * 337) % 1650),
  );

/** Small-four-shaped values: single-digit grams, so the ticks are decimal. */
const saltValues = (range: number): (number | null)[] =>
  Array.from({ length: range }, (_, i) =>
    i === 3 ? null : 0.4 + ((i * 17) % 80) / 10,
  );

const layoutOf = (
  over: {
    width?: number;
    height?: number;
    range?: 7 | 14;
    values?: (number | null)[];
    goal?: number | null;
  } = {},
) => {
  const range = over.range ?? 7;
  return buildChartLayout({
    width: over.width ?? 320,
    height: over.height ?? CHART_H,
    dates: windowOf(range),
    range,
    values: over.values ?? caloriesValues(range),
    goal: over.goal === undefined ? 2800 : over.goal,
    charW: AXIS_CHAR_W,
    capHeight: AXIS_CAP_HEIGHT,
  });
};

describe("the axis and the geometry cannot disagree", () => {
  it("draws every tick's label exactly where the scale puts its value", () => {
    const L = layoutOf();
    expect(L.yTicks.length).toBeGreaterThan(1);
    for (const tick of L.yTicks) {
      expect(L.scale.y(tick.value)).toBe(tick.y);
    }
  });

  it("anchors zero at the bottom of the plot and the top tick at the top", () => {
    const L = layoutOf();
    expect(L.yTicks[0].value).toBe(0);
    expect(L.yTicks[0].y).toBe(L.scale.plotBottom);
    expect(L.yTicks[L.yTicks.length - 1].y).toBe(L.scale.plotTop);
  });

  it("scales to the TOP TICK, not to the data max", () => {
    // If the scale kept its own max, the top gridline would sit below the
    // top of the plot and the axis would be labelled for a chart that is
    // not the one drawn. 2,850 eaten against a 2,800 goal tops out at 3,000.
    const L = layoutOf({ values: [2850, 1200, 1400], goal: 2800 });
    expect(L.yTicks[L.yTicks.length - 1].value).toBe(3000);
    expect(L.scale.y(3000)).toBe(L.scale.plotTop);
    expect(L.scale.y(2850)).toBeGreaterThan(L.scale.plotTop);
  });

  it("includes the goal in the axis even when nothing eaten comes near it", () => {
    const L = layoutOf({ values: [100, 120, 90], goal: 2800 });
    expect(L.yTicks[L.yTicks.length - 1].value).toBeGreaterThanOrEqual(2800);
    expect(L.goalY).toBe(L.scale.y(2800));
  });

  it("reports an empty window rather than making the caller work it out", () => {
    expect(layoutOf({ values: [null, null, null], goal: null }).hasData).toBe(false);
    expect(layoutOf().hasData).toBe(true);
  });

  it("centres each tick label on its line, from the font's cap height", () => {
    // alignmentBaseline is not dependable across react-native-svg's two
    // platform backends, so the baseline is computed here instead.
    const L = layoutOf();
    for (const tick of L.yTicks) {
      expect(tick.baseline).toBeCloseTo(tick.y + AXIS_CAP_HEIGHT / 2, 10);
    }
  });
});

// ────────────────────────────────────────────────────────────
// PL-034: the y labels must stay inside their own gutter
// ────────────────────────────────────────────────────────────
//
// The defect: the labels were RN <Text> with position:"absolute" inside a
// column with no width. Absolutely positioned children do not size their
// parent, so the column measured ZERO wide and every label hung off its
// left edge — "2,800" rendered as ",800" with its left edge at -2dp, and
// three-character labels started outside the card's border.
//
// The gutter is now computed from the widest label and the plot starts
// after it, so the invariant is arithmetic rather than a layout hope.

describe("the y labels stay inside the gutter", () => {
  it.each(WIDTHS)("keeps every y label's ink inside [0, gutter] at %ipx", (width) => {
    for (const range of [7, 14] as const) {
      const L = layoutOf({ width, range, values: caloriesValues(range), goal: 2800 });

      // The case that clipped: five characters including a comma. The axis
      // now tops out at 3,000 rather than at the 2,800 goal, but it is the
      // same width of label that used to lose its first digit.
      expect(L.yTicks.some((t) => t.label === "3,000")).toBe(true);

      for (const tick of L.yTicks) {
        const inkLeft = L.yLabelX - tick.label.length * AXIS_CHAR_W;
        expect(inkLeft).toBeGreaterThanOrEqual(0);
        expect(L.yLabelX).toBeLessThanOrEqual(L.gutter);
      }

      // And nothing the plot draws may sit on top of them.
      expect(L.scale.plotLeft).toBeGreaterThanOrEqual(L.gutter);
    }
  });

  it("widens the gutter for a wider label rather than clipping it", () => {
    const narrow = layoutOf({ values: [4.2], goal: null });
    const wide = layoutOf({ values: [2850], goal: 2800 });
    expect(wide.gutter).toBeGreaterThan(narrow.gutter);
    for (const L of [narrow, wide]) {
      const widest = Math.max(...L.yTicks.map((t) => t.label.length));
      expect(L.gutter).toBeGreaterThanOrEqual(widest * AXIS_CHAR_W);
    }
  });
});

describe("gridlines and the goal line", () => {
  it("drops the gridline where the goal sits exactly on a tick, and keeps the label", () => {
    const L = layoutOf({ values: [160, 120, 140], goal: 150 });
    const at150 = L.yTicks.find((t) => t.value === 150);
    expect(at150).toBeDefined();
    expect(at150!.gridline).toBe(false);
    expect(at150!.label).toBe("150");
    expect(L.goalY).toBe(at150!.y);
    // Exactly one line is dropped; the rest of the axis is untouched.
    expect(L.yTicks.filter((t) => !t.gridline)).toHaveLength(1);
  });

  it("keeps every gridline when the goal falls between two ticks", () => {
    const L = layoutOf({ values: [339, 280, 300], goal: 325 });
    expect(L.yTicks.map((t) => t.value)).toEqual([0, 100, 200, 300, 400]);
    expect(L.yTicks.every((t) => t.gridline)).toBe(true);
  });

  it("keeps every gridline when there is no goal at all", () => {
    const L = layoutOf({ goal: null });
    expect(L.goalY).toBeNull();
    expect(L.yTicks.every((t) => t.gridline)).toBe(true);
  });

  it("matches a goal that is a tick even through float noise", () => {
    // 0.3 the goal against 3 * 0.1 the tick. They format identically; only
    // the rounding inside niceTicks makes them actually equal.
    const L = layoutOf({ values: [0.26, 0.2], goal: 0.3 });
    const at3 = L.yTicks.find((t) => t.label === "0.3");
    expect(at3).toBeDefined();
    expect(at3!.gridline).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// Nothing drawn may leave the canvas, at any width the phone gives us
// ────────────────────────────────────────────────────────────
//
// Second device pass, 2026-09-20: the svg was wider than its card because
// the width was assumed. It is measured now, and this is the invariant the
// measurement has to satisfy — points, y labels and x labels — at every
// width from a 320dp phone's card interior (270) upwards.

describe("everything drawn fits inside the measured plot", () => {
  const SERIES = [
    { name: "calories", values: caloriesValues, goal: 2800 as number | null },
    { name: "salt", values: saltValues, goal: 6 as number | null },
  ];

  it.each(WIDTHS)("keeps every point inside a %ipx plot", (width) => {
    for (const range of [7, 14] as const) {
      for (const s of SERIES) {
        const values = s.values(range);
        const L = layoutOf({ width, range, values, goal: s.goal });
        for (let i = 0; i < range; i++) {
          expect(L.scale.x(i) - POINT_EXTENT).toBeGreaterThanOrEqual(0);
          expect(L.scale.x(i) + POINT_EXTENT).toBeLessThanOrEqual(width);
        }
        for (const v of values) {
          if (v == null) continue;
          expect(L.scale.y(v) - POINT_EXTENT).toBeGreaterThanOrEqual(0);
          expect(L.scale.y(v) + POINT_EXTENT).toBeLessThanOrEqual(CHART_H);
        }
      }
    }
  });

  it.each(WIDTHS)("keeps every x label inside a %ipx plot, clear of the gutter", (width) => {
    for (const range of [7, 14] as const) {
      for (const s of SERIES) {
        const L = layoutOf({ width, range, values: s.values(range), goal: s.goal });
        for (const label of L.xLabels) {
          const half = (label.text.length * AXIS_CHAR_W) / 2;
          expect(label.x - half).toBeGreaterThanOrEqual(L.gutter);
          expect(label.x + half).toBeLessThanOrEqual(width);
        }
        // Vertically: cap height above the baseline, descender below it
        // ("Sep" has one), all inside the strip under the plot.
        expect(L.xLabelBaseline - AXIS_CAP_HEIGHT).toBeGreaterThanOrEqual(
          L.scale.plotBottom,
        );
        expect(
          L.xLabelBaseline + AXIS_FONT_SIZE * MONO_DESCENDER_EM,
        ).toBeLessThanOrEqual(CHART_H);
      }
    }
  });

  it.each(WIDTHS)("never overlaps two x labels at %ipx", (width) => {
    for (const range of [7, 14] as const) {
      for (const s of SERIES) {
        const L = layoutOf({ width, range, values: s.values(range), goal: s.goal });
        for (let i = 1; i < L.xLabels.length; i++) {
          const prev = L.xLabels[i - 1];
          const here = L.xLabels[i];
          const gap =
            here.x -
            (here.text.length * AXIS_CHAR_W) / 2 -
            (prev.x + (prev.text.length * AXIS_CHAR_W) / 2);
          expect(gap).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it.each(WIDTHS)("keeps every y label inside the canvas at %ipx", (width) => {
    for (const range of [7, 14] as const) {
      for (const s of SERIES) {
        const L = layoutOf({ width, range, values: s.values(range), goal: s.goal });
        for (const tick of L.yTicks) {
          expect(tick.baseline - AXIS_CAP_HEIGHT).toBeGreaterThanOrEqual(0);
          expect(tick.baseline).toBeLessThanOrEqual(CHART_H);
        }
      }
    }
  });

  it.each(WIDTHS)("keeps the y labels a label-height apart at %ipx", (width) => {
    for (const range of [7, 14] as const) {
      for (const s of SERIES) {
        const L = layoutOf({ width, range, values: s.values(range), goal: s.goal });
        for (let i = 1; i < L.yTicks.length; i++) {
          const gap = L.yTicks[i - 1].y - L.yTicks[i].y; // y grows downward
          expect(gap).toBeGreaterThanOrEqual(AXIS_FONT_SIZE);
        }
      }
    }
  });

  it("leaves the x-axis strip intact at the taller height", () => {
    // CHART_HEIGHT went 108 → 150; X_LABEL_HEIGHT stayed 14, so all 42px
    // went to the plot rather than to the label strip.
    const L = layoutOf();
    expect(X_LABEL_HEIGHT).toBe(14);
    expect(CHART_H - L.scale.plotBottom).toBeCloseTo(X_LABEL_HEIGHT + POINT_EXTENT, 10);
  });
});


// ────────────────────────────────────────────────────────────
// The goal, now in the card header
// ────────────────────────────────────────────────────────────

describe("goalCaption", () => {
  // Moved out of the plot entirely (Robbie, 2026-09-20). Inside, it
  // collided with the y-axis top label whenever the goal WAS the top of
  // the scale -- "2,800" directly over "goal 2,800". In the header it is
  // read once, next to the thing it is a goal for.
  it("reads 'goal 2,800' for calories, with a thousands separator", () => {
    expect(goalCaption(2800, "kcal")).toBe("goal 2,800");
  });

  it("carries the unit where it helps", () => {
    expect(goalCaption(20, "g")).toBe("goal 20 g");
  });

  it("keeps one decimal on a small gram target", () => {
    expect(goalCaption(2.5, "g")).toBe("goal 2.5 g");
  });

  it("is null when there is no goal, so the header shows nothing", () => {
    expect(goalCaption(null, "kcal")).toBeNull();
    expect(goalCaption(0, "kcal")).toBeNull();
  });
});

describe("formatNutrientValue", () => {
  // Pure and here rather than in the component so the locale cannot get a
  // vote. A chart that says 2,800 in one place and 2.800 in another is
  // showing a different number, not a different style.
  it("separates thousands without asking the device", () => {
    expect(formatNutrientValue(2800, "kcal")).toBe("2,800");
    expect(formatNutrientValue(1225, "kcal")).toBe("1,225");
  });

  it("rounds calories to whole numbers", () => {
    expect(formatNutrientValue(1224.6, "kcal")).toBe("1,225");
  });

  it("keeps one decimal under 10 g and rounds above it", () => {
    expect(formatNutrientValue(4.04, "g")).toBe("4.0");
    expect(formatNutrientValue(43.7, "g")).toBe("44");
  });

  it("renders a real zero as zero", () => {
    expect(formatNutrientValue(0, "g")).toBe("0.0");
    expect(formatNutrientValue(0, "kcal")).toBe("0");
  });
});

// ────────────────────────────────────────────────────────────
// x-axis labels
// ────────────────────────────────────────────────────────────
//
// A weekday alone ("Tue") does not say WHICH Tuesday, and over 14 days it
// says two different ones. Every label now carries the day of the month,
// the month appears where it changes, and the last point says "Today"
// because that is the one day the reader can name without counting.

describe("xAxisLabels", () => {
  const week = trendWindowDates(7, noonLocal(2026, 9, 20));
  const fortnight = trendWindowDates(14, noonLocal(2026, 9, 20));

  it("labels all seven days with weekday and date, and the last as Today", () => {
    // A fixed weekday table, not toLocaleDateString: the device's locale
    // must not decide what an axis says, nor whether a test passes.
    // 2026-09-20 is a Sunday, so the window opens on Monday the 14th.
    expect(xAxisLabels(week, 7).map((l) => l.label)).toEqual([
      "Mon 14",
      "Tue 15",
      "Wed 16",
      "Thu 17",
      "Fri 18",
      "Sat 19",
      "Today",
    ]);
  });

  it("labels every index over 7 days", () => {
    expect(xAxisLabels(week, 7).map((l) => l.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("labels every other day over 14, counting back from the last", () => {
    // Counting back, not forward: the anchor is today, so the gap that
    // absorbs the odd day out falls at the OLD end where nothing depends
    // on it, rather than leaving today unlabelled.
    expect(xAxisLabels(fortnight, 14).map((l) => l.index)).toEqual([
      1, 3, 5, 7, 9, 11, 13,
    ]);
  });

  it("uses the day of the month over 14 days, with Today at the end", () => {
    expect(xAxisLabels(fortnight, 14).map((l) => l.label)).toEqual([
      "8 Sep",
      "10",
      "12",
      "14",
      "16",
      "18",
      "Today",
    ]);
  });

  it("names the month again when it changes", () => {
    // 14 days ending Monday 2026-10-05: the labelled days step over the
    // month boundary between 29 Sep and 1 Oct. Without the month, "1"
    // after "29" reads as a number going backwards.
    const across = trendWindowDates(14, noonLocal(2026, 10, 5));
    expect(xAxisLabels(across, 14).map((l) => l.label)).toEqual([
      "23 Sep",
      "25",
      "27",
      "29",
      "1 Oct",
      "3",
      "Today",
    ]);
  });

  it("never emits a duplicate index", () => {
    for (const [dates, range] of [[week, 7], [fortnight, 14]] as const) {
      const idx = xAxisLabels(dates, range).map((l) => l.index);
      expect(new Set(idx).size).toBe(idx.length);
    }
  });

  it("reads the local calendar day, not a UTC one", () => {
    // parseDateKey, never new Date("2026-10-25") — a bare date string is
    // parsed as UTC midnight and lands on the previous day west of
    // Greenwich. 2026-10-25 is the BST→GMT Sunday, the 25-hour day.
    const labels = xAxisLabels(
      trendWindowDates(7, new Date(2026, 9, 25, 23, 30)),
      7,
    );
    expect(labels[0].label).toBe("Mon 19");
    expect(labels[5].label).toBe("Sat 24");
    expect(labels[6].label).toBe("Today");
  });

  it("centres every label on its own point", () => {
    for (const range of [7, 14] as const) {
      const L = layoutOf({ range, values: caloriesValues(range) });
      for (const label of L.xLabels) {
        expect(label.x).toBe(L.scale.x(label.index));
      }
    }
  });
});


// ────────────────────────────────────────────────────────────
// The goal line
// ────────────────────────────────────────────────────────────

describe("the goal line", () => {
  const NOW = noonLocal(2026, 9, 20);
  const base = {
    entries: [makeEntry({ date: "2026-09-20" })],
    nutrients: ["calories" as const],
    range: 7 as const,
    now: NOW,
  };

  it("is present only when goals are loaded", () => {
    const loaded = buildTrendSeries({ ...base, goals: GOALS, goalsState: "loaded" });
    expect(loaded[0].goal).toBe(2000);
  });

  // PL-026: a screen that computes against goals whatever their load state
  // presents the hard-coded defaults as the user's own targets. A goal line
  // is the most confident possible version of that mistake -- a line drawn
  // across the chart at a number the user never chose.
  it.each(["loading", "absent", "error"] as const)(
    "is null while goals are %s",
    (goalsState) => {
      const series = buildTrendSeries({ ...base, goals: GOALS, goalsState });
      expect(series[0].goal).toBeNull();
    },
  );

  it("is null for a nutrient with no goal set", () => {
    const series = buildTrendSeries({
      ...base,
      nutrients: ["fibre"],
      goals: { ...GOALS, fibre: 0 },
      goalsState: "loaded",
    });
    expect(series[0].goal).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// Selection
// ────────────────────────────────────────────────────────────

describe("nutrient selection", () => {
  it("defaults to calories, protein and carbs — fibre is not a default", () => {
    expect(DEFAULT_NUTRIENTS).toEqual(["calories", "protein", "carbs"]);
    expect(DEFAULT_NUTRIENTS).not.toContain("fibre");
    expect(DEFAULT_NUTRIENTS).toHaveLength(MAX_SELECTED);
  });

  it("caps the selection at three", () => {
    expect(MAX_SELECTED).toBe(3);
    const three = toggleNutrient(["calories", "protein", "carbs"], "fibre");
    expect(three).toEqual(["calories", "protein", "carbs"]);
  });

  it("adds a nutrient when there is room", () => {
    expect(toggleNutrient(["calories"], "salt")).toEqual(["calories", "salt"]);
  });

  it("removes a selected nutrient, and a 4th fits again afterwards", () => {
    const two = toggleNutrient(["calories", "protein", "carbs"], "protein");
    expect(two).toEqual(["calories", "carbs"]);
    expect(toggleNutrient(two, "fibre")).toEqual(["calories", "carbs", "fibre"]);
  });

  it("never empties the selection — the last nutrient cannot be removed", () => {
    // An empty Trends tab is a blank screen with no way to explain itself.
    expect(toggleNutrient(["calories"], "calories")).toEqual(["calories"]);
  });

  it("builds one series per selected nutrient, in the selected order", () => {
    const series = buildTrendSeries({
      entries: [],
      nutrients: ["carbs", "calories"],
      range: 7,
      now: noonLocal(2026, 9, 20),
      goals: GOALS,
      goalsState: "loaded",
    });
    expect(series.map((s) => s.nutrient)).toEqual(["carbs", "calories"]);
  });
});
