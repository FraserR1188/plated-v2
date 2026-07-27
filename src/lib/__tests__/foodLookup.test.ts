import { describe, it, expect } from "vitest";
import { mealEntryToProduct } from "../foodLookup";
import { MealEntry } from "../../types";

function makeEntry(overrides: Partial<MealEntry> = {}): MealEntry {
  return {
    id: "e1",
    user_id: "u1",
    date: "2026-07-27",
    logged_at: "2026-07-27T12:00:00.000Z",
    name: "Porridge",
    calories: 437,
    protein: 12.5,
    carbs: 60,
    fat: 8,
    source: "search",
    barcode: null,
    off_id: null,
    serving_g: 250,
    meal_type: "breakfast",
    brand: null,
    salt: 1.25,
    fibre: 6,
    sugar: 4,
    sat_fat: 2,
    eaten_at: "2026-07-27T08:00:00.000Z",
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

describe("mealEntryToProduct", () => {
  it("returns null when serving_g is missing — there is no honest fallback", () => {
    expect(mealEntryToProduct(makeEntry({ serving_g: null }))).toBeNull();
  });

  it("returns null when serving_g is zero or negative", () => {
    expect(mealEntryToProduct(makeEntry({ serving_g: 0 }))).toBeNull();
    expect(mealEntryToProduct(makeEntry({ serving_g: -5 }))).toBeNull();
  });

  it("reconstructs per-100g values from the per-serving snapshot", () => {
    // 250g at 437 kcal → 174.8 kcal/100g, rounded to 175.
    const product = mealEntryToProduct(makeEntry())!;
    expect(product).not.toBeNull();
    expect(product.cal_per100).toBe(175);
    expect(product.protein_per100).toBe(5); // 12.5 / 250 * 100
    expect(product.carbs_per100).toBe(24); // 60 / 250 * 100
    expect(product.fat_per100).toBe(3.2); // 8 / 250 * 100
    expect(product.sat_fat_per100).toBe(0.8);
    expect(product.salt_per100).toBe(0.5); // toFixed(2)
    expect(product.fibre_per100).toBe(2.4);
    expect(product.sugar_per100).toBe(1.6);
  });

  it("treats NULL macros as zero for the per-100g reconstruction, not as missing", () => {
    const product = mealEntryToProduct(
      makeEntry({ salt: null, fibre: null, sugar: null, sat_fat: null }),
    )!;
    expect(product.salt_per100).toBe(0);
    expect(product.fibre_per100).toBe(0);
    expect(product.sugar_per100).toBe(0);
    expect(product.sat_fat_per100).toBe(0);
  });

  it("carries provenance and imagery through so ProductScreen's thumbnail survives an edit", () => {
    const product = mealEntryToProduct(
      makeEntry({
        barcode: "12345",
        off_id: "off-1",
        image_url: "https://example.com/a.jpg",
        image_path: "u1/food/front.jpg",
        custom_food_id: "cf-1",
        source: "custom",
      }),
    )!;
    expect(product.barcode).toBe("12345");
    expect(product.off_id).toBe("off-1");
    expect(product.image_url).toBe("https://example.com/a.jpg");
    expect(product.image_path).toBe("u1/food/front.jpg");
    expect(product.custom_food_id).toBe("cf-1");
    expect(product.source).toBe("custom");
  });

  it("maps every non-custom source to 'off'", () => {
    const product = mealEntryToProduct(makeEntry({ source: "barcode" }))!;
    expect(product.source).toBe("off");
  });
});
