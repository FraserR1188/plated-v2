// ============================================================
// src/lib/__tests__/receiptWriteSites.test.ts
//
// A source-level guard for the receipts tables (receipt scanner 4b,
// findings §8), the sibling of mealEntriesInsertSites.test.ts. The database
// keeps direct DML granted (security-invoker RPCs need it), so "every write
// goes through save_receipt / update_receipt / delete_receipt" is enforced
// HERE, on the client, not by the server. Six gates:
//
//   1. Exactly three write doors, all in lib/receipts.ts; no direct
//      insert/update/upsert/delete on either table anywhere; reads only in
//      lib/receipts.ts. A regex count and an AST walk, which must agree.
//   2. Receipts never touch consumption: no receipt module mentions
//      meal_entries or the meal write paths.
//   3. The payloads are explicit: snake_case, no spread, the right keys,
//      never user_id/id/created_at/updated_at; update's header has no
//      purchased_on_estimated (the server decides it); p_id is the
//      enclosing function's parameter, never read off a draft.
//   4. No UTC date keys.
//   5. Privacy (§7): no reportError extra, no Error message built from
//      values, no console call with anything but a fixed string.
//   6. Reads are paged (PL-050), or are single-receipt reads.
//
// Each gate has a sabotage run, recorded in the 4b commit.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  SRC_ROOT,
  readNormalized,
  walkTsFiles,
  parseSource,
  isFromCall,
  extractObjectLiterals,
  findVariableDeclaration,
  resolvesToObjectLiteral,
  propertyNames,
  hasSpread,
} from "./helpers/astWrites";

const rel = (file: string) => path.relative(SRC_ROOT, file).replace(/\\/g, "/");
const files = walkTsFiles(SRC_ROOT);
const texts = new Map(files.map((f) => [rel(f), readNormalized(f)]));

const RECEIPTS_FILE = "lib/receipts.ts";
const TABLES = ["receipts", "receipt_lines"];
const RPCS = ["save_receipt", "update_receipt", "delete_receipt"];
const WRITE_METHODS = ["insert", "update", "upsert", "delete"];

// The receipt modules: every file named receipt* under lib/, screens/ or
// store/, plus the two pure modules the receipt flow owns.
const RECEIPT_MODULES = [...texts.keys()]
  .filter(
    (f) =>
      /^(lib|screens|store)\/(.*\/)?receipt[^/]*\.tsx?$/i.test(f) ||
      f === "lib/money.ts" ||
      f === "lib/spending.ts",
  )
  .sort();

function sourceOf(file: string): ts.SourceFile {
  return parseSource(texts.get(file)!, file);
}

function visitAll(sf: ts.SourceFile, fn: (n: ts.Node) => void) {
  const visit = (n: ts.Node) => {
    fn(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** `<x>.rpc("<name>", ...)` → the name, else null. */
function rpcName(n: ts.Node): string | null {
  if (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "rpc" &&
    n.arguments[0] &&
    ts.isStringLiteral(n.arguments[0])
  ) {
    return n.arguments[0].text;
  }
  return null;
}

it("the receipt modules exist (the gates below would pass vacuously otherwise)", () => {
  expect(RECEIPT_MODULES).toEqual(
    expect.arrayContaining(["lib/receipts.ts", "lib/receiptScan.ts", "lib/money.ts", "lib/spending.ts"]),
  );
});

// ─── Gate 1 ─────────────────────────────────────────────────────────────────

describe("gate 1 — exactly three write doors, all in lib/receipts.ts", () => {
  const RPC_CALL = /\.rpc\(\s*["'](save_receipt|update_receipt|delete_receipt)["']/g;
  const DIRECT_WRITE = /\.from\(\s*["'](receipts|receipt_lines)["']\s*\)\s*\.(insert|update|upsert|delete)\(/g;
  // Not /g: it's used with .test(), and a global regex carries lastIndex
  // from one file to the next.
  const ANY_FROM = /\.from\(\s*["'](receipts|receipt_lines)["']\s*\)/;

  const regexRpcSites = () =>
    [...texts]
      .flatMap(([file, text]) => [...text.matchAll(RPC_CALL)].map((m) => `${file}:${m[1]}`))
      .sort();

  const astRpcSites = () =>
    [...texts.keys()]
      .flatMap((file) => {
        const out: string[] = [];
        visitAll(sourceOf(file), (n) => {
          const name = rpcName(n);
          if (name && RPCS.includes(name)) out.push(`${file}:${name}`);
        });
        return out;
      })
      .sort();

  it("regex: each RPC is called exactly once, and only from lib/receipts.ts", () => {
    expect(regexRpcSites()).toEqual(RPCS.map((r) => `${RECEIPTS_FILE}:${r}`).sort());
  });

  it("AST: the same three sites (the two methods agree)", () => {
    expect(astRpcSites()).toEqual(regexRpcSites());
  });

  it("regex: no file chains insert/update/upsert/delete on either table", () => {
    const hits = [...texts].flatMap(([file, text]) =>
      [...text.matchAll(DIRECT_WRITE)].map((m) => `${file}: .from("${m[1]}").${m[2]}(`),
    );
    expect(hits).toEqual([]);
  });

  it("AST: no direct write calls either", () => {
    const hits: string[] = [];
    for (const file of texts.keys()) {
      visitAll(sourceOf(file), (n) => {
        if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
        const callee = n.expression;
        if (
          WRITE_METHODS.includes(callee.name.text) &&
          TABLES.some((t) => isFromCall(callee.expression, t))
        ) {
          hits.push(`${file}: ${callee.getText()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("reads of either table happen only in lib/receipts.ts", () => {
    const readers = [...texts].filter(([, text]) => ANY_FROM.test(text)).map(([f]) => f);
    expect(readers).toEqual([RECEIPTS_FILE]);
  });
});

// ─── Gate 2 ─────────────────────────────────────────────────────────────────

describe("gate 2 — receipts never touch consumption", () => {
  it.each(RECEIPT_MODULES)("%s never mentions meal_entries or a meal write path", (file) => {
    const text = texts.get(file)!;
    expect(text.includes("meal_entries"), `${file} mentions meal_entries`).toBe(false);
    expect(text.match(/\b(addEntry|applyEntries|applyBatchNow)\b/g) ?? []).toEqual([]);
  });
});

// ─── Gate 3 ─────────────────────────────────────────────────────────────────

const SNAKE = /^[a-z][a-z0-9_]*$/;
const NEVER = ["user_id", "id", "created_at", "updated_at"];

type RpcSite = { name: string; args: ts.ObjectLiteralExpression; call: ts.CallExpression; sf: ts.SourceFile };

function receiptRpcSites(): RpcSite[] {
  const sf = sourceOf(RECEIPTS_FILE);
  const out: RpcSite[] = [];
  visitAll(sf, (n) => {
    const name = rpcName(n);
    if (!name || !RPCS.includes(name)) return;
    const call = n as ts.CallExpression;
    const args = call.arguments[1];
    if (!args || !ts.isObjectLiteralExpression(args)) {
      throw new Error(`${name}: the RPC arguments aren't an inline object literal — can't inspect them`);
    }
    out.push({ name, args, call, sf });
  });
  return out;
}

function prop(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  const p = obj.properties.find(
    (q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText() === key,
  );
  return p?.initializer;
}

/** The p_lines initializer's row shape: an inline .map(), a local alias of
 *  one, or a call to a builder function in the same file that returns one. */
function linesShape(expr: ts.Expression, sf: ts.SourceFile): ts.ObjectLiteralExpression[] {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    let body: ts.ConciseBody | undefined;
    visitAll(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) body = n.body;
    });
    if (!body) {
      const decl = findVariableDeclaration(sf, name);
      if (decl?.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
        body = decl.initializer.body;
      }
    }
    if (!body) throw new Error(`p_lines builder "${name}" isn't declared in ${RECEIPTS_FILE}`);
    const returned = ts.isBlock(body)
      ? body.statements.filter(ts.isReturnStatement).map((r) => r.expression).find(Boolean)
      : (body as ts.Expression);
    if (!returned) throw new Error(`p_lines builder "${name}" returns nothing inspectable`);
    return extractObjectLiterals(returned, sf, RECEIPTS_FILE);
  }
  return extractObjectLiterals(expr, sf, RECEIPTS_FILE);
}

function checkPayload(label: string, obj: ts.ObjectLiteralExpression): string[] {
  const problems: string[] = [];
  if (hasSpread(obj)) problems.push(`${label} spreads an object`);
  for (const k of propertyNames(obj)) {
    if (!SNAKE.test(k)) problems.push(`${label}.${k} isn't snake_case`);
    if (NEVER.includes(k)) problems.push(`${label} carries ${k}`);
  }
  return problems;
}

/** The names of the parameters of the function enclosing `node`. */
function enclosingParams(node: ts.Node): string[] {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur)) {
      return cur.parameters.map((p) => p.name.getText());
    }
    cur = cur.parent;
  }
  return [];
}

describe("gate 3 — the payloads are explicit", () => {
  it("finds all three RPC calls to inspect", () => {
    expect(receiptRpcSites().map((s) => s.name).sort()).toEqual([...RPCS].sort());
  });

  it.each(["save_receipt", "update_receipt"])("%s: p_receipt is an explicit snake_case literal with the right keys", (name) => {
    const site = receiptRpcSites().find((s) => s.name === name)!;
    const init = prop(site.args, "p_receipt");
    expect(init, `${name} has no p_receipt`).toBeDefined();
    const obj = resolvesToObjectLiteral(init!, site.sf);
    expect(obj, `${name}'s p_receipt isn't a traceable object literal`).not.toBeNull();

    expect(checkPayload(`${name}.p_receipt`, obj!)).toEqual([]);
    const keys = propertyNames(obj!);
    expect(keys).toContain("purchased_on");
    if (name === "save_receipt") {
      expect(keys).toContain("purchased_on_estimated");
    } else {
      // The server derives it on edit (PL-048): changing the date sets it false.
      expect(keys).not.toContain("purchased_on_estimated");
    }
  });

  it.each(["save_receipt", "update_receipt"])("%s: every p_lines row is an explicit snake_case literal", (name) => {
    const site = receiptRpcSites().find((s) => s.name === name)!;
    const init = prop(site.args, "p_lines");
    expect(init, `${name} has no p_lines`).toBeDefined();
    const rows = linesShape(init!, site.sf);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(checkPayload(`${name}.p_lines[]`, row)).toEqual([]);
      expect(propertyNames(row)).toEqual(expect.arrayContaining(["position", "raw_text", "line_total_pence", "is_discount"]));
    }
  });

  it.each(["update_receipt", "delete_receipt"])("%s: p_id is the enclosing function's own parameter", (name) => {
    const site = receiptRpcSites().find((s) => s.name === name)!;
    const init = prop(site.args, "p_id");
    expect(init, `${name} has no p_id`).toBeDefined();
    expect(ts.isIdentifier(init!), `${name}'s p_id is "${init!.getText()}", not a plain parameter`).toBe(true);
    expect(enclosingParams(site.call)).toContain((init as ts.Identifier).text);
  });
});

// ─── Gate 4 ─────────────────────────────────────────────────────────────────

describe("gate 4 — no UTC date keys", () => {
  it.each(RECEIPT_MODULES)("%s", (file) => {
    const text = texts.get(file)!;
    expect(text.match(/toISOString\(\)\s*\.split\(\s*["']T["']\s*\)\s*\[\s*0\s*\]/g) ?? []).toEqual([]);
    expect(text.match(/\.slice\(\s*0\s*,\s*10\s*\)/g) ?? []).toEqual([]);
    expect(text.match(/new Date\([^)]*purchased_?on/gi) ?? []).toEqual([]);
  });
});

// ─── Gate 5 ─────────────────────────────────────────────────────────────────

describe("gate 5 — privacy: nothing from a receipt reaches a report or a log", () => {
  it.each(RECEIPT_MODULES)("%s", (file) => {
    const problems: string[] = [];
    visitAll(sourceOf(file), (n) => {
      // reportError(op, err, opts): opts may not carry `extra`, and must be
      // inspectable if present at all.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "reportError") {
        const opts = n.arguments[2];
        if (opts && (!ts.isObjectLiteralExpression(opts) || hasSpread(opts) || propertyNames(opts).includes("extra"))) {
          problems.push(`reportError with extra/opaque options: ${n.getText()}`);
        }
      }
      // new XError(`…${x}…`) or new XError("…" + x): an uncaught message keeps its text.
      if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText())) {
        const a = n.arguments?.[0];
        if (a && (ts.isTemplateExpression(a) || (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.PlusToken))) {
          problems.push(`Error message built from values: ${n.getText()}`);
        }
      }
      // console.*(…): fixed strings only.
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === "console" &&
        n.arguments.some((a) => !ts.isStringLiteral(a) && !ts.isNoSubstitutionTemplateLiteral(a))
      ) {
        problems.push(`console call with a value: ${n.getText()}`);
      }
    });
    expect(problems).toEqual([]);
  });
});

// ─── Gate 6 ─────────────────────────────────────────────────────────────────

type ChainCall = { name: string; args: ts.NodeArray<ts.Expression> };
type SelectSite = { table: string; fn: string; chain: ChainCall[]; inPager: boolean };

function selectSites(): SelectSite[] {
  const sf = sourceOf(RECEIPTS_FILE);
  const out: SelectSite[] = [];
  visitAll(sf, (n) => {
    if (
      !ts.isCallExpression(n) ||
      !ts.isPropertyAccessExpression(n.expression) ||
      n.expression.name.text !== "select"
    ) return;
    const receiver = n.expression.expression;
    const table = TABLES.find((t) => isFromCall(receiver, t));
    if (!table) return;

    // The rest of the builder chain: .eq(…).order(…).range(…)…
    const chain: ChainCall[] = [];
    let cur: ts.Node = n;
    while (
      cur.parent &&
      ts.isPropertyAccessExpression(cur.parent) &&
      cur.parent.parent &&
      ts.isCallExpression(cur.parent.parent) &&
      cur.parent.parent.expression === cur.parent
    ) {
      chain.push({ name: cur.parent.name.text, args: cur.parent.parent.arguments });
      cur = cur.parent.parent;
    }

    let inPager = false;
    let fn = "<top level>";
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "fetchAllPages") inPager = true;
      if (ts.isFunctionDeclaration(p) && p.name) {
        fn = p.name.text;
        break;
      }
    }
    out.push({ table, fn, chain, inPager });
  });
  return out;
}

const firstArgText = (c: ChainCall) => (c.args[0] && ts.isStringLiteral(c.args[0]) ? c.args[0].text : null);

describe("gate 6 — reads are paged, or single-receipt", () => {
  it("every select on either table is paged with a unique last ORDER BY, or reads one receipt", () => {
    const problems: string[] = [];
    for (const s of selectSites()) {
      const orders = s.chain.filter((c) => c.name === "order");
      const paged =
        s.inPager &&
        s.chain.some((c) => c.name === "range") &&
        orders.length > 0 &&
        firstArgText(orders[orders.length - 1]) === "id";
      const single = s.chain.some(
        (c) => c.name === "eq" && ["id", "receipt_id"].includes(firstArgText(c) ?? ""),
      );
      if (!paged && !single) problems.push(`${s.fn}: unpaged ${s.table} read`);
    }
    expect(problems).toEqual([]);
  });

  it("fetchReceipts and fetchReceiptLinesForExport are the paged ones", () => {
    const paged = selectSites().filter((s) => s.inPager).map((s) => `${s.fn}:${s.table}`).sort();
    expect(paged).toEqual(["fetchReceiptLinesForExport:receipt_lines", "fetchReceipts:receipts"]);
  });
});

it("the guard reads real files (not a stale list)", () => {
  expect(fs.existsSync(path.join(SRC_ROOT, RECEIPTS_FILE))).toBe(true);
});
