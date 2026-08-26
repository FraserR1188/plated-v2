// ============================================================
// src/lib/passwordReset.ts — parses the recovery deep link's URL FRAGMENT.
//
// platedapp.uk/reset-password forwards to
//   plated://reset-password, fragment: access_token=...&refresh_token=...&type=recovery
// or, for a dead link, to
//   plated://reset-password, fragment: error=access_denied&error_code=otp_expired&...
//
// expo-linking's Linking.parse() only reads the QUERY STRING, via
// `new URL(url).searchParams` — it never looks at the fragment (see
// node_modules/expo-linking/build/createURL.js's parse(): the returned
// ParsedURL has no `.hash` field at all). So this hand-rolls the split
// instead of reusing it.
//
// Never log `url`, `fragment`, or the extracted tokens anywhere that can
// reach Sentry or the console. A valid access_token is a bearer credential
// on its own — scrubUrl() in scrub.ts only strips the QUERY string (splits
// on "?"), not the fragment, so handing a raw reset-password URL to
// reportError()'s `extra` would leak it uncensored.
// ============================================================

const RESET_PASSWORD_PREFIX = "plated://reset-password";

export type RecoveryLinkResult =
  | { kind: "tokens"; access_token: string; refresh_token: string }
  | { kind: "dead"; reason: "expired" | "invalid" }
  | { kind: "not_a_recovery_link" };

export function parseRecoveryLink(url: string): RecoveryLinkResult {
  if (!url.startsWith(RESET_PASSWORD_PREFIX)) {
    return { kind: "not_a_recovery_link" };
  }

  const hashIndex = url.indexOf("#");
  const fragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : "";
  const params = new URLSearchParams(fragment);

  const errorCode = params.get("error_code") ?? params.get("error");
  if (errorCode) {
    return {
      kind: "dead",
      reason: errorCode === "otp_expired" ? "expired" : "invalid",
    };
  }

  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  const type = params.get("type");

  if (type !== "recovery" || !access_token || !refresh_token) {
    return { kind: "dead", reason: "invalid" };
  }

  return { kind: "tokens", access_token, refresh_token };
}
