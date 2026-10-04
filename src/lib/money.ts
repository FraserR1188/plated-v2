// ============================================================
// src/lib/money.ts — integer pence, end to end (receipt-scanner findings §6)
//
// No float ever holds an amount: input is split on "." and padded, output
// is built from integer division. And no toLocaleString / Intl — "£12.30"
// must not render as "12,30 £" on a phone set to another locale (the
// Trends precedent).
//
// parsePenceInput is for what a PERSON types on the review screen. The
// server's parsePence (supabase/functions/_shared/receipt.ts) reads what a
// RECEIPT prints, and is stricter: exactly two decimals. Deno and RN module
// resolution are split, so they're two functions with matching tests.
// ============================================================

import { withThousands } from "./numberFormat";

// An optional leading OR trailing minus (never both), an optional £/€,
// 1–5 integer digits, and optionally "." with 1–2 decimals. No thousands
// separator: "1,234.56" is refused, so the field shows empty, never a
// guessed number (findings decision 6).
const PENCE_INPUT = /^(-)?[£€]?(\d{1,5})(?:\.(\d{1,2}))?(-)?$/;

/** "12.3" → 1230, "£12.30" → 1230, "0.50-" → -50, "-0.50" → -50.
 *  Anything else — "12.305", "abc", "", "-0.50-", "1,234.56" — is null. */
export function parsePenceInput(text: string): number | null {
  const m = PENCE_INPUT.exec(text.trim());
  if (!m) return null;
  const [, leadingMinus, whole, decimals = "", trailingMinus] = m;
  if (leadingMinus && trailingMinus) return null;
  const pence = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  return leadingMinus || trailingMinus ? -pence : pence;
}

const SYMBOLS: Record<string, string> = { GBP: "£", EUR: "€" };

// U+2212, the typographic minus: a hyphen next to a currency symbol reads as
// a dash.
const MINUS = "−";

/** 1230 GBP → "£12.30"; -50 GBP → "−£0.50"; 300 EUR → "€3.00";
 *  an unknown code → "12.30 XYZ". Thousands separated by hand. */
export function formatPence(pence: number, currency: string): string {
  const sign = pence < 0 ? MINUS : "";
  const abs = Math.abs(pence);
  const amount = `${withThousands(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
  const symbol = SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${amount}` : `${sign}${amount} ${currency}`;
}

/** The sum of the known values; null only if NONE is known (an empty list
 *  included). Nothing known is not zero — the same rule as sumBucket. */
export function sumPence(values: (number | null)[]): number | null {
  let total: number | null = null;
  for (const v of values) {
    if (v != null) total = (total ?? 0) + v;
  }
  return total;
}
