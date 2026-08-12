// ============================================================
// src/lib/reportError.ts — the one place a catch block reports a failure.
//
// Replaces a site's existing console.warn (not a second line alongside it —
// this one calls console.warn internally, then attempts Sentry capture,
// which init() gates to non-dev builds anyway). See the Phase 3 findings
// doc for the full site-by-site rollout plan; this file is the helper only.
// ============================================================

import * as Sentry from "@sentry/react-native";
import { scrubErrorForReport } from "./scrub";

type ReportOptions = {
  level?: "warning" | "error";
  /** Caller-provided, NON-sensitive only (e.g. { table: "meal_entries" }) — never raw error fields, never ids. */
  extra?: Record<string, unknown>;
  fingerprint?: string[];
};

/**
 * `operation` is a short, stable string matching the site's existing
 * console.warn name (e.g. "updateEntry") — the naming convention already in
 * place at every call site this wraps.
 *
 * Default level is "warning": nearly every site this wraps already degrades
 * gracefully (returns null/false/[]/generic-failure) rather than crashing —
 * these are handled, expected-shape failures, not unhandled exceptions.
 *
 * Default fingerprint is `[operation]` — groups every occurrence of the same
 * named failure into one Sentry issue regardless of the underlying error
 * message, so a transient outage doesn't file one issue per request.
 */
export function reportError(
  operation: string,
  error: unknown,
  opts: ReportOptions = {},
): void {
  const { level = "warning", extra, fingerprint } = opts;
  const safe = scrubErrorForReport(error);

  console.warn(operation, safe.code ?? safe.name ?? safe.message);

  const err = new Error(safe.message);
  err.name = safe.name ?? "ReportedError";

  Sentry.captureException(err, {
    level,
    tags: { operation, ...(safe.code ? { error_code: safe.code } : {}) },
    fingerprint: fingerprint ?? [operation],
    ...(extra ? { extra } : {}),
  });
}
