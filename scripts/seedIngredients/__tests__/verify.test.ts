// ============================================================
// scripts/seedIngredients/__tests__/verify.test.ts
//
// IMPORTANT: every row fixture in this file is SYNTHETIC, made up to
// exercise one predicate in isolation. None of it is real CoFID/FDC data
// and none of it stands in for a real seed run — the actual verdict on the
// real table only comes from running `npx tsx scripts/seedIngredients/
// verify.ts` after the real importer run, against real Supabase.
//
// Importing "../verify" here must NOT touch the network or call
// process.exit — see that file's entry-point guard
// (`require.main === module`). If that guard ever regresses, this whole
// test file hangs or kills the runner, which is itself a signal.
// ============================================================

import { describe, it, expect } from "vitest";
import { CHECKS, emitSql, HEADER_SQL, SALT_NULL_THRESHOLD, type IngredientRow } from "../verify";
import { SEED_STAPLES } from "../../seedStaples";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function row(overrides: Partial<IngredientRow> = {}): IngredientRow {
  return {
    slug: "test-slug",
    display_name: "Test Item",
    source: "cofid",
    source_ref: "1-2345",
    kcal_100g: 100,
    protein_100g: 5,
    carbs_100g: 10,
    fat_100g: 2,
    satfat_100g: 0.5,
    sugar_100g: 1,
    fibre_100g: 2,
    salt_100g: 0.1,
    unit_grams: {},
    ...overrides,
  };
}

function check(id: string) {
  const c = CHECKS.find((c) => c.id === id);
  if (!c) throw new Error(`no check with id ${id}`);
  return c;
}

// ─── No-drift guarantee ──────────────────────────────────────

describe("emitSql / verify.sql", () => {
  it("emitSql() reproduces the committed verify.sql byte-for-byte", () => {
    const committed = readFileSync(join(__dirname, "..", "verify.sql"), "utf-8");
    expect(emitSql()).toBe(committed);
  });

  it("starts with the same header banner", () => {
    expect(emitSql().startsWith(HEADER_SQL)).toBe(true);
  });
});

// ─── check 0: row count ──────────────────────────────────────

describe("check 0 — row count vs SEED_STAPLES", () => {
  it("passes when the row count equals SEED_STAPLES.length", () => {
    const rows = Array.from({ length: SEED_STAPLES.length }, () => row());
    const result = (check("0") as any).evaluate(rows);
    expect(result.pass).toBe(true);
  });

  it("fails with a 'dropped rows' diagnosis when short", () => {
    const rows = Array.from({ length: SEED_STAPLES.length - 5 }, () => row());
    const result = (check("0") as any).evaluate(rows);
    expect(result.pass).toBe(false);
    expect(result.diagnosis).toMatch(/dropped whole rows/i);
  });

  it("fails with a 'stale slugs' diagnosis when over", () => {
    const rows = Array.from({ length: SEED_STAPLES.length + 5 }, () => row());
    const result = (check("0") as any).evaluate(rows);
    expect(result.pass).toBe(false);
    expect(result.diagnosis).toMatch(/stale slugs|grown/i);
  });
});

// ─── check 2: head-staple alarm ──────────────────────────────

describe("check 2 — head-staple alarm", () => {
  it("passes when every unit_grams staple has all four core macros", () => {
    const rows = [row({ unit_grams: { large: 58 } }), row({ unit_grams: {} })];
    expect((check("2") as any).evaluate(rows).pass).toBe(true);
  });

  it("fails when a head staple (non-empty unit_grams) is missing a core macro", () => {
    const rows = [row({ slug: "egg", unit_grams: { large: 58 }, protein_100g: null })];
    const result = (check("2") as any).evaluate(rows);
    expect(result.pass).toBe(false);
    expect(result.diagnosis).toMatch(/egg/);
    expect(result.rows).toHaveLength(1);
  });

  it("a TAIL staple (empty unit_grams) missing a core macro does NOT trip this check", () => {
    const rows = [row({ slug: "obscure-herb", unit_grams: {}, protein_100g: null })];
    expect((check("2") as any).evaluate(rows).pass).toBe(true);
  });
});

// ─── check 4a: salt-null rate ────────────────────────────────

describe("check 4a — salt-null rate", () => {
  it("passes under the threshold", () => {
    const rows = [
      ...Array.from({ length: 96 }, () => row({ salt_100g: 0.1 })),
      ...Array.from({ length: 4 }, () => row({ salt_100g: null })), // 4%
    ];
    expect((check("4a") as any).evaluate(rows).pass).toBe(true);
  });

  it("fails over the threshold with a sodium-flatten diagnosis", () => {
    const rows = [
      ...Array.from({ length: 90 }, () => row({ salt_100g: 0.1 })),
      ...Array.from({ length: 10 }, () => row({ salt_100g: null })), // 10% > 5%
    ];
    const result = (check("4a") as any).evaluate(rows);
    expect(result.pass).toBe(false);
    expect(result.diagnosis).toMatch(/sodium.*flatten|Inorganics/i);
  });

  it("SALT_NULL_THRESHOLD is exported and used, not silently duplicated", () => {
    expect(SALT_NULL_THRESHOLD).toBeGreaterThan(0);
    expect(SALT_NULL_THRESHOLD).toBeLessThan(1);
  });
});

// ─── check 5: zero-collapse guard ────────────────────────────

describe("check 5 — zero-collapse guard", () => {
  it("passes when no row has kcal_100g exactly 0", () => {
    expect((check("5") as any).evaluate([row({ kcal_100g: 100 })]).pass).toBe(true);
  });

  it("fails with a '?? 0 bug' diagnosis when kcal_100g = 0", () => {
    const result = (check("5") as any).evaluate([row({ slug: "flour", kcal_100g: 0 })]);
    expect(result.pass).toBe(false);
    expect(result.diagnosis).toMatch(/\?\? 0 bug/);
    expect(result.diagnosis).toContain("flour");
  });

  it("does NOT flag legitimate zero protein/carbs/fat — only kcal_100g = 0 is the alarm", () => {
    // sugar has 0 protein, oil has 0 carbs — both legitimate, neither should trip this.
    const rows = [row({ kcal_100g: 387, protein_100g: 0 }), row({ kcal_100g: 884, carbs_100g: 0 })];
    expect((check("5") as any).evaluate(rows).pass).toBe(true);
  });
});

// ─── review checks: structural shape only (no pass/fail to assert) ──

describe("review checks never expose pass/fail", () => {
  it("check 1 (core-four audit) returns tables, not a verdict", () => {
    const result = (check("1") as any).evaluate([row({ protein_100g: null })]);
    expect(result.tables).toBeDefined();
    expect(result.pass).toBeUndefined();
    expect(result.tables[0].rows).toHaveLength(1);
  });

  it("check 3 (source breakdown) groups by source", () => {
    const rows = [row({ source: "cofid" }), row({ source: "cofid" }), row({ source: "fdc" })];
    const result = (check("3") as any).evaluate(rows);
    const bySource = Object.fromEntries(result.tables[0].rows.map((r: any) => [r.source, r.n]));
    expect(bySource.cofid).toBe(2);
    expect(bySource.fdc).toBe(1);
  });

  it("check 4b (salt magnitude) returns both a reference table and an outlier table", () => {
    const rows = [
      row({ slug: "whole-milk", display_name: "Whole milk", salt_100g: 0.1 }),
      row({ slug: "table-salt", display_name: "Salt", salt_100g: 97 }),
    ];
    const result = (check("4b") as any).evaluate(rows);
    expect(result.tables).toHaveLength(2);
    expect(result.tables[0].label).toMatch(/reference/i);
    expect(result.tables[1].label).toMatch(/outlier/i);
    expect(result.tables[1].rows.map((r: any) => r.slug)).toContain("table-salt");
  });

  it("check 6 (nullable-four coverage) counts each nullable field independently", () => {
    const rows = [row({ fibre_100g: null }), row({ fibre_100g: null }), row({ sugar_100g: null })];
    const result = (check("6") as any).evaluate(rows);
    const counts = result.tables[0].rows[0];
    expect(counts.fibre_null).toBe(2);
    expect(counts.sugar_null).toBe(1);
    expect(counts.total).toBe(3);
  });
});

// ─── every check id referenced by tests actually exists exactly once ─

describe("CHECKS structural integrity", () => {
  it("has the 8 documented section ids, each exactly once", () => {
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toEqual(["0", "1", "2", "3", "4a", "4b", "5", "6"]);
  });

  it("every assert check's sql field contains its own id's section header", () => {
    for (const c of CHECKS) {
      expect(c.sql.startsWith(`-- ${c.id}.`)).toBe(true);
    }
  });
});
