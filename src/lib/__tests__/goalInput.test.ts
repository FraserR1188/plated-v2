import { describe, it, expect } from "vitest";
import { parseGoalField, parseGoalValues, GOAL_FIELD_KEYS } from "../goalInput";

/**
 * PL-024. SettingsScreen used to parse each goal with
 * `parseInt(values.x) || <default>`, which silently substituted the default
 * for anything that didn't parse — a cleared field, a typo, or an explicit 0.
 *
 * With PL-023's changed-columns-only write, a cleared field is a CHANGE, so
 * the substituted default is precisely what gets persisted. Before PL-023 it
 * was one of eight values in a blind upsert; now it is the one column the
 * write targets. Strict parsing is the whole defence.
 */

const asValue = (r: ReturnType<typeof parseGoalField>) =>
  "value" in r ? r.value : null;
const asError = (r: ReturnType<typeof parseGoalField>) =>
  "error" in r ? r.error : null;

describe("parseGoalField", () => {
  it("rejects an empty field rather than substituting a default", () => {
    const r = parseGoalField("calories", "");
    expect(asValue(r)).toBeNull();
    expect(asError(r)).toEqual(expect.any(String));
  });

  it("rejects whitespace only", () => {
    expect(asError(parseGoalField("protein", "   "))).toEqual(
      expect.any(String),
    );
  });

  it("rejects a non-numeric string rather than substituting a default", () => {
    // parseInt("abc") is NaN, and NaN || 150 was 150 — the old code wrote
    // 150 g of protein because someone typed a letter.
    expect(asError(parseGoalField("protein", "abc"))).toEqual(
      expect.any(String),
    );
  });

  it("rejects trailing junk that parseInt would have silently truncated", () => {
    // parseInt("150abc") === 150. Accepting that writes a number the user
    // never typed.
    expect(asError(parseGoalField("protein", "150abc"))).toEqual(
      expect.any(String),
    );
  });

  it("rejects a thousands separator rather than reading it as 2", () => {
    // parseInt("2,500") === 2. This is the worst of the silent-truncation
    // cases: a plausible way to type a calorie target that parsed to 2.
    expect(asError(parseGoalField("calories", "2,500"))).toEqual(
      expect.any(String),
    );
  });

  it("rejects a negative target", () => {
    expect(asError(parseGoalField("protein", "-5"))).toEqual(expect.any(String));
  });

  it("accepts a plain number", () => {
    expect(asValue(parseGoalField("calories", "2500"))).toBe(2500);
  });

  it("accepts surrounding whitespace", () => {
    expect(asValue(parseGoalField("calories", " 2500 "))).toBe(2500);
  });

  // ── zero ────────────────────────────────────────────────────────────
  //
  // 0 is a real target for the seven macros — "no added sugar", "as little
  // salt as possible" — and the old `|| <default>` made it unreachable:
  // 0 is falsy, so typing 0 saved 30 g of sugar.
  //
  // calories is the exception. A zero calorie goal is not a target, it's a
  // division by zero: both TodayScreen's frac() (`goal > 0 ? … : 0`) and
  // HistoryScreen's ring fraction already special-case it, which is the
  // codebase agreeing that it isn't a usable value.

  it("accepts an explicit 0 for every macro", () => {
    for (const key of GOAL_FIELD_KEYS) {
      if (key === "calories") continue;
      expect(asValue(parseGoalField(key, "0"))).toBe(0);
    }
  });

  it("rejects 0 calories, and says why", () => {
    const r = parseGoalField("calories", "0");
    expect(asValue(r)).toBeNull();
    expect(asError(r)).toMatch(/1|at least/i);
  });

  // ── decimals follow the COLUMN type ─────────────────────────────────
  //
  // Measured on production: calories/protein/carbs/fat are `integer`;
  // sat_fat/salt/fibre/sugar are `numeric`. Accepting 150.5 protein would
  // let Postgres round it on the way in and hand back a number the user
  // never chose.

  it("rejects a decimal for an integer column", () => {
    for (const key of ["calories", "protein", "carbs", "fat"] as const) {
      expect(asError(parseGoalField(key, "150.5"))).toEqual(expect.any(String));
    }
  });

  it("accepts a decimal for a numeric column", () => {
    for (const key of ["satFat", "salt", "fibre", "sugar"] as const) {
      expect(asValue(parseGoalField(key, "5.5"))).toBe(5.5);
    }
  });
});

describe("parseGoalValues", () => {
  const good = {
    calories: "2500",
    protein: "180",
    carbs: "240",
    fat: "70",
    satFat: "24",
    salt: "5.5",
    fibre: "35",
    sugar: "40",
  };

  it("returns a complete Goals object when every field parses", () => {
    const r = parseGoalValues(good);
    expect("goals" in r).toBe(true);
    if ("goals" in r) {
      expect(r.goals).toEqual({
        calories: 2500,
        protein: 180,
        carbs: 240,
        fat: 70,
        satFat: 24,
        salt: 5.5,
        fibre: 35,
        sugar: 40,
      });
    }
  });

  it("returns errors — and NO goals — when one field is cleared", () => {
    // The PL-024 sequence in one assertion: a cleared field must not reach
    // the write path at all, under any substitution.
    const r = parseGoalValues({ ...good, fibre: "" });
    expect("goals" in r).toBe(false);
    if ("errors" in r) {
      expect(r.errors.fibre).toEqual(expect.any(String));
      expect(r.errors.calories).toBeUndefined();
    }
  });

  it("reports every invalid field, not just the first", () => {
    const r = parseGoalValues({ ...good, fibre: "", protein: "abc" });
    if ("errors" in r) {
      expect(Object.keys(r.errors).sort()).toEqual(["fibre", "protein"]);
    } else {
      throw new Error("expected errors");
    }
  });

  it("a zeroed macro is valid and is carried through as 0", () => {
    const r = parseGoalValues({ ...good, sugar: "0" });
    expect("goals" in r).toBe(true);
    if ("goals" in r) expect(r.goals.sugar).toBe(0);
  });
});
