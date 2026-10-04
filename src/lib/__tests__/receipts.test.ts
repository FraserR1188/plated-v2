// ============================================================
// src/lib/__tests__/receipts.test.ts — the receipts data layer (4b)
//
// Every write is one of three RPCs (findings §5): save_receipt,
// update_receipt, delete_receipt. Each wrapper RETURNS THE ROW OR THROWS —
// never null, never a swallowed error — because the review screen keeps
// the user's edits on failure (the PL-005/006 lesson) and can only do that
// if a failure is unmistakable. P0002 ("no receipt for this user": deleted
// on another device, or never yours) becomes ReceiptNotFoundError so the
// screen says "this receipt no longer exists" once for update and delete.
//
// Reads are paged through fetchAllPages (PL-050): a list that silently
// stops at max_rows is the bug PL-050 fixed, and this table must not
// reintroduce it.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "../supabase";
import {
  saveReceipt,
  updateReceipt,
  deleteReceipt,
  fetchReceipts,
  fetchReceiptLinesForExport,
  fetchReceipt,
  ReceiptNotFoundError,
  RECEIPTS_PAGE_SIZE,
  type ReceiptHeaderDraft,
  type ReceiptLineDraft,
} from "../receipts";
import { fakeCappedTable, type FakeRow } from "../../store/__tests__/helpers/fakePostgrest";

const USER = "a8435663-72e9-4d33-9c3f-803c4cbda393";

const HEADER: ReceiptHeaderDraft = {
  store: "Sainsbury's",
  purchasedOn: "2026-09-20",
  purchasedOnEstimated: false,
  printedTotalPence: 100,
  currency: "GBP",
};
const LINES: ReceiptLineDraft[] = [
  { rawText: "MILK", qty: null, qtyUnit: null, unitPricePence: null, lineTotalPence: 150, isDiscount: false },
  { rawText: "Nectar Price Saving", qty: null, qtyUnit: null, unitPricePence: null, lineTotalPence: -50, isDiscount: true },
];
const LINES_PAYLOAD = [
  { position: 0, raw_text: "MILK", qty: null, qty_unit: null, unit_price_pence: null, line_total_pence: 150, is_discount: false },
  { position: 1, raw_text: "Nectar Price Saving", qty: null, qty_unit: null, unit_price_pence: null, line_total_pence: -50, is_discount: true },
];
const ROW = {
  id: "r1",
  user_id: USER,
  store: "Sainsbury's",
  purchased_on: "2026-09-20",
  purchased_on_estimated: false,
  printed_total_pence: 100,
  currency: "GBP",
  created_at: "2026-10-04T10:00:00Z",
  updated_at: "2026-10-04T10:00:00Z",
};

const rpcOk = (data: unknown) =>
  vi.mocked(supabase.rpc).mockResolvedValue({ data, error: null } as never);
const rpcErr = (code: string) =>
  vi.mocked(supabase.rpc).mockResolvedValue({
    data: null,
    error: { code, message: "boom", details: null, hint: null },
  } as never);

beforeEach(() => {
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.from).mockReset();
});

describe("saveReceipt", () => {
  it("calls save_receipt with explicit snake_case header and positioned lines, and returns the row", async () => {
    rpcOk(ROW);
    expect(await saveReceipt(HEADER, LINES)).toEqual(ROW);
    expect(supabase.rpc).toHaveBeenCalledWith("save_receipt", {
      p_receipt: {
        store: "Sainsbury's",
        purchased_on: "2026-09-20",
        purchased_on_estimated: false,
        printed_total_pence: 100,
        currency: "GBP",
      },
      p_lines: LINES_PAYLOAD,
    });
  });

  it("throws on an RPC error", async () => {
    rpcErr("23514");
    await expect(saveReceipt(HEADER, LINES)).rejects.toMatchObject({ code: "23514" });
  });

  it("throws when the RPC returns no row and no error", async () => {
    rpcOk(null);
    await expect(saveReceipt(HEADER, LINES)).rejects.toThrow();
  });
});

describe("updateReceipt", () => {
  it("calls update_receipt with p_id and a header WITHOUT purchased_on_estimated (the server decides it)", async () => {
    rpcOk(ROW);
    expect(await updateReceipt("r1", HEADER, LINES)).toEqual(ROW);
    expect(supabase.rpc).toHaveBeenCalledWith("update_receipt", {
      p_id: "r1",
      p_receipt: {
        store: "Sainsbury's",
        purchased_on: "2026-09-20",
        printed_total_pence: 100,
        currency: "GBP",
      },
      p_lines: LINES_PAYLOAD,
    });
  });

  it("throws on an RPC error — never returns null", async () => {
    rpcErr("23514");
    await expect(updateReceipt("r1", HEADER, LINES)).rejects.toMatchObject({ code: "23514" });
  });

  it("P0002 is ReceiptNotFoundError", async () => {
    rpcErr("P0002");
    await expect(updateReceipt("r1", HEADER, LINES)).rejects.toBeInstanceOf(ReceiptNotFoundError);
  });

  it("throws when the RPC returns no row and no error", async () => {
    rpcOk(null);
    await expect(updateReceipt("r1", HEADER, LINES)).rejects.toThrow();
  });
});

describe("deleteReceipt", () => {
  it("calls delete_receipt with p_id and resolves", async () => {
    rpcOk(null);
    await expect(deleteReceipt("r1")).resolves.toBeUndefined();
    expect(supabase.rpc).toHaveBeenCalledWith("delete_receipt", { p_id: "r1" });
  });

  it("throws on an RPC error — never returns null", async () => {
    rpcErr("57014");
    await expect(deleteReceipt("r1")).rejects.toMatchObject({ code: "57014" });
  });

  it("P0002 is ReceiptNotFoundError", async () => {
    rpcErr("P0002");
    await expect(deleteReceipt("r1")).rejects.toBeInstanceOf(ReceiptNotFoundError);
  });
});

// ─── Paged reads ────────────────────────────────────────────────────────────

describe("fetchReceipts — paged (PL-050)", () => {
  it("the page size stays below the 1000-row cap", () => {
    expect(RECEIPTS_PAGE_SIZE).toBeLessThan(1000);
  });

  it("reads 1,203 receipts past a 1000-row cap, each exactly once, newest first", async () => {
    // Groups of 7 share a purchased_on, so ties straddle page boundaries.
    const rows: FakeRow[] = Array.from({ length: 1203 }, (_, i) => ({
      id: `r${String(i).padStart(5, "0")}`,
      user_id: USER,
      purchased_on: `2026-${String(1 + Math.floor(i / 7 / 28) % 12).padStart(2, "0")}-${String(1 + (Math.floor(i / 7) % 28)).padStart(2, "0")}`,
      printed_total_pence: 100,
      currency: "GBP",
      store: null,
    }));
    rows.push({ id: "foreign", user_id: "someone-else", purchased_on: "2026-01-01", printed_total_pence: 1, currency: "GBP", store: null });
    fakeCappedTable("receipts", rows, { cap: 1000, identity: (r) => String(r.id) });

    const got = await fetchReceipts(USER);
    const ids = got.map((r) => r.id);
    expect(ids).toHaveLength(1203);
    expect(new Set(ids).size).toBe(1203);
    expect(ids).not.toContain("foreign");
    const sorted = [...got].sort((a, z) =>
      a.purchased_on === z.purchased_on
        ? (a.id < z.id ? 1 : -1)
        : a.purchased_on < z.purchased_on ? 1 : -1,
    );
    expect(ids).toEqual(sorted.map((r) => r.id));
  });

  it("every row carries a lines array (empty when none were embedded)", async () => {
    fakeCappedTable("receipts", [{ id: "r1", user_id: USER, purchased_on: "2026-09-20" }], {
      cap: 1000,
      identity: (r) => String(r.id),
    });
    const [r] = await fetchReceipts(USER);
    expect(r.lines).toEqual([]);
  });

  it("a failed page throws rather than returning a partial list", async () => {
    const rows: FakeRow[] = Array.from({ length: 1203 }, (_, i) => ({ id: `r${i}`, user_id: USER, purchased_on: "2026-09-20" }));
    fakeCappedTable("receipts", rows, { cap: 1000, identity: (r) => String(r.id), failOnRequest: 1 });
    await expect(fetchReceipts(USER)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("fetchReceiptLinesForExport — paged (PL-050)", () => {
  it("reads 2,350 lines past a 1000-row cap, each exactly once, by receipt then position", async () => {
    const rows: FakeRow[] = Array.from({ length: 2350 }, (_, i) => ({
      id: `l${String(i).padStart(5, "0")}`,
      user_id: USER,
      receipt_id: `r${String(Math.floor(i / 47)).padStart(3, "0")}`,
      position: i % 47,
    }));
    fakeCappedTable("receipt_lines", rows, { cap: 1000, identity: (r) => String(r.id) });

    const got = await fetchReceiptLinesForExport(USER);
    expect(got).toHaveLength(2350);
    expect(new Set(got.map((l) => l.id)).size).toBe(2350);
    for (let i = 1; i < got.length; i++) {
      const a = got[i - 1];
      const b = got[i];
      const ordered = a.receipt_id < b.receipt_id || (a.receipt_id === b.receipt_id && a.position < b.position);
      expect(ordered, `${a.id} before ${b.id}`).toBe(true);
    }
  });
});

// ─── Single receipt ─────────────────────────────────────────────────────────

function fakeSingle(receipt: unknown, lines: unknown[]) {
  const calls: { table: string; filters: [string, unknown][]; orders: string[] }[] = [];
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const call = { table, filters: [] as [string, unknown][], orders: [] as string[] };
    calls.push(call);
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => (call.filters.push([c, v]), b),
      order: (c: string) => (call.orders.push(c), b),
      maybeSingle: async () => ({ data: receipt, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: lines, error: null }).then(res),
    };
    return b;
  }) as never);
  return calls;
}

describe("fetchReceipt(id)", () => {
  it("reads the header by id and its lines by receipt_id in position order", async () => {
    const lines = [{ id: "l1", receipt_id: "r1", position: 0 }];
    const calls = fakeSingle(ROW, lines);
    expect(await fetchReceipt("r1")).toEqual({ receipt: ROW, lines });
    expect(calls.find((c) => c.table === "receipts")?.filters).toEqual([["id", "r1"]]);
    const l = calls.find((c) => c.table === "receipt_lines");
    expect(l?.filters).toEqual([["receipt_id", "r1"]]);
    expect(l?.orders[0]).toBe("position");
  });

  it("a receipt that no longer exists is ReceiptNotFoundError", async () => {
    fakeSingle(null, []);
    await expect(fetchReceipt("gone")).rejects.toBeInstanceOf(ReceiptNotFoundError);
  });
});
