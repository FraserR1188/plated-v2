import { describe, it, expect, vi } from "vitest";
import {
  estimateGrams,
  normalizeIngredientName,
  resolveIngredient,
  type StapleRow,
  type ResolveDeps,
} from "../ingredients";
import type { FoodProduct } from "../../types";

function staple(overrides: Partial<StapleRow> = {}): StapleRow {
  return {
    slug: "plain-flour",
    display_name: "Plain flour",
    aliases: ["all-purpose flour"],
    kcal_100g: 341,
    protein_100g: 9.4,
    carbs_100g: 77.7,
    fat_100g: 1.3,
    satfat_100g: 0.2,
    sugar_100g: 1.5,
    fibre_100g: 3.1,
    salt_100g: 0.005,
    unit_grams: { tbsp: 8, tsp: 2.6, cup: 120 },
    density_g_per_ml: 0.53,
    ...overrides,
  };
}

function offProduct(name: string, overrides: Partial<FoodProduct> = {}): FoodProduct {
  return {
    name,
    brand: "",
    cal_per100: 100,
    protein_per100: 5,
    carbs_per100: 10,
    fat_per100: 2,
    ...overrides,
  };
}

// ─── estimateGrams ───────────────────────────────────────────

describe("estimateGrams", () => {
  it("200 g flour -> 200g, exact (true mass unit)", () => {
    expect(estimateGrams(200, "g", staple())).toEqual({ grams: 200, confidence: "exact" });
  });

  it("kg/oz/lb are also exact", () => {
    expect(estimateGrams(1, "kg", null).confidence).toBe("exact");
    expect(estimateGrams(1, "oz", null).confidence).toBe("exact");
    expect(estimateGrams(1, "lb", null).confidence).toBe("exact");
  });

  it("2 large eggs -> unit_grams hit, ESTIMATED not exact (override from the brief default)", () => {
    const egg = staple({ unit_grams: { small: 42, medium: 50, large: 58 } });
    const { grams, confidence } = estimateGrams(2, "large", egg);
    expect(grams).toBe(116);
    expect(confidence).toBe("estimated");
  });

  it("1 tbsp olive oil -> density-derived volume, estimated", () => {
    const oil = staple({ unit_grams: {}, density_g_per_ml: 0.91 });
    const { grams, confidence } = estimateGrams(1, "tbsp", oil);
    expect(grams).toBeCloseTo(13.65, 2);
    expect(confidence).toBe("estimated");
  });

  it("a pinch of salt -> null grams, unknown (no unit_grams entry, no density)", () => {
    const salt = staple({ unit_grams: { tsp: 6, tbsp: 18 }, density_g_per_ml: null });
    expect(estimateGrams(1, "pinch", salt)).toEqual({ grams: null, confidence: "unknown" });
  });

  it("missing quantity -> null grams, unknown, regardless of unit", () => {
    expect(estimateGrams(undefined, "g", staple())).toEqual({ grams: null, confidence: "unknown" });
  });

  it("unit_grams hit takes priority over a mass unit only when the mass map doesn't already match", () => {
    // sanity: "g" always resolves via MASS_G even if a staple somehow had unit_grams.g
    const weird = staple({ unit_grams: { g: 999 } });
    expect(estimateGrams(5, "g", weird)).toEqual({ grams: 5, confidence: "exact" });
  });
});

// ─── normalizeIngredientName ─────────────────────────────────

describe("normalizeIngredientName", () => {
  it("strips prep/size qualifiers but keeps identity-bearing words", () => {
    expect(normalizeIngredientName("2 large chopped fresh onions")).toBe("onion");
    expect(normalizeIngredientName("Plain flour")).toBe("plain flour");
    expect(normalizeIngredientName("Self-raising flour")).toBe("self-raising flour");
  });

  it("does not strip words that change the food's identity", () => {
    // 'plain' and 'raw' must survive — different macros, different foods.
    expect(normalizeIngredientName("plain yogurt")).toContain("plain");
    expect(normalizeIngredientName("raw chicken breast")).toContain("raw");
  });

  it("singularises plural tokens", () => {
    expect(normalizeIngredientName("tomatoes")).toBe("tomato");
  });
});

// ─── resolveIngredient tiers ─────────────────────────────────

function makeDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    lookupStaple: vi.fn(async () => null),
    offSearch: vi.fn(async () => [] as FoodProduct[]),
    ...overrides,
  };
}

describe("resolveIngredient", () => {
  it("Tier 1 — branded line goes straight to OFF, never touches the staple table", async () => {
    const lookupStaple = vi.fn(async () => staple());
    const offSearch = vi.fn(async () => [offProduct("Heinz Baked Beans"), offProduct("Heinz Beanz")]);
    const deps = makeDeps({ lookupStaple, offSearch });

    const candidates = await resolveIngredient(
      { name: "Heinz baked beans", brandPresent: true },
      deps,
    );

    expect(lookupStaple).not.toHaveBeenCalled();
    expect(candidates[0].source).toBe("off-branded");
    expect(candidates[0].preselected).toBe(true);
    expect(candidates.filter((c) => c.preselected)).toHaveLength(1);
  });

  it("Tier 2 — no brand, staple hit: staple preselected primary, OFF results as non-preselected secondaries", async () => {
    const deps = makeDeps({
      lookupStaple: vi.fn(async () => staple()),
      offSearch: vi.fn(async () => [offProduct("Generic Flour"), offProduct("Brand Flour")]),
    });

    const candidates = await resolveIngredient(
      { name: "plain flour", quantity: 200, unit: "g", brandPresent: false },
      deps,
    );

    expect(candidates[0].source).toBe("staple");
    expect(candidates[0].preselected).toBe(true);
    expect(candidates[0].estimatedGrams).toBe(200);
    expect(candidates[0].gramsConfidence).toBe("exact");
    expect(candidates.slice(1).every((c) => !c.preselected)).toBe(true);
    expect(candidates.filter((c) => c.preselected)).toHaveLength(1);
  });

  it("Tier 3 — no brand, staple miss: OFF generic fallback preselected", async () => {
    const deps = makeDeps({
      lookupStaple: vi.fn(async () => null),
      offSearch: vi.fn(async () => [offProduct("Obscure Ingredient")]),
    });

    const candidates = await resolveIngredient(
      { name: "some obscure ingredient", brandPresent: false },
      deps,
    );

    expect(candidates[0].source).toBe("off-generic");
    expect(candidates[0].preselected).toBe(true);
    expect(candidates.filter((c) => c.preselected)).toHaveLength(1);
  });

  it("a staple missing a required macro (kcal/protein/carbs/fat) is skipped, not coalesced to 0", async () => {
    const incomplete = staple({ protein_100g: null });
    const deps = makeDeps({
      lookupStaple: vi.fn(async () => incomplete),
      offSearch: vi.fn(async () => [offProduct("Fallback Flour")]),
    });

    const candidates = await resolveIngredient(
      { name: "plain flour", brandPresent: false },
      deps,
    );

    // Falls through to the OFF tier instead of offering a lying candidate.
    expect(candidates[0].source).toBe("off-generic");
  });

  it("never auto-commits — returns candidates only, no writes, nothing thrown for an empty result", async () => {
    const deps = makeDeps(); // lookupStaple -> null, offSearch -> []
    const candidates = await resolveIngredient({ name: "nothing matches this", brandPresent: false }, deps);
    expect(candidates).toEqual([]);
  });

  it("a failed OFF secondary search does not cost the user an already-found staple hit", async () => {
    const deps = makeDeps({
      lookupStaple: vi.fn(async () => staple()),
      offSearch: vi.fn(async () => {
        throw new Error("network down");
      }),
    });

    const candidates = await resolveIngredient({ name: "plain flour", brandPresent: false }, deps);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("staple");
    expect(candidates[0].preselected).toBe(true);
  });
});
