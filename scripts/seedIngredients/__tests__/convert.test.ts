import { describe, it, expect } from "vitest";
import { toSaltG, coalesceMacros, EMPTY_MACRO100 } from "../convert";

describe("toSaltG", () => {
  it("converts sodium mg to salt g at the UK 2.5 factor", () => {
    expect(toSaltG(500)).toBeCloseTo(1.25, 5);
  });

  it("keeps a genuine zero as zero, not null", () => {
    expect(toSaltG(0)).toBe(0);
  });

  it("returns null for missing sodium — never defaults to 0", () => {
    expect(toSaltG(null)).toBeNull();
    expect(toSaltG(undefined)).toBeNull();
  });

  it("returns null for a non-finite input rather than NaN", () => {
    expect(toSaltG(NaN)).toBeNull();
  });
});

describe("coalesceMacros", () => {
  it("merges per-field: primary wins, secondary fills only primary's nulls", () => {
    const primary = { ...EMPTY_MACRO100, protein_100g: 10, fibre_100g: null };
    const secondary = { ...EMPTY_MACRO100, protein_100g: 999, fibre_100g: 3, kcal_100g: 200 };

    const out = coalesceMacros(primary, secondary);

    expect(out.protein_100g).toBe(10); // primary wins, not overwritten
    expect(out.fibre_100g).toBe(3); // secondary fills primary's null
    expect(out.kcal_100g).toBe(200); // secondary fills a field primary never had
  });

  it("a genuine 0 in primary is not treated as missing", () => {
    const primary = { ...EMPTY_MACRO100, sugar_100g: 0 };
    const secondary = { ...EMPTY_MACRO100, sugar_100g: 50 };
    expect(coalesceMacros(primary, secondary).sugar_100g).toBe(0);
  });

  it("stays null when neither source has a field", () => {
    const out = coalesceMacros({}, {});
    expect(out.salt_100g).toBeNull();
  });
});
