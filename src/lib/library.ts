// ============================================================
// src/lib/library.ts — My Library tab, pure logic
//
// Pulled out of AddIngredientScreen so the filter is Vitest-covered directly
// rather than only reachable through a deferred RNTL component test (see
// CLAUDE.md: component tests are deferred until after the UI redesign).
// ============================================================

import { SavedIngredientScored } from "../types";

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
