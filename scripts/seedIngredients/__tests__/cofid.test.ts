import { describe, it, expect } from "vitest";
import { parseCofidCsv, matchCofid } from "../cofid";
import type { SeedStaple } from "../../seedStaples";

function staple(overrides: Partial<SeedStaple>): SeedStaple {
  return { slug: "x", displayName: "X", aliases: [], ...overrides };
}

describe("parseCofidCsv", () => {
  it("parses macros by header name and derives salt from sodium", () => {
    const csv =
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
      "12-345,\"Flour, white, plain\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n";

    const rows = parseCofidCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].foodCode).toBe("12-345");
    expect(rows[0].foodName).toBe("Flour, white, plain");
    expect(rows[0].macros.kcal_100g).toBe(341);
    expect(rows[0].macros.fibre_100g).toBe(3.1);
    // 2mg sodium -> (2/1000)*2.5 = 0.005g salt
    expect(rows[0].macros.salt_100g).toBeCloseTo(0.005, 6);
  });

  it("does not confuse the plain fat column with the saturated fat column", () => {
    const csv =
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
      "1,Butter,745,0.5,82,54,0.5,0.5,0,11\n";

    const rows = parseCofidCsv(csv);
    expect(rows[0].macros.fat_100g).toBe(82);
    expect(rows[0].macros.satfat_100g).toBe(54);
  });

  it("maps CoFID's 'N' (not determined) to null, never 0", () => {
    const csv =
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
      "1,Water,0,0,0,0,0,0,N,0\n";

    const rows = parseCofidCsv(csv);
    expect(rows[0].macros.fibre_100g).toBeNull();
    // a genuine, source-reported 0 stays 0
    expect(rows[0].macros.kcal_100g).toBe(0);
    expect(rows[0].macros.salt_100g).toBe(0);
  });

  it("maps 'Tr' (trace) to 0, not null", () => {
    const csv =
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
      "1,Herb,10,Tr,0.1,0,1,0.5,2,1\n";

    const rows = parseCofidCsv(csv);
    expect(rows[0].macros.protein_100g).toBe(0);
  });

  it("leaves fibre NULL for every row when only an Englyst column exists — never falls back to it", () => {
    const csv =
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (Englyst) (g),Sodium (mg)\n" +
      "1,Oats,375,11,9,1.7,58,1,9,5\n";

    const rows = parseCofidCsv(csv);
    expect(rows[0].macros.fibre_100g).toBeNull();
  });

  it("throws if the identity columns (Food Code / Food Name) can't be found", () => {
    const csv = "Energy (kcal),Protein (g)\n100,5\n";
    expect(() => parseCofidCsv(csv)).toThrow(/Food Code|Food Name|required/i);
  });
});

describe("matchCofid", () => {
  const rows = parseCofidCsv(
    "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
      "1,\"Flour, white, plain\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n" +
      "2,\"Flour, white, plain, fortified\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n" +
      "3,\"Onions, raw\",36,1.2,0.2,0,7.9,4.7,1.4,3\n",
  );

  it("matches CoFID's inverted 'Category, descriptor' naming via token containment", () => {
    const match = matchCofid(staple({ displayName: "Onion", aliases: ["brown onion"] }), rows);
    expect(match?.sourceRef).toBe("3");
  });

  it("prefers the row with fewer extra words when several rows contain all query tokens", () => {
    const match = matchCofid(staple({ displayName: "Plain flour", aliases: [] }), rows);
    expect(match?.sourceRef).toBe("1"); // not the 'fortified' variant
  });

  it("returns null when nothing contains every query token", () => {
    const match = matchCofid(staple({ displayName: "Chickpeas", aliases: [] }), rows);
    expect(match).toBeNull();
  });
});
