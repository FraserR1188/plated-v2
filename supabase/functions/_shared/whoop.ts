// ============================================================
// supabase/functions/_shared/whoop.ts
//
// Everything that knows what WHOOP looks like, in one place.
//
// The client secret NEVER leaves this server. That is the entire reason
// the token exchange lives in an Edge Function rather than in the app:
// an APK is a zip file with extra steps.
// ============================================================

// Overridable via secrets so a WHOOP host change is a `secrets set`, not
// a redeploy. Same trick as the MODEL secret in extract-nutrition-label.
const API_HOST = Deno.env.get("WHOOP_API_HOST") ?? "https://api.prod.whoop.com";

export const WHOOP_AUTH_URL = `${API_HOST}/oauth/oauth2/auth`;
export const WHOOP_TOKEN_URL = `${API_HOST}/oauth/oauth2/token`;
export const WHOOP_API_BASE = `${API_HOST}/developer/v2`;

// Must match the WHOOP dashboard EXACTLY. No trailing slash.
export const WHOOP_REDIRECT_URI = "plated://whoop-callback";

// `offline` is non-negotiable — without it WHOOP issues no refresh token
// and the connection dies the first time the access token expires.
export const WHOOP_SCOPES = [
  "offline",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
  "read:profile",
  "read:body_measurement", // ← add
].join(" ");

// A hung token call must not hang the Connect button forever.
export const WHOOP_TIMEOUT_MS = 15_000;

export type WhoopTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

export function whoopCredentials(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = Deno.env.get("WHOOP_CLIENT_ID");
  const clientSecret = Deno.env.get("WHOOP_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * POST to WHOOP's token endpoint.
 *
 * Form-encoded, per RFC 6749 §4.1.3 and WHOOP's own JavaScript tutorial
 * (which uses URLSearchParams). Note their Postman docs show a JSON body
 * for the refresh grant — if you ever see `invalid_request` here, that is
 * the first thing to try flipping.
 *
 * Returns the parsed tokens, or an error string that is for the LOG ONLY.
 * Never hand WHOOP's error text to the client: it leaks the shape of the
 * credential setup.
 */
export async function whoopTokenRequest(
  params: Record<string, string>,
): Promise<{ tokens: WhoopTokens } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHOOP_TIMEOUT_MS);

  try {
    const res = await fetch(WHOOP_TOKEN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });

    if (!res.ok) {
      const detail = await res.text();
      return { error: `whoop token ${res.status}: ${detail.slice(0, 400)}` };
    }

    const tokens = (await res.json()) as WhoopTokens;

    if (!tokens.access_token || !tokens.refresh_token) {
      // No refresh token almost always means the `offline` scope was not
      // granted — check the app's scopes in the WHOOP dashboard.
      return {
        error: `whoop token response missing tokens (scope: ${tokens.scope ?? "none"})`,
      };
    }

    return { tokens };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { error: aborted ? "whoop token request timed out" : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Absolute expiry from a relative `expires_in`, with 0 as a safe floor. */
export function expiryFrom(expiresIn: number): string {
  const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0;
  return new Date(Date.now() + seconds * 1000).toISOString();
}
