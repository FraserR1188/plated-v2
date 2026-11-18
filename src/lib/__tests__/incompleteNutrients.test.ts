// ============================================================
// src/lib/__tests__/incompleteNutrients.test.ts — PL-059 display rules
//
// The UI's half of sum-the-known, flag-the-incomplete: "≥" on a lower bound,
// one muted line saying which nutrients, and — before a batch is saved —
// which ingredients are the reason. Plus the day-total flag (getDaySummary's
// lowerBound) and FoodProduct carrying the flag for the edit screen.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  atLeast,
  isLowerBound,
  lowerBoundNote,
  missingNutrientLines,
  trendHeadlineText,
  averageText,
  averageNote,
  smallFourTotal,
  smallFourTotalText,
  smallFourBar,
  type NamedIngredient,
} from "../incompleteNutrients";
import { roundSalt } from "../macros";
import { getDaySummary } from "../entries";
import { mealEntryToProduct } from "../foodLookup";
import type { FoodProduct, MealEntry } from "../../types";

function food(over: Partial<FoodProduct> = {}): FoodProduct {
  return {
    name: "Food",
    brand: "",
    cal_per100: 100,
    protein_per100: 1,
    carbs_per100: 1,
    fat_per100: 1,
    sat_fat_per100: 0.1,
    salt_per100: 0.1,
    fibre_per100: 1,
    sugar_per100: 1,
    ...over,
  };
}

function entry(over: Partial<MealEntry> = {}): MealEntry {
  return {
    id: "e1",
    user_id: "u1",
    date: "2026-10-25",
    logged_at: "2026-10-25T12:00:00.000Z",
    name: "Chilli",
    calories: 400,
    protein: 20,
    carbs: 40,
    fat: 10,
    source: "batch",
    barcode: null,
    off_id: null,
    serving_g: 350,
    meal_type: "dinner",
    brand: null,
    sat_fat: 3,
    salt: 1.2,
    fibre: 9,
    sugar: 6,
    incomplete_nutrients: null,
    eaten_at: "2026-10-25T08:00:00.000Z",
    planned: false,
    confirmed_at: null,
    skipped_at: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    eaten_at_estimated: false,
    ...over,
  };
}

describe("atLeast / isLowerBound", () => {
  it("prefixes ≥ only on a lower bound", () => {
    expect(atLeast("2.1", true)).toBe("≥ 2.1");
    expect(atLeast("2.1", false)).toBe("2.1");
  });

  it("reads null and undefined as complete", () => {
    expect(isLowerBound(null, "fibre")).toBe(false);
    expect(isLowerBound(undefined, "fibre")).toBe(false);
    expect(isLowerBound(["salt"], "fibre")).toBe(false);
    expect(isLowerBound(["salt", "fibre"], "fibre")).toBe(true);
  });
});

describe("trendHeadlineText — the Trends card's big latest-day number", () => {
  it("prefixes ≥ when the latest point is incomplete", () => {
    expect(trendHeadlineText("4.2", true)).toBe("≥ 4.2");
  });

  it("leaves a complete point's number plain", () => {
    expect(trendHeadlineText("1,850", false)).toBe("1,850");
  });
});

describe("History small-four average — averageText / averageNote", () => {
  const avg = (value: number | null, knownDays: number, loggedDays: number, lowerBoundDays: number) => ({
    value,
    knownDays,
    loggedDays,
    lowerBoundDays,
  });

  it("shows — for an unknown average, with no note", () => {
    expect(averageText(avg(null, 0, 7, 0))).toBe("—");
    expect(averageNote(avg(null, 0, 7, 0))).toBeNull();
  });

  it("a complete average is plain, with no note", () => {
    expect(averageText(avg(3.2, 7, 7, 0))).toBe("3.2g");
    expect(averageNote(avg(3.2, 7, 7, 0))).toBeNull();
  });

  it("days left out: plain value, the existing note unchanged", () => {
    expect(averageText(avg(3.2, 6, 7, 0))).toBe("3.2g");
    expect(averageNote(avg(3.2, 6, 7, 0))).toBe("6 of 7 days");
  });

  it("minimum days: ≥ on the value, and the note says so", () => {
    expect(averageText(avg(3.2, 7, 7, 2))).toBe("≥ 3.2g");
    expect(averageNote(avg(3.2, 7, 7, 2))).toBe("2 of 7 days are minimums");
    expect(averageNote(avg(3.2, 7, 7, 1))).toBe("1 of 7 days is a minimum");
  });

  it("both: ≥, and the note says both", () => {
    expect(averageText(avg(3.2, 6, 7, 2))).toBe("≥ 3.2g");
    expect(averageNote(avg(3.2, 6, 7, 2))).toBe("6 of 7 days · 2 are minimums");
    expect(averageNote(avg(3.2, 6, 7, 1))).toBe("6 of 7 days · 1 is a minimum");
  });
});

describe("lowerBoundNote", () => {
  it("is null when nothing is flagged", () => {
    expect(lowerBoundNote(null)).toBeNull();
    expect(lowerBoundNote(undefined)).toBeNull();
    expect(lowerBoundNote([])).toBeNull();
  });

  it("names one nutrient", () => {
    expect(lowerBoundNote(["fibre"])).toBe("Some ingredients have no fibre data");
  });

  it("joins two with 'or', three or more with commas then 'or', in column order", () => {
    expect(lowerBoundNote(["fibre", "salt"])).toBe("Some ingredients have no salt or fibre data");
    expect(lowerBoundNote(["sugar", "sat_fat", "fibre"])).toBe(
      "Some ingredients have no sat fat, fibre or sugar data",
    );
  });
});

describe("missingNutrientLines — what BatchEditor and RecipeConfirm show above Save", () => {
  const ings: NamedIngredient[] = [
    { name: "kidney beans", product: food() },
    { name: "ground cumin", product: food({ fibre_per100: undefined, salt_per100: undefined }) },
    { name: "lime juice", product: food({ fibre_per100: undefined }) },
    { name: "olive oil", product: food({ fibre_per100: 0 }) }, // a real 0 is a value
  ];

  it("one line per nutrient with a gap, column order, ingredient order", () => {
    expect(missingNutrientLines(ings)).toEqual([
      "Salt missing for: ground cumin",
      "Fibre missing for: ground cumin, lime juice",
    ]);
  });

  it("a real 0 is never listed as missing", () => {
    expect(missingNutrientLines([{ name: "olive oil", product: food({ fibre_per100: 0 }) }])).toEqual([]);
  });

  it("is empty when every ingredient knows all four", () => {
    expect(missingNutrientLines([{ name: "beans", product: food() }])).toEqual([]);
  });

  it("skips a recipe row with no product match yet, and names a repeated ingredient once", () => {
    expect(
      missingNutrientLines([
        { name: "mystery", product: null },
        { name: "cumin", product: food({ sugar_per100: undefined }) },
        { name: "cumin", product: food({ sugar_per100: undefined }) },
      ]),
    ).toEqual(["Sugar missing for: cumin"]);
  });
});

describe("getDaySummary lowerBound — the day total's ≥", () => {
  const NOW = new Date(2026, 9, 25, 20, 0);

  it("lists a nutrient when any contributing eaten entry has it as a lower bound", () => {
    const s = getDaySummary(
      [entry({ id: "a" }), entry({ id: "b", incomplete_nutrients: ["salt", "fibre"] })],
      "2026-10-25",
      NOW,
    );
    expect(s.eaten.lowerBound).toEqual(["salt", "fibre"]);
    expect(s.towardGoal.lowerBound).toEqual(["salt", "fibre"]);
  });

  it("is empty when no entry is flagged — a NULL row goes in hasNullRow instead (PL-061)", () => {
    const s = getDaySummary(
      [entry({ id: "a" }), entry({ id: "b", fibre: null })],
      "2026-10-25",
      NOW,
    );
    expect(s.towardGoal.lowerBound).toEqual([]);
  });

  it("unions eaten and pending in column order for an unsettled day", () => {
    const later = "2026-10-25T21:30:00.000Z";
    const s = getDaySummary(
      [
        entry({ id: "a", incomplete_nutrients: ["sugar"] }),
        entry({ id: "b", planned: true, eaten_at: later, incomplete_nutrients: ["fibre", "sugar"] }),
      ],
      "2026-10-25",
      NOW,
    );
    expect(s.eaten.lowerBound).toEqual(["sugar"]);
    expect(s.pending.lowerBound).toEqual(["fibre", "sugar"]);
    expect(s.towardGoal.lowerBound).toEqual(["fibre", "sugar"]);
  });

  it("ignores a skipped entry's flag", () => {
    const s = getDaySummary(
      [entry({ id: "a", skipped_at: "2026-10-25T09:00:00.000Z", incomplete_nutrients: ["fibre"] })],
      "2026-10-25",
      NOW,
    );
    expect(s.towardGoal.lowerBound).toEqual([]);
  });
});

describe("mealEntryToProduct carries the flag for the edit screen", () => {
  it("copies a lower-bound flag onto the FoodProduct", () => {
    const p = mealEntryToProduct(entry({ incomplete_nutrients: ["fibre"] }))!;
    expect(p.incomplete_nutrients).toEqual(["fibre"]);
  });

  it("leaves it undefined when the entry is complete (FoodProduct's 'absent' convention)", () => {
    expect(mealEntryToProduct(entry())!.incomplete_nutrients).toBeUndefined();
  });
});

// ─── PL-061: a contributing NULL row makes the day total a minimum ──────

describe("getDaySummary hasNullRow (PL-061)", () => {
  const NOW = new Date(2026, 9, 25, 20, 0);

  it("lists a nutrient when any contributing eaten entry is NULL for it", () => {
    const s = getDaySummary(
      [entry({ id: "a" }), entry({ id: "b", fibre: null, salt: null })],
      "2026-10-25",
      NOW,
    );
    expect(s.eaten.hasNullRow).toEqual(["salt", "fibre"]);
    expect(s.towardGoal.hasNullRow).toEqual(["salt", "fibre"]);
    // A real 0 is a value, not a gap.
    expect(
      getDaySummary([entry({ sugar: 0 })], "2026-10-25", NOW).towardGoal.hasNullRow,
    ).toEqual([]);
  });

  it("unions eaten and pending in column order, and the settled day keeps eaten only", () => {
    const later = "2026-10-25T21:30:00.000Z";
    const rows = [
      entry({ id: "a", sugar: null }),
      entry({ id: "b", planned: true, eaten_at: later, sat_fat: null, sugar: null }),
    ];
    const live = getDaySummary(rows, "2026-10-25", NOW);
    expect(live.eaten.hasNullRow).toEqual(["sugar"]);
    expect(live.pending.hasNullRow).toEqual(["sat_fat", "sugar"]);
    expect(live.towardGoal.hasNullRow).toEqual(["sat_fat", "sugar"]);
    const settled = getDaySummary(rows, "2026-10-25", new Date(2026, 9, 26, 9, 0));
    expect(settled.towardGoal.hasNullRow).toEqual(["sugar"]);
  });

  it("ignores a skipped entry's NULL", () => {
    const s = getDaySummary(
      [entry({ id: "a" }), entry({ id: "b", fibre: null, skipped_at: "2026-10-25T09:00:00.000Z" })],
      "2026-10-25",
      NOW,
    );
    expect(s.towardGoal.hasNullRow).toEqual([]);
  });
});

describe("smallFourTotal / smallFourTotalText — the one rule Today, Trends and History share", () => {
  const NOW = new Date(2026, 9, 25, 20, 0);
  const bucket = (rows: MealEntry[]) => getDaySummary(rows, "2026-10-25", NOW).towardGoal;

  it("unknown when every contributing row is NULL — rendered —", () => {
    const t = smallFourTotal(bucket([entry({ fibre: null }), entry({ id: "b", fibre: null })]), "fibre");
    expect(t).toEqual({ known: false });
    expect(smallFourTotalText(t, String)).toBe("—");
  });

  it("a known sum is a minimum when any contributing row is NULL", () => {
    const t = smallFourTotal(bucket([entry({ fibre: 6 }), entry({ id: "b", fibre: null })]), "fibre");
    expect(t).toEqual({ known: true, value: 6, atLeast: true });
    expect(smallFourTotalText(t, String)).toBe("≥ 6");
  });

  it("a known sum is a minimum when any contributing row is flagged", () => {
    const t = smallFourTotal(
      bucket([entry({ fibre: 6, incomplete_nutrients: ["fibre"] })]),
      "fibre",
    );
    expect(t).toEqual({ known: true, value: 6, atLeast: true });
  });

  it("plain when every row is known and unflagged, a real 0 included", () => {
    const t = smallFourTotal(bucket([entry({ sugar: 0 }), entry({ id: "b", sugar: 4 })]), "sugar");
    expect(t).toEqual({ known: true, value: 4, atLeast: false });
    expect(smallFourTotalText(t, String)).toBe("4");
    expect(smallFourTotal(bucket([entry({ sugar: 0 })]), "sugar")).toEqual({
      known: true,
      value: 0,
      atLeast: false,
    });
  });

  it("a flag on one nutrient or a NULL in one nutrient does not mark the others", () => {
    const b = bucket([entry({ fibre: null, incomplete_nutrients: ["salt"] })]);
    expect(smallFourTotal(b, "sugar")).toEqual({ known: true, value: 6, atLeast: false });
    expect(smallFourTotal(b, "salt")).toEqual({ known: true, value: 1.2, atLeast: true });
  });
});

describe("smallFourBar — Today's small-four bars and strip (PL-061)", () => {
  const NOW = new Date(2026, 9, 25, 20, 0);
  const today = (rows: MealEntry[]) => getDaySummary(rows, "2026-10-25", NOW).towardGoal;

  it("all-unknown: no number at all — consumed null, text —", () => {
    // The device bug: every fibre row NULL, the bar read "0 g".
    const bar = smallFourBar(
      today([entry({ fibre: null }), entry({ id: "b", fibre: null })]),
      "fibre",
      Math.round,
    );
    expect(bar).toEqual({ consumed: null, atLeast: false, text: "—" });
  });

  it("partly NULL: the known sum, as a minimum", () => {
    const bar = smallFourBar(
      today([entry({ fibre: 6.4 }), entry({ id: "b", fibre: null })]),
      "fibre",
      Math.round,
    );
    expect(bar).toEqual({ consumed: 6, atLeast: true, text: "≥ 6" });
  });

  it("a NULL planned meal makes today's total a minimum — plans count toward the goal", () => {
    const later = "2026-10-25T21:30:00.000Z";
    const bar = smallFourBar(
      today([entry({ salt: 1.2 }), entry({ id: "p", planned: true, eaten_at: later, salt: null })]),
      "salt",
      roundSalt,
    );
    expect(bar).toEqual({ consumed: 1.2, atLeast: true, text: "≥ 1.2" });
  });

  it("complete: plain, rounded by the caller's rule", () => {
    const bar = smallFourBar(
      today([entry({ salt: 0.235 }), entry({ id: "b", salt: 0.235 })]),
      "salt",
      roundSalt,
    );
    expect(bar).toEqual({ consumed: 0.47, atLeast: false, text: "0.47" });
  });

  it("a flagged batch is still a minimum, as PL-059 had it", () => {
    const bar = smallFourBar(
      today([entry({ sugar: 6, incomplete_nutrients: ["sugar"] })]),
      "sugar",
      Math.round,
    );
    expect(bar).toEqual({ consumed: 6, atLeast: true, text: "≥ 6" });
  });
});

// ─── PL-061 device fix: a day with NO contributing entries is a known 0 ──
//
// Device pass: an empty day showed "—" for sat fat, fibre, sugar and salt
// while protein, carbs and fat showed 0. sumBucket leaves the small four
// null when nothing contributed, and the shared rule read that null as
// "unknown". No entries is a known zero intake. "—" needs at least one
// contributing entry, every one of them NULL for that nutrient.

describe("PL-061: zero contributing entries → 0, plain, never —", () => {
  const NOW = new Date(2026, 9, 25, 20, 0);
  const KEYS = ["sat_fat", "salt", "fibre", "sugar"] as const;

  it("an empty day: every small-four bar reads 0, like the big four", () => {
    const empty = getDaySummary([], "2026-10-25", NOW).towardGoal;
    for (const k of KEYS) {
      expect(smallFourTotal(empty, k), k).toEqual({ known: true, value: 0, atLeast: false });
      expect(smallFourBar(empty, k, k === "salt" ? roundSalt : Math.round), k).toEqual({
        consumed: 0,
        atLeast: false,
        text: "0",
      });
    }
  });

  it("entries that don't contribute (skipped, another day) leave the day at 0", () => {
    const rows = [
      entry({ id: "s", fibre: null, skipped_at: "2026-10-25T09:00:00.000Z" }),
      entry({ id: "y", date: "2026-10-24", fibre: null }),
    ];
    const b = getDaySummary(rows, "2026-10-25", NOW).towardGoal;
    expect(smallFourBar(b, "fibre", Math.round)).toEqual({ consumed: 0, atLeast: false, text: "0" });
  });

  it("a settled day whose only row is an unconfirmed NULL plan reads 0: the plan never happened", () => {
    const plan = entry({ id: "p", planned: true, eaten_at: "2026-10-25T21:30:00.000Z", fibre: null });
    const settled = getDaySummary([plan], "2026-10-25", new Date(2026, 9, 26, 9, 0)).towardGoal;
    expect(smallFourBar(settled, "fibre", Math.round)).toEqual({ consumed: 0, atLeast: false, text: "0" });
    // While the day is live the plan counts toward the goal, and its NULL is unknown.
    const live = getDaySummary([plan], "2026-10-25", NOW).towardGoal;
    expect(smallFourBar(live, "fibre", Math.round)).toEqual({ consumed: null, atLeast: false, text: "—" });
  });

  it("one contributing entry, NULL for the nutrient, is still —", () => {
    const b = getDaySummary([entry({ fibre: null })], "2026-10-25", NOW).towardGoal;
    expect(smallFourBar(b, "fibre", Math.round).text).toBe("—");
  });
});
