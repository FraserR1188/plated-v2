// ============================================================
// src/lib/__tests__/receiptCapture.test.ts — the parts list (receipt 5a)
//
// The ReceiptScan modal holds up to three photos of ONE receipt, top of the
// receipt first (findings §4). The list logic is pure and lives in
// receiptCapture.ts so it's tested here, not through the screen:
//   • a part is added at the end, and never a 4th (the server refuses 4
//     with too_long, but the screen must not offer it);
//   • ↑/↓ swap neighbours and do nothing at the ends;
//   • ✕ removes one part and keeps the rest in order;
//   • the order on screen is the order sent — the model is told "Part 1 of
//     3" by position, so a reversed send reads the receipt bottom-up;
//   • a successful scan becomes a create-mode draft for the review screen.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "../supabase";
import {
  addPart,
  canAddPart,
  movePart,
  removePart,
  scanParts,
  draftFromScan,
} from "../receiptCapture";
import { MAX_RECEIPT_PARTS, type ReceiptScanSuccess } from "../receiptScan";

const p = (n: number) => ({ uri: `file:///part${n}.jpg`, base64: `B${n}` });
const uris = (parts: { uri: string }[]) => parts.map((x) => x.uri);

beforeEach(() => {
  vi.mocked(supabase.functions.invoke).mockReset();
});

describe("addPart / canAddPart", () => {
  it("adds at the end, in order", () => {
    expect(uris(addPart(addPart([], p(1)), p(2)))).toEqual(uris([p(1), p(2)]));
  });

  it("caps at 3: a 4th part is not added", () => {
    const three = [p(1), p(2), p(3)];
    expect(MAX_RECEIPT_PARTS).toBe(3);
    expect(canAddPart(three)).toBe(false);
    expect(uris(addPart(three, p(4)))).toEqual(uris(three));
  });

  it("can add while there are fewer than 3", () => {
    expect(canAddPart([])).toBe(true);
    expect(canAddPart([p(1), p(2)])).toBe(true);
  });

  it("returns a new array (state stays immutable)", () => {
    const one = [p(1)];
    const two = addPart(one, p(2));
    expect(two).not.toBe(one);
    expect(one).toHaveLength(1);
  });
});

describe("movePart", () => {
  it("↓ swaps a part with the next one", () => {
    expect(uris(movePart([p(1), p(2), p(3)], 0, 1))).toEqual(uris([p(2), p(1), p(3)]));
  });

  it("↑ swaps a part with the previous one", () => {
    expect(uris(movePart([p(1), p(2), p(3)], 2, -1))).toEqual(uris([p(1), p(3), p(2)]));
  });

  it("does nothing past either end", () => {
    const parts = [p(1), p(2)];
    expect(uris(movePart(parts, 0, -1))).toEqual(uris(parts));
    expect(uris(movePart(parts, 1, 1))).toEqual(uris(parts));
  });
});

describe("removePart", () => {
  it("removes one part and keeps the others in order", () => {
    expect(uris(removePart([p(1), p(2), p(3)], 1))).toEqual(uris([p(1), p(3)]));
  });

  it("an out-of-range index removes nothing", () => {
    expect(uris(removePart([p(1)], 5))).toEqual(uris([p(1)]));
  });
});

describe("scanParts — the order on screen is the order sent", () => {
  it("sends the parts in their current order, after a reorder", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: { message: "x", context: { json: async () => ({ ok: false, error: "model_error", message: "m" }) } },
    } as never);
    const reordered = movePart([p(1), p(2), p(3)], 2, -1); // 1, 3, 2
    await scanParts(reordered);
    const body = (vi.mocked(supabase.functions.invoke).mock.calls[0][1] as { body: { parts: { imageBase64: string }[] } }).body;
    expect(body.parts.map((x) => x.imageBase64)).toEqual(["B1", "B3", "B2"]);
  });
});

describe("draftFromScan", () => {
  const SCAN: ReceiptScanSuccess = {
    ok: true,
    partCount: 2,
    store: "Sainsbury's",
    purchasedOn: "2026-09-20",
    currency: "GBP",
    printedTotalPence: 100,
    totalPrintedPart: 2,
    lines: [
      { part: 1, rawText: "MILK", qty: null, qtyUnit: null, unitPricePence: null, lineTotalPence: 150, isDiscount: false, possibleSeamDuplicate: false },
      { part: 2, rawText: "Nectar Price Saving", qty: null, qtyUnit: null, unitPricePence: null, lineTotalPence: -50, isDiscount: true, possibleSeamDuplicate: true },
    ],
    notes: [],
  };

  it("maps a read date as not estimated, and keeps the lines with their part and seam flag", () => {
    const parts = [p(1), p(2)];
    const d = draftFromScan(SCAN, parts, "2026-10-04");
    expect(d.mode).toEqual({ kind: "create" });
    expect(d.parts).toBe(parts);
    expect(d.header).toEqual({
      store: "Sainsbury's",
      purchasedOn: "2026-09-20",
      purchasedOnEstimated: false,
      printedTotalPence: 100,
      currency: "GBP",
    });
    expect(d.lines).toEqual(SCAN.lines.map(({ part, rawText, qty, qtyUnit, unitPricePence, lineTotalPence, isDiscount, possibleSeamDuplicate }) => ({
      part, rawText, qty, qtyUnit, unitPricePence, lineTotalPence, isDiscount, possibleSeamDuplicate,
    })));
  });

  it("an unread date defaults to today and is marked estimated (PL-048's meaning)", () => {
    const d = draftFromScan({ ...SCAN, purchasedOn: null }, [p(1)], "2026-10-04");
    expect(d.header.purchasedOn).toBe("2026-10-04");
    expect(d.header.purchasedOnEstimated).toBe(true);
  });

  // Revised 5b: it used to default to GBP for the review screen to show. A
  // default can be saved without anyone looking at it, so it stays unset
  // and the review screen won't save until it's chosen.
  it("an unread currency stays unset (null), never a silent GBP", () => {
    expect(draftFromScan({ ...SCAN, currency: null }, [p(1)], "2026-10-04").header.currency).toBeNull();
  });

  it("an unread total stays null, never 0", () => {
    expect(draftFromScan({ ...SCAN, printedTotalPence: null }, [p(1)], "2026-10-04").header.printedTotalPence).toBeNull();
  });
});
