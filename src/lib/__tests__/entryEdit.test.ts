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
import { buildEditPatch, type EditOriginal, type EditState } from "../entryEdit";
import type { FoodProduct } from "../../types";

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

const product: FoodProduct = {
  name: "Greek yogurt",
  brand: "",
  cal_per100: 97,
  protein_per100: 9,
  carbs_per100: 3.9,
  fat_per100: 5,
  sat_fat_per100: 3.3,
  salt_per100: 0.1,
  fibre_per100: 0,
  sugar_per100: 3.9,
};

// The loaded row. eaten_at deliberately carries seconds and milliseconds,
// as a row logged at "now" does.
const original: EditOriginal = {
  meal_type: "breakfast",
  serving_g: 150,
  eaten_at: "2026-09-20T07:30:42.123+00:00",
  eaten_at_estimated: true,
};

// What handleSubmit resolves an UNTOUCHED time to: the same minute, seconds zeroed.
const SAME_MINUTE = "2026-09-20T07:30:00.000Z";

const untouched = (over: Partial<EditState> = {}): EditState => ({
  mealType: "breakfast",
  servingText: "150",
  eatenAt: SAME_MINUTE,
  timeTouched: false,
  product,
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
    const nullSmallFour: FoodProduct = {
      ...product,
      sat_fat_per100: undefined,
      salt_per100: undefined,
      fibre_per100: undefined,
      sugar_per100: undefined,
    };
    const patch = buildEditPatch(
      original,
      untouched({ servingText: "200", product: nullSmallFour }),
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
