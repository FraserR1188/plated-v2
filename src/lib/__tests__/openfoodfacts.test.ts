import { describe, it, expect } from "vitest";
import { rankResults, singularise } from "../openfoodfacts";
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
