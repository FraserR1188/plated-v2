import { describe, it, expect } from "vitest";
import {
  roundSalt,
  computeServingTotals,
  hasUsableNutrition,
  needsManualEntry,
  canSubmitProduct,
  numOrNull,
  canSaveCustomFood,
  PerHundredGram,
} from "../macros";
import type { MacroKey } from "../labelExtraction";

function makeMacros(overrides: Partial<Record<MacroKey, string>> = {}): Record<MacroKey, string> {
  return {
    cal: "100",
    protein: "5",
    carbs: "10",
    fat: "2",
    satFat: "",
    salt: "",
    fibre: "",
    sugar: "",
    ...overrides,
  };
}

describe("roundSalt", () => {
  it("keeps small sub-gram values visible instead of collapsing them to 0", () => {
    // Math.round(0.04 * 100) / 100 would also survive, but Math.round(0.004)
    // would not — floor is the one that never rounds a real trace amount away.
    expect(roundSalt(0.04)).toBe(0.04);
  });

  it("trims floating-point noise from a summed total", () => {
    // 0.1 + 0.1 + 0.27 is 0.47000000000000003 in IEEE754 — without the
    // +1e-9 nudge, floor(46.99999999999999...) would wrongly floor to 0.46.
    const sum = 0.1 + 0.1 + 0.27;
    expect(roundSalt(sum)).toBe(0.47);
  });

  it("does not let the +1e-9 nudge round a genuine .xx6 value up a cent", () => {
    // 0.469 floored to 2dp is 0.46, not 0.47 — the nudge only exists to undo
    // FP noise, not to change which cent a real value floors to.
    expect(roundSalt(0.469)).toBe(0.46);
  });

  it("floors rather than rounds to nearest", () => {
    expect(roundSalt(0.478)).toBe(0.47);
  });

  it("handles zero", () => {
    expect(roundSalt(0)).toBe(0);
  });
});

describe("computeServingTotals", () => {
  const product = {
    cal_per100: 178,
    protein_per100: 8.2,
    carbs_per100: 21.3,
    fat_per100: 6.7,
    sat_fat_per100: 1.8,
    salt_per100: 0.6,
    fibre_per100: 1.4,
    sugar_per100: 3.1,
  };

  it("scales every macro to the given serving size", () => {
    const totals = computeServingTotals(product, 450);

    expect(totals.calories).toBe(Math.round(178 * 4.5));
    expect(totals.protein).toBe(+(8.2 * 4.5).toFixed(1));
    expect(totals.carbs).toBe(+(21.3 * 4.5).toFixed(1));
    expect(totals.fat).toBe(+(6.7 * 4.5).toFixed(1));
    expect(totals.satFat).toBe(+(1.8 * 4.5).toFixed(1));
    expect(totals.fibre).toBe(+(1.4 * 4.5).toFixed(1));
    expect(totals.sugar).toBe(+(3.1 * 4.5).toFixed(1));
  });

  it("treats missing optional per-100g fields (sat fat, salt, fibre, sugar) as zero", () => {
    const totals = computeServingTotals(
      { cal_per100: 100, protein_per100: 5, carbs_per100: 10, fat_per100: 2 },
      200,
    );

    expect(totals.satFat).toBe(0);
    expect(totals.salt).toBe(0);
    expect(totals.fibre).toBe(0);
    expect(totals.sugar).toBe(0);
  });

  // This is the actual bug fix: ProductScreen's serving preview used to
  // compute salt with `.toFixed(2)`, which rounds HALF UP — exactly the FP
  // noise problem roundSalt exists to avoid. A per-100g salt value summing
  // to a `...0000000000001` tail must floor, not round, through this path.
  it("rounds the scaled salt total through roundSalt, not toFixed", () => {
    const noisyProduct = { ...product, salt_per100: 0.1 + 0.1 + 0.27 }; // 0.47000000000000003
    const totals = computeServingTotals(noisyProduct, 100);

    expect(totals.salt).toBe(roundSalt(noisyProduct.salt_per100));
    expect(totals.salt).toBe(0.47);
  });

  it("floors a scaled salt value the way roundSalt does, where toFixed would round up", () => {
    // 0.469 * 100 (100g serving == identity scale) floors to 0.46 under
    // roundSalt; Number(0.469).toFixed(2) would give "0.47".
    const totals = computeServingTotals({ ...product, salt_per100: 0.469 }, 100);
    expect(totals.salt).toBe(0.46);
  });
});

describe("hasUsableNutrition (Phase 2 detector)", () => {
  it("flags a product as unusable when energy/protein/carbs/fat are all zero", () => {
    expect(
      hasUsableNutrition({
        cal_per100: 0,
        protein_per100: 0,
        carbs_per100: 0,
        fat_per100: 0,
      }),
    ).toBe(false);
  });

  it("is usable when only three of the big four are zero", () => {
    // A real product with a legitimate zero on ONE of the four (e.g. a
    // pure-fat oil with 0g protein/carbs) must not be flagged — only ALL
    // FOUR at once is the "no usable nutrition" signal.
    expect(
      hasUsableNutrition({
        cal_per100: 884,
        protein_per100: 0,
        carbs_per100: 0,
        fat_per100: 100,
      }),
    ).toBe(true);
  });

  it("is usable whenever any one of the big four is non-zero", () => {
    expect(
      hasUsableNutrition({
        cal_per100: 0,
        protein_per100: 0,
        carbs_per100: 0,
        fat_per100: 2,
      }),
    ).toBe(true);
  });

  it("does not look at sat-fat/salt/fibre/sugar at all", () => {
    // These can legitimately be 0 (or absent) on a perfectly usable product
    // and must never factor into this specific detector.
    const product: PerHundredGram = {
      cal_per100: 52,
      protein_per100: 0.3,
      carbs_per100: 14,
      fat_per100: 0.2,
      sat_fat_per100: 0,
      salt_per100: 0,
      fibre_per100: 0,
      sugar_per100: 0,
    };
    expect(
      hasUsableNutrition(product),
    ).toBe(true);
  });
});

describe("needsManualEntry (Phase 3: the source: 'custom' carve-out)", () => {
  const zeroDataProduct = {
    cal_per100: 0,
    protein_per100: 0,
    carbs_per100: 0,
    fat_per100: 0,
  };
  const realProduct = {
    cal_per100: 362,
    protein_per100: 23,
    carbs_per100: 35,
    fat_per100: 10,
  };

  it("matches hasUsableNutrition's negation when source is absent (OFF, unchanged from Phase 2)", () => {
    expect(needsManualEntry(zeroDataProduct)).toBe(true);
    expect(needsManualEntry(realProduct)).toBe(false);
  });

  it("still needs manual entry for an all-zero product explicitly sourced 'off'", () => {
    expect(needsManualEntry({ ...zeroDataProduct, source: "off" })).toBe(true);
  });

  it("does NOT need manual entry for an all-zero product sourced 'custom' — the water/black-coffee loop this exists to close", () => {
    // A custom_foods row can only exist if canSaveCustomFood already
    // required all four big-four fields to be present (CreateFoodScreen's
    // Save gate) — so a "custom" all-zero is a DELIBERATE, human-typed
    // zero, not an untrusted OFF one. Without this, returning from
    // CreateFoodScreen would trip the gate again and re-block Add.
    expect(needsManualEntry({ ...zeroDataProduct, source: "custom" })).toBe(false);
  });

  it("a real (non-zero) product never needs manual entry regardless of source", () => {
    expect(needsManualEntry({ ...realProduct, source: "custom" })).toBe(false);
    expect(needsManualEntry({ ...realProduct, source: "off" })).toBe(false);
  });
});

describe("canSubmitProduct (Phase 2 gate — the actual ProductScreen decision, not a component approximation of it)", () => {
  const zeroDataProduct = {
    cal_per100: 0,
    protein_per100: 0,
    carbs_per100: 0,
    fat_per100: 0,
  };
  const realProduct = {
    cal_per100: 362,
    protein_per100: 23,
    carbs_per100: 35,
    fat_per100: 10,
  };

  it("refuses a no-usable-nutrition product on a fresh add, even with a valid serving size", () => {
    expect(canSubmitProduct(zeroDataProduct, 45, false)).toBe(false);
  });

  it("allows a real product on a fresh add", () => {
    expect(canSubmitProduct(realProduct, 45, false)).toBe(true);
  });

  it("still refuses a zero-serving-size submit for a real product (the pre-Phase-2 gate, unchanged)", () => {
    expect(canSubmitProduct(realProduct, 0, false)).toBe(false);
  });

  it("does NOT refuse a no-usable-nutrition product while editing an already-confirmed entry", () => {
    // A previously-logged genuine 0-kcal/0g entry (e.g. water) must remain
    // re-saveable — this is the deliberate isEditing carve-out, not a gap.
    expect(canSubmitProduct(zeroDataProduct, 250, true)).toBe(true);
  });

  it("still requires a valid serving size while editing", () => {
    expect(canSubmitProduct(realProduct, 0, true)).toBe(false);
  });

  it("allows a manually-entered all-zero product (water) fresh from CreateFoodScreen, not editing", () => {
    // The Phase 3 regression this whole fix targets: without the
    // needsManualEntry source carve-out, this would be false.
    expect(
      canSubmitProduct({ ...zeroDataProduct, source: "custom" }, 250, false),
    ).toBe(true);
  });

  it("still refuses a fresh all-zero product sourced 'off' (the untrusted OFF case, unaffected)", () => {
    expect(
      canSubmitProduct({ ...zeroDataProduct, source: "off" }, 250, false),
    ).toBe(false);
  });
});

describe("numOrNull", () => {
  it("returns null for a blank string", () => {
    expect(numOrNull("")).toBeNull();
    expect(numOrNull("   ")).toBeNull();
  });

  it("returns null for garbage input, not a fallback 0", () => {
    expect(numOrNull("abc")).toBeNull();
  });

  it("returns null for a negative number", () => {
    expect(numOrNull("-5")).toBeNull();
  });

  it("returns 0 for a typed zero — present, not absent", () => {
    expect(numOrNull("0")).toBe(0);
  });

  it("parses a comma-decimal like the rest of this codebase's number fields", () => {
    expect(numOrNull("1,5")).toBe(1.5);
  });

  it("parses a plain positive number", () => {
    expect(numOrNull("362")).toBe(362);
  });
});

describe("canSaveCustomFood (CreateFoodScreen's Save gate — string-layer presence, not parsed positivity)", () => {
  it("refuses when the name is blank, even with a full macro grid", () => {
    expect(canSaveCustomFood("", makeMacros(), false)).toBe(false);
    expect(canSaveCustomFood("   ", makeMacros(), false)).toBe(false);
  });

  it("refuses when any one of the big four is blank", () => {
    expect(canSaveCustomFood("Water", makeMacros({ cal: "" }), false)).toBe(false);
    expect(canSaveCustomFood("Water", makeMacros({ protein: "" }), false)).toBe(false);
    expect(canSaveCustomFood("Water", makeMacros({ carbs: "" }), false)).toBe(false);
    expect(canSaveCustomFood("Water", makeMacros({ fat: "" }), false)).toBe(false);
  });

  it("refuses when a big-four field is garbage — proves this isn't just a presence check on the string", () => {
    expect(canSaveCustomFood("Water", makeMacros({ cal: "abc" }), false)).toBe(false);
  });

  it("allows a genuine typed 0 across the whole big four — this is the water/black-coffee case", () => {
    expect(
      canSaveCustomFood(
        "Water",
        makeMacros({ cal: "0", protein: "0", carbs: "0", fat: "0" }),
        false,
      ),
    ).toBe(true);
  });

  it("allows a real product with the small-four left entirely blank", () => {
    // satFat/salt/fibre/sugar are nullable and irrelevant to THIS gate —
    // makeMacros()'s defaults already leave them blank.
    expect(canSaveCustomFood("Granola", makeMacros(), false)).toBe(true);
  });

  it("refuses while a save is already in flight", () => {
    expect(canSaveCustomFood("Granola", makeMacros(), true)).toBe(false);
  });
});
