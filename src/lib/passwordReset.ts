// ============================================================
// src/lib/passwordReset.ts — parses the recovery deep link.
//
// platedapp.uk/reset-password forwards to
//   plated://reset-password, fragment: access_token=...&refresh_token=...&type=recovery
// or, for a dead link, to
//   plated://reset-password, fragment: error=access_denied&error_code=otp_expired&...
//
// The fragment-parsing itself (why it's hand-rolled instead of using
// expo-linking's Linking.parse(), and why tokens/fragment must never be
// logged) lives in authLinks.ts's parseAuthFragment — this file only adds
// the "type must be recovery" check and narrows the result to
// RecoveryLinkResult's pre-existing shape.
// ============================================================

import { parseAuthFragment } from "./authLinks";

const RESET_PASSWORD_PREFIX = "plated://reset-password";

export type RecoveryLinkResult =
  | { kind: "tokens"; access_token: string; refresh_token: string }
  | { kind: "dead"; reason: "expired" | "invalid" }
  | { kind: "not_a_recovery_link" };

export function parseRecoveryLink(url: string): RecoveryLinkResult {
  const result = parseAuthFragment(url, RESET_PASSWORD_PREFIX);

  if (result.kind === "no_match") {
    return { kind: "not_a_recovery_link" };
  }
  if (result.kind === "dead") {
    return result;
  }
  if (result.type !== "recovery") {
    return { kind: "dead", reason: "invalid" };
  }
  return {
    kind: "tokens",
    access_token: result.access_token,
    refresh_token: result.refresh_token,
  };
}
