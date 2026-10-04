// ============================================================
// src/lib/receiptCapture.ts — the ReceiptScan modal's parts list, pure
// (receipt-scanner findings §4)
//
// Up to three photos of ONE receipt, top of the receipt first. The order on
// screen is the order sent: scan-receipt labels each image "Part k of n" by
// position, so the list is reordered here (↑/↓ only — drag needs
// react-native-gesture-handler, a native dependency that would change the
// fingerprint) and sent as it stands.
//
// Every function returns a new array; the store holds the result.
// ============================================================

import type { PreparedImage } from "./imagePrep";
import type { ReceiptDraft } from "./receipts";
import {
  MAX_RECEIPT_PARTS,
  scanReceipt,
  type ReceiptScanResponse,
  type ReceiptScanSuccess,
} from "./receiptScan";

export type ReceiptPart = PreparedImage;

/**
 * The long-receipt notice (findings §3 rule 2, revised 2026-10-04): the
 * multi-photo re-run hasn't passed, so a scan of 2+ parts ships to testers
 * with this on the review screen. THE ONE SWITCH: set it to null when the
 * re-run passes or tester reports show multi-part scans holding up (and
 * update its test).
 */
export const LONG_RECEIPT_NOTICE: string | null =
  "Long receipts are still being tested. Check the lines against your receipt, and please tell us how it coped.";

/** A fresh scan of 2 or more parts, while the notice is on. Not in edit
 *  mode: a saved receipt has already been checked. */
export function showLongReceiptNotice(draft: Pick<ReceiptDraft, "mode" | "parts">): boolean {
  return LONG_RECEIPT_NOTICE != null && draft.mode.kind === "create" && draft.parts.length >= 2;
}

/** Fewer than 3 parts so far. At 3 the screen says "3 parts is the most". */
export function canAddPart(parts: readonly ReceiptPart[]): boolean {
  return parts.length < MAX_RECEIPT_PARTS;
}

/** Add at the end; never a 4th. */
export function addPart(parts: readonly ReceiptPart[], part: ReceiptPart): ReceiptPart[] {
  return canAddPart(parts) ? [...parts, part] : [...parts];
}

/** Swap with the neighbour above (-1) or below (+1); nothing past an end. */
export function movePart(parts: readonly ReceiptPart[], index: number, dir: -1 | 1): ReceiptPart[] {
  const to = index + dir;
  if (index < 0 || index >= parts.length || to < 0 || to >= parts.length) return [...parts];
  const next = [...parts];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removePart(parts: readonly ReceiptPart[], index: number): ReceiptPart[] {
  return parts.filter((_, i) => i !== index);
}

/** One request for all the parts, in their current order. */
export function scanParts(parts: readonly ReceiptPart[]): Promise<ReceiptScanResponse> {
  return scanReceipt([...parts]);
}

/**
 * A successful scan as a create-mode draft for the review screen.
 *
 * purchased_on_estimated (PL-048's meaning): true iff the date wasn't read
 * from the receipt — then it defaults to today's dateKey(), and the review
 * screen lets the user set it. An unread currency stays null — the review
 * screen won't save until one is chosen, so it can't save silently as GBP
 * (5b). An unread total stays null, never 0.
 */
export function draftFromScan(
  scan: ReceiptScanSuccess,
  parts: ReceiptPart[],
  todayKey: string,
): ReceiptDraft {
  return {
    mode: { kind: "create" },
    parts,
    header: {
      store: scan.store,
      purchasedOn: scan.purchasedOn ?? todayKey,
      purchasedOnEstimated: scan.purchasedOn == null,
      printedTotalPence: scan.printedTotalPence,
      currency: scan.currency,
    },
    lines: scan.lines.map((l) => ({
      part: l.part,
      rawText: l.rawText,
      qty: l.qty,
      qtyUnit: l.qtyUnit,
      unitPricePence: l.unitPricePence,
      lineTotalPence: l.lineTotalPence,
      isDiscount: l.isDiscount,
      possibleSeamDuplicate: l.possibleSeamDuplicate,
    })),
  };
}
