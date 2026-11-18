import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mealEntryToProduct,
  createCustomFood,
  customFoodToProduct,
} from "../foodLookup";
import { MealEntry, CustomFood } from "../../types";
import { isOpenFoodFactsSourced } from "../../content/attributions";
import { supabase } from "../supabase";
import { useStore } from "../../store/useStore";

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

function makeCustomFood(overrides: Partial<CustomFood> = {}): CustomFood {
  return {
    id: "cf1",
    user_id: "test-user-id",
    name: "Homemade granola",
    brand: null,
    barcode: null,
    cal_per100: 450,
    protein_per100: 10,
    carbs_per100: 60,
    fat_per100: 15,
    sat_fat_per100: null,
    salt_per100: null,
    fibre_per100: null,
    sugar_per100: null,
    serving_g: null,
    serving_label: null,
    created_at: "2026-08-14T00:00:00.000Z",
    image_url: null,
    label_image_url: null,
    ...overrides,
  };
}

/** Wire supabase.from("custom_foods").insert(row).select().single() to
 *  capture the row it was called with and hand back a canned RETURNING row.
 *  Mirrors useStore.test.ts's mockInsertSingle for meal_entries. */
function mockCustomFoodInsertSingle(returning: unknown) {
  const capture: { row?: unknown } = {};
  const single = vi.fn(async () => ({ data: returning, error: null }));
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn((row: unknown) => {
    capture.row = row;
    return { select };
  });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });
  return capture;
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

  it("preserves NULL small-macros as undefined, not zero, through the per-100g reconstruction", () => {
    const product = mealEntryToProduct(
      makeEntry({ salt: null, fibre: null, sugar: null, sat_fat: null }),
    )!;
    expect(product.salt_per100).toBeUndefined();
    expect(product.fibre_per100).toBeUndefined();
    expect(product.sugar_per100).toBeUndefined();
    expect(product.sat_fat_per100).toBeUndefined();
  });

  it("preserves a genuine typed 0 small-macro as 0, not undefined", () => {
    const product = mealEntryToProduct(
      makeEntry({ salt: 0, fibre: 0, sugar: 0, sat_fat: 0 }),
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

});

// ─── PL-060: the edit screen's source notice ───────────────────────────
//
// mealEntryToProduct mapped every non-custom source to "off", so editing a
// batch or AI-photo entry said "Source: Open Food Facts (ODbL)". The two
// mistakes are not equal: an OFF notice on non-OFF food is harmless, but
// losing it on OFF-derived food breaks ODbL §4.3 attribution. Hosted data
// (2026-11-18) has NULL off_id rows in every source group, up to this week,
// so off_id alone can't decide. The rule errs toward OFF:
//   custom, or any custom_food_id        → custom (no notice)
//   off_id set                           → OFF
//   ai_photo, batch                      → non-OFF (no notice)
//   anything else (search, barcode, bundle, copied, legacy) → OFF

describe("PL-060: which logged entries keep the Open Food Facts notice", () => {
  const notice = (over: Partial<MealEntry>) =>
    isOpenFoodFactsSourced(mealEntryToProduct(makeEntry(over))!.source);

  it("non-OFF entries show no notice: ai_photo, batch, custom, custom-linked", () => {
    expect(notice({ source: "ai_photo" })).toBe(false);
    expect(notice({ source: "batch" })).toBe(false);
    expect(notice({ source: "custom", custom_food_id: "cf-1" })).toBe(false);
    expect(notice({ source: "custom" })).toBe(false);
    // 45 hosted copied rows carry a custom_food_id: a copy of a custom food.
    expect(notice({ source: "copied", custom_food_id: "cf-1" })).toBe(false);
    expect(notice({ source: "bundle", custom_food_id: "cf-1", barcode: "5000000000001" })).toBe(false);
  });

  it("the non-OFF value is explicit — never undefined, which means OFF", () => {
    expect(mealEntryToProduct(makeEntry({ source: "ai_photo" }))!.source).toBe("other");
    expect(mealEntryToProduct(makeEntry({ source: "batch" }))!.source).toBe("other");
    expect(mealEntryToProduct(makeEntry({ source: "custom" }))!.source).toBe("custom");
  });

  it("OFF retention: every row that may carry OFF data keeps the notice", () => {
    // off_id set: OFF, whatever the source says.
    for (const source of ["barcode", "search", "bundle", "copied"]) {
      expect(notice({ source, off_id: "3017620422003" }), `${source} + off_id`).toBe(true);
    }
    // No off_id and no custom link: kept as OFF (79 barcode, 29 search,
    // 2 bundle, 65 copied hosted rows), because removing attribution from
    // OFF data is the mistake that matters.
    expect(notice({ source: "barcode", barcode: "5000000000001" })).toBe(true);
    expect(notice({ source: "search" })).toBe(true);
    expect(notice({ source: "bundle" })).toBe(true);
    expect(notice({ source: "copied" })).toBe(true);
    expect(notice({ source: "copied", barcode: "5000000000001" })).toBe(true);
    // A source this client never writes (legacy "manual", or anything older).
    expect(notice({ source: "manual" })).toBe(true);
    expect(notice({ source: "something-older" })).toBe(true);
  });
});

describe("createCustomFood (custom_foods NULL-not-zero — 20260814100000_custom_foods_null_not_zero.sql)", () => {
  beforeEach(() => {
    useStore.getState().setUserId("test-user-id");
  });

  const baseInput = {
    name: "Test food",
    brand: null,
    barcode: null,
    cal_per100: 100,
    protein_per100: 5,
    carbs_per100: 10,
    fat_per100: 2,
    serving_g: null,
    serving_label: null,
  };

  it("persists a blank small-macro field (null) as NULL through the insert row, not 0", async () => {
    const capture = mockCustomFoodInsertSingle(makeCustomFood());
    await createCustomFood({
      ...baseInput,
      sat_fat_per100: null,
      salt_per100: null,
      fibre_per100: null,
      sugar_per100: null,
    });

    const row = capture.row as Record<string, unknown>;
    expect(row.sat_fat_per100).toBeNull();
    expect(row.salt_per100).toBeNull();
    expect(row.fibre_per100).toBeNull();
    expect(row.sugar_per100).toBeNull();
  });

  it("persists a genuine typed 0 as 0, not NULL", async () => {
    const capture = mockCustomFoodInsertSingle(makeCustomFood());
    await createCustomFood({
      ...baseInput,
      sat_fat_per100: 0,
      salt_per100: 0,
      fibre_per100: 0,
      sugar_per100: 0,
    });

    const row = capture.row as Record<string, unknown>;
    expect(row.sat_fat_per100).toBe(0);
    expect(row.salt_per100).toBe(0);
    expect(row.fibre_per100).toBe(0);
    expect(row.sugar_per100).toBe(0);
  });
});

describe("customFoodToProduct", () => {
  it("maps a NULL small-macro to undefined on FoodProduct, not 0", () => {
    const cf = makeCustomFood({
      sat_fat_per100: null,
      salt_per100: null,
      fibre_per100: null,
      sugar_per100: null,
    });
    const product = customFoodToProduct(cf);

    expect(product.sat_fat_per100).toBeUndefined();
    expect(product.salt_per100).toBeUndefined();
    expect(product.fibre_per100).toBeUndefined();
    expect(product.sugar_per100).toBeUndefined();
  });

  it("maps a genuine 0 small-macro to 0, not undefined", () => {
    const cf = makeCustomFood({
      sat_fat_per100: 0,
      salt_per100: 0,
      fibre_per100: 0,
      sugar_per100: 0,
    });
    const product = customFoodToProduct(cf);

    expect(product.sat_fat_per100).toBe(0);
    expect(product.salt_per100).toBe(0);
    expect(product.fibre_per100).toBe(0);
    expect(product.sugar_per100).toBe(0);
  });
});
