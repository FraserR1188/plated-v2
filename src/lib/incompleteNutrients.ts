// ============================================================
// src/lib/incompleteNutrients.ts — PL-059 display helpers
//
// A batch with an ingredient that has no fibre on record logs fibre as the
// KNOWN ingredients' sum and lists 'fibre' in incomplete_nutrients (see
// sumBatchMacros in lib/compositions.ts). These helpers are how the UI says
// so: "≥ 2.1 g" on the number, one muted line naming what's missing, and —
// before a batch is saved — which ingredients are the reason.
//
// Pure, no React, so every rule here is tested in node
// (__tests__/incompleteNutrients.test.ts).
// ============================================================

import type { FoodProduct, SmallFourKey } from "../types";

/** Column order — the order incomplete_nutrients is written in. */
export const SMALL_FOUR_KEYS: readonly SmallFourKey[] = ["sat_fat", "salt", "fibre", "sugar"];

const LABEL: Record<SmallFourKey, string> = {
  sat_fat: "Sat fat",
  salt: "Salt",
  fibre: "Fibre",
  sugar: "Sugar",
};

const PER100: Record<SmallFourKey, keyof FoodProduct> = {
  sat_fat: "sat_fat_per100",
  salt: "salt_per100",
  fibre: "fibre_per100",
  sugar: "sugar_per100",
};

/** "≥ 2.1" for a lower bound, the text unchanged otherwise. */
export function atLeast(text: string, lowerBound: boolean): string {
  return lowerBound ? `≥ ${text}` : text;
}

/** Is `key` listed as a lower bound? Tolerates null/undefined (complete). */
export function isLowerBound(
  flags: readonly SmallFourKey[] | null | undefined,
  key: SmallFourKey,
): boolean {
  return !!flags?.includes(key);
}

/**
 * The one muted line under a flagged entry's nutrition, or null when nothing
 * is flagged. Column order, whatever order `flags` came in:
 *   ["fibre"]                 → "Some ingredients have no fibre data"
 *   ["salt", "fibre"]         → "Some ingredients have no salt or fibre data"
 *   ["sat_fat","salt","fibre"] → "Some ingredients have no sat fat, salt or fibre data"
 */
export function lowerBoundNote(
  flags: readonly SmallFourKey[] | null | undefined,
): string | null {
  const nouns = SMALL_FOUR_KEYS.filter((k) => isLowerBound(flags, k)).map((k) =>
    LABEL[k].toLowerCase(),
  );
  if (nouns.length === 0) return null;
  const list =
    nouns.length === 1
      ? nouns[0]
      : `${nouns.slice(0, -1).join(", ")} or ${nouns[nouns.length - 1]}`;
  return `Some ingredients have no ${list} data`;
}

/** One ingredient as the batch screens hold it: a display name and the food
 *  it resolved to (null while a recipe row has no match yet — skipped). */
export interface NamedIngredient {
  name: string;
  product: FoodProduct | null;
}

/**
 * Before a batch is saved: for each small-four nutrient, which ingredients
 * have no value for it — the ones that will make the logged number a lower
 * bound. One line per nutrient with at least one, column order, ingredient
 * order kept, each name once:
 *   "Fibre missing for: ground cumin, lime juice"
 *
 * A real 0 is a value, not a gap: only `== null` counts.
 */
export function missingNutrientLines(ingredients: readonly NamedIngredient[]): string[] {
  const lines: string[] = [];
  for (const key of SMALL_FOUR_KEYS) {
    const names: string[] = [];
    for (const ing of ingredients) {
      if (ing.product && ing.product[PER100[key]] == null && !names.includes(ing.name)) {
        names.push(ing.name);
      }
    }
    if (names.length > 0) lines.push(`${LABEL[key]} missing for: ${names.join(", ")}`);
  }
  return lines;
}
