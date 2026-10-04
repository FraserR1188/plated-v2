// ============================================================
// The receipt-draft slice (receipt scanner 4b; findings §7).
//
// The draft travels in the store, not route params: a 150-line draft with up
// to three photos is large for navigation state, and PL-046 already argues
// against non-serialisable params. Like every other per-user field it must
// not survive sign-out — reset() wipes it, or the next account opens the
// previous one's receipt photos and lines.
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { supabase } from "../../lib/supabase";
import { useStore } from "../useStore";
import { fetchReceipt, ReceiptNotFoundError, type ReceiptDraft } from "../../lib/receipts";
import { fieldsFromDraft, updateLine } from "../../lib/receiptReview";

// fetchReceipt is replaced so openReceiptForEdit can be driven directly;
// every write still goes through the real receipts.ts to the mocked rpc.
vi.mock("../../lib/receipts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/receipts")>()),
  fetchReceipt: vi.fn(),
}));

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
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(fetchReceipt).mockReset();
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

  it("startReceiptCapture opens an empty create-mode draft dated today, estimated", () => {
    useStore.getState().startReceiptCapture("2026-10-04");
    expect(useStore.getState().receiptDraft).toEqual({
      mode: { kind: "create" },
      parts: [],
      header: {
        store: null,
        purchasedOn: "2026-10-04",
        purchasedOnEstimated: true,
        printedTotalPence: null,
        currency: null,
      },
      lines: [],
    });
  });

  it("setReceiptParts replaces the parts and leaves the rest of the draft alone", () => {
    useStore.getState().startReceiptCapture("2026-10-04");
    const parts = [
      { uri: "file:///a.jpg", base64: "QQ" },
      { uri: "file:///b.jpg", base64: "Qg" },
    ];
    useStore.getState().setReceiptParts(parts);
    const d = useStore.getState().receiptDraft!;
    expect(d.parts).toEqual(parts);
    expect(d.mode).toEqual({ kind: "create" });
    expect(d.lines).toEqual([]);
  });

  it("setReceiptParts with no draft open does nothing", () => {
    useStore.getState().setReceiptParts([{ uri: "file:///a.jpg", base64: "QQ" }]);
    expect(useStore.getState().receiptDraft).toBeNull();
  });

  it("reset() (sign-out) wipes it", () => {
    useStore.getState().setReceiptDraft(DRAFT);
    useStore.getState().reset();
    expect(useStore.getState().receiptDraft).toBeNull();
  });
});

// ─── 5b: save, delete and load for the review screen ────────────────────────
//
// The screen seeds its text fields from the draft and reseeds only when the
// draft OBJECT changes (a load in edit mode). So "keep every input on any
// save failure" is a store contract: a failed save or delete leaves the
// draft exactly as it was — the same object — and the screen's fields are
// never reseeded. Only success clears it.

const ROW = {
  id: "r1",
  user_id: "u1",
  store: "Sainsbury's",
  purchased_on: "2026-09-20",
  purchased_on_estimated: false,
  printed_total_pence: 100,
  currency: "GBP",
  created_at: "2026-10-04T10:00:00Z",
  updated_at: "2026-10-04T10:00:00Z",
};
const EDIT: ReceiptDraft = { ...DRAFT, parts: [], mode: { kind: "edit", receiptId: "r1" } };

const rpcOk = (data: unknown) => vi.mocked(supabase.rpc).mockResolvedValue({ data, error: null } as never);
const rpcErr = (code: string) =>
  vi.mocked(supabase.rpc).mockResolvedValue({
    data: null,
    error: { code, message: "boom", details: null, hint: null },
  } as never);

describe("saveReceiptReview", () => {
  it("create mode: save_receipt with exactly the shown values, then the draft is cleared", async () => {
    rpcOk(ROW);
    useStore.getState().setReceiptDraft(DRAFT);
    const f = fieldsFromDraft(DRAFT);
    const shown = updateLine(f, f.lines[0].key, { totalText: "1.10" }); // not blurred
    const out = await useStore.getState().saveReceiptReview(shown);
    expect(out).toEqual({ kind: "saved", receipt: ROW });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = vi.mocked(supabase.rpc).mock.calls[0] as unknown as [
      string,
      { p_receipt: object; p_lines: { line_total_pence: number }[] },
    ];
    expect(fn).toBe("save_receipt");
    expect(args.p_receipt).toEqual({
      store: "Sainsbury's",
      purchased_on: "2026-09-20",
      purchased_on_estimated: false,
      printed_total_pence: 100,
      currency: "GBP",
    });
    expect(args.p_lines[0].line_total_pence).toBe(110);
    expect(useStore.getState().receiptDraft).toBeNull();
  });

  it("edit mode: update_receipt for the draft's receipt", async () => {
    rpcOk(ROW);
    useStore.getState().setReceiptDraft(EDIT);
    expect((await useStore.getState().saveReceiptReview(fieldsFromDraft(EDIT))).kind).toBe("saved");
    const [fn, args] = vi.mocked(supabase.rpc).mock.calls[0] as unknown as [string, { p_id: string }];
    expect(fn).toBe("update_receipt");
    expect(args.p_id).toBe("r1");
    expect(useStore.getState().receiptDraft).toBeNull();
  });

  it("invalid fields: nothing is sent, the problems come back, the draft is untouched", async () => {
    useStore.getState().setReceiptDraft(DRAFT);
    const before = useStore.getState().receiptDraft;
    const out = await useStore.getState().saveReceiptReview({ ...fieldsFromDraft(DRAFT), currency: null });
    expect(out.kind).toBe("invalid");
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(useStore.getState().receiptDraft).toBe(before);
  });

  it.each([
    ["a server error", () => rpcErr("XX000")],
    ["a network failure", () => vi.mocked(supabase.rpc).mockRejectedValue(new Error("Network request failed"))],
  ])("A SAVE FAILURE KEEPS EVERY INPUT (%s): failed, and the draft is the same object", async (_, fail) => {
    fail();
    for (const d of [DRAFT, EDIT]) {
      useStore.getState().setReceiptDraft(d);
      const before = useStore.getState().receiptDraft;
      expect(await useStore.getState().saveReceiptReview(fieldsFromDraft(d))).toEqual({ kind: "failed" });
      expect(useStore.getState().receiptDraft).toBe(before);
    }
  });

  it("P0002 is gone (deleted elsewhere): the draft stays until the screen closes", async () => {
    rpcErr("P0002");
    useStore.getState().setReceiptDraft(EDIT);
    const before = useStore.getState().receiptDraft;
    expect(await useStore.getState().saveReceiptReview(fieldsFromDraft(EDIT))).toEqual({ kind: "gone" });
    expect(useStore.getState().receiptDraft).toBe(before);
  });

  it("with no draft open, nothing is sent", async () => {
    expect(await useStore.getState().saveReceiptReview(fieldsFromDraft(DRAFT))).toEqual({ kind: "no_draft" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe("deleteReviewedReceipt", () => {
  it("edit mode: delete_receipt for the draft's receipt, then the draft is cleared", async () => {
    rpcOk(null);
    useStore.getState().setReceiptDraft(EDIT);
    expect(await useStore.getState().deleteReviewedReceipt()).toEqual({ kind: "deleted" });
    expect(supabase.rpc).toHaveBeenCalledWith("delete_receipt", { p_id: "r1" });
    expect(useStore.getState().receiptDraft).toBeNull();
  });

  it("create mode has nothing saved to delete: nothing is sent", async () => {
    useStore.getState().setReceiptDraft(DRAFT);
    expect(await useStore.getState().deleteReviewedReceipt()).toEqual({ kind: "no_draft" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("a failure keeps the draft; P0002 is gone", async () => {
    useStore.getState().setReceiptDraft(EDIT);
    const before = useStore.getState().receiptDraft;
    rpcErr("XX000");
    expect(await useStore.getState().deleteReviewedReceipt()).toEqual({ kind: "failed" });
    expect(useStore.getState().receiptDraft).toBe(before);
    rpcErr("P0002");
    expect(await useStore.getState().deleteReviewedReceipt()).toEqual({ kind: "gone" });
    expect(useStore.getState().receiptDraft).toBe(before);
  });
});

describe("openReceiptForEdit", () => {
  it("loads the receipt into an edit-mode draft", async () => {
    vi.mocked(fetchReceipt).mockResolvedValue({
      receipt: ROW,
      lines: [
        {
          id: "l1",
          receipt_id: "r1",
          user_id: "u1",
          position: 0,
          raw_text: "MILK",
          qty: null,
          qty_unit: null,
          unit_price_pence: null,
          line_total_pence: 100,
          is_discount: false,
        },
      ],
    });
    expect(await useStore.getState().openReceiptForEdit("r1")).toBe("ok");
    const d = useStore.getState().receiptDraft!;
    expect(d.mode).toEqual({ kind: "edit", receiptId: "r1" });
    expect(d.lines.map((l) => [l.rawText, l.lineTotalPence])).toEqual([["MILK", 100]]);
    expect(fetchReceipt).toHaveBeenCalledWith("r1");
  });

  it("a receipt that's gone is gone; another failure is failed; neither leaves a draft", async () => {
    vi.mocked(fetchReceipt).mockRejectedValue(new ReceiptNotFoundError());
    expect(await useStore.getState().openReceiptForEdit("r1")).toBe("gone");
    vi.mocked(fetchReceipt).mockRejectedValue(new Error("x"));
    expect(await useStore.getState().openReceiptForEdit("r1")).toBe("failed");
    expect(useStore.getState().receiptDraft).toBeNull();
  });
});
