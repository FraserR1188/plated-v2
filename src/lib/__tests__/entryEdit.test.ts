// ============================================================
// src/lib/__tests__/entryEdit.test.ts — PL-037
//
// buildEditPatch sends only what the user changed, compared against the row
// as it was loaded. Every test asserts the KEY SET, not just values: a slot
// change that also resends the macros snaps them to the rounding grid
// (PL-010), and a patch that carries an untouched eaten_at silently zeroes
// its seconds. Absence is the thing under test.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildEditPatch,
  editPreviewTotals,
  scaleStoredMacros,
  type EditOriginal,
  type EditState,
} from "../entryEdit";
import { roundSalt } from "../macros";

const MACRO_KEYS = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "sat_fat",
  "salt",
  "fibre",
  "sugar",
];

// The loaded row: Greek yogurt at 150 g (97 kcal, 9 g protein … per 100 g).
// eaten_at deliberately carries seconds and milliseconds, as a row logged
// at "now" does. PL-010: the row's own eight stored values are what a
// grams edit scales — never a per-100g rate rebuilt from them.
const original: EditOriginal = {
  meal_type: "breakfast",
  serving_g: 150,
  eaten_at: "2026-09-20T07:30:42.123+00:00",
  eaten_at_estimated: true,
  calories: 145.5,
  protein: 13.5,
  carbs: 5.85,
  fat: 7.5,
  sat_fat: 4.95,
  salt: 0.15,
  fibre: 0,
  sugar: 5.85,
};

// What handleSubmit resolves an UNTOUCHED time to: the same minute, seconds zeroed.
const SAME_MINUTE = "2026-09-20T07:30:00.000Z";

const untouched = (over: Partial<EditState> = {}): EditState => ({
  mealType: "breakfast",
  servingText: "150",
  eatenAt: SAME_MINUTE,
  timeTouched: false,
  ...over,
});

const keys = (o: object) => Object.keys(o).sort();

describe("buildEditPatch — PL-037: only what changed", () => {
  it("slot only → exactly { meal_type }", () => {
    const patch = buildEditPatch(original, untouched({ mealType: "snacks" }));
    expect(patch).toEqual({ meal_type: "snacks" });
  });

  it("time only (time chip touched) → eaten_at plus the upgraded flag; no macros, no serving_g", () => {
    const patch = buildEditPatch(
      original,
      untouched({ eatenAt: "2026-09-20T09:15:00.000Z", timeTouched: true }),
    );
    expect(keys(patch)).toEqual(["eaten_at", "eaten_at_estimated"]);
    expect(patch.eaten_at).toBe("2026-09-20T09:15:00.000Z");
    expect(patch.eaten_at_estimated).toBe(false);
  });

  it("date only (time chip untouched) → eaten_at alone; the flag is never set on an untouched time", () => {
    const patch = buildEditPatch(
      original,
      untouched({ eatenAt: "2026-09-19T07:30:00.000Z" }),
    );
    expect(keys(patch)).toEqual(["eaten_at"]);
  });

  it("serving only → serving_g and the eight macros; no meal_type, no eaten_at", () => {
    const patch = buildEditPatch(original, untouched({ servingText: "200" }));
    expect(keys(patch)).toEqual([...MACRO_KEYS, "serving_g"].sort());
    expect(patch.serving_g).toBe(200);
    expect(patch.calories).toBeCloseTo(194);
    expect(patch.protein).toBeCloseTo(18);
  });

  it("serving changed on a row whose small four are NULL → they stay NULL, not 0", () => {
    const patch = buildEditPatch(
      { ...original, sat_fat: null, salt: null, fibre: null, sugar: null },
      untouched({ servingText: "200" }),
    );
    expect(patch.sat_fat).toBeNull();
    expect(patch.salt).toBeNull();
    expect(patch.fibre).toBeNull();
    expect(patch.sugar).toBeNull();
  });

  it("nothing changed → {}", () => {
    expect(buildEditPatch(original, untouched())).toEqual({});
  });

  it("slot and serving together → both, and nothing else", () => {
    const patch = buildEditPatch(
      original,
      untouched({ mealType: "lunch", servingText: "100" }),
    );
    expect(keys(patch)).toEqual([...MACRO_KEYS, "meal_type", "serving_g"].sort());
    expect(patch.meal_type).toBe("lunch");
  });

  it("slot only, on a row whose eaten_at has non-zero seconds → no eaten_at key (the time keeps its seconds)", () => {
    // Before PL-037 every edit re-sent eaten_at resolved to the minute, so
    // this row's :42.123 was silently rewritten to :00. Minute precision is
    // the comparison, so an untouched time is equal and is not sent.
    const patch = buildEditPatch(original, untouched({ mealType: "snacks" }));
    expect(keys(patch)).toEqual(["meal_type"]);
  });

  it('"37.50" typed against a stored 37.5 → no serving_g and no macros', () => {
    const patch = buildEditPatch(
      { ...original, serving_g: 37.5 },
      untouched({ servingText: "37.50" }),
    );
    expect(patch).toEqual({});
  });

  it("a serving_g that arrives off the wire as a string still compares by value", () => {
    // PostgREST encodes numeric as a JSON number, so this SHOULD never
    // happen — but a strict !== against "37.5" would be true on every edit
    // and quietly resend the macros each time. Both sides are coerced.
    const wire = { ...original, serving_g: "37.5" as unknown as number };
    expect(buildEditPatch(wire, untouched({ servingText: "37.5" }))).toEqual({});
  });

  it("PL-059: a grams change on a lower-bound batch entry rescales the stored values and never touches the flag", () => {
    // A partial batch, logged at 350 g with salt and fibre as lower bounds,
    // edited to 175 g. The stored (partial) values are scaled, so the
    // rescaled numbers are still lower bounds — the row's flag must survive,
    // which it does only because the patch never names it.
    const patch = buildEditPatch(
      { ...original, serving_g: 350, salt: 0.7, fibre: 7 },
      untouched({ servingText: "175" }),
    );
    expect(patch.salt).toBeCloseTo(0.35);
    expect(patch.fibre).toBeCloseTo(3.5);
    expect(keys(patch)).toEqual([...MACRO_KEYS, "serving_g"].sort());
    expect("incomplete_nutrients" in patch).toBe(false);
  });

  it("PL-059: the return type cannot carry incomplete_nutrients — an edit can neither clear nor forge it", () => {
    const patch = buildEditPatch(original, untouched({ servingText: "200" }));
    // @ts-expect-error — not in MealEntryPatch, by design.
    void patch.incomplete_nutrients;
    expect("incomplete_nutrients" in patch).toBe(false);
  });

  it("the return type cannot carry date or planned", () => {
    const patch = buildEditPatch(original, untouched({ mealType: "dinner" }));
    // @ts-expect-error — `date` is derived from eaten_at by updateEntry, never sent.
    void patch.date;
    // @ts-expect-error — `planned` is the trigger's, never the client's.
    void patch.planned;
    expect("date" in patch).toBe(false);
    expect("planned" in patch).toBe(false);
  });
});

// ─── PL-010: ratio scaling off the stored values ───────────────────────
//
// Device pass 2026-11-18: a chilli entry stored at 713 g, 481 kcal, salt
// 3.02 g. The edit screen previewed 478 / 2.99 without anything being
// touched, and a grams edit to 400 g wrote salt 1.68 (a rate rounded to
// 0.42 × 4) instead of 1.69. Both came from mealEntryToProduct's rounded
// per-100g rate. The fix copies the bundle pattern (compositions.ts,
// "Ratio scaling off the item's stored absolute macros"): unchanged grams
// → the stored values verbatim; otherwise each × (new g / stored g).

const chilli: EditOriginal = {
  meal_type: "dinner",
  serving_g: 713,
  eaten_at: "2026-11-18T18:30:00.000Z",
  eaten_at_estimated: false,
  calories: 481,
  protein: 38.4,
  carbs: 52.1,
  fat: 14.7,
  sat_fat: 5.3,
  salt: 3.02,
  fibre: 15.6,
  sugar: 11.2,
};

describe("PL-010: the device-pass chilli", () => {
  it("an unchanged entry previews exactly its stored values: 481 kcal, 3.02 g salt", () => {
    expect(editPreviewTotals(chilli, 713)).toEqual({
      calories: 481,
      protein: 38.4,
      carbs: 52.1,
      fat: 14.7,
      satFat: 5.3,
      salt: 3.02,
      fibre: 15.6,
      sugar: 11.2,
    });
  });

  it("a grams edit to 400 g writes salt 3.02 × 400/713 = 1.6942…, which displays as 1.69, not 1.68", () => {
    const patch = buildEditPatch(
      chilli,
      untouched({ mealType: "dinner", servingText: "400", eatenAt: chilli.eaten_at }),
    );
    expect(patch.serving_g).toBe(400);
    expect(patch.salt).toBe(3.02 * (400 / 713));
    expect(patch.salt).toBeCloseTo(1.6942, 4);
    expect(roundSalt(patch.salt!)).toBe(1.69);
    expect(patch.calories).toBe(481 * (400 / 713));
    // The preview at 400 g shows what will be written.
    expect(editPreviewTotals(chilli, 400)!.salt).toBe(1.69);
    expect(editPreviewTotals(chilli, 400)!.calories).toBe(270);
  });
});

describe("scaleStoredMacros", () => {
  it("unchanged grams → the eight stored values verbatim, NULLs included", () => {
    const row = { ...chilli, fibre: null, sugar: 0 };
    expect(scaleStoredMacros(row, 713)).toEqual({
      calories: 481,
      protein: 38.4,
      carbs: 52.1,
      fat: 14.7,
      sat_fat: 5.3,
      salt: 3.02,
      fibre: null,
      sugar: 0,
    });
    // A serving_g that arrives off the wire as a string is still "unchanged".
    expect(scaleStoredMacros({ ...row, serving_g: "713" as unknown as number }, 713)!.salt).toBe(3.02);
  });

  it("changed grams → each stored value × (new g / stored g); NULL stays NULL", () => {
    const s = scaleStoredMacros({ ...chilli, fibre: null }, 356.5)!;
    expect(s.calories).toBe(481 * (356.5 / 713));
    expect(s.salt).toBe(3.02 * (356.5 / 713));
    expect(s.fibre).toBeNull();
  });

  it("a stored serving_g that is NULL or 0 can't be scaled → null (TodayScreen never opens these for edit)", () => {
    expect(scaleStoredMacros({ ...chilli, serving_g: null }, 400)).toBeNull();
    expect(scaleStoredMacros({ ...chilli, serving_g: 0 }, 400)).toBeNull();
    expect(editPreviewTotals({ ...chilli, serving_g: null }, 400)).toBeNull();
    // buildEditPatch then sends no serving and no macros, rather than inventing them.
    const patch = buildEditPatch(
      { ...chilli, serving_g: null },
      untouched({ mealType: "dinner", servingText: "400", eatenAt: chilli.eaten_at }),
    );
    expect(patch).toEqual({});
  });

  it("any untouched entry previews at its own display rounding, for 20 000 random rows", () => {
    // The old path (rate rounded, then × g/100) missed this on most rows;
    // even an UNROUNDED rate misses it on ~1 in 25 (2.45 → 2.4499…). The
    // verbatim short-circuit is what makes it exact.
    let seed = 10;
    const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 20000; i++) {
      const g = Math.round(r() * 1500 * 10) / 10 + 1;
      const v = (max: number, dp: number) => +(r() * max).toFixed(dp);
      const row: EditOriginal = {
        ...chilli,
        serving_g: g,
        calories: v(2000, 0),
        protein: v(150, 1),
        carbs: v(300, 1),
        fat: v(120, 1),
        sat_fat: v(40, 1),
        salt: v(8, 2),
        fibre: v(40, 1),
        sugar: v(90, 1),
      };
      const p = editPreviewTotals(row, g)!;
      expect(p.calories).toBe(Math.round(row.calories));
      expect(p.protein).toBe(+row.protein.toFixed(1));
      expect(p.salt).toBe(roundSalt(row.salt!));
      expect(p.fibre).toBe(+row.fibre!.toFixed(1));
    }
  });
});
