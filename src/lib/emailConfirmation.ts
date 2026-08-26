// ============================================================
// src/lib/emailConfirmation.ts — parses the email-confirmation deep link.
//
// platedapp.uk/confirm-email forwards to
//   plated://confirm-email, fragment: access_token=...&refresh_token=...&type=signup
// or, for a dead link, to
//   plated://confirm-email, fragment: error=access_denied&error_code=otp_expired&...
//
// Same shape as passwordReset.ts, sharing its fragment-parsing core via
// authLinks.ts's parseAuthFragment. See that file's header for why the
// fragment is hand-rolled and must never be logged.
//
// NOTE: `type=signup` is this file's assumption about what Supabase's
// confirmation-email template actually sends in the fragment. The bridge
// page defaults `type` to "signup" when the fragment omits it, so a
// mismatch here means Supabase actively sent something else — most
// plausibly `type=email_change`, which this file does not yet handle as a
// distinct case. That's reported below rather than swallowed, precisely
// so an email-change redirect landing here doesn't fail silently.
// ============================================================

import { parseAuthFragment } from "./authLinks";
import { reportError } from "./reportError";

const CONFIRM_EMAIL_PREFIX = "plated://confirm-email";
const EXPECTED_TYPE = "signup";

export type ConfirmLinkResult =
  | { kind: "tokens"; access_token: string; refresh_token: string }
  | { kind: "dead"; reason: "expired" | "invalid" }
  | { kind: "not_a_confirm_link" };

export function parseConfirmLink(url: string): ConfirmLinkResult {
  const result = parseAuthFragment(url, CONFIRM_EMAIL_PREFIX);

  if (result.kind === "no_match") {
    return { kind: "not_a_confirm_link" };
  }
  if (result.kind === "dead") {
    return result;
  }
  if (result.type !== EXPECTED_TYPE) {
    // error.code carries the actual observed type — scrubErrorForReport
    // (scrub.ts) never forwards a plain .message, only .code/.name, so the
    // value has to travel that way to show up in Sentry at all.
    reportError(
      "confirmLinkUnexpectedType",
      { code: result.type ?? "missing", name: "UnexpectedConfirmLinkType" },
      { fingerprint: ["confirm-link-unexpected-type"] },
    );
    return { kind: "dead", reason: "invalid" };
  }
  return {
    kind: "tokens",
    access_token: result.access_token,
    refresh_token: result.refresh_token,
  };
}
