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
//
// TWO INDEPENDENT DETECTION METHODS ON PURPOSE. #1/#2 find insert sites by
// regex on `.from("meal_entries").insert(`; #3/#4 find the SAME call sites
// by parsing the AST and inspecting the actual object literal(s) passed to
// insert(). Neither reads the other's result. If they ever disagree —
// regex finds a site the AST walk can't parse, or vice versa — that
// disagreement is itself the signal something changed shape.
//
// UPDATE COVERAGE (added alongside a NULL-not-zero fix to
// mealEntryToProduct): the invariants above are about WRITES to
// meal_entries, and .update() is a write just as much as .insert() is —
// ProductScreen's edit path is exactly how a NULL macro got fabricated
// into a stored 0 (see foodLookup.mealEntryToProduct's fix). The walker
// below is parameterised over ["insert", "update"] so the same AST
// machinery covers both, rather than forking a second copy of it.
//
// The repo stores LF; core.autocrlf converts to CRLF on checkout on
// Windows. Every text read below is normalized back to LF before it's
// matched or parsed, so neither detection method depends on which OS
// checked the working copy out.
//
// The generic AST machinery (object-literal tracing, spread detection,
// property inspection) lives in helpers/astWrites.ts, shared with
// receiptWriteSites.test.ts. It moved there unchanged; the meal-specific
// finders and every assertion below are as they were.
// ============================================================

import { describe, it, expect } from "vitest";
import path from "node:path";
import ts from "typescript";
import {
  SRC_ROOT,
  readNormalized,
  walkTsFiles,
  extractObjectLiterals,
  findSpreadOfUninspectableSource,
  nearestPropertyAssignmentName,
  propertyNames,
  hasSpread,
  initializerTextOf,
  isFromCall,
} from "./helpers/astWrites";

// Matches `.from("meal_entries")` (either quote style) followed, across any
// whitespace/newlines, by `.insert(` — the shape of every real insert call
// in this codebase (chained on the same statement, a few lines apart).
const INSERT_CALL = /\.from\(\s*["']meal_entries["']\s*\)\s*\.insert\(/g;

// Same shape, for `.update(`. Kept as its own regex (not reused across both
// methods) for the same reason INSERT_CALL is regex-based at all: this is
// detection method #1/#2's independence from the AST walk, and folding
// insert/update into one pattern would blur which method actually matched.
const UPDATE_CALL = /\.from\(\s*["']meal_entries["']\s*\)\s*\.update\(/g;

const files = walkTsFiles(SRC_ROOT);

function countCallSites(pattern: RegExp) {
  return files
    .map((file) => {
      const text = readNormalized(file);
      const count = text.match(pattern)?.length ?? 0;
      return { file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"), count };
    })
    .filter((s) => s.count > 0);
}

const sites = countCallSites(INSERT_CALL);
const updateSites = countCallSites(UPDATE_CALL);

// ============================================================
// AST helper — used by #3 and #4 only. #1/#2 stay regex-based deliberately;
// see the file-header comment.
//
// Finds every CallExpression shaped `<expr>.from("meal_entries").<method>(<arg>)`
// in a source file and returns the ObjectLiteralExpression(s) passed to it,
// so a test can assert on property names instead of matching text.
//
// HARD REQUIREMENT: this must never silently return an empty list for an
// argument it can't actually inspect. A `.insert(someOpaqueThing)` (or
// `.update(...)`) that this helper can't see into throws, loudly, rather
// than letting the caller's property-presence assertions trivially pass
// against nothing.
// ============================================================

/** Is `expr` the callee's object in `<expr>.from("meal_entries")`? */
function isMealEntriesFromCall(expr: ts.Node): boolean {
  return isFromCall(expr, "meal_entries");
}

/** Parse `text` and return the object literal(s) passed to every
 *  `.from("meal_entries").<methodName>(...)` call found in it. Throws if the
 *  file has such a call but the argument isn't something
 *  extractObjectLiterals can actually inspect, OR if it resolves to an
 *  object literal that spreads an uninspectable source (see
 *  findSpreadOfUninspectableSource); throws if the file has NO such call at
 *  all, so a caller that expected one can't mistake "found nothing" for
 *  "found an empty object". */
function findMealEntriesCallObjectLiterals(
  text: string,
  fileName: string,
  methodName: "insert" | "update",
): ts.ObjectLiteralExpression[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const results: ts.ObjectLiteralExpression[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === methodName &&
      isMealEntriesFromCall(node.expression.expression)
    ) {
      const [arg] = node.arguments;
      if (!arg) {
        throw new Error(`${fileName}: .${methodName}() called with no arguments`);
      }
      const literals = extractObjectLiterals(arg, sourceFile, fileName);
      for (const lit of literals) {
        const badSpread = findSpreadOfUninspectableSource(lit, sourceFile);
        if (badSpread) {
          throw new Error(
            `${fileName}: .${methodName}() payload spreads ` +
              `"${badSpread.expression.getText()}", which isn't a traceable ` +
              `local object literal — can't inspect its keys for this guard`,
          );
        }
      }
      results.push(...literals);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (results.length === 0) {
    throw new Error(
      `${fileName}: no .from("meal_entries").${methodName}(...) call found`,
    );
  }
  return results;
}

type UpdateSite = {
  /** Enclosing store-action name, e.g. "updateEntry", "confirmEntries". */
  name: string;
  /** The payload object literal, or null if this site's payload can't be
   *  statically inspected (see `reason`). */
  literal: ts.ObjectLiteralExpression | null;
  /** Why `literal` is null. Always present when `literal` is null, always
   *  absent when it isn't. */
  reason: string | null;
};

/** Same call shape as findMealEntriesCallObjectLiterals, restricted to
 *  `.update(...)`, but COLLECTS every site instead of throwing on the first
 *  uninspectable one. Bug 1 (mealEntryToProduct fabricating a zero for a
 *  NULL small-macro) travelled through exactly one of several `.update()`
 *  calls in this file — confirmEntries, skipEntries and retimeEntries all
 *  also update meal_entries, for unrelated reasons, and none of them should
 *  make a genuinely-uninspectable payload elsewhere in the file invisible
 *  to the caller. A throw-on-first-bad-site helper can't express "here is
 *  the complete set of sites, and here is which ones I could and couldn't
 *  see into" — this one can. */
function findMealEntriesUpdateSites(
  text: string,
  fileName: string,
): UpdateSite[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const results: UpdateSite[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "update" &&
      isMealEntriesFromCall(node.expression.expression)
    ) {
      const name = nearestPropertyAssignmentName(node) ?? "<unnamed>";
      const [arg] = node.arguments;

      if (!arg) {
        results.push({
          name,
          literal: null,
          reason: "update() called with no arguments",
        });
      } else {
        try {
          const literals = extractObjectLiterals(arg, sourceFile, fileName);
          for (const lit of literals) {
            const badSpread = findSpreadOfUninspectableSource(lit, sourceFile);
            if (badSpread) {
              results.push({
                name,
                literal: null,
                reason:
                  `payload spreads "${badSpread.expression.getText()}", ` +
                  `which isn't a traceable local object literal`,
              });
            } else {
              results.push({ name, literal: lit, reason: null });
            }
          }
        } catch (e) {
          results.push({ name, literal: null, reason: (e as Error).message });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (results.length === 0) {
    throw new Error(
      `${fileName}: no .from("meal_entries").update(...) call found`,
    );
  }
  return results;
}

const NUTRIENT_KEYS = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "sat_fat",
  "salt",
  "fibre",
  "sugar",
];

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
    const file = path.join(SRC_ROOT, "lib/entries.ts");
    const text = readNormalized(file);
    const [obj] = findMealEntriesCallObjectLiterals(
      text,
      "lib/entries.ts",
      "insert",
    );

    const names = propertyNames(obj);
    expect(names).toContain("date");
    expect(names).toContain("meal_type");
    expect(names).not.toContain("planned");
    expect(names).not.toContain("confirmed_at");
    expect(names).not.toContain("skipped_at");

    // No `...d` / `...draft` spread inside the row builder — every column is
    // listed explicitly, so a forgotten field is a compile error, not a
    // silent null.
    expect(hasSpread(obj)).toBe(false);

    // Stronger than presence: `date` must be DERIVED from eaten_at via
    // dateKey(), not passed through or picked independently — that
    // divergence is the D2 bug (see the file-header comment in entries.ts).
    expect(initializerTextOf(obj, "date")).toBe(
      "dateKey(new Date(d.eaten_at))",
    );
  });

  it("store/useStore.ts (addEntry) takes an explicit {date, meal_type} and never spreads the caller's input", () => {
    const file = path.join(SRC_ROOT, "store/useStore.ts");
    const text = readNormalized(file);
    const [obj] = findMealEntriesCallObjectLiterals(
      text,
      "store/useStore.ts",
      "insert",
    );

    const names = propertyNames(obj);
    expect(names).toContain("date");
    expect(names).toContain("meal_type");
    expect(names).not.toContain("planned");
    expect(names).not.toContain("confirmed_at");
    expect(names).not.toContain("skipped_at");

    expect(hasSpread(obj)).toBe(false);
  });
});

describe("meal_entries update sites (structural)", () => {
  it("useStore.ts is the only file under src/ that updates meal_entries", () => {
    // Unlike insert (one row-creation action per file), a single file
    // legitimately owns several DISTINCT update actions here — edit,
    // confirm (x2 branches), skip, retime — so the invariant worth
    // encoding isn't a call count, it's ownership: every write-side rule
    // this file exists to protect only actually holds if every update to
    // meal_entries lives in the one file reviewed for them.
    expect(updateSites.map((s) => s.file).sort()).toEqual([
      "store/useStore.ts",
    ]);
  });

  // ────────────────────────────────────────────────────────────────────
  // THE GAP THIS SECTION EXISTS TO NAME.
  //
  // ProductScreen's edit path — the one that fabricated a stored 0 for a
  // NULL small-macro, which is what motivated adding update coverage to
  // this file at all — writes through updateEntry's .update() call.
  // updateEntry builds its payload as
  // `const next: Record<string, unknown> = { ...patch };`, a spread of
  // `patch`, a function PARAMETER. No static analysis in this file (or any
  // file) can see what keys a caller puts in `patch` at runtime — that is
  // a fact about ProductScreen.tsx, not about useStore.ts's source text.
  //
  // So: THIS TEST FILE GIVES NO COVERAGE OF BUG 1'S ACTUAL WRITE PATH, and
  // the assertion below exists to keep that fact loud rather than let a
  // "no traceable payload contains a stray zero" green checkmark be read
  // as "the edit path is safe." It isn't checked; it's structurally
  // unreachable to check, in its current shape.
  //
  // The assertion is an EXACT set match against {"updateEntry"} — not "at
  // least", not "ignoring known cases" — so it fails in both directions:
  //   - a SECOND uninspectable update payload appears anywhere in this
  //     file (a new unguarded write, silently) → fails, because the set
  //     is no longer exactly {updateEntry}.
  //   - updateEntry itself stops spreading `patch` (the real fix: an
  //     explicit, keyof-MealEntryPatch-exhaustiveness-checked snake_case
  //     field list, deferred to its own commit because it rewrites the
  //     live edit path) → also fails, because the set becomes empty and
  //     this exemption is now stale. At that point DELETE this test and
  //     let the ordinary nutrient-zero-literal check below cover
  //     updateEntry like every other site — do not widen the exemption.
  // ────────────────────────────────────────────────────────────────────
  it("the set of uninspectable meal_entries update payloads is exactly {updateEntry} — not more, not fewer", () => {
    const file = path.join(SRC_ROOT, "store/useStore.ts");
    const text = readNormalized(file);
    const updateSitesAst = findMealEntriesUpdateSites(text, "store/useStore.ts");

    const uninspectable = new Set(
      updateSitesAst.filter((s) => s.literal === null).map((s) => s.name),
    );
    expect(uninspectable).toEqual(new Set(["updateEntry"]));
  });

  it("every traceable meal_entries update payload never assigns a numeric-zero literal to a nutrient key", () => {
    const file = path.join(SRC_ROOT, "store/useStore.ts");
    const text = readNormalized(file);
    const updateSitesAst = findMealEntriesUpdateSites(text, "store/useStore.ts");

    for (const site of updateSitesAst) {
      // updateEntry is covered (as "uninspectable, and that's the finding")
      // by the exact-set assertion above, not here — skipping it here is
      // not the same silent tolerance that assertion guards against.
      if (!site.literal) continue;
      for (const key of NUTRIENT_KEYS) {
        const init = initializerTextOf(site.literal, key);
        if (init === undefined) continue;
        expect(
          init.trim(),
          `${site.name}.${key} initializer: ${init}`,
        ).not.toBe("0");
      }
    }
  });

  it("no traceable meal_entries update payload outside updateEntry carries a nutrient key at all", () => {
    const file = path.join(SRC_ROOT, "store/useStore.ts");
    const text = readNormalized(file);
    const updateSitesAst = findMealEntriesUpdateSites(text, "store/useStore.ts");

    for (const site of updateSitesAst) {
      if (!site.literal || site.name === "updateEntry") continue;
      const nutrientKeysPresent = propertyNames(site.literal).filter((n) =>
        NUTRIENT_KEYS.includes(n),
      );
      expect(
        nutrientKeysPresent,
        `${site.name} unexpectedly carries nutrient key(s)`,
      ).toEqual([]);
    }
  });
});
