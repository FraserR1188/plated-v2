// ============================================================
// src/lib/entryEdit.ts — the edit path's changed-fields patch (PL-037)
//
// RED-COMMIT STUB. This reproduces ProductScreen.handleSubmit's CURRENT edit
// patch exactly — every edit resends serving_g, all eight macros and
// eaten_at, and never meal_type — so the tests in
// __tests__/entryEdit.test.ts fail on behaviour rather than on a missing
// module. Nothing imports it yet. The next commit replaces the body.
// ============================================================

import type { FoodProduct, MealEntry, MealType } from "../types";
import type { MealEntryPatch } from "../store/useStore";

/** The loaded row, snapshotted when ProductScreen opened it. */
export type EditOriginal = Pick<
  MealEntry,
  "meal_type" | "serving_g" | "eaten_at" | "eaten_at_estimated"
>;

/** What the edit screen holds at Submit. */
export interface EditState {
  mealType: MealType;
  /** The serving field's raw text. */
  servingText: string;
  /** The resolved eaten_at (ISO), as handleSubmit computes it. */
  eatenAt: string;
  /** Did the user pick a time on ProductScreen's own time chip? */
  timeTouched: boolean;
  /** Per-100g source for recomputing macros. */
  product: FoodProduct;
}

export function buildEditPatch(
  _original: EditOriginal,
  edited: EditState,
): MealEntryPatch {
  const g = parseFloat(edited.servingText) || 0;
  const f = g / 100;
  const p = edited.product;
  const patch: MealEntryPatch = {
    serving_g: g,
    calories: p.cal_per100 * f,
    protein: p.protein_per100 * f,
    carbs: p.carbs_per100 * f,
    fat: p.fat_per100 * f,
    sat_fat: p.sat_fat_per100 != null ? p.sat_fat_per100 * f : null,
    salt: p.salt_per100 != null ? p.salt_per100 * f : null,
    fibre: p.fibre_per100 != null ? p.fibre_per100 * f : null,
    sugar: p.sugar_per100 != null ? p.sugar_per100 * f : null,
    eaten_at: edited.eatenAt,
  };
  if (edited.timeTouched) patch.eaten_at_estimated = false;
  return patch;
}
