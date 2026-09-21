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
  DEFAULT_NUTRIENTS,
  buildPathSegments,
  MAX_SELECTED,
  NULLABLE_NUTRIENTS,
  RANGE_DAYS,
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

  it("makes one segment from an unbroken run", () => {
    const segs = buildPathSegments(
      [pt("a", 10), pt("b", 20), pt("c", 30)],
      x,
      y,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]).toBe("M0 90 L10 80 L20 70");
  });

  // THE test. Two runs either side of a gap, and no ink between them.
  it("breaks into two segments across a gap and draws nothing over it", () => {
    const segs = buildPathSegments(
      [pt("a", 10), pt("b", 20), pt("gap", null), pt("d", 40), pt("e", 50)],
      x,
      y,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toBe("M0 90 L10 80");
    expect(segs[1]).toBe("M30 60 L40 50");

    // The gap sits at x=20. No segment may contain a coordinate there, and
    // no segment may span it: the first ends at 10, the second starts at 30.
    expect(segs.join(" ")).not.toContain("20 ");
  });

  it("breaks at several gaps", () => {
    const segs = buildPathSegments(
      [pt("a", 10), pt("g", null), pt("c", 30), pt("d", 40), pt("g2", null), pt("f", 60), pt("g3", 70)],
      x,
      y,
    );
    expect(segs).toHaveLength(2); // the lone first point makes no path
    expect(segs[0]).toBe("M20 70 L30 60");
    expect(segs[1]).toBe("M50 40 L60 30");
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
    expect(segs).toEqual(["M10 80 L20 70"]);
  });

  it("treats a real zero as a point, not a gap", () => {
    const segs = buildPathSegments([pt("a", 0), pt("b", 10)], x, y);
    expect(segs).toEqual(["M0 100 L10 90"]);
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
