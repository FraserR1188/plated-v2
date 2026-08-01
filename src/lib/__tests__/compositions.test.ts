// ============================================================
// src/lib/__tests__/compositions.test.ts
//
// draftsFromComposition is pure (no Supabase calls) — it just resolves a
// composition's items onto a target day. This file covers the meal_type
// defaulting added alongside time-based section defaulting: each item's
// section must come from its (possibly anchor-shifted) eaten_at, never from
// the item's saved meal_type. See lib/time.ts's sectionForTime.
// ============================================================

import { describe, it, expect } from "vitest";
import { draftsFromComposition } from "../compositions";
import { MealCompositionItem, MealCompositionWithItems, MealType } from "../../types";

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

function makeComposition(items: MealCompositionItem[]): MealCompositionWithItems {
  return {
    id: "comp-1",
    user_id: "user-1",
    name: "Test bundle",
    use_count: 0,
    last_used_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
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
