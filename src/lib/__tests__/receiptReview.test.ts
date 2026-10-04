// ============================================================
// src/lib/__tests__/receiptReview.test.ts — the review screen's fields,
// pure (receipt 5b; findings §3, §6, commit 5b as revised 2026-10-04)
//
// The screen holds what the user sees as TEXT, and Save parses that text —
// never a value committed on blur (the PL-005/006 lesson, CopyConfirm's
// pattern). So everything that decides what gets saved is here:
//   • fields from a scan (create) or a saved receipt (edit);
//   • parseReview: exactly what's shown, or a refusal that names the field —
//     never a guessed number, and never a silent GBP;
//   • the live summary: items and discounts (not lines), and the reconcile,
//     both over the lines as they are NOW — a removed seam repeat drops out;
//   • the long-receipt notice, from its one constant.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  penceText,
  fieldsFromDraft,
  draftFromReceipt,
  updateLine,
  addLine,
  removeLine,
  setPurchasedOn,
  setCurrency,
  parseReview,
  reviewSummary,
  itemCountLabel,
  reconcileBanner,
  type ReviewFields,
} from "../receiptReview";
import { countLines } from "../spending";
import { LONG_RECEIPT_NOTICE, showLongReceiptNotice } from "../receiptCapture";
import type { ReceiptDraft, ReceiptLineRow, ReceiptRow } from "../receipts";

const line = (
  rawText: string,
  lineTotalPence: number | null,
  extra: Partial<ReceiptDraft["lines"][number]> = {},
): ReceiptDraft["lines"][number] => ({
  part: 1,
  rawText,
  qty: null,
  qtyUnit: null,
  unitPricePence: null,
  lineTotalPence,
  isDiscount: false,
  possibleSeamDuplicate: false,
  ...extra,
});

// 2 parts. BREAD at the top of part 2 repeats the foot of part 1 (flagged).
// Lines: 120 + 250 + 250 (flagged) − 50 = 570; printed total 320 + 250 = 570
// would be "equal" only if the flagged repeat is real — it's printed 320.
const SCANNED: ReceiptDraft = {
  mode: { kind: "create" },
  parts: [
    { uri: "file:///p1.jpg", base64: "QQ" },
    { uri: "file:///p2.jpg", base64: "Qg" },
  ],
  header: {
    store: "Tesco",
    purchasedOn: "2026-10-03",
    purchasedOnEstimated: false,
    printedTotalPence: 320,
    currency: "GBP",
  },
  lines: [
    line("MILK", 120),
    line("BREAD", 250),
    line("BREAD", 250, { part: 2, possibleSeamDuplicate: true }),
    line("MULTIBUY SAVING", -50, { part: 2, isDiscount: true }),
  ],
};

const fields = () => fieldsFromDraft(SCANNED);
const keyOf = (f: ReviewFields, i: number) => f.lines[i].key;

describe("penceText — what a money field shows", () => {
  it("is plain decimal text the user can edit, never a symbol", () => {
    expect(penceText(1230)).toBe("12.30");
    expect(penceText(5)).toBe("0.05");
    expect(penceText(-50)).toBe("-0.50");
    expect(penceText(0)).toBe("0.00");
  });

  it("an unknown amount is an empty field, never 0.00", () => {
    expect(penceText(null)).toBe("");
  });
});

describe("fieldsFromDraft", () => {
  it("shows every header value and every line as text, in order", () => {
    const f = fields();
    expect(f.store).toBe("Tesco");
    expect(f.purchasedOn).toBe("2026-10-03");
    expect(f.purchasedOnEstimated).toBe(false);
    expect(f.currency).toBe("GBP");
    expect(f.totalText).toBe("3.20");
    expect(f.lines.map((l) => [l.rawText, l.totalText])).toEqual([
      ["MILK", "1.20"],
      ["BREAD", "2.50"],
      ["BREAD", "2.50"],
      ["MULTIBUY SAVING", "-0.50"],
    ]);
  });

  it("gives every line a unique key", () => {
    const keys = fields().lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("an unread store and total are empty fields; an unread currency stays unset", () => {
    const f = fieldsFromDraft({
      ...SCANNED,
      header: { ...SCANNED.header, store: null, printedTotalPence: null, currency: null },
    });
    expect(f.store).toBe("");
    expect(f.totalText).toBe("");
    expect(f.currency).toBeNull();
  });
});

describe("draftFromReceipt — edit mode", () => {
  const receipt: ReceiptRow = {
    id: "r1",
    user_id: "u1",
    store: null,
    purchased_on: "2026-09-30",
    purchased_on_estimated: true,
    printed_total_pence: null,
    currency: "EUR",
    created_at: "2026-09-30T10:00:00Z",
    updated_at: "2026-09-30T10:00:00Z",
  };
  const row = (position: number, raw_text: string, line_total_pence: number | null, is_discount = false): ReceiptLineRow => ({
    id: `l${position}`,
    receipt_id: "r1",
    user_id: "u1",
    position,
    raw_text,
    qty: 2,
    qty_unit: "each",
    unit_price_pence: 100,
    line_total_pence,
    is_discount,
  });

  it("carries the receipt id in its mode, no photos, and the saved values as they are", () => {
    const d = draftFromReceipt(receipt, [row(0, "EGGS", 200), row(1, "OFF", -20, true)]);
    expect(d.mode).toEqual({ kind: "edit", receiptId: "r1" });
    expect(d.parts).toEqual([]);
    expect(d.header).toEqual({
      store: null,
      purchasedOn: "2026-09-30",
      purchasedOnEstimated: true,
      printedTotalPence: null,
      currency: "EUR",
    });
    expect(d.lines).toEqual([
      { part: null, rawText: "EGGS", qty: 2, qtyUnit: "each", unitPricePence: 100, lineTotalPence: 200, isDiscount: false, possibleSeamDuplicate: false },
      { part: null, rawText: "OFF", qty: 2, qtyUnit: "each", unitPricePence: 100, lineTotalPence: -20, isDiscount: true, possibleSeamDuplicate: false },
    ]);
  });

  it("orders lines by position, whatever order they arrive in", () => {
    const d = draftFromReceipt(receipt, [row(1, "SECOND", 1), row(0, "FIRST", 1)]);
    expect(d.lines.map((l) => l.rawText)).toEqual(["FIRST", "SECOND"]);
  });
});

describe("editing", () => {
  it("updateLine changes only that line's text", () => {
    const f = fields();
    const g = updateLine(f, keyOf(f, 0), { totalText: "1.25" });
    expect(g.lines[0].totalText).toBe("1.25");
    expect(g.lines[0].rawText).toBe("MILK");
    expect(g.lines.slice(1)).toEqual(f.lines.slice(1));
    expect(f.lines[0].totalText).toBe("1.20"); // not mutated
  });

  it("addLine appends an empty line with a key no other line has", () => {
    const f = addLine(addLine(fields()));
    const keys = f.lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(f.lines.at(-1)).toMatchObject({ rawText: "", totalText: "", part: null, possibleSeamDuplicate: false });
  });

  it("addLine after a remove still never reuses a key", () => {
    let f = addLine(fields());
    f = removeLine(f, f.lines.at(-1)!.key);
    f = addLine(f);
    const keys = f.lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("removeLine takes out exactly that line, keeping the order of the rest", () => {
    const f = fields();
    const g = removeLine(f, keyOf(f, 2));
    expect(g.lines.map((l) => l.key)).toEqual([keyOf(f, 0), keyOf(f, 1), keyOf(f, 3)]);
  });

  it("setting the date marks it as the user's, not estimated", () => {
    const f = { ...fields(), purchasedOnEstimated: true };
    const g = setPurchasedOn(f, "2026-10-01");
    expect(g.purchasedOn).toBe("2026-10-01");
    expect(g.purchasedOnEstimated).toBe(false);
  });

  it("setCurrency sets it", () => {
    expect(setCurrency({ ...fields(), currency: null }, "EUR").currency).toBe("EUR");
  });
});

describe("parseReview — Save uses exactly what's shown", () => {
  it("parses every shown value, mapping each line by hand", () => {
    const r = parseReview(fields());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.header).toEqual({
      store: "Tesco",
      purchasedOn: "2026-10-03",
      purchasedOnEstimated: false,
      printedTotalPence: 320,
      currency: "GBP",
    });
    expect(r.lines.map((l) => [l.rawText, l.lineTotalPence, l.isDiscount])).toEqual([
      ["MILK", 120, false],
      ["BREAD", 250, false],
      ["BREAD", 250, false],
      ["MULTIBUY SAVING", -50, true],
    ]);
  });

  it("an edit that hasn't blurred is what's saved — the text is the value", () => {
    const f = fields();
    const r = parseReview(updateLine(f, keyOf(f, 0), { totalText: "1.99" }));
    expect(r.ok && r.lines[0].lineTotalPence).toBe(199);
  });

  it("keeps the read qty and unit price on a line", () => {
    const f = fieldsFromDraft({
      ...SCANNED,
      lines: [line("APPLES", 300, { qty: 3, qtyUnit: "each", unitPricePence: 100 })],
    });
    const r = parseReview(f);
    expect(r.ok && r.lines[0]).toMatchObject({ qty: 3, qtyUnit: "each", unitPricePence: 100 });
  });

  it("never carries a line's part or seam flag into what's saved", () => {
    const r = parseReview(fields());
    expect(r.ok && Object.keys(r.lines[2]).sort()).toEqual(
      ["isDiscount", "lineTotalPence", "qty", "qtyUnit", "rawText", "unitPricePence"],
    );
  });

  it("trims the store, and an empty store is null", () => {
    expect((parseReview({ ...fields(), store: "  Aldi " }) as { header: { store: string } }).header.store).toBe("Aldi");
    const r = parseReview({ ...fields(), store: "   " });
    expect(r.ok && r.header.store).toBeNull();
  });

  it("an empty total is unknown (null), never 0", () => {
    const r = parseReview({ ...fields(), totalText: "" });
    expect(r.ok && r.header.printedTotalPence).toBeNull();
  });

  it("an empty line amount is unknown (null), never 0", () => {
    const f = fields();
    const r = parseReview(updateLine(f, keyOf(f, 0), { totalText: " " }));
    expect(r.ok && r.lines[0].lineTotalPence).toBeNull();
  });

  it("an unparseable total refuses to save and names the field — never a guess", () => {
    const r = parseReview({ ...fields(), totalText: "3.2O" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.total).toBe(true);
    expect(r.message).toMatch(/amount/i);
  });

  it("an unparseable line amount refuses to save and names that line", () => {
    const f = fields();
    const r = parseReview(updateLine(f, keyOf(f, 1), { totalText: "2.505" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.lines).toEqual({ [keyOf(f, 1)]: "amount" });
  });

  it("A NULL CURRENCY NEVER SAVES — it must be chosen, not defaulted to GBP", () => {
    const r = parseReview({ ...fields(), currency: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.currency).toBe(true);
    expect(r.message).toMatch(/currency/i);
  });

  it("a line with an amount but no text refuses to save", () => {
    const f = fields();
    const r = parseReview(updateLine(f, keyOf(f, 0), { rawText: "  " }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.lines).toEqual({ [keyOf(f, 0)]: "text" });
  });

  it("an added line left completely empty is dropped, not saved blank", () => {
    const r = parseReview(addLine(fields()));
    expect(r.ok && r.lines).toHaveLength(4);
  });

  it("a known amount decides discount by its sign; an unknown one keeps the read flag", () => {
    let f = addLine(fields());
    f = updateLine(f, f.lines.at(-1)!.key, { rawText: "COUPON", totalText: "-1.00" });
    f = updateLine(f, keyOf(f, 3), { totalText: "" }); // the read discount, amount cleared
    const r = parseReview(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.at(-1)).toMatchObject({ rawText: "COUPON", lineTotalPence: -100, isDiscount: true });
    expect(r.lines[3]).toMatchObject({ lineTotalPence: null, isDiscount: true });
    expect(r.lines[0].isDiscount).toBe(false);
  });

  it("a user-set date saves as not estimated; an untouched default stays estimated", () => {
    const est = { ...fields(), purchasedOnEstimated: true };
    expect((parseReview(est) as { header: { purchasedOnEstimated: boolean } }).header.purchasedOnEstimated).toBe(true);
    const set = setPurchasedOn(est, "2026-10-02");
    expect((parseReview(set) as { header: { purchasedOnEstimated: boolean } }).header.purchasedOnEstimated).toBe(false);
  });
});

describe("countLines (spending.ts) — items, not lines", () => {
  it("items are the non-discount lines, discounts the rest", () => {
    expect(countLines([{ isDiscount: false }, { isDiscount: false }, { isDiscount: true }])).toEqual({
      items: 2,
      discounts: 1,
    });
    expect(countLines([])).toEqual({ items: 0, discounts: 0 });
  });
});

describe("itemCountLabel", () => {
  it('reads "45 items · 16 discounts", never a raw line count', () => {
    expect(itemCountLabel({ items: 45, discounts: 16 })).toBe("45 items · 16 discounts");
  });
  it("singular, and no discount clause when there are none", () => {
    expect(itemCountLabel({ items: 1, discounts: 1 })).toBe("1 item · 1 discount");
    expect(itemCountLabel({ items: 3, discounts: 0 })).toBe("3 items");
    expect(itemCountLabel({ items: 0, discounts: 0 })).toBe("0 items");
  });
});

describe("reviewSummary — over the lines as they are now", () => {
  it("counts items and discounts, and flags the over-read", () => {
    const s = reviewSummary(fields());
    expect(s.counts).toEqual({ items: 3, discounts: 1 });
    expect(s.flaggedCount).toBe(1);
    expect(s.reconcile.status).toBe("over");
    expect(s.reconcile.message).toBe("Lines are £2.50 over the total — the same as the flagged possible repeat.");
  });

  it("REMOVING THE FLAGGED REPEAT lowers the item count and fixes the reconcile", () => {
    const f = fields();
    const s = reviewSummary(removeLine(f, keyOf(f, 2)));
    expect(s.counts).toEqual({ items: 2, discounts: 1 });
    expect(s.flaggedCount).toBe(0);
    expect(s.reconcile.status).toBe("equal");
  });

  it("follows an edit that hasn't blurred", () => {
    const f = fields();
    const s = reviewSummary(updateLine(f, keyOf(f, 2), { totalText: "0" }));
    expect(s.reconcile.status).toBe("equal");
  });

  it("an amount being typed (unparseable) means the reconcile can't check yet", () => {
    const f = fields();
    expect(reviewSummary(updateLine(f, keyOf(f, 0), { totalText: "1." + "x" })).reconcile.status).toBe("unknown");
  });

  it("an empty added line doesn't count as an item", () => {
    expect(reviewSummary(addLine(fields())).counts).toEqual({ items: 3, discounts: 1 });
  });

  it("formats the reconcile in the chosen currency", () => {
    expect(reviewSummary({ ...fields(), currency: "EUR" }).reconcile.message).toMatch(/^Lines are €2\.50 over/);
  });

  it("with no currency chosen yet, the amount has no symbol — not a £ that implies GBP", () => {
    expect(reviewSummary({ ...fields(), currency: null }).reconcile.message).toBe(
      "Lines are 2.50 over the total — the same as the flagged possible repeat.",
    );
  });
});

describe("reconcileBanner — equal / over / under / can't check", () => {
  it("equal", () => {
    expect(reconcileBanner({ status: "equal", diffPence: 0, message: null })).toEqual({
      tone: "ok",
      text: "Lines add up to the total",
    });
  });
  it("over and under carry the reconcile's own message", () => {
    expect(reconcileBanner({ status: "over", diffPence: 5, message: "Lines are £0.05 over the total" })).toEqual({
      tone: "warn",
      text: "Lines are £0.05 over the total",
    });
    expect(reconcileBanner({ status: "under", diffPence: -5, message: "Lines are £0.05 under the total" }).tone).toBe("warn");
  });
  it("can't check says why", () => {
    expect(reconcileBanner({ status: "unknown", diffPence: null, message: null })).toEqual({
      tone: "info",
      text: "Can't check the lines against the total: the total or a line amount is missing",
    });
  });
});

describe("the long-receipt notice — one source", () => {
  it("is on, with the agreed wording", () => {
    expect(LONG_RECEIPT_NOTICE).toBe(
      "Long receipts are still being tested. Check the lines against your receipt, and please tell us how it coped.",
    );
  });
  it("shows on a 2- or 3-part scan, in create mode only", () => {
    const one = { ...SCANNED, parts: SCANNED.parts.slice(0, 1) };
    const three = { ...SCANNED, parts: [...SCANNED.parts, SCANNED.parts[0]] };
    expect(showLongReceiptNotice(SCANNED)).toBe(true);
    expect(showLongReceiptNotice(three)).toBe(true);
    expect(showLongReceiptNotice(one)).toBe(false);
    expect(showLongReceiptNotice({ ...SCANNED, mode: { kind: "edit", receiptId: "r1" } })).toBe(false);
  });
});
