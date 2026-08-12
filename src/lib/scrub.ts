// ============================================================
// src/lib/scrub.ts — shared redaction, used by instrument.ts (beforeSend/
// beforeBreadcrumb) AND reportError.ts. One implementation, two call sites —
// see the Phase 3 findings doc for why this was pulled out of instrument.ts.
// ============================================================

export const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function scrubUrl(url?: string): string | undefined {
  if (!url) return url;
  const [base] = url.split("?"); // drop query string: kills ?user_id=eq.<uuid> and date filters
  return base.replace(UUID_RE, "<redacted>"); // belt-and-braces: redact any UUID left in the path
}

export function scrubString(s: string): string {
  return s.replace(UUID_RE, "<redacted>");
}

export type SafeError = { message: string; code?: string; name?: string };

/**
 * The health-data boundary for reportError(). NEVER forwards `.message`,
 * `.details`, or `.hint` off an object error — PostgREST interpolates the
 * failing predicate/constraint VALUES into exactly those three fields, and
 * an `Error` built from `pgError.message` (e.g. foodLookup's
 * findCustomFoodByBarcode) inherits the same risk. Only `code`/`name` (a
 * failure CLASS, never a value) make it through. Trades readable prose for
 * a zero-leak guarantee — the operation tag the caller supplies plus this
 * code/name is the triage signal, not the original message text.
 */
export function scrubErrorForReport(error: unknown): SafeError {
  if (typeof error === "string") {
    return { message: scrubString(error) };
  }
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const code = typeof e.code === "string" ? e.code : undefined;
    const name = typeof e.name === "string" ? e.name : undefined;
    const message = code ?? name ?? "unknown_error";
    return { message: scrubString(message), code, name };
  }
  return { message: "unknown_error" };
}
