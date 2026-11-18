// ============================================================
// src/lib/__tests__/productScreenTiles.test.ts — PL-059 follow-up
//
// Device pass 2026-11-18: editing a chilli entry with incomplete_nutrients
// {salt,fibre} showed "≥ 2.99" / "≥ 25" in the Nutrition preview but a plain
// "0.42 g" / "3.5 g" on the Per 100g tiles above it. A per-100g rate rebuilt
// from a lower bound is a lower bound too.
//
// ProductScreen can't be imported under vitest (theme tokens pull in React
// Navigation), so the rule lives in a pure function, tested here, and a
// source check pins the tile to that function — the same pattern as
// components/__tests__/trendsUi.test.ts.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { per100TileText } from "../incompleteNutrients";

describe("per100TileText", () => {
  it("prefixes ≥ on a flagged small-four rate", () => {
    expect(per100TileText(0.42, ["salt", "fibre"], "salt")).toBe("≥ 0.42");
    expect(per100TileText(3.5, ["salt", "fibre"], "fibre")).toBe("≥ 3.5");
  });

  it("leaves an unflagged small-four rate plain", () => {
    expect(per100TileText(1.2, ["salt", "fibre"], "sat_fat")).toBe("1.2");
    expect(per100TileText(1.2, null, "sat_fat")).toBe("1.2");
    expect(per100TileText(1.2, undefined, "sugar")).toBe("1.2");
  });

  it("never prefixes a big-four tile, which has no small-four column", () => {
    expect(per100TileText(175, ["salt", "fibre"], undefined)).toBe("175");
  });
});

describe("ProductScreen's Per 100g tiles use per100TileText", () => {
  const src = fs
    .readFileSync(path.resolve(process.cwd(), "src/screens/ProductScreen.tsx"), "utf8")
    .replace(/\r\n/g, "\n");

  it("the read-only tile value is rendered through per100TileText with the draft's flag", () => {
    const grid = src.slice(src.indexOf("Per 100g</Text>"), src.indexOf("Serving size card"));
    expect(grid.length).toBeGreaterThan(0);
    expect(grid).toMatch(
      /per100TileText\(\s*m\.get\(draft\),\s*draft\.incomplete_nutrients,\s*m\.column\s*\)/,
    );
  });

  it("each small-four MACRO_META entry names its incomplete_nutrients column", () => {
    for (const [key, column] of [
      ["satFat", "sat_fat"],
      ["salt", "salt"],
      ["fibre", "fibre"],
      ["sugar", "sugar"],
    ]) {
      expect(src, `${key} → ${column}`).toMatch(
        new RegExp(`key: "${key}",[\\s\\S]*?column: "${column}",[\\s\\S]*?\\n  \\}`),
      );
    }
  });
});
