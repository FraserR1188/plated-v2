import { describe, it, expect } from "vitest";
import { roundSalt, computeServingTotals } from "../macros";

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
