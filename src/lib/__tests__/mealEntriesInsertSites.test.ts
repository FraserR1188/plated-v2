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
// The repo stores LF; core.autocrlf converts to CRLF on checkout on
// Windows. Every text read below is normalized back to LF before it's
// matched or parsed, so neither detection method depends on which OS
// checked the working copy out.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC_ROOT = path.resolve(process.cwd(), "src");

function readNormalized(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

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
    const text = readNormalized(file);
    const count = text.match(INSERT_CALL)?.length ?? 0;
    return { file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"), count };
  })
  .filter((s) => s.count > 0);

// ============================================================
// AST helper — used by #3 and #4 only. #1/#2 stay regex-based deliberately;
// see the file-header comment.
//
// Finds every CallExpression shaped `<expr>.from("meal_entries").insert(<arg>)`
// in a source file and returns the ObjectLiteralExpression(s) passed to
// insert(), so a test can assert on property names instead of matching text.
//
// HARD REQUIREMENT: this must never silently return an empty list for an
// argument it can't actually inspect. An `.insert(someOpaqueThing)` that
// this helper can't see into throws, loudly, rather than letting the
// caller's property-presence assertions trivially pass against nothing.
// ============================================================

/** Everything actually inserted into meal_entries in this codebase, either a
 *  literal object, a literal array of objects, or a `const rows = xs.map(...)`
 *  whose callback returns one object-literal shape (entries.ts's `rows`).
 *  Anything else — a bare identifier this can't trace, a spread of a
 *  variable, a function call that isn't `.map(...)` — is NOT this helper's
 *  job to guess at, and it throws instead of guessing. */
function extractObjectLiterals(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string,
): ts.ObjectLiteralExpression[] {
  if (ts.isObjectLiteralExpression(expr)) {
    return [expr];
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((el) => {
      if (!ts.isObjectLiteralExpression(el)) {
        throw new Error(
          `${fileName}: insert() array contains a non-object-literal element ` +
            `(${ts.SyntaxKind[el.kind]}) — can't inspect it`,
        );
      }
      return el;
    });
  }

  // `xs.map((d) => ({...}))` or `xs.map((d) => { ...; return {...}; })` — the
  // array's SHAPE is the callback's returned object literal. One shape, not
  // one per element (the callback runs once per row at runtime, not once per
  // parse), so return it once.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "map" &&
    expr.arguments.length === 1
  ) {
    const callback = expr.arguments[0];
    if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
      const returned = findReturnedObjectLiteral(callback.body);
      if (returned) return [returned];
    }
    throw new Error(
      `${fileName}: insert() argument is a .map() call whose callback doesn't ` +
        `visibly return a single object literal — can't inspect it`,
    );
  }

  // A bare identifier: resolve to its local declaration and recurse on the
  // initializer, one hop. This is what makes entries.ts's
  // `const rows = drafts.map((d) => ({...})); ... .insert(rows)` inspectable
  // without a full type-checker.
  if (ts.isIdentifier(expr)) {
    const decl = findVariableDeclaration(sourceFile, expr.text);
    if (decl?.initializer) {
      return extractObjectLiterals(decl.initializer, sourceFile, fileName);
    }
    throw new Error(
      `${fileName}: insert() argument "${expr.text}" isn't a local const/let ` +
        `this helper can trace to a declaration — can't inspect it`,
    );
  }

  throw new Error(
    `${fileName}: insert() argument is not an inline object literal, an array ` +
      `of them, or a traceable .map() over one (got ${ts.SyntaxKind[expr.kind]}) — can't inspect it`,
  );
}

function findReturnedObjectLiteral(
  body: ts.ConciseBody,
): ts.ObjectLiteralExpression | null {
  if (ts.isParenthesizedExpression(body)) {
    return ts.isObjectLiteralExpression(body.expression)
      ? body.expression
      : null;
  }
  if (ts.isObjectLiteralExpression(body)) {
    return body;
  }
  if (ts.isBlock(body)) {
    let result: ts.ObjectLiteralExpression | null = null;
    for (const stmt of body.statements) {
      if (!ts.isReturnStatement(stmt) || !stmt.expression) continue;
      const returned = stmt.expression;
      if (ts.isParenthesizedExpression(returned)) {
        result = ts.isObjectLiteralExpression(returned.expression)
          ? returned.expression
          : result;
      } else if (ts.isObjectLiteralExpression(returned)) {
        result = returned;
      }
    }
    return result;
  }
  return null;
}

function findVariableDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/** Is `expr` the callee's object in `<expr>.from("meal_entries")`? */
function isMealEntriesFromCall(expr: ts.Node): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "from" &&
    expr.arguments.length === 1 &&
    ts.isStringLiteral(expr.arguments[0]) &&
    expr.arguments[0].text === "meal_entries"
  );
}

/** Parse `text` and return the object literal(s) passed to every
 *  `.from("meal_entries").insert(...)` call found in it. Throws if the file
 *  has such a call but the argument isn't something extractObjectLiterals
 *  can actually inspect; throws if the file has NO such call at all, so a
 *  caller that expected one can't mistake "found nothing" for "found an
 *  empty object". */
function findMealEntriesInsertObjectLiterals(
  text: string,
  fileName: string,
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
      node.expression.name.text === "insert" &&
      isMealEntriesFromCall(node.expression.expression)
    ) {
      const [arg] = node.arguments;
      if (!arg) {
        throw new Error(`${fileName}: .insert() called with no arguments`);
      }
      results.push(...extractObjectLiterals(arg, sourceFile, fileName));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (results.length === 0) {
    throw new Error(
      `${fileName}: no .from("meal_entries").insert(...) call found`,
    );
  }
  return results;
}

function propertyNames(obj: ts.ObjectLiteralExpression): string[] {
  return obj.properties
    .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p))
    .map((p) => p.name.getText());
}

function hasSpread(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => ts.isSpreadAssignment(p));
}

function initializerTextOf(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): string | undefined {
  const prop = obj.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText() === propName,
  );
  return prop?.initializer.getText();
}

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
    const [obj] = findMealEntriesInsertObjectLiterals(text, "lib/entries.ts");

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
    const [obj] = findMealEntriesInsertObjectLiterals(text, "store/useStore.ts");

    const names = propertyNames(obj);
    expect(names).toContain("date");
    expect(names).toContain("meal_type");
    expect(names).not.toContain("planned");
    expect(names).not.toContain("confirmed_at");
    expect(names).not.toContain("skipped_at");

    expect(hasSpread(obj)).toBe(false);
  });
});