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

describe("matchCofid — raw preference (unhinted staples)", () => {
  it("prefers raw over grilled/roasted on an extraWords tie, regardless of CSV row order", () => {
    const rows = parseCofidCsv(
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
        "1,\"Chicken, breast, meat, grilled\",165,31,3.6,1,0,0,0,74\n" +
        "2,\"Chicken, breast, meat, roasted\",148,30,3,0.9,0,0,0,70\n" +
        "3,\"Chicken, breast, meat, raw\",106,23.1,1.1,0.3,0,0,0,72\n",
    );
    // 'raw' is listed LAST on purpose — this proves the raw tie-break
    // decided it, not first-writer-wins CSV order (the pre-existing bug).
    const match = matchCofid(staple({ displayName: "Chicken breast" }), rows);
    expect(match?.sourceRef).toBe("3");
  });

  it("is unchanged from the pre-existing extraWords ranking when no candidate row contains 'raw'", () => {
    const rows = parseCofidCsv(
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
        "1,\"Flour, white, plain\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n" +
        "2,\"Flour, white, plain, fortified\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n",
    );
    const match = matchCofid(staple({ displayName: "Plain flour" }), rows);
    expect(match?.sourceRef).toBe("1"); // fewer extra words — same result as before this change
  });
});

describe("matchCofid — preparationPreference (hinted staples)", () => {
  it("picks the longer canned row over a shorter raw row when hinted", () => {
    const rows = parseCofidCsv(
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
        "1,\"Beans, raw\",300,21,1.5,0.3,54,2,15,4\n" +
        "2,\"Beans, canned, drained\",90,6.6,0.5,0.1,15,2,6.5,3\n",
    );

    // Without a hint, the shorter 'raw' row wins on extraWords alone (1 vs
    // 2) — this is exactly the failure mode the hint exists to fix.
    const unhinted = matchCofid(staple({ displayName: "Beans" }), rows);
    expect(unhinted?.sourceRef).toBe("1");

    const hinted = matchCofid(
      staple({ displayName: "Beans", preparationPreference: ["canned"] }),
      rows,
    );
    expect(hinted?.sourceRef).toBe("2");
  });

  it("falls back to the unhinted ranking when no row contains the hint token", () => {
    const rows = parseCofidCsv(
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
        "1,\"Peas, dried\",300,21,1.5,0.3,54,2,15,4\n" +
        "2,\"Peas, raw\",83,6.9,0.4,0,11,4,4.5,1\n",
    );
    // No 'canned' row exists at all — must fall back rather than treat this
    // as unresolved. Fallback ranking: extraWords ties (1 each), so the
    // raw tie-break decides it -> row 2.
    const match = matchCofid(
      staple({ displayName: "Peas", preparationPreference: ["canned"] }),
      rows,
    );
    expect(match?.sourceRef).toBe("2");
  });
});
