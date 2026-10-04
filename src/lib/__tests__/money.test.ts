// ============================================================
// Receipt scanner, commit 2 — RED. src/lib/money.ts doesn't exist yet
// (findings §6). Every test here must fail with "module not found: money"
// until commit 4b; see helpers/redImports.ts.
//
// Money is integer pence end to end. Nothing here may use a float for an
// amount, and nothing may use toLocaleString / Intl: "£12.30" must not
// render as "12,30 £" on a phone set to another locale (the Trends
// precedent, trendsUi.test.ts).
// ============================================================

import { describe, it, expect } from "vitest";
import { requireExports } from "./helpers/redImports";

type Money = {
  parsePenceInput: (text: string) => number | null;
  formatPence: (pence: number, currency: string) => string;
  sumPence: (values: (number | null)[]) => number | null;
};

const MONEY = "../money";
const money = () =>
  requireExports<Money>(() => import(/* @vite-ignore */ MONEY), "money", [
    "parsePenceInput",
    "formatPence",
    "sumPence",
  ]);

describe("parsePenceInput — review-screen fields", () => {
  // Accepted. One decimal digit is padded ("12.3" is £12.30): this is what a
  // person types, unlike the server's parsePence, which reads printed
  // receipts and requires exactly two.
  it.each([
    ["12.3", 1230],
    ["12.30", 1230],
    ["£12.30", 1230],
    ["0.50-", -50],
    ["-0.50", -50],
  ])("%j → %d", async (text, pence) => {
    const { parsePenceInput } = await money();
    expect(parsePenceInput(text)).toBe(pence);
  });

  // Rejected → null, so the field shows empty, never a guessed number.
  // "-0.50-" and "1,234.56" are decided cases (findings decision 6).
  it.each(["12.305", "abc", "", "-0.50-", "1,234.56"])("%j → null", async (text) => {
    const { parsePenceInput } = await money();
    expect(parsePenceInput(text)).toBeNull();
  });

  it("does no float arithmetic: 0.29 is 29 pence, not 28.999…", async () => {
    const { parsePenceInput } = await money();
    expect(parsePenceInput("0.29")).toBe(29);
    expect(parsePenceInput("1.15")).toBe(115);
  });
});

describe("formatPence — locale-free", () => {
  it.each([
    [1230, "GBP", "£12.30"],
    [-50, "GBP", "−£0.50"], // U+2212 minus, before the symbol
    [300, "EUR", "€3.00"],
    [0, "GBP", "£0.00"],
    [123456789, "GBP", "£1,234,567.89"], // thousands separator done by hand
    [1230, "XYZ", "12.30 XYZ"], // unknown code: amount, then the code
  ])("%d %s → %j", async (pence, currency, text) => {
    const { formatPence } = await money();
    expect(formatPence(pence, currency)).toBe(text);
  });
});

describe("sumPence — nothing known is not zero", () => {
  it.each<[(number | null)[], number | null]>([
    [[], null],
    [[null, null], null],
    [[null, 100], 100],
    [[0], 0],
    [[-50, 100], 50],
  ])("%j → %j", async (values, total) => {
    const { sumPence } = await money();
    expect(sumPence(values)).toBe(total);
  });
});
