// ============================================================
// src/lib/authLinks.ts — shared core for parsing a Supabase auth deep
// link's URL FRAGMENT. Extracted out of passwordReset.ts so a second link
// type (email confirmation) doesn't duplicate the same hand-rolled
// fragment split.
//
// expo-linking's Linking.parse() only reads the QUERY STRING, via
// `new URL(url).searchParams` — it never looks at the fragment (see
// node_modules/expo-linking/build/createURL.js's parse(): the returned
// ParsedURL has no `.hash` field at all). So this hand-rolls the split
// instead of reusing it.
//
// This function only matches the URL prefix and pulls tokens/type off the
// fragment — it does NOT validate `type` against a specific expected
// value ("recovery", "signup", ...). That check is link-specific and
// belongs to each caller (see passwordReset.ts, emailConfirmation.ts).
//
// Never log `url`, `fragment`, or the extracted tokens anywhere that can
// reach Sentry or the console. A valid access_token is a bearer credential
// on its own — scrubUrl() in scrub.ts only strips the QUERY string (splits
// on "?"), not the fragment, so handing a raw link to reportError()'s
// `extra` would leak it uncensored.
// ============================================================

// Passed as emailRedirectTo for both signUp() and resend({ type: 'signup' })
// (see supabase.ts). Live at platedapp.uk and already on the Supabase
// project's Redirect URLs allow-list — GoTrue rejects an emailRedirectTo
// that isn't allow-listed, so this must stay in sync with that dashboard
// setting if it ever changes.
export const CONFIRM_EMAIL_BRIDGE_URL = "https://platedapp.uk/confirm-email";

export type AuthFragmentResult =
  | {
      kind: "tokens";
      access_token: string;
      refresh_token: string;
      type: string | null;
    }
  | { kind: "dead"; reason: "expired" | "invalid" }
  | { kind: "no_match" };

/**
 * Matches `url` against `prefix`. On a match, extracts access_token,
 * refresh_token and type from the fragment (never the query string).
 */
export function parseAuthFragment(
  url: string,
  prefix: string,
): AuthFragmentResult {
  if (!url.startsWith(prefix)) {
    return { kind: "no_match" };
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

  if (!access_token || !refresh_token) {
    return { kind: "dead", reason: "invalid" };
  }

  return { kind: "tokens", access_token, refresh_token, type };
}
