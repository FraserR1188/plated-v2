// ============================================================
// src/lib/__tests__/helpers/astWrites.ts — the source-level write-site
// machinery shared by the structural guards:
//   mealEntriesInsertSites.test.ts  (meal_entries: exactly two insert sites)
//   receiptWriteSites.test.ts       (receipts: exactly three RPC doors)
//
// Extracted unchanged from mealEntriesInsertSites.test.ts (receipt scanner
// commit 4b, findings §8); only `export` was added. The HARD REQUIREMENT
// that file states holds for every helper here: a payload this machinery
// can't see into THROWS, it never comes back as an empty list a guard
// would trivially pass against.
//
// The repo stores LF; core.autocrlf converts to CRLF on checkout on
// Windows. Every text read is normalized back to LF before it's matched or
// parsed, so no guard depends on which OS checked the working copy out.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const SRC_ROOT = path.resolve(process.cwd(), "src");

/** Parse a file's text as TypeScript with parent pointers set. */
export function parseSource(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Is `expr` the callee's object in `<expr>.from("<table>")`? */
export function isFromCall(expr: ts.Node, table: string): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "from" &&
    expr.arguments.length === 1 &&
    ts.isStringLiteral(expr.arguments[0]) &&
    expr.arguments[0].text === table
  );
}

export function readNormalized(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

export function walkTsFiles(dir: string, out: string[] = []): string[] {
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

/** Everything actually inserted/updated into meal_entries in this codebase,
 *  either a literal object, a literal array of objects, or a
 *  `const rows = xs.map(...)` whose callback returns one object-literal
 *  shape (entries.ts's `rows`). Anything else — a bare identifier this
 *  can't trace, a spread of a variable, a function call that isn't
 *  `.map(...)` — is NOT this helper's job to guess at, and it throws
 *  instead of guessing. */
export function extractObjectLiterals(
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
          `${fileName}: insert()/update() array contains a non-object-literal ` +
            `element (${ts.SyntaxKind[el.kind]}) — can't inspect it`,
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
      `${fileName}: insert()/update() argument is a .map() call whose callback ` +
        `doesn't visibly return a single object literal — can't inspect it`,
    );
  }

  // A bare identifier: resolve to its local declaration and recurse on the
  // initializer, one hop. This is what makes entries.ts's
  // `const rows = drafts.map((d) => ({...})); ... .insert(rows)` inspectable
  // without a full type-checker — and, symmetrically, what makes useStore.ts's
  // `const next = { ...patch }; ... .update(next)` resolvable far enough to
  // discover that ITS shape is opaque (see resolvesToObjectLiteral below).
  if (ts.isIdentifier(expr)) {
    const decl = findVariableDeclaration(sourceFile, expr.text);
    if (decl?.initializer) {
      return extractObjectLiterals(decl.initializer, sourceFile, fileName);
    }
    throw new Error(
      `${fileName}: insert()/update() argument "${expr.text}" isn't a local ` +
        `const/let this helper can trace to a declaration — can't inspect it`,
    );
  }

  throw new Error(
    `${fileName}: insert()/update() argument is not an inline object literal, ` +
      `an array of them, or a traceable .map() over one (got ${ts.SyntaxKind[expr.kind]}) — can't inspect it`,
  );
}

export function findReturnedObjectLiteral(
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

export function findVariableDeclaration(
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

/** Does `expr` resolve to a statically-inspectable object literal? An
 *  object literal resolves to itself; a bare identifier resolves ONE hop to
 *  a local const/let's initializer (recursively, so a chain of aliases
 *  still resolves); anything else — most importantly a FUNCTION PARAMETER,
 *  which findVariableDeclaration cannot find because it only looks for
 *  ts.VariableDeclaration nodes — resolves to null. This is what lets
 *  findSpreadOfUninspectableSource tell "spreads a local object we can see
 *  into" apart from "spreads a parameter whose shape is a runtime fact this
 *  file cannot know." */
export function resolvesToObjectLiteral(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) {
    const decl = findVariableDeclaration(sourceFile, expr.text);
    if (decl?.initializer) {
      return resolvesToObjectLiteral(decl.initializer, sourceFile);
    }
  }
  return null;
}

/** Property-presence assertions (propertyNames, hasSpread, initializerTextOf
 *  below) only see PropertyAssignments — a SpreadAssignment's keys are
 *  invisible to them by construction. That's fine when the spread source is
 *  itself a traceable local object literal (this function would find no
 *  problem and the caller's own hasSpread() check still flags the spread as
 *  a spread). It stops being fine when the source can't be traced at all —
 *  at that point "no forbidden key found" and "this file cannot see the
 *  payload's keys" are indistinguishable to every assertion below, and the
 *  HARD REQUIREMENT at the top of this file (never silently pass against
 *  nothing) applies exactly as much to a spread as it does to any other
 *  uninspectable argument shape. */
export function findSpreadOfUninspectableSource(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): ts.SpreadAssignment | null {
  for (const prop of obj.properties) {
    if (
      ts.isSpreadAssignment(prop) &&
      !resolvesToObjectLiteral(prop.expression, sourceFile)
    ) {
      return prop;
    }
  }
  return null;
}

/** Walk up from `node` to the nearest enclosing PropertyAssignment and
 *  return its key text — e.g. for a call nested inside
 *  `updateEntry: async (id, patch) => { ... }`, returns "updateEntry".
 *  useStore.ts's actions are exactly this shape (a big object literal
 *  passed to zustand's `create()`), so this is what lets the update-site
 *  scan below name WHICH action a given `.update()` call belongs to,
 *  without hardcoding a list of action names to look for. Returns null if
 *  no enclosing PropertyAssignment exists (shouldn't happen for any real
 *  call site in this codebase's actual shape, but this helper doesn't
 *  assume that — an unnamed site still gets collected, just unnamed). */
export function nearestPropertyAssignmentName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isPropertyAssignment(cur)) {
      return cur.name.getText();
    }
    cur = cur.parent;
  }
  return null;
}

export function propertyNames(obj: ts.ObjectLiteralExpression): string[] {
  return obj.properties
    .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p))
    .map((p) => p.name.getText());
}

export function hasSpread(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => ts.isSpreadAssignment(p));
}

export function initializerTextOf(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): string | undefined {
  const prop = obj.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText() === propName,
  );
  return prop?.initializer.getText();
}
