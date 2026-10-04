// ============================================================
// The receipt-draft slice (receipt scanner 4b; findings §7).
//
// The draft travels in the store, not route params: a 150-line draft with up
// to three photos is large for navigation state, and PL-046 already argues
// against non-serialisable params. Like every other per-user field it must
// not survive sign-out — reset() wipes it, or the next account opens the
// previous one's receipt photos and lines.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../useStore";
import type { ReceiptDraft } from "../../lib/receipts";

const DRAFT: ReceiptDraft = {
  mode: { kind: "create" },
  parts: [{ uri: "file:///p1.jpg", base64: "QUJD" }],
  header: {
    store: "Sainsbury's",
    purchasedOn: "2026-09-20",
    purchasedOnEstimated: false,
    printedTotalPence: 100,
    currency: "GBP",
  },
  lines: [
    {
      part: 1,
      rawText: "MILK",
      qty: null,
      qtyUnit: null,
      unitPricePence: null,
      lineTotalPence: 100,
      isDiscount: false,
      possibleSeamDuplicate: false,
    },
  ],
};

beforeEach(() => {
  useStore.getState().reset();
});

describe("receiptDraft", () => {
  it("starts empty", () => {
    expect(useStore.getState().receiptDraft).toBeNull();
  });

  it("set, then clear", () => {
    useStore.getState().setReceiptDraft(DRAFT);
    expect(useStore.getState().receiptDraft).toEqual(DRAFT);
    useStore.getState().clearReceiptDraft();
    expect(useStore.getState().receiptDraft).toBeNull();
  });

  it("an edit-mode draft carries the receipt id in its mode", () => {
    useStore.getState().setReceiptDraft({ ...DRAFT, mode: { kind: "edit", receiptId: "r1" } });
    expect(useStore.getState().receiptDraft?.mode).toEqual({ kind: "edit", receiptId: "r1" });
  });

  it("reset() (sign-out) wipes it", () => {
    useStore.getState().setReceiptDraft(DRAFT);
    useStore.getState().reset();
    expect(useStore.getState().receiptDraft).toBeNull();
  });
});
