import { describe, it, expect } from "vitest";
import { rankResults, singularise, parseProduct } from "../openfoodfacts";
import { FoodProduct } from "../../types";

function makeProduct(overrides: Partial<FoodProduct> = {}): FoodProduct {
  return {
    name: "Product",
    brand: "",
    cal_per100: 100,
    protein_per100: 5,
    carbs_per100: 10,
    fat_per100: 2,
    ...overrides,
  };
}

describe("rankResults", () => {
  it("ranks an exact name match above a prefix match, which beats a whole-word match", () => {
    const wholeWord = makeProduct({ name: "Organic apple rings" });
    const prefix = makeProduct({ name: "Apple juice" });
    const exact = makeProduct({ name: "Apple" });

    const ranked = rankResults([wholeWord, prefix, exact], "apples");

    expect(ranked.map((p) => p.name)).toEqual([
      "Apple",
      "Apple juice",
      "Organic apple rings",
    ]);
  });

  it("does not let a substring match stand in for a whole-word match ('grape' must not match 'grapefruit')", () => {
    const grapefruit = makeProduct({ name: "Grapefruit" });
    const grapeJuice = makeProduct({ name: "Grape juice" });

    const ranked = rankResults([grapefruit, grapeJuice], "grape");

    // Grape juice: whole-word match. Grapefruit: only an all-words-present-ish
    // fallback at best, and never the whole-word tier — it must rank lower.
    expect(ranked[0].name).toBe("Grape juice");
  });

  it("matches 'chicken breast' against 'breast of chicken' via all-words-present", () => {
    const ranked = rankResults(
      [makeProduct({ name: "Breast of chicken" })],
      "chicken breast",
    );
    expect(ranked).toHaveLength(1);
  });

  it("prefers the unbranded whole food over a branded product with a similar name, for a generic query", () => {
    const branded = makeProduct({ name: "Apple", brand: "Big Snack Co" });
    const unbranded = makeProduct({ name: "Apple", brand: "" });

    const ranked = rankResults([branded, unbranded], "apple");

    // Both are exact-name matches; the unbranded bonus must break the tie.
    expect(ranked[0].brand).toBe("");
  });

  it("does NOT apply the unbranded bonus against a branded product when the query IS the brand", () => {
    // Searching "weetabix" should not be punished for matching the brand.
    const weetabix = makeProduct({ name: "Weetabix", brand: "Weetabix" });
    const genericCereal = makeProduct({ name: "Weetabix style cereal", brand: "" });

    const ranked = rankResults([weetabix, genericCereal], "weetabix");

    // The exact match tier alone (1000 vs 500) should already win, and the
    // brand-query guard means it isn't fighting a branded penalty on top.
    expect(ranked[0].name).toBe("Weetabix");
  });

  it("gives a brevity bonus so a short name beats a long descriptive one at the same match tier", () => {
    // Both are prefix matches (tier 2, +500) — the query is not their exact
    // name, and neither the unbranded nor popularity bonuses differ between
    // them, so only word count should decide the order.
    const short = makeProduct({ name: "Apple juice fresh", brand: "" });
    const long = makeProduct({
      name: "Apple juice from concentrate with added vitamin C and no sugar",
      brand: "",
    });

    const ranked = rankResults([long, short], "apple juice");
    expect(ranked[0].name).toBe("Apple juice fresh");
  });

  it("uses popularity only as a tiebreaker — it cannot lift a worse match tier above a better one", () => {
    const megaPopularButWorse = makeProduct({
      name: "Apple flavoured cereal bar",
      unique_scans_n: 1_000_000,
    });
    const realApple = makeProduct({ name: "Apple", unique_scans_n: 0 });

    const ranked = rankResults([megaPopularButWorse, realApple], "apple");
    expect(ranked[0].name).toBe("Apple");
  });

  it("penalises products with no nutrition data at all", () => {
    const empty = makeProduct({
      name: "Apple",
      cal_per100: 0,
      protein_per100: 0,
      carbs_per100: 0,
    });
    const withData = makeProduct({ name: "Apple", cal_per100: 52 });

    const ranked = rankResults([empty, withData], "apple");
    expect(ranked[0].cal_per100).toBe(52);
  });

  it("does not mutate the input array", () => {
    const products = [makeProduct({ name: "Banana" }), makeProduct({ name: "Apple" })];
    const original = [...products];
    rankResults(products, "apple");
    expect(products).toEqual(original);
  });
});

describe("parseProduct — NULL vs zero (Phase 0/1: absent nutriments must not become fake zeros)", () => {
  // Raw nutriments for barcode 5060853641220 ("Fibre & Protein Bar", Bio &
  // me), captured live from the OFF API. This is the exact product from the
  // zero-data bug report: energy/protein/carbs/fat are GENUINELY 0 in OFF's
  // own data (a bad crowd-sourced entry — OFF even flags it with its own "~"
  // approximate modifier), while saturated-fat/salt/fibre/sugar/sodium keys
  // are ENTIRELY ABSENT. Both facts are real and must be preserved exactly:
  // the adapter should not invent zeros for the second group.
  const zeroDataProduct = {
    product_name: "Fibre & Protein Bar",
    brands: "Bio & me",
    code: "5060853641220",
    nutriments: {
      carbohydrates: 0,
      carbohydrates_100g: 0,
      "energy-kcal": 0,
      "energy-kcal_100g": 0,
      energy: 0,
      energy_100g: 0,
      fat: 0,
      fat_100g: 0,
      proteins: 0,
      proteins_100g: 0,
      // NOTE: no saturated-fat_100g, salt_100g, sodium_100g, fiber_100g,
      // fibre_100g, or sugars_100g keys — this is the real OFF payload shape.
    },
  };

  it("passes through a genuine OFF zero for energy/protein/carbs/fat unchanged (not a coercion bug — OFF's own data)", () => {
    const product = parseProduct(zeroDataProduct);
    expect(product).not.toBeNull();
    expect(product!.cal_per100).toBe(0);
    expect(product!.protein_per100).toBe(0);
    expect(product!.carbs_per100).toBe(0);
    expect(product!.fat_per100).toBe(0);
  });

  it("preserves NULL (undefined) for sat-fat/salt/fibre/sugar when their OFF keys are entirely absent", () => {
    const product = parseProduct(zeroDataProduct);
    expect(product).not.toBeNull();
    expect(product!.sat_fat_per100).toBeUndefined();
    expect(product!.salt_per100).toBeUndefined();
    expect(product!.fibre_per100).toBeUndefined();
    expect(product!.sugar_per100).toBeUndefined();
  });

  it("still reports a genuine OFF-supplied 0 for a small-four nutrient as 0, not undefined", () => {
    const product = parseProduct({
      product_name: "Test product",
      nutriments: {
        "energy-kcal_100g": 100,
        proteins_100g: 5,
        carbohydrates_100g: 10,
        fat_100g: 2,
        "saturated-fat_100g": 0,
        salt_100g: 0,
        fiber_100g: 0,
        sugars_100g: 0,
      },
    });
    expect(product!.sat_fat_per100).toBe(0);
    expect(product!.salt_per100).toBe(0);
    expect(product!.fibre_per100).toBe(0);
    expect(product!.sugar_per100).toBe(0);
  });

  it("derives salt from sodium × 2.5 when only sodium is present", () => {
    const product = parseProduct({
      product_name: "Test product",
      nutriments: {
        "energy-kcal_100g": 100,
        proteins_100g: 5,
        carbohydrates_100g: 10,
        fat_100g: 2,
        sodium_100g: 0.208,
      },
    });
    expect(product!.salt_per100).toBeCloseTo(0.52, 2);
  });

  it("leaves salt as undefined (not NaN, not 0) when neither salt nor sodium keys are present", () => {
    const product = parseProduct({
      product_name: "Test product",
      nutriments: {
        "energy-kcal_100g": 100,
        proteins_100g: 5,
        carbohydrates_100g: 10,
        fat_100g: 2,
      },
    });
    expect(product!.salt_per100).toBeUndefined();
  });

  it("prefers an explicit salt_100g over deriving from sodium", () => {
    const product = parseProduct({
      product_name: "Test product",
      nutriments: {
        "energy-kcal_100g": 100,
        proteins_100g: 5,
        carbohydrates_100g: 10,
        fat_100g: 2,
        salt_100g: 1.1,
        sodium_100g: 0.1, // would derive to 0.25 — must be ignored
      },
    });
    expect(product!.salt_per100).toBe(1.1);
  });
});

describe("singularise (used to normalise ranking queries)", () => {
  it("singularises regular plurals", () => {
    expect(singularise("apples")).toBe("apple");
    expect(singularise("berries")).toBe("berry");
    expect(singularise("tomatoes")).toBe("tomato");
    expect(singularise("sandwiches")).toBe("sandwich");
  });

  it("leaves words on the exception list alone", () => {
    expect(singularise("hummus")).toBe("hummus");
    expect(singularise("oats")).toBe("oats");
    expect(singularise("beans")).toBe("beans");
  });

  it("does not mangle short words or words ending in double-s", () => {
    expect(singularise("glass")).toBe("glass");
    expect(singularise("gas")).toBe("gas");
  });
});
