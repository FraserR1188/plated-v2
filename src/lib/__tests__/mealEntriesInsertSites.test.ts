// ============================================================
// src/lib/__tests__/mealEntriesInsertSites.test.ts
//
// A source-level (not runtime) invariant test. CLAUDE.md's architecture
// invariants — `date` derived from eaten_at, `planned`/`confirmed_at`/
// `skipped_at` never sent, no camelCase spread into a snake_case row — are
// only actually enforced by there being exactly TWO places a row is ever
// inserted into meal_entries: lib/entries.ts (applyEntries, the bulk path
// for copy-a-day / bundles / social) and store/useStore.ts (addEntry, the
// single-row path). Every other write goes through applyEntries().
//
// A third insert site would be a new, unreviewed place for those
// invariants to quietly not apply. This test fails loudly if one appears,
// or if either existing site starts spreading a draft/entry object instead
// of listing columns explicitly.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(process.cwd(), "src");

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !full.split(path.sep).includes("__tests__")
    ) {
      out.push(full);
    }
  }
  return out;
}

// Matches `.from("meal_entries")` (either quote style) followed, across any
// whitespace/newlines, by `.insert(` — the shape of every real insert call
// in this codebase (chained on the same statement, a few lines apart).
const INSERT_CALL = /\.from\(\s*["']meal_entries["']\s*\)\s*\.insert\(/g;

const files = walkTsFiles(SRC_ROOT);
const sites = files
  .map((file) => {
    const text = fs.readFileSync(file, "utf8");
    const count = text.match(INSERT_CALL)?.length ?? 0;
    return { file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"), count };
  })
  .filter((s) => s.count > 0);

describe("meal_entries insert sites (structural)", () => {
  it("has exactly two files under src/ that insert into meal_entries", () => {
    // If this fails because a THIRD site was added: stop. Route the write
    // through applyEntries() in src/lib/entries.ts instead of inserting
    // directly — see the comment at the top of that file for why.
    expect(sites.map((s) => s.file).sort()).toEqual([
      "lib/entries.ts",
      "store/useStore.ts",
    ]);
  });

  it("each site calls .insert() exactly once, not several scattered in one file", () => {
    for (const s of sites) {
      expect(s.count, `${s.file} has ${s.count} insert calls`).toBe(1);
    }
  });

  it("lib/entries.ts (applyEntries) derives `date` from eaten_at and never spreads the draft into the row", () => {
    const text = fs.readFileSync(path.join(SRC_ROOT, "lib/entries.ts"), "utf8");

    expect(text).toMatch(/date:\s*dateKey\(new Date\(d\.eaten_at\)\)/);
    expect(text).toMatch(/meal_type:\s*d\.meal_type/);

    // No `...d` / `...draft` spread inside the row builder — every column is
    // listed explicitly, so a forgotten field is a compile error, not a
    // silent null.
    expect(text).not.toMatch(/\.\.\.d\b/);
    expect(text).not.toMatch(/\.\.\.draft\b/);

    // planned / confirmed_at / skipped_at must never be sent — the BEFORE
    // INSERT trigger owns them.
    const insertBlock = text.slice(
      text.indexOf(".from(\"meal_entries\")"),
      text.indexOf(".select();") + 1,
    );
    expect(insertBlock).not.toMatch(/\bplanned:/);
    expect(insertBlock).not.toMatch(/\bconfirmed_at:/);
    expect(insertBlock).not.toMatch(/\bskipped_at:/);
  });

  it("store/useStore.ts (addEntry) takes an explicit {date, meal_type} and never spreads the caller's input", () => {
    const text = fs.readFileSync(path.join(SRC_ROOT, "store/useStore.ts"), "utf8");

    const match = text.match(/addEntry:\s*async[\s\S]*?\n  \},\n/);
    expect(match, "couldn't find the addEntry action in useStore.ts").toBeTruthy();
    const body = match![0];

    expect(body).toMatch(/date:\s*entry\.date/);
    expect(body).toMatch(/meal_type:\s*entry\.meal_type/);
    expect(body).not.toMatch(/\.\.\.entry\b/);

    expect(body).not.toMatch(/\bplanned:/);
    expect(body).not.toMatch(/\bconfirmed_at:/);
    expect(body).not.toMatch(/\bskipped_at:/);
  });
});
