// ============================================================
// src/lib/macros.ts — pure macro-display helpers
//
// Split out of TodayScreen so the rounding logic is unit-testable without
// dragging React Native into the test environment (see roundSalt).
// ============================================================

/** Salt is sub-gram, so Math.round() would collapse it to 0 — and the raw float
 *  sum shows a "0.4660000000000001" tail. Floored to 2dp: trims the noise, keeps
 *  small values visible (0.04 stays 0.04, not "0.0"), and the +1e-9 nudge stops
 *  a value like 0.47 slipping to 0.46 on FP error. Swap Math.floor→Math.round if
 *  you'd rather round to nearest. */
export const roundSalt = (g: number): number => Math.floor(g * 100 + 1e-9) / 100;

/** A per-100g rate, the shape every product source in this app converges on
 *  (OFF, custom foods, label scans, AI photo drafts). Only the fields this
 *  file needs — not FoodProduct itself, so this stays free of a screens/
 *  or store dependency. */
export type PerHundredGram = {
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
  sat_fat_per100?: number;
  salt_per100?: number;
  fibre_per100?: number;
  sugar_per100?: number;
};

export type ServingTotals = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  satFat: number;
  salt: number;
  fibre: number;
  sugar: number;
};

/**
 * Scale a per-100g rate to a serving size. Pulled out of ProductScreen so
 * "edit a macro, see the serving total recompute" is testable without RNTL
 * (deferred — see CLAUDE.md) and so every caller gets the same rounding.
 *
 * Fixes a real bug in the process: ProductScreen's preview used
 * `.toFixed(2)` for salt, not roundSalt — the exact float-noise problem
 * roundSalt exists to fix (a summed 0.4660000000000001 would round HALF UP
 * to "0.47" via toFixed, not floor to "0.46"). Every other product screen
 * in the app treats roundSalt as the house convention for salt; this one
 * quietly wasn't following it.
 */
export function computeServingTotals(
  product: PerHundredGram,
  servingG: number,
): ServingTotals {
  const f = servingG / 100;
  return {
    calories: Math.round(product.cal_per100 * f),
    protein: +(product.protein_per100 * f).toFixed(1),
    carbs: +(product.carbs_per100 * f).toFixed(1),
    fat: +(product.fat_per100 * f).toFixed(1),
    satFat: +((product.sat_fat_per100 ?? 0) * f).toFixed(1),
    salt: roundSalt((product.salt_per100 ?? 0) * f),
    fibre: +((product.fibre_per100 ?? 0) * f).toFixed(1),
    sugar: +((product.sugar_per100 ?? 0) * f).toFixed(1),
  };
}
