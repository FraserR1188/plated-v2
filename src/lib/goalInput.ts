// ============================================================
// src/lib/goalInput.ts — parsing the eight daily-target inputs.
//
// PL-024. SettingsScreen parsed each field as
// `parseInt(values.x) || <default>`, which is three silent substitutions in
// one expression:
//
//   - a CLEARED field  → NaN → the default
//   - a TYPO ("abc")   → NaN → the default
//   - an explicit 0    → 0 is falsy → the default
//
// and parseInt's own truncation on top: "150abc" is 150, and "2,500" — a
// perfectly reasonable way to type a calorie target — is 2.
//
// That was survivable when Save blind-upserted all eight columns from a
// form seeded at mount. It stopped being survivable with PL-023, which
// writes only the columns that CHANGED: clearing a field is now a change,
// so the substituted default is precisely and only what gets persisted.
//
// Nothing here substitutes anything. A field either parses to what the user
// typed or it is an error the screen has to show.
// ============================================================

import { Goals } from "../types";

export const GOAL_FIELD_KEYS = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "satFat",
  "salt",
  "fibre",
  "sugar",
] as const;

export type GoalFieldKey = (typeof GOAL_FIELD_KEYS)[number];

export type GoalFieldResult = { value: number } | { error: string };

/**
 * Which columns are `integer` and which are `numeric`, measured against
 * production rather than assumed: calories/protein/carbs/fat are integer;
 * sat_fat/salt/fibre/sugar are numeric with no declared scale.
 *
 * It matters for input: accepting "150.5" for an integer column lets
 * Postgres round on the way in and hand back a number the user never chose.
 */
const INTEGER_FIELDS: ReadonlySet<GoalFieldKey> = new Set([
  "calories",
  "protein",
  "carbs",
  "fat",
]);

/**
 * calories is the one field where 0 is not a target but a division by zero.
 * Both TodayScreen's `frac()` and HistoryScreen's ring fraction already
 * special-case `goal > 0`, which is the codebase agreeing it isn't usable.
 *
 * Every macro accepts 0: "no added sugar" and "as little salt as possible"
 * are real targets, and `|| <default>` made them unreachable because 0 is
 * falsy.
 */
const MINIMUM: Record<GoalFieldKey, number> = {
  calories: 1,
  protein: 0,
  carbs: 0,
  fat: 0,
  satFat: 0,
  salt: 0,
  fibre: 0,
  sugar: 0,
};

/** Strict: optional sign is rejected separately, so this is digits with at
 *  most one decimal point and at least one digit. No exponent, no comma, no
 *  trailing unit — anything parseInt would have truncated is refused. */
const NUMERIC = /^\d+(\.\d+)?$/;

export function parseGoalField(
  key: GoalFieldKey,
  raw: string,
): GoalFieldResult {
  const text = raw.trim();

  if (text === "") return { error: "Enter a number" };
  if (text.startsWith("-")) return { error: "Can't be negative" };
  if (!NUMERIC.test(text)) return { error: "Numbers only" };

  const value = Number(text);
  if (!Number.isFinite(value)) return { error: "Numbers only" };

  if (INTEGER_FIELDS.has(key) && !Number.isInteger(value)) {
    return { error: "Whole numbers only" };
  }

  const min = MINIMUM[key];
  if (value < min) {
    return { error: min === 1 ? "Must be at least 1" : "Can't be negative" };
  }

  return { value };
}

export type GoalValuesResult =
  | { goals: Goals }
  | { errors: Partial<Record<GoalFieldKey, string>> };

/**
 * Parses all eight together. Either every field is good and a complete
 * `Goals` comes back, or nothing does and the caller gets one message per
 * bad field — there is deliberately no partial result, because a partial
 * result is what a write path would be tempted to use.
 */
export function parseGoalValues(
  values: Record<string, string>,
): GoalValuesResult {
  const parsed: Partial<Record<GoalFieldKey, number>> = {};
  const errors: Partial<Record<GoalFieldKey, string>> = {};

  for (const key of GOAL_FIELD_KEYS) {
    const result = parseGoalField(key, values[key] ?? "");
    if ("error" in result) errors[key] = result.error;
    else parsed[key] = result.value;
  }

  if (Object.keys(errors).length > 0) return { errors };

  return {
    goals: {
      calories: parsed.calories!,
      protein: parsed.protein!,
      carbs: parsed.carbs!,
      fat: parsed.fat!,
      satFat: parsed.satFat!,
      salt: parsed.salt!,
      fibre: parsed.fibre!,
      sugar: parsed.sugar!,
    },
  };
}
