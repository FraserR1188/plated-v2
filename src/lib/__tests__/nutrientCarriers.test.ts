// ============================================================
// src/lib/__tests__/nutrientCarriers.test.ts
//
// Value parity for every function that carries the eight nutrients from one
// row shape to another (MealEntry → EntryDraft, item → EntryDraft, draft →
// scaled draft, MealEntry → per-100g FoodProduct).
//
// WHY THIS EXISTS: these builders are hand-written field maps, and a field
// map can drift out of sync with its siblings without any compiler noticing.
// ConnectedUserLogScreen's entryToProduct did exactly that — it never mapped
// sat_fat, so a friend's known sat fat became NULL in the copier's log.
// Omission is now a compile error on both target types (EntryDraft's eight
// nutrients and FoodProduct's four small ones are required keys). What tsc
// still cannot see is a SWAP — `sat_fat: e.salt` type-checks perfectly. So
// every carrier here is fed eight DISTINCT values; any swap, drop or leak
// between fields lands the wrong number in some field and fails.
//
// THE REGISTRY IS SELF-ENFORCING for EntryDraft producers: the last test
// walks src/ for every function declared to return EntryDraft / EntryDraft[]
// and requires that set to equal this registry's EntryDraft entries exactly.
// A new builder that isn't registered here fails CI instead of rotting.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { draftsFromFeedEntry, draftsForCopy } from "../social";
import { draftsFromDay, draftsForTarget } from "../entries";
import {
  draftsFromComposition,
  draftsFromBatch,
  scaleEntryDraftGrams,
  scaleCompositionItem,
} from "../compositions";
import { mealEntryToProduct } from "../foodLookup";
import {
  EntryDraft,
  MealEntry,
  MealComposition,
  MealCompositionItem,
  MealCompositionWithItems,
} from "../../types";

const KEYS = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "sat_fat",
  "salt",
  "fibre",
  "sugar",
] as const;
type Key = (typeof KEYS)[number];
type Nutrients = Record<Key, number | null>;

const SMALL: Key[] = ["sat_fat", "salt", "fibre", "sugar"];

// Eight DISTINCT values, chosen so they stay distinct after every carrier's
// ratio, and sit exactly on the rounding grid of the carriers that round
// (whole kcal, 1dp, 2dp salt) both as-is and halved — so rounding carriers
// are exact and a mismatch can only mean the wrong field.
const SRC: Nutrients = {
  calories: 402,
  protein: 12,
  carbs: 46,
  fat: 74,
  sat_fat: 10,
  salt: 3.4,
  fibre: 26,
  sugar: 38,
};

const SERVING_G = 200;

function pick(o: Record<Key, number | null | undefined>): Nutrients {
  const out = {} as Nutrients;
  for (const k of KEYS) out[k] = o[k] ?? null;
  return out;
}

function makeEntry(n: Nutrients): MealEntry {
  return {
    id: "e1",
    user_id: "friend-1",
    date: "2026-09-01",
    logged_at: "2026-09-01T12:00:00.000Z",
    name: "Parity food",
    brand: null,
    source: "search",
    barcode: null,
    off_id: null,
    serving_g: SERVING_G,
    meal_type: "lunch",
    calories: n.calories as number,
    protein: n.protein as number,
    carbs: n.carbs as number,
    fat: n.fat as number,
    sat_fat: n.sat_fat,
    salt: n.salt,
    fibre: n.fibre,
    sugar: n.sugar,
    eaten_at: "2026-09-01T12:00:00.000Z",
    planned: false,
    confirmed_at: null,
    skipped_at: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    eaten_at_estimated: false,
  };
}

function makeItem(
  n: Nutrients,
  overrides: Partial<MealCompositionItem> = {},
): MealCompositionItem {
  return {
    id: "item-1",
    composition_id: "comp-1",
    user_id: "user-1",
    position: 0,
    name: "Parity item",
    brand: null,
    serving_g: SERVING_G,
    calories: n.calories as number,
    protein: n.protein as number,
    carbs: n.carbs as number,
    fat: n.fat as number,
    sat_fat: n.sat_fat,
    salt: n.salt,
    fibre: n.fibre,
    sugar: n.sugar,
    meal_type: "lunch",
    eaten_time: "12:00:00",
    barcode: null,
    off_id: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    ...overrides,
  };
}

function makeComposition(
  items: MealCompositionItem[],
  overrides: Partial<MealComposition> = {},
): MealCompositionWithItems {
  return {
    id: "comp-1",
    user_id: "user-1",
    name: "Parity composition",
    use_count: 0,
    last_used_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    kind: "bundle",
    yield_g: null,
    portion_g: null,
    portion_label: null,
    ...overrides,
    items,
  };
}

function makeDraft(n: Nutrients): EntryDraft {
  return {
    name: "Parity draft",
    brand: null,
    serving_g: SERVING_G,
    calories: n.calories as number,
    protein: n.protein as number,
    carbs: n.carbs as number,
    fat: n.fat as number,
    sat_fat: n.sat_fat,
    salt: n.salt,
    fibre: n.fibre,
    sugar: n.sugar,
    meal_type: "lunch",
    eaten_at: "2026-09-05T12:00:00.000Z",
    eaten_at_estimated: true,
    source: "copied",
    barcode: null,
    off_id: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
  };
}

interface Carrier {
  /** Exactly the function's declared name — the registry check matches on it. */
  name: string;
  /** Whether it is declared to return EntryDraft / EntryDraft[]. */
  returnsEntryDraft: boolean;
  /** output nutrient = input nutrient × ratio. */
  ratio: number;
  run: (n: Nutrients) => Nutrients;
}

const TARGET_DAY = "2026-09-05";

const CARRIERS: Carrier[] = [
  {
    name: "draftsFromFeedEntry",
    returnsEntryDraft: true,
    ratio: 1,
    run: (n) =>
      pick(
        draftsFromFeedEntry(
          { scope: "meal_section", entries: [makeEntry(n)], sourceName: "Parity" },
          { dayKey: TARGET_DAY, time: { hours: 12, minutes: 0 }, meal_type: "lunch" },
        )[0],
      ),
  },
  {
    // The single-ingredient friend copy, at a new portion: the friend's
    // absolutes ratio-scaled from their own serving_g.
    name: "draftsForCopy",
    returnsEntryDraft: true,
    ratio: 2,
    run: (n) =>
      pick(
        draftsForCopy(
          { scope: "ingredient", entries: [makeEntry(n)], sourceName: "Parity" },
          { dayKey: TARGET_DAY, time: { hours: 12, minutes: 0 }, meal_type: "lunch" },
          SERVING_G * 2,
        )[0],
      ),
  },
  {
    name: "draftsFromDay",
    returnsEntryDraft: true,
    ratio: 1,
    run: (n) => pick(draftsFromDay([makeEntry(n)], TARGET_DAY)[0]),
  },
  {
    name: "draftsForTarget",
    returnsEntryDraft: true,
    ratio: 1,
    run: (n) =>
      pick(
        draftsForTarget([makeEntry(n)], {
          dayKey: TARGET_DAY,
          meal_type: "dinner",
          time: { hours: 19, minutes: 0 },
        })[0],
      ),
  },
  {
    name: "draftsFromComposition",
    returnsEntryDraft: true,
    ratio: 1,
    run: (n) => pick(draftsFromComposition(makeComposition([makeItem(n)]), TARGET_DAY)[0]),
  },
  {
    // A one-ingredient batch whose portion IS its yield: scale 1, so the
    // once-only rounding lands exactly on SRC's on-grid values.
    name: "draftsFromBatch",
    returnsEntryDraft: true,
    ratio: 1,
    run: (n) =>
      pick(
        draftsFromBatch(
          makeComposition([makeItem(n, { meal_type: null, eaten_time: null })], {
            kind: "batch",
            yield_g: SERVING_G,
            portion_g: SERVING_G,
          }),
          { date: TARGET_DAY },
          new Date("2026-09-05T12:00:00"),
        ),
      ),
  },
  {
    name: "scaleEntryDraftGrams",
    returnsEntryDraft: true,
    ratio: 2,
    run: (n) => pick(scaleEntryDraftGrams(makeDraft(n), SERVING_G, SERVING_G * 2)),
  },
  {
    name: "scaleCompositionItem",
    returnsEntryDraft: false,
    ratio: 2,
    run: (n) => pick(scaleCompositionItem(makeItem(n), SERVING_G * 2)),
  },
  {
    // Per-100g rebuild: output per-100g = per-serving × 100 / serving_g.
    name: "mealEntryToProduct",
    returnsEntryDraft: false,
    ratio: 100 / SERVING_G,
    run: (n) => {
      const p = mealEntryToProduct(makeEntry(n));
      if (!p) throw new Error("mealEntryToProduct refused a weighted entry");
      return pick({
        calories: p.cal_per100,
        protein: p.protein_per100,
        carbs: p.carbs_per100,
        fat: p.fat_per100,
        sat_fat: p.sat_fat_per100,
        salt: p.salt_per100,
        fibre: p.fibre_per100,
        sugar: p.sugar_per100,
      });
    },
  },
];

function expectCarried(out: Nutrients, src: Nutrients, ratio: number) {
  for (const k of KEYS) {
    const want = src[k];
    if (want == null) {
      expect(out[k], `${k} should stay NULL`).toBeNull();
    } else {
      expect(out[k], `${k} landed in the wrong place or was dropped`).not.toBeNull();
      expect(out[k] as number, `${k}`).toBeCloseTo(want * ratio, 9);
    }
  }
}

describe.each(CARRIERS)("nutrient carrier: $name", (c) => {
  it("carries every nutrient into its own field — distinct values expose any swap", () => {
    expectCarried(c.run(SRC), SRC, c.ratio);
  });

  it.each(SMALL)(
    "a NULL in only %s stays NULL there and nowhere else",
    (k) => {
      const src = { ...SRC, [k]: null };
      expectCarried(c.run(src), src, c.ratio);
    },
  );
});

// ─── Registry completeness ───────────────────────────────────

const SRC_ROOT = path.resolve(process.cwd(), "src");

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * EntryDraft producers that map NO nutrient field themselves — they only hand
 * off to a registered carrier — so there is nothing in them to swap. Each is
 * verified below to contain no object literal with a nutrient key; the moment
 * one starts mapping fields itself, it loses the exemption and must be
 * registered in CARRIERS instead.
 */
const DELEGATES: Record<string, string> = {
  scaledDraftOf:
    "BundleApplyReviewScreen — returns scaleEntryDraftGrams(...) unchanged",
};

/** Every function under src/ (tests excluded) whose DECLARED return type is
 *  EntryDraft, EntryDraft[], or a Promise / `| null` of either — with whether
 *  it writes any nutrient key in an object literal of its own. */
function entryDraftProducers(): Map<string, { writesNutrients: boolean }> {
  const found = new Map<string, { writesNutrients: boolean }>();
  const RETURNS_DRAFT = /^(Promise<)?EntryDraft(\[\])?(\|null)?>?$/;
  const KEY_SET = new Set<string>(KEYS);

  const writesNutrients = (fn: ts.Node, sf: ts.SourceFile): boolean => {
    let hit = false;
    const scan = (n: ts.Node) => {
      if (
        ts.isObjectLiteralExpression(n) &&
        n.properties.some(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            KEY_SET.has(p.name.getText(sf)),
        )
      ) {
        hit = true;
      }
      if (!hit) ts.forEachChild(n, scan);
    };
    scan(fn);
    return hit;
  };

  for (const file of walkTsFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node) => {
      let name: string | undefined;
      let returnType: ts.TypeNode | undefined;
      let fn: ts.Node | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
        returnType = node.type;
        fn = node;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        name = node.name.text;
        returnType = node.initializer.type;
        fn = node.initializer;
      }
      if (name && returnType && fn) {
        const t = returnType.getText(sf).replace(/\s+/g, "");
        if (RETURNS_DRAFT.test(t)) {
          found.set(name, { writesNutrients: writesNutrients(fn, sf) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe("nutrient carrier registry", () => {
  const producers = entryDraftProducers();

  it("covers exactly the functions under src/ declared to return EntryDraft — register a new builder here, or this fails", () => {
    const expected = [
      ...CARRIERS.filter((c) => c.returnsEntryDraft).map((c) => c.name),
      ...Object.keys(DELEGATES),
    ].sort();
    expect([...producers.keys()].sort()).toEqual(expected);
  });

  it("every DELEGATES exemption really maps no nutrient field itself", () => {
    for (const name of Object.keys(DELEGATES)) {
      expect(
        producers.get(name)?.writesNutrients,
        `${name} now writes nutrient keys itself — move it into CARRIERS`,
      ).toBe(false);
    }
  });
});
