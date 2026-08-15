// ============================================================
// src/lib/macros.ts — pure macro-display helpers
//
// Split out of TodayScreen so the rounding logic is unit-testable without
// dragging React Native into the test environment (see roundSalt).
// ============================================================

import { MacroKey } from "./labelExtraction";

/**
 * Parse a raw text-field string to a number, collapsing blank/garbage/
 * negative input to `null` rather than 0. This is what makes "was
 * something real typed here" distinguishable from "left blank" at the
 * string layer — a typed "0" survives as 0, a typed "abc" does not
 * silently become 0 either. Used both for custom_foods' nullable
 * small-four (a blank field IS unknown, must persist as NULL — see
 * 20260814100000_custom_foods_null_not_zero.sql) and for CreateFoodScreen's
 * canSaveCustomFood gate below (a blank big-four field must not be
 * indistinguishable from a typed "0").
 */
export function numOrNull(s: string): number | null {
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * CreateFoodScreen's Save gate. Name + all four big-four macros PRESENT
 * (not merely positive) are the minimum for a useful entry.
 *
 * `numOrNull(macros.cal) > 0`-style checks (the strict-positive version
 * this replaced) reject a genuine 0-kcal food — water, black coffee —
 * which is exactly the class of real data manual entry exists to let
 * someone type in. Checking `numOrNull(...) !== null` on the RAW STRING
 * for every big-four field is what lets a typed "0" through while still
 * refusing a blank or garbage field: presence, not positivity.
 */
export function canSaveCustomFood(
  name: string,
  macros: Record<MacroKey, string>,
  saving: boolean,
): boolean {
  const bigFour: MacroKey[] = ["cal", "protein", "carbs", "fat"];
  const bigFourPresent = bigFour.every((k) => numOrNull(macros[k]) !== null);
  return name.trim().length > 0 && bigFourPresent && !saving;
}

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
 * "No usable nutrition" detector (Phase 2). Energy + the big three
 * (protein/carbs/fat) are the only fields that can never legitimately be
 * zero ACROSS ALL FOUR AT ONCE for a real food — sat-fat/salt/fibre/sugar
 * legitimately can be, so they're deliberately not part of this check.
 *
 * Keys on the VALUE being zero, not on whether it was null before reaching
 * here — a genuine OFF crowd-sourced zero (bad but real data) and a
 * pre-Phase-1 null-coerced zero are indistinguishable once they're plain
 * numbers, and both need the same outcome: don't let this reach the log
 * without a human confirming real values.
 */
export function hasUsableNutrition(p: {
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
}): boolean {
  return !(
    p.cal_per100 === 0 &&
    p.protein_per100 === 0 &&
    p.carbs_per100 === 0 &&
    p.fat_per100 === 0
  );
}

/**
 * Phase 2's display/gate predicate: does this product still need a trip
 * through manual entry? Almost `!hasUsableNutrition`, with one carve-out
 * that has to live HERE rather than at each call site, or it will drift:
 *
 * A `source: "custom"` product's big-four were necessarily human-typed —
 * canSaveCustomFood (CreateFoodScreen's Save gate) requires all four
 * present before a custom_foods row can even be created. That's the SAME
 * confirmation this whole detector exists to demand from an OFF-sourced
 * product; a custom food already did it, at save time.
 *
 * Without this, a manually-entered genuine all-zero (water, black coffee —
 * exactly the case Phase 3 exists to let through) would trip
 * hasUsableNutrition AGAIN the instant it comes back from
 * CreateFoodScreen, re-triggering the no-usable-nutrition card and
 * re-blocking Add — the user would be handed back into the exact gate they
 * just cleared, with no way out. `source` is the one signal available at
 * this point that distinguishes "untrusted, came straight from OFF" from
 * "already human-confirmed", so it's the one this checks.
 */
export function needsManualEntry(product: {
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
  source?: "off" | "custom";
}): boolean {
  if (product.source === "custom") return false;
  return !hasUsableNutrition(product);
}

/**
 * The complete Phase 2 submit gate for ProductScreen's Add/Save button,
 * pulled out so the actual decision — not a component-side approximation
 * of it — is what's under test.
 *
 * Editing is exempt from the nutrition check: an edit's draft comes from
 * mealEntryToProduct() on an already-confirmed MealEntry, and re-litigating
 * already-logged history (e.g. blocking a genuine 0-kcal water entry from
 * being re-saved) would be a regression, not a fix. The serving-size check
 * (servingG > 0) applies either way — it predates Phase 2 and is unrelated
 * to the nutrition-data question.
 */
export function canSubmitProduct(
  product: {
    cal_per100: number;
    protein_per100: number;
    carbs_per100: number;
    fat_per100: number;
    source?: "off" | "custom";
  },
  servingG: number,
  isEditing: boolean,
): boolean {
  return servingG > 0 && (isEditing || !needsManualEntry(product));
}

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
