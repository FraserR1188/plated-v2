// ============================================================
// src/lib/entryEdit.ts — the edit path's changed-fields patch (PL-037),
// scaled off the row's stored values (PL-010)
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
// PL-010: the macros are the row's OWN stored values × (new g / stored g) —
// the same ratio scaling bundles use (compositions.ts, "Apply-time quantity
// adjustment"). Never a per-100g rate: mealEntryToProduct's rate is only for
// display, and going through any rate (rounded or not) and back does not
// reproduce the stored numbers. Device pass 2026-11-18: a chilli at 713 g
// with salt 3.02 previewed 2.99 untouched, and a 400 g edit wrote 1.68
// (0.42 × 4) instead of 1.6942.
//
// Returns MealEntryPatch, so `date` and `planned` stay unrepresentable, and
// incomplete_nutrients can't be named: a lower bound scaled is still a
// lower bound, so the row's flag stands. `date` is derived from eaten_at
// inside updateEntry, and only when eaten_at is sent — a slot-only patch
// leaves the day alone. `{}` means nothing changed; the caller then writes
// nothing.
// ============================================================

import type { MealEntry, MealType } from "../types";
import type { MealEntryPatch } from "../store/useStore";
import { roundServingTotals, type ServingTotals } from "./macros";

/** The eight stored macro columns, as the row holds them. */
export type StoredMacros = Pick<
  MealEntry,
  "calories" | "protein" | "carbs" | "fat" | "sat_fat" | "salt" | "fibre" | "sugar"
>;

/** The loaded row, snapshotted when ProductScreen opened it. */
export type EditOriginal = Pick<
  MealEntry,
  "meal_type" | "serving_g" | "eaten_at" | "eaten_at_estimated"
> &
  StoredMacros;

/** What the edit screen holds at Submit. */
export interface EditState {
  mealType: MealType;
  /** The serving field's raw text. */
  servingText: string;
  /** The resolved eaten_at (ISO), as handleSubmit computes it. */
  eatenAt: string;
  /** Did the user pick a time on ProductScreen's own time chip? */
  timeTouched: boolean;
}

const minuteOf = (iso: string): number =>
  Math.floor(new Date(iso).getTime() / 60000);

/**
 * The row's eight stored values at `grams`.
 *
 *   grams equal to the stored serving → the stored values VERBATIM (no
 *                                       arithmetic, so nothing can drift);
 *   otherwise                         → each × (grams / stored serving);
 *   NULL                              → NULL, at any grams.
 *
 * null when the stored serving_g is NULL or not > 0: there is nothing to
 * scale from. TodayScreen refuses to open such a row for editing (it can't
 * rebuild a per-100g rate either — see mealEntryToProduct), so this is a
 * guard, not a path.
 */
export function scaleStoredMacros(
  row: Pick<MealEntry, "serving_g"> & StoredMacros,
  grams: number,
): StoredMacros | null {
  const stored = Number(row.serving_g);
  if (row.serving_g == null || !(stored > 0)) return null;

  if (grams === stored) {
    return {
      calories: row.calories,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
      sat_fat: row.sat_fat ?? null,
      salt: row.salt ?? null,
      fibre: row.fibre ?? null,
      sugar: row.sugar ?? null,
    };
  }

  const ratio = grams / stored;
  const scale = (v: number | null | undefined): number | null =>
    v == null ? null : v * ratio;
  return {
    calories: row.calories * ratio,
    protein: row.protein * ratio,
    carbs: row.carbs * ratio,
    fat: row.fat * ratio,
    sat_fat: scale(row.sat_fat),
    salt: scale(row.salt),
    fibre: scale(row.fibre),
    sugar: scale(row.sugar),
  };
}

/**
 * The edit screen's Nutrition preview: scaleStoredMacros through the same
 * display rounding as every other preview (roundServingTotals). An untouched
 * entry therefore shows exactly its stored values. null when the row can't
 * be scaled (see above) — the caller falls back to the rate-based preview.
 */
export function editPreviewTotals(
  row: Pick<MealEntry, "serving_g"> & StoredMacros,
  grams: number,
): ServingTotals | null {
  const s = scaleStoredMacros(row, grams);
  if (!s) return null;
  return roundServingTotals({
    calories: s.calories,
    protein: s.protein,
    carbs: s.carbs,
    fat: s.fat,
    satFat: s.sat_fat,
    salt: s.salt,
    fibre: s.fibre,
    sugar: s.sugar,
  });
}

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
    const scaled = scaleStoredMacros(original, g);
    // No stored serving to scale from: send neither the serving nor macros
    // rather than invent them. Unreachable from the UI (see scaleStoredMacros).
    if (scaled) {
      patch.serving_g = g;
      patch.calories = scaled.calories;
      patch.protein = scaled.protein;
      patch.carbs = scaled.carbs;
      patch.fat = scaled.fat;
      patch.sat_fat = scaled.sat_fat;
      patch.salt = scaled.salt;
      patch.fibre = scaled.fibre;
      patch.sugar = scaled.sugar;
    }
  }

  return patch;
}
