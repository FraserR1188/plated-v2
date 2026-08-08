// ============================================================
// scripts/seedIngredients/cofid.ts — CoFID lookup for the seed importer
//
// INPUT CONTRACT — read this before running the importer.
//
// CoFID 2021 (labelling-adjusted) ships as a multi-sheet government Excel
// workbook, not a flat CSV, and its column headers have already shifted
// across the 2015 -> 2021 releases (see the Phase 2 brief). Rather than
// guess at today's exact workbook layout — which is exactly how the
// "map by index, not header" bug class happens — this loader takes ONE
// flattened CSV that you export yourself (Excel: combine the Proximates +
// Inorganics sheets on Food Code, then Save As CSV UTF-8):
//
//   Required column, any ONE recognised header per row (case/spacing
//   insensitive, matched by whole-word token so "Energy (kcal)" and
//   "Energy, kcal" both resolve):
//     Food Code        "Food Code", "Code"
//     Food Name        "Food Name", "Name", "Description"
//     Energy, kcal      must contain "kcal" (never matches a kJ-only column)
//     Protein           "Protein"
//     Fat               "Fat" — NOT matched if the header also says
//                        saturated/satd, so it can't collide with the next row
//     Saturated fat     "Saturated fat", "Satd fat", "Saturated fatty acids"
//     Carbohydrate      "Carbohydrate", "Carb"
//     Sugars            "Sugars", "Total sugars"
//     Fibre, AOAC       must contain "aoac" — see the header note below
//     Sodium (mg)       "Sodium"
//
//   A column that can't be found by any recognised header is left NULL for
//   every row, not zero-filled — see convert.ts.
//
// WHY FIBRE MUST BE AOAC, NOT ENGLYST/NSP
//   CoFID carries both fibre methods in the same workbook. UK nutrition
//   labels are AOAC; Englyst/NSP values run systematically lower for the
//   same food. If no AOAC-named column is found, fibre is left NULL and a
//   warning is logged — it does NOT silently fall back to an Englyst column
//   that happens to also match "fibre", because that would under-report
//   fibre for every affected row without anyone noticing.
//
// 'N' / 'Tr' — CoFID's own missing-value conventions
//   'N'  = not determined for this food -> null (unknown, not zero).
//   'Tr' = trace: present below a reliably measurable amount -> treated as
//          0. This is a judgement call, not a rediscovery of the NULL-vs-0
//          rule: the source has already told us "detectable but
//          negligible", which is a different claim from "we don't know".
//          If you'd rather these stayed NULL too, flip TRACE_AS_ZERO below.
// ============================================================

import { readFileSync } from "node:fs";
import type { SeedStaple } from "../seedStaples";
import { Macro100, toSaltG } from "./convert";
// Reused, not forked — same "apples"/"apple" stemming problem OFF search
// has (src/lib/openfoodfacts.ts's header comment), and CoFID row names are
// just as often plural ("Onions, raw") as a staple's singular query name.
import { singularise } from "../../src/lib/openfoodfacts";

const TRACE_AS_ZERO = true;

export interface CofidRow {
  foodCode: string;
  foodName: string;
  macros: Partial<Macro100>;
}

export interface CofidMatch {
  macros: Partial<Macro100>;
  sourceRef: string; // CoFID food code
  matchedName: string;
}

// ─── CSV parsing (minimal, RFC4180-ish: quoted fields, escaped "") ────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ─── Header matching ────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function headerTokens(header: string): Set<string> {
  return new Set(normalize(header).split(" ").filter(Boolean));
}

/**
 * First header whose normalised tokens contain every token of ANY candidate
 * set (tried in order), skipping headers that contain an excluded token.
 * Order candidate sets most-specific first — see how satFat is searched
 * before the plain "fat" exclusion relies on it below.
 */
function findColumn(
  headers: string[],
  candidateSets: string[][],
  excludeTokens: string[] = [],
): number {
  const tokenSets = headers.map(headerTokens);
  for (const candidate of candidateSets) {
    for (let i = 0; i < tokenSets.length; i++) {
      if (excludeTokens.some((t) => tokenSets[i].has(t))) continue;
      if (candidate.every((t) => tokenSets[i].has(t))) return i;
    }
  }
  return -1;
}

function parseCofidValue(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^n$/i.test(trimmed)) return null; // not determined
  if (/^tr$/i.test(trimmed)) return TRACE_AS_ZERO ? 0 : null; // trace
  const num = parseFloat(trimmed.replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

interface ColumnMap {
  foodCode: number;
  foodName: number;
  kcal: number;
  protein: number;
  fat: number;
  satFat: number;
  carbs: number;
  sugars: number;
  fibreAoac: number;
  sodium: number;
}

function resolveColumns(headers: string[]): ColumnMap {
  const satFat = findColumn(headers, [
    ["saturated", "fat"],
    ["satd", "fat"],
    ["saturated", "fatty", "acids"],
  ]);

  const map: ColumnMap = {
    foodCode: findColumn(headers, [["food", "code"], ["code"]]),
    foodName: findColumn(headers, [["food", "name"], ["name"], ["description"]]),
    kcal: findColumn(headers, [["energy", "kcal"], ["kcal"]], ["kj"]),
    protein: findColumn(headers, [["protein"]]),
    // Excludes whatever header satFat matched by requiring it NOT contain
    // saturated/satd — otherwise "Saturated fat (g)" would satisfy the
    // bare ["fat"] candidate too and the two columns would collide.
    fat: findColumn(headers, [["fat"]], ["saturated", "satd"]),
    satFat,
    carbs: findColumn(headers, [["carbohydrate"], ["carb"]]),
    sugars: findColumn(headers, [["sugars"], ["total", "sugars"], ["sugar"]]),
    // AOAC ONLY. No fallback candidate set — see the header comment on why
    // silently accepting an Englyst/NSP column here would be worse than
    // leaving fibre null.
    fibreAoac: findColumn(headers, [
      ["fibre", "aoac"],
      ["dietary", "fibre", "aoac"],
      ["aoac", "fibre"],
    ]),
    sodium: findColumn(headers, [["sodium"]]),
  };

  const missing = Object.entries(map)
    .filter(([, idx]) => idx === -1)
    .map(([name]) => name);
  if (map.foodCode === -1 || map.foodName === -1) {
    throw new Error(
      `CoFID CSV is missing required identity column(s): ${missing.join(", ")}. ` +
        `Headers seen: ${headers.join(" | ")}`,
    );
  }
  if (missing.length > 0) {
    console.warn(
      `[cofid] Column(s) not found, will import as NULL for every row: ${missing.join(", ")}`,
    );
    if (missing.includes("fibreAoac")) {
      const hasEnglyst = headers.some((h) => /englyst|nsp/i.test(h));
      console.warn(
        `[cofid] No AOAC fibre column found.${hasEnglyst ? " An Englyst/NSP column exists but is deliberately NOT used as a fallback — fibre will be NULL for all rows." : ""}`,
      );
    }
  }

  return map;
}

// ─── Public API ─────────────────────────────────────────────────────────

export function loadCofid(csvPath: string): CofidRow[] {
  return parseCofidCsv(readFileSync(csvPath, "utf-8"));
}

/** Text-in, rows-out — split out from loadCofid so this is testable without
 *  touching the filesystem. loadCofid is the only caller that reads a file. */
export function parseCofidCsv(text: string): CofidRow[] {
  const table = parseCsv(text);
  if (table.length < 2) return [];

  const [headerRow, ...dataRows] = table;
  const cols = resolveColumns(headerRow);

  const rows: CofidRow[] = [];
  for (const r of dataRows) {
    const foodName = (r[cols.foodName] ?? "").trim();
    const foodCode = (r[cols.foodCode] ?? "").trim();
    if (!foodName || !foodCode) continue;

    const sodiumMg = cols.sodium === -1 ? null : parseCofidValue(r[cols.sodium]);

    rows.push({
      foodCode,
      foodName,
      macros: {
        kcal_100g: cols.kcal === -1 ? null : parseCofidValue(r[cols.kcal]),
        protein_100g: cols.protein === -1 ? null : parseCofidValue(r[cols.protein]),
        carbs_100g: cols.carbs === -1 ? null : parseCofidValue(r[cols.carbs]),
        fat_100g: cols.fat === -1 ? null : parseCofidValue(r[cols.fat]),
        satfat_100g: cols.satFat === -1 ? null : parseCofidValue(r[cols.satFat]),
        sugar_100g: cols.sugars === -1 ? null : parseCofidValue(r[cols.sugars]),
        fibre_100g: cols.fibreAoac === -1 ? null : parseCofidValue(r[cols.fibreAoac]),
        salt_100g: toSaltG(sodiumMg),
      },
    });
  }
  return rows;
}

// ─── Matching a staple to a CoFID row ──────────────────────────────────
//
// CoFID names invert as "Category, descriptor" ("Onions, raw"; "Sugar,
// white"). Token-set containment (every word of the query found somewhere
// in the row name) handles that inversion for free, without needing a
// second "swap around the comma" special case.

function nameTokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean).map(singularise);
}

export function matchCofid(staple: SeedStaple, rows: CofidRow[]): CofidMatch | null {
  const queries = [staple.displayName, ...staple.aliases];

  let best: { row: CofidRow; extraWords: number } | null = null;

  for (const row of rows) {
    const rowTokens = new Set(nameTokens(row.foodName));
    for (const query of queries) {
      const qTokens = nameTokens(query);
      if (qTokens.length === 0) continue;
      const allPresent = qTokens.every((t) => rowTokens.has(t));
      if (!allPresent) continue;

      // Prefer the row whose name has the fewest words beyond the query —
      // "Flour, white, plain" beats "Flour, white, plain, fortified" for
      // the query "plain flour".
      const extraWords = rowTokens.size - qTokens.length;
      if (!best || extraWords < best.extraWords) {
        best = { row, extraWords };
      }
    }
  }

  if (!best) return null;
  return {
    macros: best.row.macros,
    sourceRef: best.row.foodCode,
    matchedName: best.row.foodName,
  };
}
