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

/** One (row, query) pair that satisfied token containment — every
 *  staple.displayName/alias is still tried against every row, same as
 *  before this file gained a ranking step; this just materialises the full
 *  candidate set instead of reducing it inline, so the ranking function
 *  used can vary per staple (see below). */
interface Candidate {
  row: CofidRow;
  rowTokens: Set<string>;
  extraWords: number;
}

function candidatesFor(staple: SeedStaple, rows: CofidRow[]): Candidate[] {
  const queries = [staple.displayName, ...staple.aliases];
  const out: Candidate[] = [];

  for (const row of rows) {
    const rowTokens = new Set(nameTokens(row.foodName));
    for (const query of queries) {
      const qTokens = nameTokens(query);
      if (qTokens.length === 0) continue;
      if (!qTokens.every((t) => rowTokens.has(t))) continue;
      // Fewest words beyond the query — "Flour, white, plain" beats
      // "Flour, white, plain, fortified" for the query "plain flour".
      out.push({ row, rowTokens, extraWords: rowTokens.size - qTokens.length });
    }
  }
  return out;
}

// ─── Ranking — deliberately asymmetric between hinted and unhinted staples ──
//
// UNHINTED (staple.preparationPreference absent — the great majority of
// SEED_STAPLES): extraWords stays the PRIMARY key, and "does this row
// contain 'raw'" is only a TIE-BREAK between rows that are otherwise
// EQUALLY specific. This is the conservative choice, and deliberately so:
// most staples really are correctly matched by raw (fresh veg, raw meat/
// fish, dry grains/pulses weighed uncooked), so a same-tier tie-break fixes
// the one real bug that existed before this change — several raw/grilled/
// roasted variants tying on extraWords and falling to whatever order the
// CoFID CSV happened to list them in — without ever letting "contains raw"
// override a row that's a textually BETTER match. Where no candidate row
// contains "raw" at all, this is byte-identical to the old behaviour: the
// first candidate seen at the best extraWords tier still wins.
//
// HINTED (staple.preparationPreference present): the hint token becomes the
// PRIMARY key, ranked ABOVE extraWords — not merely a tie-break, and not
// "raw" with a different word substituted in. The reason it has to rank
// above extraWords, not alongside it: for a tinned pulse or tinned tuna,
// the CORRECT CoFID row ("Chick peas, canned, drained") is inherently
// LONGER than the WRONG one it needs to beat ("Chick peas, raw"), so a
// same-tier tie-break would never even fire — the wrong row already wins
// outright on extraWords, with no tie for a tie-break to catch. Only
// promoting the hint above extraWords fixes that.
//
// Why the two cases get different treatment, not just different tokens:
// a hint is opt-in and per-staple — a human looked at THIS one ingredient
// and asserted "the CoFID category I actually want is canned/dried/
// roasted", which is a narrow, reviewed claim about a single food. That is
// a fundamentally different risk from promoting "prefer canned" (or
// anything else) above specificity GLOBALLY, which would be wrong for the
// ~170 staples where raw genuinely is correct. The asymmetry is what makes
// it safe to let a hint be this aggressive.
//
// FALLBACK: if a hinted staple has no candidate row containing any of its
// hint tokens (this CoFID export just doesn't have a "canned" row for it,
// say), matchCofid() falls back to the unhinted ranking over the FULL
// candidate set — not just the non-hinted remainder — rather than treating
// the staple as unresolved. A missing hint category is not evidence the
// staple has no usable match at all.

function bestByExtraWordsThenRaw(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!best || c.extraWords < best.extraWords) {
      best = c;
      continue;
    }
    // Tie-break only — this can never let "raw" beat a MORE specific row,
    // only decide between two that are equally specific.
    if (c.extraWords === best.extraWords && c.rowTokens.has("raw") && !best.rowTokens.has("raw")) {
      best = c;
    }
  }
  return best;
}

function bestByHint(candidates: Candidate[], hintTokens: string[]): Candidate | null {
  const hinted = candidates.filter((c) => hintTokens.some((t) => c.rowTokens.has(t)));
  if (hinted.length === 0) return null; // signals "fall back to the unhinted path"

  let best: Candidate | null = null;
  for (const c of hinted) {
    if (!best || c.extraWords < best.extraWords) best = c;
  }
  return best;
}

export function matchCofid(staple: SeedStaple, rows: CofidRow[]): CofidMatch | null {
  const candidates = candidatesFor(staple, rows);
  if (candidates.length === 0) return null;

  const hintTokens = staple.preparationPreference;
  const best =
    (hintTokens && hintTokens.length > 0 ? bestByHint(candidates, hintTokens) : null) ??
    bestByExtraWordsThenRaw(candidates);

  if (!best) return null;
  return {
    macros: best.row.macros,
    sourceRef: best.row.foodCode,
    matchedName: best.row.foodName,
  };
}
