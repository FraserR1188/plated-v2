// ============================================================
// src/lib/__tests__/compositions.test.ts
//
// draftsFromComposition/draftsFromBatch are pure (no Supabase calls) — they
// just resolve a composition's items onto a target day/time. This file
// covers:
//   - meal_type defaulting: each item's/batch's section must come from the
//     resolved eaten_at, never inherited from a saved meal_type. See
//     lib/time.ts's sectionForTime.
//   - the batch per-portion macro derivation and the null-poisons-total rule.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  draftsFromComposition,
  draftsFromBatch,
  previewComposition,
  bundlesOnly,
} from "../compositions";
import {
  MealComposition,
  MealCompositionItem,
  MealCompositionWithItems,
  MealType,
} from "../../types";

function makeItem(
  overrides: Partial<MealCompositionItem> & {
    id: string;
    eaten_time: string;
    meal_type: MealType;
  },
): MealCompositionItem {
  return {
    composition_id: "comp-1",
    user_id: "user-1",
    position: 0,
    name: "Test food",
    brand: null,
    serving_g: 100,
    calories: 200,
    protein: 10,
    carbs: 20,
    fat: 5,
    sat_fat: 1,
    salt: 0.5,
    fibre: 2,
    sugar: 3,
    barcode: null,
    off_id: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    ...overrides,
  };
}

/** A batch ingredient: meal_type/eaten_time NULL, per the DB trigger. */
function makeBatchIngredient(
  overrides: Partial<MealCompositionItem> & { id: string },
): MealCompositionItem {
  return {
    composition_id: "comp-1",
    user_id: "user-1",
    position: 0,
    name: "Test ingredient",
    brand: null,
    serving_g: 100,
    calories: 200,
    protein: 10,
    carbs: 20,
    fat: 5,
    sat_fat: 1,
    salt: 0.5,
    fibre: 2,
    sugar: 3,
    meal_type: null,
    eaten_time: null,
    barcode: null,
    off_id: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    ...overrides,
  };
}

function makeComposition(
  items: MealCompositionItem[],
  overrides: Partial<MealComposition> = {},
): MealCompositionWithItems {
  return {
    id: "comp-1",
    user_id: "user-1",
    name: "Test bundle",
    use_count: 0,
    last_used_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    kind: "bundle",
    yield_g: null,
    portion_g: null,
    portion_label: null,
    ...overrides,
    items,
  };
}

describe("draftsFromComposition — section derived from the resolved time", () => {
  it("derives breakfast/lunch/dinner from each item's own saved time, NOT the saved meal_type", () => {
    // The reported bug: a bundle whose items were all saved under one
    // section (breakfast, here) must NOT apply as all-breakfast — each
    // item's section comes from ITS OWN time.
    const composition = makeComposition([
      makeItem({ id: "1", position: 0, eaten_time: "08:00", meal_type: "breakfast" }),
      makeItem({ id: "2", position: 1, eaten_time: "14:00", meal_type: "breakfast" }),
      makeItem({ id: "3", position: 2, eaten_time: "18:00", meal_type: "breakfast" }),
    ]);

    const drafts = draftsFromComposition(composition, "2026-07-27");

    expect(drafts.map((d) => d.meal_type)).toEqual(["breakfast", "lunch", "dinner"]);
  });

  it("re-derives the section from the ANCHOR-SHIFTED time, not the saved time or saved meal_type", () => {
    // Saved 08:00/08:05/08:20, all saved as "breakfast". Anchored at 17:30 —
    // every item shifts into the evening and must land in Dinner, regardless
    // of what was saved either for the time or the section.
    const composition = makeComposition([
      makeItem({ id: "1", position: 0, eaten_time: "08:00", meal_type: "breakfast" }),
      makeItem({ id: "2", position: 1, eaten_time: "08:05", meal_type: "breakfast" }),
      makeItem({ id: "3", position: 2, eaten_time: "08:20", meal_type: "breakfast" }),
    ]);

    const drafts = draftsFromComposition(composition, "2026-07-27", {
      hours: 17,
      minutes: 30,
    });

    expect(drafts.map((d) => d.meal_type)).toEqual(["dinner", "dinner", "dinner"]);

    const d = new Date(drafts[0].eaten_at);
    expect(d.getHours()).toBe(17);
    expect(d.getMinutes()).toBe(30);
  });

  it("a saved meal_type of snacks does not survive apply — snacks is manual-only, and apply never chooses it", () => {
    // Not a realistic bundle (bundles aren't built with a "snacks" workflow
    // today), but proves sectionForTime's "never snacks" rule holds even
    // when the stored item claims otherwise.
    const composition = makeComposition([
      makeItem({ id: "1", position: 0, eaten_time: "15:00", meal_type: "snacks" }),
    ]);

    const drafts = draftsFromComposition(composition, "2026-07-27");

    expect(drafts[0].meal_type).toBe("lunch"); // 15:00 falls in the lunch window
  });
});

describe("draftsFromBatch", () => {
  it("scales the summed ingredients by portion_g / yield_g, rounded once", () => {
    // Ingredients: 200+300 = 500 kcal, 10+20 = 30g protein, 20+10 = 30g
    // carbs, 5+15 = 20g fat, 2+4 = 6g sat_fat, 0.4+0.6 = 1.0g salt,
    // 3+5 = 8g fibre, 1+2 = 3g sugar. yield_g=500, portion_g=100 → scale=0.2.
    const composition = makeComposition(
      [
        makeBatchIngredient({
          id: "1",
          calories: 200,
          protein: 10,
          carbs: 20,
          fat: 5,
          sat_fat: 2,
          salt: 0.4,
          fibre: 3,
          sugar: 1,
        }),
        makeBatchIngredient({
          id: "2",
          calories: 300,
          protein: 20,
          carbs: 10,
          fat: 15,
          sat_fat: 4,
          salt: 0.6,
          fibre: 5,
          sugar: 2,
        }),
      ],
      { kind: "batch", yield_g: 500, portion_g: 100 },
    );

    const draft = draftsFromBatch(
      composition,
      { date: "2026-07-27" },
      new Date(2026, 6, 27, 8, 0),
    );

    expect(draft.calories).toBe(100); // 500 * 0.2
    expect(draft.protein).toBe(6);
    expect(draft.carbs).toBe(6);
    expect(draft.fat).toBe(4);
    expect(draft.sat_fat).toBe(1.2);
    expect(draft.salt).toBe(0.2);
    expect(draft.fibre).toBe(1.6);
    expect(draft.sugar).toBe(0.6);
    expect(draft.serving_g).toBe(100); // portion_g
  });

  it("sums a real 0 normally but poisons on null — they look alike, behave oppositely", () => {
    // scale = 1 (yield_g === portion_g) so the totals ARE the draft values —
    // no rounding arithmetic to second-guess while checking this rule.
    const composition = makeComposition(
      [
        makeBatchIngredient({
          id: "1",
          fibre: 3, // real value
          sugar: 0, // REAL ZERO — must sum normally, must NOT poison
        }),
        makeBatchIngredient({
          id: "2",
          fibre: null, // UNKNOWN — must poison the batch total
          sugar: 5,
        }),
      ],
      { kind: "batch", yield_g: 100, portion_g: 100 },
    );

    const draft = draftsFromBatch(
      composition,
      { date: "2026-07-27" },
      new Date(2026, 6, 27, 8, 0),
    );

    expect(draft.sugar).toBe(5); // 0 + 5 = 5 — the 0 summed, it didn't poison
    expect(draft.fibre).toBeNull(); // one null among the ingredients poisons the total
  });

  it("produces exactly one draft, with meal_type derived from THIS apply's own eaten_at — never inherited", () => {
    const composition = makeComposition(
      [makeBatchIngredient({ id: "1" }), makeBatchIngredient({ id: "2" })],
      { kind: "batch", yield_g: 200, portion_g: 100 },
    );

    const draft = draftsFromBatch(
      composition,
      { date: "2026-07-27" },
      new Date(2026, 6, 27, 18, 30), // 18:30 — dinner window
    );

    expect(Array.isArray(draft)).toBe(false); // exactly ONE draft, not an array
    expect(draft.meal_type).toBe("dinner");
    expect(draft.source).toBe("batch");
    expect(draft.eaten_at_estimated).toBe(false); // a fact ("now"), not a forecast

    const d = new Date(draft.eaten_at);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(27);
    expect(d.getHours()).toBe(18);
    expect(d.getMinutes()).toBe(30);
  });

  // ── Picked-time apply (eat-time sheet) ──────────────────────
  //
  // Europe/London-pinned: this app's actual user is UK-based, and 27 Jul is
  // deliberately inside BST (UTC+1) — the exact condition CLAUDE.md's
  // dateKey()/toISOString() warning is about. Pinning here means these
  // wall-clock assertions (getHours/getDate) mean the same thing regardless
  // of which timezone CI or a dev machine happens to run in.
  describe("picked-time apply (Europe/London, BST)", () => {
    const ORIGINAL_TZ = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "Europe/London";
    });
    afterAll(() => {
      process.env.TZ = ORIGINAL_TZ;
    });

    // chosenAt is a 4th, separate param from `now` specifically because
    // `now` has to keep meaning "the real clock" — it's what
    // eaten_at_estimated is judged against. Passing the picked time AS `now`
    // (instead of as chosenAt) would compare the picked time against itself
    // and always read "not planned," even for a batch scheduled hours into
    // the future — the tests below pin exactly that distinction.

    it("a picked instant becomes eaten_at exactly — target.date is ignored when chosenAt is given", () => {
      const composition = makeComposition(
        [makeBatchIngredient({ id: "1" }), makeBatchIngredient({ id: "2" })],
        { kind: "batch", yield_g: 200, portion_g: 100 },
      );

      const chosenAt = new Date(2026, 6, 27, 19, 45); // 27 Jul 2026, 19:45 BST
      // target.date deliberately does NOT match chosenAt's day, to prove
      // chosenAt — not target.date — is what wins.
      const draft = draftsFromBatch(
        composition,
        { date: "2026-01-01" },
        new Date(2026, 6, 27, 10, 0), // real clock: same day, earlier
        chosenAt,
      );

      expect(draft.eaten_at).toBe(chosenAt.toISOString());
    });

    it("a picked time more than 30 minutes ahead of the real clock is planned and stays an estimate", () => {
      const composition = makeComposition(
        [makeBatchIngredient({ id: "1" }), makeBatchIngredient({ id: "2" })],
        { kind: "batch", yield_g: 200, portion_g: 100 },
      );

      const realNow = new Date(2026, 6, 27, 14, 0); // it's actually 14:00 BST
      const chosenAt = new Date(2026, 6, 27, 19, 0); // picked 19:00 — 5h ahead

      const draft = draftsFromBatch(
        composition,
        { date: "2026-07-27" },
        realNow,
        chosenAt,
      );

      expect(draft.eaten_at_estimated).toBe(true); // a forecast, not a fact
      expect(new Date(draft.eaten_at).getHours()).toBe(19);
    });

    it("a picked time in the past (backlogging) is a fact, not an estimate", () => {
      const composition = makeComposition(
        [makeBatchIngredient({ id: "1" }), makeBatchIngredient({ id: "2" })],
        { kind: "batch", yield_g: 200, portion_g: 100 },
      );

      const realNow = new Date(2026, 6, 27, 14, 0); // it's actually 14:00 BST
      const chosenAt = new Date(2026, 6, 27, 12, 30); // picked 12:30 — already happened

      const draft = draftsFromBatch(
        composition,
        { date: "2026-07-27" },
        realNow,
        chosenAt,
      );

      expect(draft.eaten_at_estimated).toBe(false);
    });

    it("midnight-crossing: picking tomorrow 00:30 while it's 23:00 tonight lands on tomorrow, planned", () => {
      const composition = makeComposition(
        [makeBatchIngredient({ id: "1" }), makeBatchIngredient({ id: "2" })],
        { kind: "batch", yield_g: 200, portion_g: 100 },
      );

      const realNow = new Date(2026, 6, 27, 23, 0); // 23:00 BST on the 27th
      const chosenAt = new Date(2026, 6, 28, 0, 30); // 00:30 BST on the 28th

      const draft = draftsFromBatch(
        composition,
        { date: "2026-07-27" }, // target.date doesn't matter — chosenAt wins
        realNow,
        chosenAt,
      );

      const d = new Date(draft.eaten_at);
      expect(d.getDate()).toBe(28);
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(30);
      expect(draft.eaten_at_estimated).toBe(true); // 90 minutes out — planned
    });
  });

  it("throws if the composition isn't kind='batch' — refuses rather than silently misreading a bundle", () => {
    const composition = makeComposition(
      [makeItem({ id: "1", eaten_time: "08:00", meal_type: "breakfast" })],
      { kind: "bundle" },
    );

    expect(() => draftsFromBatch(composition, { date: "2026-07-27" })).toThrow();
  });

  it("throws if yield_g/portion_g are missing — unreachable past the DB CHECK, guarded anyway", () => {
    const composition = makeComposition([], {
      kind: "batch",
      yield_g: null,
      portion_g: null,
    });

    expect(() => draftsFromBatch(composition, { date: "2026-07-27" })).toThrow();
  });

  it("throws for a batch with no ingredients", () => {
    const composition = makeComposition([], {
      kind: "batch",
      yield_g: 100,
      portion_g: 50,
    });

    expect(() => draftsFromBatch(composition, { date: "2026-07-27" })).toThrow();
  });
});

// ============================================================
// REGRESSION — crash-on-launch loop, 2026-08-02.
//
// A correctly-saved batch (kind='batch', valid yield_g/portion_g,
// ingredients with correctly-NULL eaten_time) was loaded by TodayScreen's
// Bundles sheet, which rendered ALL compositions regardless of kind.
// previewComposition → bundleItemTime threw on the batch item's NULL
// eaten_time, crashing every launch. The batch data, the CHECK, and the
// trigger were all correct — the bug was purely that the bundle-apply UI
// never filtered by kind. Two fixes, both covered below: bundlesOnly() is
// the actual fix (nothing batch-shaped should ever reach previewComposition
// in the first place); previewComposition degrading instead of throwing is
// the second line of defence, for whatever the next unfiltered call site is.
// ============================================================

describe("bundlesOnly — the actual fix: batches never reach the Bundles sheet", () => {
  it("excludes kind='batch' and keeps kind='bundle'", () => {
    const bundle = makeComposition(
      [makeItem({ id: "1", eaten_time: "08:00", meal_type: "breakfast" })],
      { id: "comp-bundle", kind: "bundle" },
    );
    const batch = makeComposition(
      [makeBatchIngredient({ id: "2" })],
      { id: "comp-batch", kind: "batch", yield_g: 100, portion_g: 50 },
    );

    const result = bundlesOnly([bundle, batch]);

    expect(result).toEqual([bundle]);
    expect(result.some((c) => c.kind === "batch")).toBe(false);
  });

  it("returns an empty list when there are no bundles at all", () => {
    const batch = makeComposition([makeBatchIngredient({ id: "1" })], {
      kind: "batch",
      yield_g: 100,
      portion_g: 50,
    });
    expect(bundlesOnly([batch])).toEqual([]);
  });
});

describe("previewComposition — degrades, never throws (the crash itself)", () => {
  it("returns an empty preview for a batch composition, instead of throwing", () => {
    const batch = makeComposition(
      [makeBatchIngredient({ id: "1" }), makeBatchIngredient({ id: "2" })],
      { kind: "batch", yield_g: 200, portion_g: 100 },
    );

    // This is the exact call that crashed: previewComposition on a batch,
    // whose items correctly have NULL eaten_time.
    expect(() => previewComposition(batch, "2026-07-27")).not.toThrow();
    expect(previewComposition(batch, "2026-07-27")).toEqual([]);
  });

  it("skips a malformed bundle item (NULL eaten_time) rather than throwing on the whole preview", () => {
    const malformed = makeComposition(
      [
        makeItem({ id: "1", eaten_time: "08:00", meal_type: "breakfast" }),
        { ...makeItem({ id: "2", eaten_time: "12:00", meal_type: "lunch" }), eaten_time: null },
      ],
      { kind: "bundle" },
    );

    const preview = previewComposition(malformed, "2026-07-27");

    expect(preview.map((p) => p.item.id)).toEqual(["1"]); // item 2 skipped, not thrown on
  });

  it("still previews a genuine bundle normally — the fix didn't break the working case", () => {
    const bundle = makeComposition([
      makeItem({ id: "1", eaten_time: "08:00", meal_type: "breakfast" }),
      makeItem({ id: "2", eaten_time: "13:00", meal_type: "lunch" }),
    ]);

    const preview = previewComposition(bundle, "2026-07-27");

    expect(preview).toHaveLength(2);
    preview.forEach((p) => {
      const d = new Date(p.eaten_at);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(6);
      expect(d.getDate()).toBe(27);
    });
  });
});
