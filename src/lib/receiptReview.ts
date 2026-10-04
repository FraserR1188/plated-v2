// ============================================================
// src/lib/receiptReview.ts — the review screen's fields, pure
// (receipt-scanner findings §3, §6; commit 5b)
//
// THE TEXT IS THE VALUE. The screen holds every editable value as the text
// the user sees, and Save parses that text. Nothing is committed on blur,
// so a tap on Save straight after typing saves what was typed — the
// PL-005/006 lesson, and CopyConfirm's live-text pattern. The live summary
// (item count, reconcile) reads the same text, so the banner, the count and
// the write can't disagree.
//
// NEVER A GUESS. Text that doesn't parse refuses the save and names the
// field; it's never replaced by a last-good value or 0. An empty amount is
// unknown (null). An unset currency refuses the save: it must be chosen,
// never defaulted to GBP.
//
// `part` and `possibleSeamDuplicate` are review-only (findings §3): they
// drive the part tags and the seam flags, and parseReview never passes them
// on to the write.
// ============================================================

import { parsePenceInput } from "./money";
import { countLines, reconcile, type LineCounts, type Reconcile } from "./spending";
import type {
  ReceiptDraft,
  ReceiptDraftLine,
  ReceiptHeader,
  ReceiptLineDraft,
  ReceiptLineRow,
  ReceiptRow,
} from "./receipts";

export type ReviewLine = Pick<
  ReceiptDraftLine,
  "part" | "qty" | "qtyUnit" | "unitPricePence" | "isDiscount" | "possibleSeamDuplicate"
> & {
  /** Stable across edits, adds and removes; never reused. */
  key: string;
  rawText: string;
  totalText: string;
};

export type ReviewFields = {
  store: string;
  purchasedOn: string;
  purchasedOnEstimated: boolean;
  currency: string | null;
  totalText: string;
  lines: ReviewLine[];
  /** The next added line's key number. Only ever goes up. */
  nextKey: number;
};

export type ReviewProblems = {
  currency?: true;
  total?: true;
  /** By line key: no text where there's an amount, or an amount that doesn't parse. */
  lines: Record<string, "text" | "amount">;
};

export type ParsedReview =
  | { ok: true; header: ReceiptHeader; lines: ReceiptLineDraft[] }
  | { ok: false; problems: ReviewProblems; message: string };

export type ReviewSummary = {
  counts: LineCounts;
  reconcile: Reconcile;
  /** Possible seam repeats still on the list. */
  flaggedCount: number;
};

// ─── Text ⇄ pence ───────────────────────────────────────────────────────────

/** 1230 → "12.30", -50 → "-0.50", null → "". No symbol: the currency is its
 *  own control, and parsePenceInput reads this back exactly. */
export function penceText(pence: number | null): string {
  if (pence == null) return "";
  const abs = Math.abs(pence);
  return `${pence < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

type Amount = { ok: true; pence: number | null } | { ok: false };

/** "" → unknown; text that doesn't parse → not ok (never a guess). */
function readAmount(text: string): Amount {
  const t = text.trim();
  if (t === "") return { ok: true, pence: null };
  const pence = parsePenceInput(t);
  return pence == null ? { ok: false } : { ok: true, pence };
}

/** A line the user added and never filled in: dropped, not saved blank. */
const isBlank = (l: ReviewLine) => l.rawText.trim() === "" && l.totalText.trim() === "";

/** A known amount decides by its sign (scan-receipt stores discounts as
 *  negative); an unknown one keeps the flag it was read with. */
const discountFor = (l: ReviewLine, pence: number | null) => (pence != null ? pence < 0 : l.isDiscount);

// ─── Draft → fields ─────────────────────────────────────────────────────────

export function fieldsFromDraft(draft: ReceiptDraft): ReviewFields {
  return {
    store: draft.header.store ?? "",
    purchasedOn: draft.header.purchasedOn,
    purchasedOnEstimated: draft.header.purchasedOnEstimated,
    currency: draft.header.currency,
    totalText: penceText(draft.header.printedTotalPence),
    lines: draft.lines.map((l, i) => ({
      key: `l${i}`,
      part: l.part,
      rawText: l.rawText,
      totalText: penceText(l.lineTotalPence),
      qty: l.qty,
      qtyUnit: l.qtyUnit,
      unitPricePence: l.unitPricePence,
      isDiscount: l.isDiscount,
      possibleSeamDuplicate: l.possibleSeamDuplicate,
    })),
    nextKey: 0,
  };
}

/** A saved receipt as an edit-mode draft: no photos, no parts, no flags
 *  (neither is stored), lines in their saved order. */
export function draftFromReceipt(receipt: ReceiptRow, lines: ReceiptLineRow[]): ReceiptDraft {
  return {
    mode: { kind: "edit", receiptId: receipt.id },
    parts: [],
    header: {
      store: receipt.store,
      purchasedOn: receipt.purchased_on,
      purchasedOnEstimated: receipt.purchased_on_estimated,
      printedTotalPence: receipt.printed_total_pence,
      currency: receipt.currency,
    },
    lines: [...lines]
      .sort((a, z) => a.position - z.position)
      .map((l) => ({
        part: null,
        rawText: l.raw_text,
        qty: l.qty,
        qtyUnit: l.qty_unit,
        unitPricePence: l.unit_price_pence,
        lineTotalPence: l.line_total_pence,
        isDiscount: l.is_discount,
        possibleSeamDuplicate: false,
      })),
  };
}

// ─── Edits (each returns new fields) ────────────────────────────────────────

export function updateLine(
  fields: ReviewFields,
  key: string,
  patch: Partial<Pick<ReviewLine, "rawText" | "totalText">>,
): ReviewFields {
  return { ...fields, lines: fields.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) };
}

export function addLine(fields: ReviewFields): ReviewFields {
  const line: ReviewLine = {
    key: `n${fields.nextKey}`,
    part: null,
    rawText: "",
    totalText: "",
    qty: null,
    qtyUnit: null,
    unitPricePence: null,
    isDiscount: false,
    possibleSeamDuplicate: false,
  };
  return { ...fields, lines: [...fields.lines, line], nextKey: fields.nextKey + 1 };
}

export function removeLine(fields: ReviewFields, key: string): ReviewFields {
  return { ...fields, lines: fields.lines.filter((l) => l.key !== key) };
}

/** A date the user picked is theirs, not an estimate (PL-048's meaning). */
export function setPurchasedOn(fields: ReviewFields, dayKey: string): ReviewFields {
  return { ...fields, purchasedOn: dayKey, purchasedOnEstimated: false };
}

export function setCurrency(fields: ReviewFields, currency: string): ReviewFields {
  return { ...fields, currency };
}

// ─── Save ───────────────────────────────────────────────────────────────────

/** Exactly what's shown, or a refusal naming every field that's wrong. */
export function parseReview(fields: ReviewFields): ParsedReview {
  const problems: ReviewProblems = { lines: {} };
  const total = readAmount(fields.totalText);
  if (!total.ok) problems.total = true;
  if (fields.currency == null) problems.currency = true;

  const lines: ReceiptLineDraft[] = [];
  for (const l of fields.lines) {
    if (isBlank(l)) continue;
    const amount = readAmount(l.totalText);
    if (!amount.ok) {
      problems.lines[l.key] = "amount";
      continue;
    }
    const rawText = l.rawText.trim();
    if (rawText === "") {
      problems.lines[l.key] = "text";
      continue;
    }
    lines.push({
      rawText,
      qty: l.qty,
      qtyUnit: l.qtyUnit,
      unitPricePence: l.unitPricePence,
      lineTotalPence: amount.pence,
      isDiscount: discountFor(l, amount.pence),
    });
  }

  const badLines = Object.values(problems.lines);
  if (fields.currency == null || !total.ok || badLines.length > 0) {
    const message = [
      problems.currency ? "Choose the currency." : null,
      problems.total || badLines.includes("amount") ? "Fix the amounts marked in red, like 12.30." : null,
      badLines.includes("text") ? "Give each line a name, or remove it." : null,
    ]
      .filter(Boolean)
      .join(" ");
    return { ok: false, problems, message };
  }

  const store = fields.store.trim();
  return {
    ok: true,
    header: {
      store: store === "" ? null : store,
      purchasedOn: fields.purchasedOn,
      purchasedOnEstimated: fields.purchasedOnEstimated,
      printedTotalPence: total.pence,
      currency: fields.currency,
    },
    lines,
  };
}

// ─── Live summary ───────────────────────────────────────────────────────────

/** Over the lines as they are now — edited, added and removed. An amount
 *  that doesn't parse yet counts as unknown, so the reconcile can't check. */
export function reviewSummary(fields: ReviewFields): ReviewSummary {
  const live = fields.lines
    .filter((l) => !isBlank(l))
    .map((l) => {
      const amount = readAmount(l.totalText);
      const pence = amount.ok ? amount.pence : null;
      return {
        line_total_pence: pence,
        isDiscount: discountFor(l, pence),
        flagged: l.possibleSeamDuplicate,
      };
    });
  const total = readAmount(fields.totalText);
  const flagged = live.filter((l) => l.flagged);
  const flaggedPence = flagged.reduce((sum, l) => sum + (l.line_total_pence ?? 0), 0);
  return {
    counts: countLines(live),
    reconcile: reconcile(live, total.ok ? total.pence : null, fields.currency ?? "", flaggedPence),
    flaggedCount: flagged.length,
  };
}

/** "45 items · 16 discounts" — never a raw line count. */
export function itemCountLabel({ items, discounts }: LineCounts): string {
  const itemPart = `${items} ${items === 1 ? "item" : "items"}`;
  return discounts === 0 ? itemPart : `${itemPart} · ${discounts} ${discounts === 1 ? "discount" : "discounts"}`;
}

export type BannerTone = "ok" | "warn" | "info";

export function reconcileBanner(r: Reconcile): { tone: BannerTone; text: string } {
  switch (r.status) {
    case "equal":
      return { tone: "ok", text: "Lines add up to the total" };
    case "over":
    case "under":
      return { tone: "warn", text: r.message ?? "" };
    case "unknown":
      return {
        tone: "info",
        text: "Can't check the lines against the total: the total or a line amount is missing",
      };
  }
}
