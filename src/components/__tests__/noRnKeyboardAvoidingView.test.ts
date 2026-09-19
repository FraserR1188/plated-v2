// ============================================================
// src/components/__tests__/noRnKeyboardAvoidingView.test.ts
//
// A source-level (not runtime) invariant test, same approach as
// theme/__tests__/noRawHexColors.test.ts: walk the source and fail if a
// pattern this codebase has decided against reappears.
//
// The invariant: nothing imports KeyboardAvoidingView from "react-native".
// At targetSdk 36 Android is always edge-to-edge, so adjustResize no longer
// shrinks the window. RN's KeyboardAvoidingView was paired here with
// behavior={undefined} on Android, which does nothing by design, so every
// screen that used it was covered by the keyboard (PL-004). Screens with
// inputs go through components/KeyboardScreen.tsx (keyboard-controller)
// instead.
//
// This proves nothing about the keyboard itself. The lift is device-only
// (native insets, Reanimated, layout); this only stops a screen sliding back
// to the old pattern.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC_ROOT = path.resolve(ROOT, "src");

/** Files still allowed the import, each with the reason. An entry that no
 *  longer imports it fails the stale-entry test below, so this can only
 *  shrink. */
const ALLOWED: Record<string, string> = {
  "src/screens/CreateFoodScreen.tsx":
    "PL-004 follow-up: lifts itself with its own Keyboard listener today; migrates in a separate PR with a before/after device check",
};

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const isRn = (spec: ts.Expression) =>
  ts.isStringLiteral(spec) && spec.text === "react-native";

/** Every way this file reaches RN's KeyboardAvoidingView: a named import or
 *  re-export (aliased or not), a deep import of the component's module, or a
 *  property access on a namespace import of "react-native". */
function rnKavUses(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const uses: string[] = [];
  const namespaces = new Set<string>();
  const line = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith("react-native/") && /KeyboardAvoidingView/.test(spec)) {
        uses.push(`${line(node)}: deep import ${spec}`);
      }
      if (isRn(node.moduleSpecifier)) {
        const named = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        if (named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
          for (const el of named.elements) {
            if ((el.propertyName ?? el.name).text === "KeyboardAvoidingView") {
              uses.push(`${line(el)}: named import from "react-native"`);
            }
          }
        }
        if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "KeyboardAvoidingView" &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      uses.push(`${line(node)}: ${node.expression.text}.KeyboardAvoidingView`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

const files = [...walkTsFiles(SRC_ROOT), path.resolve(ROOT, "App.tsx")];
const offenders = new Map<string, string[]>();
for (const file of files) {
  const uses = rnKavUses(file);
  if (uses.length) {
    offenders.set(path.relative(ROOT, file).replace(/\\/g, "/"), uses);
  }
}

describe("no KeyboardAvoidingView from react-native (structural)", () => {
  it("no screen or component imports RN's KeyboardAvoidingView", () => {
    // If this fails: wrap the screen in <KeyboardScreen> from
    // components/KeyboardScreen.tsx (keyboard-controller, behavior
    // "padding", offset from the header) instead. RN's version with the old
    // Platform.OS === "ios" ? "padding" : undefined idiom does nothing on
    // Android under edge-to-edge.
    const unexpected = [...offenders].filter(([file]) => !(file in ALLOWED));
    expect(
      unexpected.map(([file]) => file),
      unexpected.map(([file, uses]) => `${file}\n  ${uses.join("\n  ")}`).join("\n"),
    ).toEqual([]);
  });

  it("every allowlisted file still imports it (no stale entries)", () => {
    // If this fails: the file was migrated. Delete its ALLOWED entry.
    const stale = Object.keys(ALLOWED).filter((file) => !offenders.has(file));
    expect(stale).toEqual([]);
  });
});
