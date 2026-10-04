// ============================================================
// src/lib/receipts.ts — the receipts data layer (receipt-scanner §5, §8)
//
// THE ONLY FILE THAT TOUCHES receipts / receipt_lines. Every write is one
// of three security-invoker RPCs, each called exactly once, here:
//   save_receipt    header + lines in one transaction
//   update_receipt  replace header + lines in one transaction (the server
//                   derives purchased_on_estimated: a changed date is false)
//   delete_receipt  lines go by cascade
// The database keeps direct DML granted (the RPCs run as the caller), so
// "only through the RPCs" is enforced by receiptWriteSites.test.ts, not by
// the server. Don't add a .from("receipts").insert/update/delete anywhere.
//
// RETURN THE ROW OR THROW. Never null, never a swallowed error: the review
// screen keeps the user's edits on failure (the PL-005/006 lesson), and it
// can only do that if a failure is unmistakable. P0002 — the RPCs' "no
// receipt for this user" (deleted on another device, or never yours) — is
// ReceiptNotFoundError, so the screen says "this receipt no longer exists"
// once, for update and delete alike.
//
// PAYLOADS ARE EXPLICIT (CLAUDE.md: MealEntry-style snake_case, never a
// spread). The draft is camelCase; every column is mapped by hand below,
// and user_id / id / created_at / updated_at are never sent — the server
// takes user_id from auth.uid().
//
// READS ARE PAGED (PL-050): a list that silently stops at max_rows is the
// bug PL-050 fixed. Every list read goes through fetchAllPages with an
// ORDER BY ending in a unique column; the only unpaged reads are of one
// receipt by id.
//
// PRIVACY (findings §7): a receipt is a person's shopping. Errors are
// reported by operation name only — no `extra`, no values in messages.
// ============================================================

import { supabase } from "./supabase";
import { reportError } from "./reportError";
import { fetchAllPages } from "./paging";
import type { PreparedImage } from "./imagePrep";
import type { QtyUnit, ReceiptScanLine } from "./receiptScan";

/** Below the API's max_rows (2000, supabase/config.toml), like ENTRIES_PAGE_SIZE. */
export const RECEIPTS_PAGE_SIZE = 500;

// ─── Rows (snake_case, as stored) ───────────────────────────────────────────

export type ReceiptRow = {
  id: string;
  user_id: string;
  store: string | null;
  purchased_on: string;
  purchased_on_estimated: boolean;
  printed_total_pence: number | null;
  currency: string;
  created_at: string;
  updated_at: string;
};

export type ReceiptLineRow = {
  id: string;
  receipt_id: string;
  user_id: string;
  position: number;
  raw_text: string;
  qty: number | null;
  qty_unit: QtyUnit | null;
  unit_price_pence: number | null;
  line_total_pence: number | null;
  is_discount: boolean;
};

/** A list row: the header plus just enough of its lines to fall back on
 *  their sum when the printed total is unreadable (spending.receiptAmount). */
export type ReceiptListRow = ReceiptRow & {
  lines: Pick<ReceiptLineRow, "line_total_pence">[];
};

// ─── The draft (camelCase, in the store) ────────────────────────────────────

export type ReceiptHeaderDraft = {
  store: string | null;
  /** YYYY-MM-DD from dateKey(), never toISOString(). */
  purchasedOn: string;
  /** true iff not read from the receipt AND not set by the user (PL-048).
   *  Sent on save only; on update the server decides it. */
  purchasedOnEstimated: boolean;
  printedTotalPence: number | null;
  /** null = not read from the receipt and not yet chosen. Never defaulted:
   *  the review screen won't save until the user picks one (5b), so an
   *  unread currency can't be saved silently as GBP. */
  currency: string | null;
};

/** A header ready to write: the currency has been chosen. */
export type ReceiptHeader = Omit<ReceiptHeaderDraft, "currency"> & { currency: string };

export type ReceiptLineDraft = {
  rawText: string;
  qty: number | null;
  qtyUnit: QtyUnit | null;
  unitPricePence: number | null;
  lineTotalPence: number | null;
  isDiscount: boolean;
};

/** A line on the review screen. `part` and `possibleSeamDuplicate` live only
 *  here: neither is stored (findings §3), so edit mode has neither. */
export type ReceiptDraftLine = ReceiptLineDraft &
  Pick<ReceiptScanLine, "part" | "possibleSeamDuplicate">;

export type ReceiptDraftMode = { kind: "create" } | { kind: "edit"; receiptId: string };

export type ReceiptDraft = {
  mode: ReceiptDraftMode;
  /** The photos, in receipt order. Empty in edit mode. */
  parts: PreparedImage[];
  header: ReceiptHeaderDraft;
  lines: ReceiptDraftLine[];
};

// ─── Errors ─────────────────────────────────────────────────────────────────

/** The receipt isn't there for this user any more (P0002 from the RPCs, or
 *  no row on a single read). The review screen says so and closes. */
export class ReceiptNotFoundError extends Error {
  readonly code = "P0002";
  constructor() {
    super("This receipt no longer exists.");
    this.name = "ReceiptNotFoundError";
  }
}

type RpcError = { code?: string } | null;

/** Report, then throw — P0002 as ReceiptNotFoundError (not reported: it's
 *  an expected outcome of a delete on another device, not a failure). */
function raise(operation: string, error: NonNullable<RpcError>): never {
  if (error.code === "P0002") throw new ReceiptNotFoundError();
  reportError(operation, error);
  throw error;
}

/** An RPC that answered with neither a row nor an error. Shouldn't happen
 *  (both RPCs return the row or raise), but a null must never pass as a save. */
function noRow(operation: string): never {
  const e = new Error("rpc returned no row");
  reportError(operation, e);
  throw e;
}

// ─── Writes: the three doors ────────────────────────────────────────────────

/** The one p_lines builder, shared by save and update. Position is the
 *  screen order. */
function linesPayload(lines: ReceiptLineDraft[]) {
  return lines.map((l, i) => ({
    position: i,
    raw_text: l.rawText,
    qty: l.qty,
    qty_unit: l.qtyUnit,
    unit_price_pence: l.unitPricePence,
    line_total_pence: l.lineTotalPence,
    is_discount: l.isDiscount,
  }));
}

export async function saveReceipt(
  header: ReceiptHeader,
  lines: ReceiptLineDraft[],
): Promise<ReceiptRow> {
  const { data, error } = await supabase.rpc("save_receipt", {
    p_receipt: {
      store: header.store,
      purchased_on: header.purchasedOn,
      purchased_on_estimated: header.purchasedOnEstimated,
      printed_total_pence: header.printedTotalPence,
      currency: header.currency,
    },
    p_lines: linesPayload(lines),
  });
  if (error) raise("saveReceipt", error);
  if (!data) noRow("saveReceipt");
  return data as ReceiptRow;
}

export async function updateReceipt(
  id: string,
  header: ReceiptHeader,
  lines: ReceiptLineDraft[],
): Promise<ReceiptRow> {
  const { data, error } = await supabase.rpc("update_receipt", {
    p_id: id,
    // No purchased_on_estimated: the server derives it (a changed date is a
    // user-set date), so the client can't get it wrong.
    p_receipt: {
      store: header.store,
      purchased_on: header.purchasedOn,
      printed_total_pence: header.printedTotalPence,
      currency: header.currency,
    },
    p_lines: linesPayload(lines),
  });
  if (error) raise("updateReceipt", error);
  if (!data) noRow("updateReceipt");
  return data as ReceiptRow;
}

export async function deleteReceipt(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_receipt", { p_id: id });
  if (error) raise("deleteReceipt", error);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Every receipt of the user's, newest first, each with its line totals.
 *  purchased_on desc, id desc is a total order, so pages can't overlap or
 *  skip. Throws on a failed page rather than returning part of the list. */
export async function fetchReceipts(userId: string): Promise<ReceiptListRow[]> {
  const rows = await fetchAllPages<ReceiptRow & { receipt_lines?: ReceiptListRow["lines"] }>(
    (from, to) =>
      supabase
        .from("receipts")
        .select("*, receipt_lines(line_total_pence)")
        .eq("user_id", userId)
        .order("purchased_on", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    RECEIPTS_PAGE_SIZE,
  );
  return rows.map(({ receipt_lines, ...r }) => ({ ...r, lines: receipt_lines ?? [] }));
}

/** Every line of every receipt, for the spending CSV: by receipt, then by
 *  position, with id as the unique tiebreaker. */
export async function fetchReceiptLinesForExport(userId: string): Promise<ReceiptLineRow[]> {
  return fetchAllPages<ReceiptLineRow>(
    (from, to) =>
      supabase
        .from("receipt_lines")
        .select("*")
        .eq("user_id", userId)
        .order("receipt_id", { ascending: true })
        .order("position", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    RECEIPTS_PAGE_SIZE,
  );
}

/** One receipt and its lines, for the review screen's edit mode. A receipt
 *  that's gone is ReceiptNotFoundError. At most 150 lines (the function's
 *  cap), well under max_rows. */
export async function fetchReceipt(
  id: string,
): Promise<{ receipt: ReceiptRow; lines: ReceiptLineRow[] }> {
  const { data: receipt, error } = await supabase
    .from("receipts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) raise("fetchReceipt", error);
  if (!receipt) throw new ReceiptNotFoundError();

  const { data: lines, error: linesError } = await supabase
    .from("receipt_lines")
    .select("*")
    .eq("receipt_id", id)
    .order("position", { ascending: true });
  if (linesError) raise("fetchReceipt:lines", linesError);

  return { receipt: receipt as ReceiptRow, lines: (lines ?? []) as ReceiptLineRow[] };
}
