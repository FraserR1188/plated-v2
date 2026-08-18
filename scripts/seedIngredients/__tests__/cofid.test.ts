import { describe, it, expect } from "vitest";
import { parseCofidCsv, matchCofid, matchCofidWithRunnerUp } from "../cofid";
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

  it("parses the optional Group column when present", () => {
    const csv =
      "Food Code,Food Name,Group,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
      "1,\"Milk, whole, pasteurised\",Milk and milk products,64,3.3,3.6,2.3,4.6,4.6,0,44\n";

    const rows = parseCofidCsv(csv);
    expect(rows[0].group).toBe("Milk and milk products");
  });

  it("leaves Group NULL, without throwing, on a CSV that predates the column", () => {
    // Every other test in this file uses a header with no Group column at
    // all — this just asserts that's a silent, non-throwing NULL, the same
    // warn-and-continue treatment every other optional column gets.
    const csv =
      "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n" +
      "1,\"Flour, white, plain\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n";

    const rows = parseCofidCsv(csv);
    expect(rows[0].group).toBeNull();
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

describe("matchCofid — identity anchoring", () => {
  const HEADER =
    "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n";

  it("doesn't let 'Chocolate, milk' win a bare 'milk' query over the actual milk row", () => {
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Chocolate, milk\",550,7.6,29.7,17.7,59.6,56.5,1.7,120\n" +
        "2,\"Milk, whole, pasteurised\",64,3.3,3.6,2.3,4.6,4.6,0,44\n",
    );
    const match = matchCofid(staple({ displayName: "Whole milk", aliases: ["milk"] }), rows);
    expect(match?.sourceRef).toBe("2");
  });

  it("doesn't let 'Chutney, tomato' win over the plain tomato row", () => {
    // The right row's descriptor is deliberately 2 words, not 1 — with a
    // single-word "Tomatoes, raw" this test would pass even with the gate
    // disabled, because it ties the wrong row on extraWords and the
    // pre-existing raw tie-break (from 7f19f4a) happens to save it too.
    // Padding the descriptor makes the wrong row strictly SHORTER, so only
    // the new identity gate — not extraWords, not the raw tie-break — can
    // be what excludes it.
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Chutney, tomato\",89,0.8,0.2,0,20.4,19,0.9,900\n" +
        "2,\"Tomatoes, raw, average\",17,0.7,0.3,0.1,3.1,3.1,1,5\n",
    );
    const match = matchCofid(staple({ displayName: "Tomato", aliases: ["fresh tomato"] }), rows);
    expect(match?.sourceRef).toBe("2");
  });

  it("excludes 'Carrot juice' for a carrot query — the load-bearing no-comma branch", () => {
    // No comma at all in "Carrot juice": it isn't CoFID's usual inverted
    // naming, it's a compound product in plain English order, same shape
    // as the query. The whole name has to be treated as the identity
    // segment for this to be caught — a comma-only implementation would
    // let this straight through, since "carrot" trivially appears. The
    // right row's descriptor is padded to 2 words for the same reason as
    // the tomato test above — otherwise the pre-existing raw tie-break
    // alone would save this test even with the gate disabled.
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Carrot juice\",24,0.5,0.1,0,5.6,5.4,0.5,26\n" +
        "2,\"Carrots, raw, average\",30,0.6,0.4,0.1,6,4.9,2.5,66\n",
    );
    const match = matchCofid(staple({ displayName: "Carrot", aliases: ["fresh carrot"] }), rows);
    expect(match?.sourceRef).toBe("2");
  });

  it("doesn't let 'Orange roughy, raw' (a fish) win over the plain orange row", () => {
    // Both rows contain "raw", which neutralises the pre-existing raw
    // tie-break as a possible accidental saviour here — and the right
    // row's descriptor is padded to 3 words so it doesn't win outright on
    // extraWords either. Only the identity gate can be what's deciding this.
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Orange roughy, raw\",73,15.7,1.2,0,0,0,0,55\n" +
        "2,\"Oranges, raw, whole, peeled\",37,1.1,0.1,0,8.5,8.5,1.7,3\n",
    );
    const match = matchCofid(staple({ displayName: "Orange" }), rows);
    expect(match?.sourceRef).toBe("2");
  });

  it("doesn't let a bare 'rice' alias match 'Flour, rice' over the actual rice row", () => {
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Flour, rice\",366,5.9,1.4,0.3,80.1,0.1,2.4,4\n" +
        "2,\"Rice, easy cook, raw\",383,7.3,3.6,0.8,85.8,0.1,1.4,3\n",
    );
    const match = matchCofid(staple({ displayName: "Basmati rice", aliases: ["rice"] }), rows);
    expect(match?.sourceRef).toBe("2");
  });

  it("doesn't let 'Beef steak pudding' (a dish) win over the actual rump steak row", () => {
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Beef steak pudding\",188,10.4,10.6,4.6,13.7,1,0.8,400\n" +
        "2,\"Beef, rump steak, raw\",123,20.9,4.1,1.7,0,0,0,52\n",
    );
    // Matches the real rump-steak staple's actual aliases — the 'beef
    // steak' alias is what lets the correct row's identity ("Beef") pass
    // the gate at all, since the bare displayName "Rump steak" alone
    // doesn't contain "beef".
    const match = matchCofid(
      staple({ displayName: "Rump steak", aliases: ["beef steak", "sirloin steak"] }),
      rows,
    );
    expect(match?.sourceRef).toBe("2");
  });

  it("doesn't interfere with the hint layer — tinned-tuna still resolves canned over raw", () => {
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Tuna, raw\",108,23.5,0.6,0.2,0,0,0,50\n" +
        "2,\"Tuna, canned in brine, drained\",99,23.5,0.6,0.2,0,0,0,247\n",
    );
    const match = matchCofid(
      staple({
        displayName: "Tinned tuna",
        aliases: ["canned tuna", "tuna"],
        preparationPreference: ["canned"],
      }),
      rows,
    );
    expect(match?.sourceRef).toBe("2");
  });
});

describe("matchCofidWithRunnerUp", () => {
  const HEADER =
    "Food Code,Food Name,Energy (kcal),Protein (g),Fat (g),Saturated fat (g),Carbohydrate (g),Sugars (g),Fibre (AOAC) (g),Sodium (mg)\n";

  it("surfaces the next-best DIFFERENT row as the runner-up, deduplicated by food code", () => {
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Flour, white, plain\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n" +
        "2,\"Flour, white, plain, fortified\",341,9.4,1.3,0.2,77.7,1.5,3.1,2\n",
    );
    // "Plain flour" and its would-be alias both point at food code 1 here —
    // the runner-up must still be food code 2, not code 1 re-surfacing via
    // a second query.
    const result = matchCofidWithRunnerUp(
      staple({ displayName: "Plain flour", aliases: ["flour"] }),
      rows,
    );
    expect(result.match?.sourceRef).toBe("1");
    expect(result.runnerUp?.sourceRef).toBe("2");
  });

  it("returns a null runner-up when only one candidate survives", () => {
    const rows = parseCofidCsv(HEADER + "1,\"Onions, raw\",36,1.2,0.2,0,7.9,4.7,1.4,3\n");
    const result = matchCofidWithRunnerUp(staple({ displayName: "Onion" }), rows);
    expect(result.match?.sourceRef).toBe("1");
    expect(result.runnerUp).toBeNull();
  });

  it("matchCofid() still returns exactly matchCofidWithRunnerUp().match", () => {
    const rows = parseCofidCsv(
      HEADER +
        "1,\"Chocolate, milk\",550,7.6,29.7,17.7,59.6,56.5,1.7,120\n" +
        "2,\"Milk, whole, pasteurised\",64,3.3,3.6,2.3,4.6,4.6,0,44\n",
    );
    const s = staple({ displayName: "Whole milk", aliases: ["milk"] });
    expect(matchCofid(s, rows)).toEqual(matchCofidWithRunnerUp(s, rows).match);
  });
});
