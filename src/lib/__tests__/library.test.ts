import { describe, it, expect } from "vitest";
import { filterSavedIngredients } from "../library";
import type { SavedIngredientScored } from "../../types";

function makeItem(
  overrides: Partial<SavedIngredientScored> = {},
): SavedIngredientScored {
  return {
    id: "id-1",
    user_id: "u1",
    name: "Porridge",
    brand: null,
    cal_per100: 175,
    protein_per100: 5,
    carbs_per100: 24,
    fat_per100: 3.2,
    sat_fat_per100: 0.8,
    salt_per100: 0.1,
    fibre_per100: 2.4,
    sugar_per100: 1.6,
    barcode: null,
    off_id: null,
    use_count: 1,
    created_at: "2026-07-20T12:00:00.000Z",
    decay_score: 1,
    last_used_at: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("filterSavedIngredients", () => {
  const items = [
    makeItem({ id: "1", name: "Smooth Peanut Butter", brand: "Pip & Nut" }),
    makeItem({ id: "2", name: "Peanut Butter", brand: "Sainsbury's" }),
    makeItem({ id: "3", name: "Porridge Oats", brand: null }),
  ];

  it("empty query returns every item, unchanged order", () => {
    expect(filterSavedIngredients(items, "")).toEqual(items);
    expect(filterSavedIngredients(items, "   ")).toEqual(items);
  });

  it("matches on name, case-insensitively", () => {
    const result = filterSavedIngredients(items, "PEANUT");
    expect(result.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("matches on brand, case-insensitively", () => {
    const result = filterSavedIngredients(items, "pip");
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });

  it("a null brand never matches and never throws", () => {
    const result = filterSavedIngredients(items, "sainsbury");
    expect(result.map((i) => i.id)).toEqual(["2"]);
  });

  it("no match anywhere → empty array, not an error", () => {
    expect(filterSavedIngredients(items, "xyz-nonexistent")).toEqual([]);
  });

  it("matches a substring in the middle of a word, not just a prefix", () => {
    const result = filterSavedIngredients(items, "oats");
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });
});
