// ============================================================
// src/lib/__tests__/receiptDevEntry.test.ts — the temporary dev entry to
// ReceiptScan can't ship, and can't outlive the real entry
//
// Receipt commit 5a needs a device pass before its real entry (Data →
// Spending, commit 6) exists, so components/DevReceiptEntry.tsx opens the
// modal from Settings in dev builds. This guard makes "temporary" true by
// construction:
//   1. It's imported only by SettingsScreen, and every place it's rendered
//      is the right-hand side of `__DEV__ && …` — dead code in release and
//      preview builds, where __DEV__ is compiled to false.
//   2. The component also returns null on its own when !__DEV__.
//   3. Once ANY other navigate("ReceiptScan") exists in src/ (the real entry),
//      the dev entry must be gone: the file, its import and its render. This
//      test fails at commit 6 until it's deleted.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SRC_ROOT, readNormalized, walkTsFiles } from "./helpers/astWrites";

const DEV_FILE = "components/DevReceiptEntry.tsx";
const COMPONENT = "DevReceiptEntry";

const rel = (f: string) => path.relative(SRC_ROOT, f).replace(/\\/g, "/");
const files = walkTsFiles(SRC_ROOT).map((f) => ({ file: rel(f), text: readNormalized(f) }));

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function visitAll(sf: ts.SourceFile, fn: (n: ts.Node) => void) {
  const visit = (n: ts.Node) => {
    fn(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** Every `navigate("ReceiptScan")` call, by file. */
function receiptScanEntries(): string[] {
  const out: string[] = [];
  for (const { file, text } of files) {
    visitAll(parse(file, text), (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "navigate" &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0]) &&
        n.arguments[0].text === "ReceiptScan"
      ) {
        out.push(file);
      }
    });
  }
  return out;
}

/** Is this JSX element the right operand of `__DEV__ && …`? */
function isUnderDevGuard(node: ts.Node): boolean {
  let cur: ts.Node = node;
  while (cur.parent && ts.isParenthesizedExpression(cur.parent)) cur = cur.parent;
  const p = cur.parent;
  return (
    !!p &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    p.right === cur &&
    ts.isIdentifier(p.left) &&
    p.left.text === "__DEV__"
  );
}

const devFileExists = fs.existsSync(path.join(SRC_ROOT, DEV_FILE));
const realEntries = receiptScanEntries().filter((f) => f !== DEV_FILE);

describe("the dev entry to ReceiptScan (temporary, receipt 5a)", () => {
  it("is gone once a real ReceiptScan entry exists (commit 6: delete DevReceiptEntry and its use)", () => {
    if (realEntries.length === 0) return; // not yet: the dev entry is the only way in
    expect(devFileExists, `${DEV_FILE} still exists alongside ${realEntries.join(", ")}`).toBe(false);
    const refs = files.filter(({ file, text }) => file !== DEV_FILE && text.includes(COMPONENT)).map((f) => f.file);
    expect(refs).toEqual([]);
  });

  it("is imported only by SettingsScreen", () => {
    const importers = files
      .filter(({ file, text }) => file !== DEV_FILE && new RegExp(`from\\s+["'][^"']*/${COMPONENT}["']`).test(text))
      .map((f) => f.file);
    expect(importers).toEqual(devFileExists ? ["screens/SettingsScreen.tsx"] : []);
  });

  it("is rendered only as `__DEV__ && <DevReceiptEntry />`", () => {
    const bad: string[] = [];
    let renders = 0;
    for (const { file, text } of files) {
      if (file === DEV_FILE || !text.includes(COMPONENT)) continue;
      visitAll(parse(file, text), (n) => {
        if (
          (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
          n.tagName.getText() === COMPONENT
        ) {
          renders++;
          const el = ts.isJsxOpeningElement(n) ? n.parent : n;
          if (!isUnderDevGuard(el)) bad.push(`${file}: ${el.getText()}`);
        }
      });
    }
    expect(bad).toEqual([]);
    if (devFileExists) expect(renders).toBe(1);
  });

  it("returns null on its own outside dev builds", () => {
    if (!devFileExists) return;
    const text = readNormalized(path.join(SRC_ROOT, DEV_FILE));
    expect(text).toMatch(/if\s*\(\s*!__DEV__\s*\)\s*return null;/);
  });

  it("is today the only way into ReceiptScan (until commit 6)", () => {
    // Informational pin: if this fails because a real entry appeared, the
    // first test above is the one that matters.
    expect(receiptScanEntries()).toEqual(devFileExists ? [DEV_FILE] : realEntries);
  });
});
