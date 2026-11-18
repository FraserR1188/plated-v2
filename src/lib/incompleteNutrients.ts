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
import type { KnownAverage } from "./historyAverages";

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
 * The Trends card's headline (the latest day's number). An INCOMPLETE point —
 * the one drawn hollow for missing or lower-bound data — is an undercount,
 * so its number reads "≥". Keyed on `incomplete` alone, not the whole hollow
 * condition: a "today so far" point is already labelled by its own note,
 * and calories can never be incomplete.
 */
export function trendHeadlineText(formatted: string, incomplete: boolean): string {
  return atLeast(formatted, incomplete);
}

/**
 * History's small-four daily average. "—" when unknown; "≥" when any day in
 * it was a lower bound (lowerBoundDays > 0) — that day is included at its
 * known sum, so the average is a minimum too.
 */
export function averageText(avg: KnownAverage): string {
  if (avg.value == null) return "—";
  return atLeast(`${avg.value}g`, avg.lowerBoundDays > 0);
}

/**
 * The note under that average, or null. PL-058's "6 of 7 days" (days left
 * out) is unchanged; PL-059 adds how many of the included days are minimums:
 *   "6 of 7 days" · "2 of 7 days are minimums" · "6 of 7 days · 1 is a minimum"
 */
export function averageNote(avg: KnownAverage): string | null {
  if (avg.value == null) return null;
  const leftOut = avg.knownDays < avg.loggedDays;
  const n = avg.lowerBoundDays;
  const minimums = n === 1 ? "1 is a minimum" : `${n} are minimums`;
  if (leftOut && n > 0) return `${avg.knownDays} of ${avg.loggedDays} days · ${minimums}`;
  if (leftOut) return `${avg.knownDays} of ${avg.loggedDays} days`;
  if (n > 0) {
    return `${n} of ${avg.loggedDays} days ${n === 1 ? "is a minimum" : "are minimums"}`;
  }
  return null;
}

/**
 * ProductScreen's read-only Per 100g tile value. A per-100g rate rebuilt from
 * a lower bound (mealEntryToProduct on a flagged entry) is a lower bound too,
 * so it gets the same "≥" as the Nutrition preview below it. `column` is the
 * tile's small-four column; big-four tiles pass undefined and stay plain.
 * PL-010: the rate may be exact (an edit's rate is no longer rounded), so
 * the tile rounds to `places` here, for display only.
 */
export function per100TileText(
  value: number,
  flags: readonly SmallFourKey[] | null | undefined,
  column: SmallFourKey | undefined,
  places: number,
): string {
  return atLeast(String(+value.toFixed(places)), column != null && isLowerBound(flags, column));
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
