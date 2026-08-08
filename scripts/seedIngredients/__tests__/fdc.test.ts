import { describe, it, expect } from "vitest";
import { foodToMacros, type FdcFood } from "../fdc";

function food(nutrients: Array<{ id: number; value: number }>): FdcFood {
  return {
    fdcId: 1,
    description: "Test food",
    dataType: "Foundation",
    foodNutrients: nutrients.map((n) => ({ nutrientId: n.id, value: n.value })),
  };
}

describe("foodToMacros", () => {
  it("extracts by nutrient id, not array position", () => {
    const f = food([
      { id: 1093, value: 400 }, // sodium mg, listed first on purpose
      { id: 1008, value: 165 }, // kcal
      { id: 1003, value: 31 }, // protein
    ]);
    const m = foodToMacros(f);
    expect(m.kcal_100g).toBe(165);
    expect(m.protein_100g).toBe(31);
    expect(m.salt_100g).toBeCloseTo(1.0, 5); // 400mg -> 1.0g
  });

  it("accepts either sugars nutrient id (2000 or the legacy 1063)", () => {
    expect(foodToMacros(food([{ id: 2000, value: 5 }])).sugar_100g).toBe(5);
    expect(foodToMacros(food([{ id: 1063, value: 7 }])).sugar_100g).toBe(7);
  });

  it("leaves a field null, not 0, when FDC doesn't report that nutrient", () => {
    const m = foodToMacros(food([{ id: 1008, value: 100 }]));
    expect(m.fibre_100g).toBeNull();
    expect(m.salt_100g).toBeNull();
  });

  it("supports the nested nutrient.id / amount shape as well as the flat one", () => {
    const f: FdcFood = {
      fdcId: 2,
      description: "Nested shape",
      dataType: "SR Legacy",
      foodNutrients: [{ nutrient: { id: 1004 }, amount: 12.5 }],
    };
    expect(foodToMacros(f).fat_100g).toBe(12.5);
  });
});
