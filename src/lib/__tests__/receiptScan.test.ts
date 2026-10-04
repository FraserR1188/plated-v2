// ============================================================
// src/lib/__tests__/receiptScan.test.ts — the scan-receipt client (4b)
//
// Same contract as mealRecognition.ts: functions.invoke() with the JWT;
// a non-2xx hides the { ok: false, error, message } envelope in
// error.context, not error.message; and a 200 body is shape-checked, not
// cast, so a truncated or drifted payload is a generic failure rather than
// a ReceiptScanSuccess with undefined lines.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "../supabase";
import {
  scanReceipt,
  isReceiptScanSuccessShape,
  MAX_TOTAL_BASE64_CHARS,
  MAX_RECEIPT_PARTS,
} from "../receiptScan";

const VALID = {
  ok: true,
  partCount: 2,
  store: "Sainsbury's",
  purchasedOn: "2026-09-20",
  currency: "GBP",
  printedTotalPence: 100,
  totalPrintedPart: 2,
  lines: [
    {
      part: 1,
      rawText: "MILK",
      qty: null,
      qtyUnit: null,
      unitPricePence: null,
      lineTotalPence: 150,
      isDiscount: false,
      possibleSeamDuplicate: false,
    },
    {
      part: 2,
      rawText: "Nectar Price Saving",
      qty: null,
      qtyUnit: null,
      unitPricePence: null,
      lineTotalPence: -50,
      isDiscount: true,
      possibleSeamDuplicate: true,
    },
  ],
  notes: [],
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const part = (n: number) => ({ uri: "file:///p.jpg", base64: "A".repeat(n) });

beforeEach(() => {
  vi.mocked(supabase.functions.invoke).mockReset();
});

describe("isReceiptScanSuccessShape", () => {
  it("accepts the server's success shape", () => {
    expect(isReceiptScanSuccessShape(clone(VALID))).toBe(true);
  });

  it("accepts nulls where the server sends null for unread", () => {
    const v = clone(VALID) as any;
    Object.assign(v, { store: null, purchasedOn: null, currency: null, printedTotalPence: null, totalPrintedPart: null });
    Object.assign(v.lines[0], { part: null, lineTotalPence: null });
    expect(isReceiptScanSuccessShape(v)).toBe(true);
  });

  it.each<[string, (v: any) => void]>([
    ["ok is not true", (v) => (v.ok = false)],
    ["partCount missing", (v) => delete v.partCount],
    ["partCount 4", (v) => (v.partCount = 4)],
    ["lines not an array", (v) => (v.lines = null)],
    ["a line without possibleSeamDuplicate", (v) => delete v.lines[1].possibleSeamDuplicate],
    ["a line's part as a string", (v) => (v.lines[0].part = "1")],
    ["a line's part missing", (v) => delete v.lines[0].part],
    ["a fractional pence amount", (v) => (v.lines[0].lineTotalPence = 1.5)],
    ["an unknown qtyUnit", (v) => (v.lines[0].qtyUnit = "lb")],
    ["an unknown currency", (v) => (v.currency = "USD")],
    ["notes missing", (v) => delete v.notes],
    ["isDiscount not boolean", (v) => (v.lines[0].isDiscount = 0)],
  ])("rejects: %s", (_label, mutate) => {
    const v = clone(VALID);
    mutate(v);
    expect(isReceiptScanSuccessShape(v)).toBe(false);
  });
});

describe("scanReceipt", () => {
  it("sends every part, in order, in one invoke", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: clone(VALID), error: null } as never);
    const out = await scanReceipt([part(10), part(20)]);
    expect(out).toEqual(VALID);
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
    expect(supabase.functions.invoke).toHaveBeenCalledWith("scan-receipt", {
      body: {
        parts: [
          { imageBase64: "A".repeat(10), mediaType: "image/jpeg" },
          { imageBase64: "A".repeat(20), mediaType: "image/jpeg" },
        ],
      },
    });
  });

  it("returns the server's error envelope from error.context", async () => {
    const envelope = { ok: false, error: "no_receipt", message: "That doesn't look like a till receipt." };
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: { message: "Edge Function returned a non-2xx status code", context: { json: async () => envelope } },
    } as never);
    expect(await scanReceipt([part(10)])).toEqual(envelope);
  });

  it("a malformed 200 body is a generic failure, not a cast", async () => {
    const bad = clone(VALID) as any;
    delete bad.lines[0].possibleSeamDuplicate;
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: bad, error: null } as never);
    expect(await scanReceipt([part(10)])).toMatchObject({ ok: false, error: "network_error" });
  });

  it("no parts is bad_request, without calling the function", async () => {
    expect(await scanReceipt([])).toMatchObject({ ok: false, error: "bad_request" });
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it(`more than ${MAX_RECEIPT_PARTS} parts is too_long, without calling the function`, async () => {
    expect(await scanReceipt([part(1), part(1), part(1), part(1)])).toMatchObject({
      ok: false,
      error: "too_long",
    });
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("a request over MAX_TOTAL_BASE64_CHARS (9M) is too_long, without calling the function", async () => {
    expect(MAX_TOTAL_BASE64_CHARS).toBe(9_000_000);
    const third = Math.ceil(MAX_TOTAL_BASE64_CHARS / 3) + 1;
    expect(await scanReceipt([part(third), part(third), part(third)])).toMatchObject({
      ok: false,
      error: "too_long",
    });
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });
});
