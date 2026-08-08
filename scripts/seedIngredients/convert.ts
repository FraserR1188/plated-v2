// ============================================================
// scripts/seedIngredients/convert.ts — pure macro conversion/merge helpers
//
// Pulled out of the importer so they're unit-testable without a CoFID file,
// an FDC key, or a Supabase connection. Keyed by the core_ingredients COLUMN
// names directly (kcal_100g, etc.) — there's exactly one place downstream
// (the upsert row builder) that needs a mapping, so this file doesn't need
// a second parallel naming scheme.
// ============================================================

export type Macro100Key =
  | "kcal_100g"
  | "protein_100g"
  | "carbs_100g"
  | "fat_100g"
  | "satfat_100g"
  | "sugar_100g"
  | "fibre_100g"
  | "salt_100g";

export const MACRO100_KEYS: Macro100Key[] = [
  "kcal_100g",
  "protein_100g",
  "carbs_100g",
  "fat_100g",
  "satfat_100g",
  "sugar_100g",
  "fibre_100g",
  "salt_100g",
];

/** NULL = unknown. Never 0-by-default — see the migration's header comment. */
export type Macro100 = Record<Macro100Key, number | null>;

export const EMPTY_MACRO100: Macro100 = {
  kcal_100g: null,
  protein_100g: null,
  carbs_100g: null,
  fat_100g: null,
  satfat_100g: null,
  sugar_100g: null,
  fibre_100g: null,
  salt_100g: null,
};

// UK label convention (exact factor 2.542, commonly rounded to 2.5 — matches
// src/lib/macros.ts's roundSalt callers and openfoodfacts.ts's sodium*2.5
// fallback, so a staple and an OFF product agree on the same rate).
export const SALT_PER_SODIUM = 2.5;

/**
 * sodium (mg/100g) -> salt (g/100g). NEVER defaults an unknown sodium to 0 —
 * that would assert "this food has no salt" instead of "we don't know",
 * exactly the meal_entries `?? 0`-on-write bug this project has hit before
 * (see src/lib/entries.ts's comment on sat_fat/salt/fibre/sugar).
 */
export function toSaltG(sodiumMg: number | null | undefined): number | null {
  if (sodiumMg == null || !Number.isFinite(sodiumMg)) return null;
  return (sodiumMg / 1000) * SALT_PER_SODIUM;
}

/**
 * Merge two partial macro rows PER FIELD: primary (CoFID) wins, secondary
 * (FDC) fills only the fields primary left null/undefined. Never per-row —
 * a staple with CoFID protein but no CoFID fibre must take FDC's fibre
 * while keeping CoFID's protein, not fall back to FDC wholesale.
 */
export function coalesceMacros(
  primary: Partial<Macro100>,
  secondary: Partial<Macro100>,
): Macro100 {
  const out = { ...EMPTY_MACRO100 };
  for (const k of MACRO100_KEYS) {
    const p = primary[k];
    const s = secondary[k];
    out[k] = p != null ? p : s != null ? s : null;
  }
  return out;
}
