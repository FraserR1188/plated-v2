// ============================================================
// src/lib/entryEdit.ts — the edit path's changed-fields patch (PL-037)
//
// ProductScreen's edit path used to resend serving_g, all eight macros and
// eaten_at on EVERY save. Two costs:
//   - the macros were recomputed from a per-100g rate that mealEntryToProduct
//     had rounded, so any save snapped them onto the rounding grid (PL-010) —
//     including a save that only moved the meal to another slot;
//   - eaten_at was re-resolved to the minute, so every edit zeroed the
//     row's seconds.
//
// This builds the patch from what actually CHANGED, compared against the row
// as it was loaded (ProductScreen snapshots it on mount), never against
// route params:
//
//   meal_type           when the chip differs from the row's slot;
//   eaten_at            when the resolved time differs AT MINUTE PRECISION —
//                       the precision the picker works in, so an untouched
//                       time is equal and keeps its seconds;
//   eaten_at_estimated  false, only when ProductScreen's time chip was touched
//                       and the row still says true. Only ever upgraded;
//                       never set true on the edit path;
//   serving_g + macros  when the serving differs by VALUE. The text is parsed
//                       to a number and the stored value goes through Number():
//                       it comes off the wire, and a strict compare against a
//                       string would resend the macros on every edit — the
//                       failure this exists to stop.
//
// Returns MealEntryPatch, so `date` and `planned` stay unrepresentable.
// `date` is derived from eaten_at inside updateEntry, and only when eaten_at
// is sent — a slot-only patch leaves the day alone. `{}` means nothing
// changed; the caller then writes nothing.
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

const minuteOf = (iso: string): number =>
  Math.floor(new Date(iso).getTime() / 60000);

export function buildEditPatch(
  original: EditOriginal,
  edited: EditState,
): MealEntryPatch {
  const patch: MealEntryPatch = {};

  if (edited.mealType !== original.meal_type) {
    patch.meal_type = edited.mealType;
  }

  if (minuteOf(edited.eatenAt) !== minuteOf(original.eaten_at)) {
    patch.eaten_at = edited.eatenAt;
  }
  if (edited.timeTouched && original.eaten_at_estimated) {
    patch.eaten_at_estimated = false;
  }

  // parseFloat is how handleSubmit reads the field, and always yields a
  // number; Number() is the coercion that matters, on the stored side.
  const g = parseFloat(edited.servingText) || 0;
  if (g !== Number(original.serving_g)) {
    // NULL-not-zero: an unknown per-100g value stays NULL through the scale.
    const f = g / 100;
    const p = edited.product;
    patch.serving_g = g;
    patch.calories = p.cal_per100 * f;
    patch.protein = p.protein_per100 * f;
    patch.carbs = p.carbs_per100 * f;
    patch.fat = p.fat_per100 * f;
    patch.sat_fat = p.sat_fat_per100 != null ? p.sat_fat_per100 * f : null;
    patch.salt = p.salt_per100 != null ? p.salt_per100 * f : null;
    patch.fibre = p.fibre_per100 != null ? p.fibre_per100 * f : null;
    patch.sugar = p.sugar_per100 != null ? p.sugar_per100 * f : null;
  }

  return patch;
}
