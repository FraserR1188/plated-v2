// ============================================================
// scripts/seedIngredients/verify.ts — post-seed integrity check for
// public.core_ingredients.
//
// USAGE
//   npx tsx scripts/seedIngredients/verify.ts              run the checks
//   npx tsx scripts/seedIngredients/verify.ts --emit-sql    regenerate verify.sql
//
// ENV (for a real run; --emit-sql needs none of this)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   same as scripts/seedCoreIngredients.ts —
//                                              reused via ./db, not reimplemented here.
//
// TWO KINDS OF CHECK
//   assert — has a right answer. Prints PASS/FAIL and a SPECIFIC diagnosis on
//            failure (not just "FAIL"), and a failing assert makes this
//            script exit non-zero.
//   review — has no right answer this script can judge. Prints the table and
//            stops. A human reads it; this script never passes/fails it.
//
// SINGLE SOURCE OF TRUTH, NOT TWO HAND-MAINTAINED COPIES
//   Each CHECKS entry below carries its own `sql` field — the EXACT verbatim
//   text of its section in verify.sql. `--emit-sql` regenerates verify.sql
//   from these strings, so the pasteable SQL-editor copy and the executed
//   checks can't drift apart silently. (`npx vitest run` includes a test
//   that emits and diffs against the committed verify.sql.)
//
//   What this script does NOT do: hand verify.sql's text to Postgres and run
//   it as-is. supabase-js talks to PostgREST, which has no "run this raw SQL
//   string" endpoint — only the query builder, or an RPC to a Postgres
//   function you'd have to define yourself. Adding a generic SQL-execution
//   RPC (even service-role-gated) is a bigger surface than a verification
//   script justifies, so `evaluate()` below re-expresses each check's WHERE/
//   GROUP BY as a plain JS predicate over ONE full-table fetch instead. Each
//   evaluate() is written to be provably equivalent to its `sql` sibling —
//   that's what the section id/title pairing is FOR: diff them by eye.
// ============================================================

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdminClient } from "./db";
import { SEED_STAPLES } from "../seedStaples";

// ─── Row shape ───────────────────────────────────────────────

export interface IngredientRow {
  slug: string;
  display_name: string;
  source: string;
  source_ref: string | null;
  kcal_100g: number | null;
  protein_100g: number | null;
  carbs_100g: number | null;
  fat_100g: number | null;
  satfat_100g: number | null;
  sugar_100g: number | null;
  fibre_100g: number | null;
  salt_100g: number | null;
  unit_grams: Record<string, number> | null;
}

function hasUnitGrams(r: IngredientRow): boolean {
  return !!r.unit_grams && Object.keys(r.unit_grams).length > 0;
}

function missingCoreFour(r: IngredientRow): boolean {
  return (
    r.kcal_100g == null || r.protein_100g == null || r.carbs_100g == null || r.fat_100g == null
  );
}

// ─── Checks ──────────────────────────────────────────────────

export interface Table {
  label: string;
  rows: Record<string, unknown>[];
  note?: string;
}

export interface AssertResult {
  pass: boolean;
  summary: string;
  /** SPECIFIC cause, not "FAIL" — see the header comment. Only set when !pass. */
  diagnosis?: string;
  rows?: Record<string, unknown>[];
}

export interface ReviewResult {
  tables: Table[];
}

interface AssertCheck {
  id: string;
  title: string;
  mode: "assert";
  sql: string;
  evaluate: (rows: IngredientRow[]) => AssertResult;
}

interface ReviewCheck {
  id: string;
  title: string;
  mode: "review";
  sql: string;
  evaluate: (rows: IngredientRow[]) => ReviewResult;
}

export type CheckDef = AssertCheck | ReviewCheck;

// Tunable — CoFID has sodium for virtually every food, so a NULL salt rate
// above this is a real signal (the Inorganics sheet not surviving the CSV
// flatten), not noise.
export const SALT_NULL_THRESHOLD = 0.05;

const REFERENCE_SALT_SLUGS = ["whole-milk", "cheddar", "butter", "table-salt", "soy-sauce"];

// Head staples (non-empty unit_grams) allowed to miss the core four despite
// check 2's alarm. CoFID marks these N (not determined) — not zero, not a
// name-match miss — for the whole category, and there is no better row to
// match to. Each entry needs its own CoFID-code justification; this is not
// a general escape hatch for a real name-match failure.
const HEAD_STAPLE_NULL_ALLOWLIST = new Set<string>([
  "black-pepper", // CoFID 13-880 "Pepper, black, dried, ground": energy & carbohydrate both N. Ground spices and stock cubes carry the same N marking generally.
]);

// Slugs allowed to have a genuinely zero kcal_100g for check 5. CoFID
// records a literal zero for these — not a NULL coalesced to zero on write
// — because each is a pure inorganic compound with no macronutrient content
// at all. Each entry needs its own CoFID-code justification; this is not a
// general escape hatch for the ?? 0 bug this check exists to catch.
const ZERO_KCAL_ALLOWLIST = new Set<string>([
  "table-salt", // CoFID 17-367 "Salt": inorganic — genuinely 0 kcal/protein/carbohydrate/fat.
  "bicarbonate-of-soda", // CoFID 17-356 "Bicarbonate of soda": same — inorganic, genuinely 0.
]);

export const HEADER_SQL = `-- ============================================================================
-- core_ingredients — post-seed verification suite
--
-- Run AFTER the real import (npx tsx scripts/seedCoreIngredients.ts --cofid <real.csv>),
-- against the Supabase SQL editor or psql. Read-only; safe to run repeatedly.
--
-- Reading order matters: Q1 tells you WHAT is missing, Q3 tells you WHY.
-- A core-four miss + a source that shows CoFID never matched = name-match miss,
-- not a genuine data gap. Chase those before accepting anything as "just missing".
-- ============================================================================`;

export const CHECKS: CheckDef[] = [
  {
    id: "0",
    title: "Seed-list coverage — which staples have no row",
    mode: "review",
    sql: `-- 0. Seed-list coverage — which staples have no row ---------------------------
-- Row count here will legitimately be LESS than SEED_STAPLES.length: a total
-- CoFID/FDC miss, or a stale/typo'd cofidOverride code, means the importer
-- skips the row entirely rather than inserting a NULL-macro placeholder (see
-- seedCoreIngredients.ts's MISS / OVERRIDE NOT FOUND branches). So there is
-- no single "expected" count to assert against — this is a by-name review,
-- not a pass/fail check.
select slug from public.core_ingredients order by slug;
-- Compare the result against SEED_STAPLES in scripts/seedStaples.ts, or just
-- re-read the import run's own '[seed] MISS' / '[seed] OVERRIDE NOT FOUND'
-- console lines — that's the authoritative list, computed at import time.
-- This script's evaluate() below does the same set-difference against the
-- CURRENT seed list, so you don't have to do it by hand.`,
    evaluate: (rows) => {
      const present = new Set(rows.map((r) => r.slug));
      const absent = SEED_STAPLES.filter((s) => !present.has(s.slug))
        .map((s) => ({ slug: s.slug, display_name: s.displayName }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      return {
        tables: [
          {
            label: `SEED_STAPLES slugs with no core_ingredients row (${rows.length}/${SEED_STAPLES.length} present)`,
            rows: absent,
            note:
              absent.length === 0
                ? undefined
                : "Absence here is EXPECTED for a genuine CoFID/FDC total miss or a stale cofidOverride code — cross-check each slug against the import run's '[seed] MISS' / 'OVERRIDE NOT FOUND' log lines before treating any of these as a bug.",
          },
        ],
      };
    },
  },
  {
    id: "1",
    title: 'Core-four NULL audit — the "invisible to the staple tier" list',
    mode: "review",
    sql: `-- 1. Core-four NULL audit — the "invisible to the staple tier" list -----------
-- calories/protein/carbs/fat are NOT NULL everywhere else in the app, so a staple
-- missing any of them cannot become a FoodProduct and falls through to OFF.
-- This is the list to eyeball BY NAME. Include source/source_ref so you can tell
-- a CoFID name-match miss from a real gap in one pass.
select
  slug,
  display_name,
  source,
  source_ref,
  (kcal_100g    is null) as kcal_missing,
  (protein_100g is null) as protein_missing,
  (carbs_100g   is null) as carbs_missing,
  (fat_100g     is null) as fat_missing
from public.core_ingredients
where kcal_100g is null
   or protein_100g is null
   or carbs_100g is null
   or fat_100g is null
order by display_name;
-- If a COMMON ingredient is here and 'source' shows CoFID didn't contribute,
-- suspect the inverted-naming match, not the data. If it's an obscure tail item, shrug.`,
    evaluate: (rows) => {
      const missing = rows
        .filter(missingCoreFour)
        .sort((a, b) => a.display_name.localeCompare(b.display_name))
        .map((r) => ({
          slug: r.slug,
          display_name: r.display_name,
          source: r.source,
          source_ref: r.source_ref,
          kcal_missing: r.kcal_100g == null,
          protein_missing: r.protein_100g == null,
          carbs_missing: r.carbs_100g == null,
          fat_missing: r.fat_100g == null,
        }));
      return {
        tables: [
          {
            label: "Core-four NULL rows (read BY NAME — a CoFID miss for a common item is a name-match bug, not a gap)",
            rows: missing,
          },
        ],
      };
    },
  },
  {
    id: "2",
    title: "Head-staple alarm — these should NEVER miss the core four",
    mode: "assert",
    sql: `-- 2. Head-staple alarm — these should NEVER miss the core four -----------------
-- Head staples are exactly the rows with seeded unit_grams (non-empty jsonb).
-- They're the common, well-documented ingredients; any miss here is a red flag.
select slug, display_name, source, kcal_100g, protein_100g, carbs_100g, fat_100g
from public.core_ingredients
where unit_grams <> '{}'::jsonb
  and (kcal_100g is null or protein_100g is null or carbs_100g is null or fat_100g is null)
  and slug not in ('black-pepper'); -- CoFID marks energy & carbohydrate N for ground spices/stock cubes generally — see verify.ts's HEAD_STAPLE_NULL_ALLOWLIST.
-- EXPECT: 0 rows. Any row (other than the allowlisted spices/stock cubes above) => investigate that staple's CoFID name match first.`,
    evaluate: (rows) => {
      const offenders = rows.filter(
        (r) => hasUnitGrams(r) && missingCoreFour(r) && !HEAD_STAPLE_NULL_ALLOWLIST.has(r.slug),
      );
      return {
        pass: offenders.length === 0,
        summary: `${offenders.length} head staple(s) missing a core macro`,
        diagnosis:
          offenders.length > 0
            ? `Common staple(s) failed to resolve a core macro: ${offenders.map((o) => o.slug).join(", ")}. A common staple failed to resolve; check its CoFID name match.`
            : undefined,
        rows: offenders.map((r) => ({
          slug: r.slug,
          display_name: r.display_name,
          source: r.source,
          kcal_100g: r.kcal_100g,
          protein_100g: r.protein_100g,
          carbs_100g: r.carbs_100g,
          fat_100g: r.fat_100g,
        })),
      };
    },
  },
  {
    id: "3",
    title: "Source provenance breakdown — the name-match discriminator",
    mode: "review",
    sql: `-- 3. Source provenance breakdown — the name-match discriminator ----------------
select source, count(*) as n
from public.core_ingredients
group by source
order by n desc;
-- CoFID is primary: expect most rows 'cofid' or 'merged'.
-- A large 'fdc'-only share => CoFID name-matching is missing rows broadly
-- (the inverted "Category, descriptor" naming problem), NOT FDC doing its job well.`,
    evaluate: (rows) => {
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
      const breakdown = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([source, n]) => ({ source, n }));

      const fdcOnly = counts.get("fdc") ?? 0;
      const note =
        rows.length > 0 && fdcOnly / rows.length > 0.25
          ? `'fdc'-only is ${((fdcOnly / rows.length) * 100).toFixed(0)}% of rows — that's more likely CoFID name-matching missing rows broadly than FDC doing an unusually good job. Worth checking the CoFID CSV's Food Name column against a few 'fdc' rows.`
          : undefined;

      return { tables: [{ label: "source breakdown", rows: breakdown, note }] };
    },
  },
  {
    id: "4a",
    title: "Sodium survival — salt NULL rate",
    mode: "assert",
    sql: `-- 4a. Sodium survival — salt NULL rate ----------------------------------------
-- CoFID carries sodium for essentially all foods, and salt is derived from it.
-- So salt_100g NULL should be a small handful at most.
select
  count(*) filter (where salt_100g is null) as salt_null,
  count(*) as total
from public.core_ingredients;
-- Many NULLs => the Inorganics sheet (where sodium lives) didn't survive the
-- flatten into the CSV, so toSaltG() had nothing to run on. This is the specific
-- failure mode to guard: sodium is a separate sheet from the Proximates macros.`,
    evaluate: (rows) => {
      const total = rows.length;
      const saltNull = rows.filter((r) => r.salt_100g == null).length;
      const rate = total > 0 ? saltNull / total : 0;
      const pass = rate <= SALT_NULL_THRESHOLD;
      return {
        pass,
        summary: `${saltNull}/${total} rows missing salt_100g (${(rate * 100).toFixed(1)}%, threshold ${(SALT_NULL_THRESHOLD * 100).toFixed(0)}%)`,
        diagnosis: pass
          ? undefined
          : "Salt-null rate is high — sodium likely dropped in the CoFID Inorganics->CSV flatten. Sodium lives on a separate sheet from the Proximates macros; if that sheet didn't make it into the flattened CSV, toSaltG() had nothing to run on for these rows.",
      };
    },
  },
  {
    id: "4b",
    title: "Salt magnitude — reference spot-check + conversion-error signatures",
    mode: "review",
    sql: `-- 4b. Salt magnitude — reference spot-check + conversion-error signatures ------
select slug, display_name, salt_100g
from public.core_ingredients
where slug in ('whole-milk','cheddar','butter','table-salt','soy-sauce')
order by salt_100g nulls first;
-- Order-of-magnitude sanity (exact figures vary by CoFID entry — check the shape, not the decimal):
--   whole-milk ~0.1 g   cheddar ~1.5–1.9 g   butter (salted) ~1.5–1.8 g
--   table-salt ~90–100 g   soy-sauce single-digit g
--
-- Failure signatures — each points at a specific broken step:
--   ~2.5x too low   (e.g. milk ~0.04)      => the x2.5 sodium->salt step was skipped
--   ~1000x too high (e.g. milk ~40–110)    => mg->g (/1000) was skipped
--   NULL where a value is expected         => sodium dropped in the flatten (see 4a)

-- broad outlier catch for the same conversion errors across all rows:
select slug, display_name, salt_100g
from public.core_ingredients
where salt_100g > 5
order by salt_100g desc;
-- Legitimately high: table-salt (~100), stock cubes, yeast extract, soy sauce.
-- If ordinary foods (milk, flour, plain veg) show large numbers here => mg->g missing.`,
    evaluate: (rows) => {
      const reference = REFERENCE_SALT_SLUGS.map((slug) => {
        const r = rows.find((row) => row.slug === slug);
        return { slug, display_name: r?.display_name ?? "(not found)", salt_100g: r?.salt_100g ?? null };
      }).sort((a, b) => (a.salt_100g ?? -1) - (b.salt_100g ?? -1));

      const outliers = rows
        .filter((r) => r.salt_100g != null && r.salt_100g > 5)
        .sort((a, b) => (b.salt_100g ?? 0) - (a.salt_100g ?? 0))
        .map((r) => ({ slug: r.slug, display_name: r.display_name, salt_100g: r.salt_100g }));

      return {
        tables: [
          {
            label: "reference spot-check",
            rows: reference,
            note:
              "Order-of-magnitude sanity only — CoFID figures vary, don't compare decimals. Expected shape: " +
              "whole-milk ~0.1g, cheddar ~1.5-1.9g, butter (salted) ~1.5-1.8g, table-salt ~90-100g, soy-sauce single-digit g. " +
              "~2.5x too low => the x2.5 sodium->salt step was skipped. ~1000x too high => mg->g (/1000) was skipped.",
          },
          {
            label: "outliers (salt_100g > 5)",
            rows: outliers,
            note:
              "Legitimately high: table-salt (~100), stock cubes, yeast extract, soy sauce. " +
              "An ORDINARY food (milk, flour, plain veg) here => mg->g conversion missing.",
          },
        ],
      };
    },
  },
  {
    id: "5",
    title: "Zero-collapse guard — the ?? 0 bug this project keeps stamping out",
    mode: "assert",
    sql: `-- 5. Zero-collapse guard — the ?? 0 bug this project keeps stamping out --------
select slug, display_name, source, kcal_100g, protein_100g, carbs_100g, fat_100g
from public.core_ingredients
where kcal_100g = 0
  and slug not in ('table-salt', 'bicarbonate-of-soda') -- inorganic — genuinely 0 in CoFID, see verify.ts's ZERO_KCAL_ALLOWLIST
order by display_name;
-- kcal exactly 0 is implausible for virtually every OTHER staple in the list =>
-- smoking gun for a NULL silently coalesced to 0 on write. EXPECT: 0 rows.
-- (protein/carbs/fat = 0 can be legitimate — oils have 0 carbs, sugar 0 protein —
--  so those are NOT alarms on their own.)`,
    evaluate: (rows) => {
      const offenders = rows
        .filter((r) => r.kcal_100g === 0 && !ZERO_KCAL_ALLOWLIST.has(r.slug))
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
      return {
        pass: offenders.length === 0,
        summary: `${offenders.length} row(s) with kcal_100g = 0`,
        diagnosis:
          offenders.length > 0
            ? `NULL coalesced to 0 on write (the ?? 0 bug): ${offenders.map((o) => o.slug).join(", ")}. kcal=0 is implausible for virtually every staple in this list.`
            : undefined,
        rows: offenders.map((r) => ({
          slug: r.slug,
          display_name: r.display_name,
          source: r.source,
          kcal_100g: r.kcal_100g,
          protein_100g: r.protein_100g,
          carbs_100g: r.carbs_100g,
          fat_100g: r.fat_100g,
        })),
      };
    },
  },
  {
    id: "6",
    title: "Informational — coverage on the legitimately-nullable four",
    mode: "review",
    sql: `-- 6. Informational — coverage on the legitimately-nullable four ---------------
select
  count(*) filter (where satfat_100g is null) as satfat_null,
  count(*) filter (where sugar_100g  is null) as sugar_null,
  count(*) filter (where fibre_100g  is null) as fibre_null,
  count(*) filter (where salt_100g   is null) as salt_null,
  count(*) as total
from public.core_ingredients;
-- These four are nullable by design; some NULLs are expected and CORRECT — not a bug.
-- One thing to glance at: if fibre_null is suspiciously high, it can hint the AOAC
-- fibre column wasn't the one picked up (Englyst column matched instead, or neither).`,
    evaluate: (rows) => {
      const total = rows.length;
      const satfat_null = rows.filter((r) => r.satfat_100g == null).length;
      const sugar_null = rows.filter((r) => r.sugar_100g == null).length;
      const fibre_null = rows.filter((r) => r.fibre_100g == null).length;
      const salt_null = rows.filter((r) => r.salt_100g == null).length;

      const note =
        total > 0 && fibre_null / total > 0.3
          ? `fibre_null is ${((fibre_null / total) * 100).toFixed(0)}% of rows — worth checking the AOAC fibre column was the one matched (not Englyst, not missed entirely). See check 2's cofid.ts header comment.`
          : "These four are nullable by design; some NULLs are expected and correct — not a bug on their own.";

      return {
        tables: [{ label: "nullable-four coverage", rows: [{ satfat_null, sugar_null, fibre_null, salt_null, total }], note }],
      };
    },
  },
];

// ─── --emit-sql ──────────────────────────────────────────────

export function emitSql(): string {
  return [HEADER_SQL, ...CHECKS.map((c) => c.sql)].join("\n\n\n") + "\n";
}

// ─── Report printing ─────────────────────────────────────────

function printTable(rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  console.table(rows);
}

function runChecks(rows: IngredientRow[]): boolean {
  let allPassed = true;

  if (rows.length === 0) {
    console.warn(
      "\n[verify] core_ingredients is EMPTY. Have you run scripts/seedCoreIngredients.ts yet? " +
        "Checks below will run against zero rows and most will read as failures.\n",
    );
  }

  for (const check of CHECKS) {
    console.log(`\n─── [${check.id}] ${check.title} ${check.mode === "assert" ? "(assert)" : "(review — read, don't auto-trust)"} ───`);

    if (check.mode === "assert") {
      const result = check.evaluate(rows);
      console.log(result.pass ? `  PASS — ${result.summary}` : `  FAIL — ${result.summary}`);
      if (!result.pass) {
        allPassed = false;
        if (result.diagnosis) console.log(`  DIAGNOSIS: ${result.diagnosis}`);
        if (result.rows && result.rows.length > 0) printTable(result.rows);
      }
    } else {
      const result = check.evaluate(rows);
      for (const table of result.tables) {
        console.log(`  ${table.label} (${table.rows.length} row${table.rows.length === 1 ? "" : "s"}):`);
        printTable(table.rows);
        if (table.note) console.log(`  NOTE: ${table.note}`);
      }
    }
  }

  return allPassed;
}

// ─── Entry point ─────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--emit-sql")) {
    const outPath = join(__dirname, "verify.sql");
    writeFileSync(outPath, emitSql(), "utf-8");
    console.log(`[verify] Wrote ${outPath} from CHECKS[].sql — the two files cannot drift apart if this is re-run after any edit.`);
    return;
  }

  const supabase = createAdminClient();
  // No-arg select() — same pattern as src/lib/entries.ts's applyEntries()
  // (`.insert(rows).select()` -> `as MealEntry[]`) rather than fighting
  // postgrest-js's literal-string column-list type inference for a table
  // this small (~190 rows). Extra columns (id, aliases, verified, ...) just
  // ride along unused by IngredientRow.
  const { data, error } = await supabase.from("core_ingredients").select();
  if (error) {
    console.error(`[verify] Query failed: ${error.message}`);
    process.exit(1);
  }

  const rows = (data ?? []) as IngredientRow[];
  const allPassed = runChecks(rows);

  const assertCount = CHECKS.filter((c) => c.mode === "assert").length;
  console.log(
    `\n${allPassed ? "PASS" : "FAIL"} — ${assertCount} hard invariant(s) checked against ${rows.length} row(s). ${
      allPassed ? "" : "See DIAGNOSIS lines above."
    }`,
  );

  if (!allPassed) process.exit(1);
}

// Only auto-run when this file is THE entry script (`npx tsx
// scripts/seedIngredients/verify.ts`), never when something imports it for
// CHECKS/emitSql/etc — a test file doing exactly that must not trigger a
// live DB connection attempt (or process.exit) as a side effect of import.
// `require.main` is always the process's actual entry module, so this is
// true only for a direct run, never for a nested import — and the
// `typeof require` guard keeps this a no-op (not a crash) if this ever runs
// under a pure-ESM loader with no `require` global.
if (typeof require !== "undefined" && require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
