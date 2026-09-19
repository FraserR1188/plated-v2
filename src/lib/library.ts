// ============================================================
// src/lib/library.ts — My Library tab, pure logic
//
// Pulled out of AddIngredientScreen so the filter is Vitest-covered directly
// rather than only reachable through a deferred RNTL component test (see
// CLAUDE.md: component tests are deferred until after the UI redesign).
// ============================================================

import { FoodProduct, SavedIngredient, SavedIngredientScored } from "../types";

/**
 * A My Library row → the FoodProduct that ProductScreen (log it) and
 * BatchIngredientPicker (add it to a batch) both start from. One mapping for
 * both — they used to be two identical hand-written copies, the shape of bug
 * that let ConnectedUserLogScreen's rebuild drift.
 *
 * The small four are NULLABLE in saved_ingredients (NULL = unknown) and
 * `number | undefined` on FoodProduct: NULL → undefined is a sentinel
 * translation, the same one customFoodToProduct does — NOT a coercion.
 * ProductScreen then shows "—" and writes NULL to meal_entries; a batch
 * ingredient stays NULL and the batch total for that macro becomes unknown.
 * It used to be `sat_fat_per100 ?? 0`, which turned an unknown into a logged
 * "zero sat fat" on every re-add.
 */
export function savedIngredientToProduct(saved: SavedIngredient): FoodProduct {
  return {
    name: saved.name,
    brand: saved.brand ?? "",
    cal_per100: saved.cal_per100,
    protein_per100: saved.protein_per100,
    carbs_per100: saved.carbs_per100,
    fat_per100: saved.fat_per100,
    sat_fat_per100: saved.sat_fat_per100 ?? undefined,
    salt_per100: saved.salt_per100 ?? undefined,
    fibre_per100: saved.fibre_per100 ?? undefined,
    sugar_per100: saved.sugar_per100 ?? undefined,
    barcode: saved.barcode ?? undefined,
    off_id: saved.off_id ?? undefined,
  };
}

/**
 * In-memory substring match over the already-loaded savedIngredients array —
 * name or brand, case-insensitive. Not a query: there is nothing to debounce
 * and nothing to hit the network for. Scoped to the My Library tab only; the
 * Search tab's OFF lookup is a completely separate path (see searchFood in
 * lib/openfoodfacts.ts).
 */
export function filterSavedIngredients(
  items: SavedIngredientScored[],
  query: string,
): SavedIngredientScored[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      (item.brand ?? "").toLowerCase().includes(q),
  );
}
