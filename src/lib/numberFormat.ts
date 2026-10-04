// ============================================================
// src/lib/numberFormat.ts — locale-free number formatting
//
// Pure, and never toLocaleString / Intl, so the device's locale gets no
// vote: a chart that says 2,800 in one place and 2.800 in another is
// showing a different number, not a different style, and money is worse
// ("£12.30" vs "12,30 £"). Lifted from trends.ts so money.ts shares it
// rather than writing a second one (receipt-scanner findings §6).
// ============================================================

/** "2800" → "2,800". Takes a string as well as a number so a tick label
 *  keeps the decimal places its step calls for: String(0.30) is "0.3", but
 *  "0.30" stays "0.30". */
export function withThousands(n: number | string): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
