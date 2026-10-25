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
  type NamedIngredient,
} from "../incompleteNutrients";
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

  it("is empty when no entry is flagged — a NULL row alone is PL-061, not this", () => {
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
