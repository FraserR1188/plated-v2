// ============================================================
// src/lib/receiptScan.ts — client wrapper for scan-receipt
//
// Same pattern as mealRecognition.ts:
//   • functions.invoke() attaches the session JWT automatically
//   • non-2xx comes back as a FunctionsHttpError with the JSON body
//     hidden inside error.context, NOT in error.message
//   • the function always answers with { ok: true, ... } or
//     { ok: false, error, message } — the caller switches on the code and
//     shows `message` verbatim
//
// One call carries 1–3 photos of ONE receipt, in order, top to bottom
// (findings §3). The parts and the request total are checked here before
// anything is sent, and again in the function.
//
// PRIVACY (findings §7): a scan result is a person's shopping. Nothing here
// logs it or puts it in an error report — fixed strings only.
// ============================================================

import { supabase } from "./supabase";
import { reportError } from "./reportError";
import type { PreparedImage } from "./imagePrep";

// ⚠️  MIRROR OF supabase/functions/scan-receipt (the response shape and the
//     limits). Deno and RN have separate tsconfigs; sharing one file across
//     that boundary costs more than it saves. Change one, change the other.

/** Photos per receipt (findings decision 2). */
export const MAX_RECEIPT_PARTS = 3;

/** The whole request's base64 (findings §3, confirmed in the bake-off). Each
 *  part is already held to MAX_PART_BASE64_CHARS by prepareImage. */
export const MAX_TOTAL_BASE64_CHARS = 9_000_000;

export type ReceiptCurrency = "GBP" | "EUR";
export type QtyUnit = "each" | "kg";

export type ReceiptScanLine = {
  /** 1-based photo the line was read from; null if the model's was out of range. */
  part: number | null;
  rawText: string;
  qty: number | null;
  qtyUnit: QtyUnit | null;
  unitPricePence: number | null;
  lineTotalPence: number | null;
  isDiscount: boolean;
  /** Read at the top of part k+1 identically to the foot of part k: maybe a
   *  seam echo, maybe a real repeat purchase. Kept, flagged, never stored. */
  possibleSeamDuplicate: boolean;
};

export type ReceiptScanSuccess = {
  ok: true;
  partCount: number;
  store: string | null;
  /** YYYY-MM-DD, or null if the date wasn't read unambiguously. */
  purchasedOn: string | null;
  currency: ReceiptCurrency | null;
  printedTotalPence: number | null;
  totalPrintedPart: number | null;
  lines: ReceiptScanLine[];
  notes: string[];
};

export type ReceiptScanErrorCode =
  | "unauthorized"
  | "bad_request"
  | "rate_limited"
  | "no_receipt"
  | "too_long"
  | "model_error"
  | "server_error"
  | "network_error"; // client-side only: never reached the function

export type ReceiptScanFailure = {
  ok: false;
  error: ReceiptScanErrorCode;
  message: string;
};

export type ReceiptScanResponse = ReceiptScanSuccess | ReceiptScanFailure;

const FUNCTION_NAME = "scan-receipt";

const GENERIC_FAILURE: ReceiptScanFailure = {
  ok: false,
  error: "network_error",
  message: "Couldn't reach the receipt scanner. Check your connection and try again.",
};

/**
 * Send 1–3 prepared photos of one receipt, in receipt order.
 *
 * @param parts Each MUST have been through prepareImage(…, "receipt") — the
 *              function trusts the declared media type and the sizing.
 */
export async function scanReceipt(
  parts: Pick<PreparedImage, "base64">[],
): Promise<ReceiptScanResponse> {
  if (parts.length === 0) {
    return { ok: false, error: "bad_request", message: "Add a photo of the receipt first." };
  }
  if (parts.length > MAX_RECEIPT_PARTS) {
    return {
      ok: false,
      error: "too_long",
      message: "Photograph long receipts in up to 3 overlapping parts.",
    };
  }
  const total = parts.reduce((n, p) => n + p.base64.length, 0);
  if (total > MAX_TOTAL_BASE64_CHARS) {
    return {
      ok: false,
      error: "too_long",
      message: "Those photos are too large together. Try retaking them.",
    };
  }

  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: {
        parts: parts.map((p) => ({ imageBase64: p.base64, mediaType: "image/jpeg" })),
      },
    });

    if (error) {
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;
      console.warn("scanReceipt: invoke failed");
      return GENERIC_FAILURE;
    }

    if (!isReceiptScanSuccessShape(data)) {
      reportError("scanReceipt:unexpected_payload", new Error("unexpected_payload"));
      return GENERIC_FAILURE;
    }

    return data;
  } catch {
    console.warn("scanReceipt: threw");
    return GENERIC_FAILURE;
  }
}

/** Dig our error envelope out of a FunctionsHttpError. */
async function readErrorBody(error: unknown): Promise<ReceiptScanFailure | null> {
  const context = (error as { context?: { json?: unknown } } | null)?.context;
  if (!context || typeof context.json !== "function") return null;

  try {
    const body = await (context.json as () => Promise<unknown>)();
    const b = body as Record<string, unknown> | null;
    if (b && b.ok === false && typeof b.error === "string") {
      return {
        ok: false,
        error: b.error as ReceiptScanErrorCode,
        message:
          typeof b.message === "string" && b.message ? b.message : GENERIC_FAILURE.message,
      };
    }
  } catch {
    // Body wasn't JSON, or was already consumed. Fall through.
  }
  return null;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isIntOrNull = (v: unknown) => v === null || isInt(v);
const isStringOrNull = (v: unknown) => v === null || typeof v === "string";

function isLineShape(v: unknown): v is ReceiptScanLine {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (
    "part" in l &&
    isIntOrNull(l.part) &&
    typeof l.rawText === "string" &&
    (l.qty === null || typeof l.qty === "number") &&
    (l.qtyUnit === null || l.qtyUnit === "each" || l.qtyUnit === "kg") &&
    isIntOrNull(l.unitPricePence) &&
    isIntOrNull(l.lineTotalPence) &&
    typeof l.isDiscount === "boolean" &&
    typeof l.possibleSeamDuplicate === "boolean"
  );
}

/**
 * Shape-check rather than trusting a cast. A malformed or truncated
 * response (a proxy timeout mid-body, a contract drift) must fail loudly
 * here — as GENERIC_FAILURE — instead of handing the review screen lines
 * with undefined totals that would sum to NaN.
 */
export function isReceiptScanSuccessShape(data: unknown): data is ReceiptScanSuccess {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.ok === true &&
    isInt(d.partCount) &&
    d.partCount >= 1 &&
    d.partCount <= MAX_RECEIPT_PARTS &&
    isStringOrNull(d.store) &&
    isStringOrNull(d.purchasedOn) &&
    (d.currency === null || d.currency === "GBP" || d.currency === "EUR") &&
    isIntOrNull(d.printedTotalPence) &&
    isIntOrNull(d.totalPrintedPart) &&
    Array.isArray(d.lines) &&
    d.lines.every(isLineShape) &&
    Array.isArray(d.notes) &&
    d.notes.every((n) => typeof n === "string")
  );
}
