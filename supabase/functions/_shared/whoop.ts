// ============================================================
// supabase/functions/_shared/whoop.ts
//
// Everything that knows what WHOOP looks like, in one place.
//
// The client secret NEVER leaves this server. That is the entire reason
// the token exchange lives in an Edge Function rather than in the app:
// an APK is a zip file with extra steps.
//
// ── CHANGED IN D2 ───────────────────────────────────────────────────────
//
// 1. ERRORS ARE NOW TYPED, and carry `fatal`.
//
//    D1's rule was "refresh failure = revoked, not retryable". Taken
//    literally that is a landmine: WHOOP has a bad afternoon, every
//    getValidToken() call gets a 503, and the rule dutifully revokes every
//    connection in the app. Refresh tokens ROTATE, so a wrongly-revoked
//    connection cannot be recovered — the user has to notice a "Reconnect"
//    chip in Settings and tap it. A transient outage becomes a permanent,
//    silent, app-wide disconnection.
//
//    So callers get `fatal: boolean`, and when it is ambiguous we return
//    `fatal: false`. A stuck sync is annoying. A bricked connection is a
//    support ticket.
//
// 2. `whoopRefresh()` is LENIENT about the returned refresh token, where
//    the authorization_code path stays strict. See the comment on it.
//
// 3. `whoopGet()` — one paginated, rate-limit-aware GET for all four
//    collections. No second fetch wrapper.
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
].join(" ");

// A hung token call must not hang the Connect button forever.
export const WHOOP_TIMEOUT_MS = 15_000;

// Data reads are allowed to be slower than the token round-trip, but not
// much — the Edge Function's own budget is 150s before the client 504s.
export const WHOOP_API_TIMEOUT_MS = 20_000;

// WHOOP's hard ceiling. Do not raise it: they reject `limit` above 25.
export const WHOOP_PAGE_LIMIT = 25;

export type WhoopTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

/**
 * A failed WHOOP call.
 *
 * `error`  — for the LOG ONLY. Never hand WHOOP's error text to the client:
 *            it describes the shape of the credential setup.
 * `status` — undefined means the request never got an answer (timeout, DNS,
 *            connection reset). Those are ALWAYS transient.
 * `fatal`  — true only when the credential itself is dead. When in doubt,
 *            false. See the header.
 */
export type WhoopError = {
  error: string;
  status?: number;
  fatal: boolean;
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

/** Coerce, don't cast. A string `expires_in` would floor to 0 below, every
 *  call would then think the token was expiring, and rotation would turn
 *  that into a refresh storm. */
function seconds(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Absolute expiry from a relative `expires_in`, with 0 as a safe floor. */
export function expiryFrom(expiresIn: unknown): string {
  return new Date(Date.now() + seconds(expiresIn) * 1000).toISOString();
}

/**
 * Reads the structured OAuth `error` field out of a JSON body and says
 * whether it names a dead credential. Returns null — not false — when the
 * body isn't JSON or has no top-level `error` field, so the caller knows to
 * fall back rather than treating "couldn't parse" as "not fatal".
 */
function fatalOAuthErrorField(body: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { error?: unknown }).error !== "string"
  ) {
    return null;
  }

  const code = (parsed as { error: string }).error;
  return code === "invalid_grant" || code === "invalid_client";
}

/**
 * Is this token-endpoint failure the credential's fault, or WHOOP's?
 *
 * Fatal   — 401 unconditionally, and a 400 or 403 whose OAuth `error` field
 *           names a dead credential (`invalid_grant`, `invalid_client`). 403
 *           is included alongside 400 because WHOOP does not always use 400
 *           for a dead credential in practice.
 * Not     — everything else. A 400/403 we don't recognise, a 429, any 5xx,
 *           and every network-level failure.
 *
 * The body is normally JSON, so the `error` field is checked structurally
 * first. If it isn't JSON, or has no `error` field, that's a WHOOP response
 * shape we haven't seen — fall back to a raw substring check rather than
 * silently classifying it as non-fatal.
 */
export function isFatalTokenFailure(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;

  const fromField = fatalOAuthErrorField(body);
  if (fromField !== null) return fromField;

  const lowered = body.toLowerCase();
  return (
    lowered.includes("invalid_grant") || lowered.includes("invalid_client")
  );
}

type RawTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: unknown;
  scope?: string;
  token_type?: string;
};

/**
 * POST to WHOOP's token endpoint. Form-encoded, per RFC 6749 §4.1.3 and
 * WHOOP's own JavaScript tutorial (which uses URLSearchParams).
 *
 * Their Postman docs show a JSON body for the refresh grant — if you ever
 * see `invalid_request` here, that is the first thing to try flipping.
 */
async function postToken(
  params: Record<string, string>,
): Promise<{ raw: RawTokenResponse } | WhoopError> {
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
      return {
        error: `whoop token ${res.status}: ${detail.slice(0, 400)}`,
        status: res.status,
        fatal: isFatalTokenFailure(res.status, detail),
      };
    }

    return { raw: (await res.json()) as RawTokenResponse };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return {
      error: aborted ? "whoop token request timed out" : String(e),
      // No status at all: the request never got an answer. Never fatal.
      fatal: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The authorization_code grant. STRICT: a first exchange that returns no
 * refresh token means the `offline` scope was not granted, and a connection
 * without a refresh token is dead in an hour. Fail loudly, now.
 *
 * Signature unchanged from D1 — `"error" in result` still narrows correctly.
 */
export async function whoopTokenRequest(
  params: Record<string, string>,
): Promise<{ tokens: WhoopTokens } | WhoopError> {
  const result = await postToken(params);
  if ("error" in result) return result;

  const raw = result.raw;

  if (!raw.access_token || !raw.refresh_token) {
    // Almost always means `offline` was not granted — check the app's scopes
    // in the WHOOP dashboard.
    return {
      error: `whoop token response missing tokens (scope: ${raw.scope ?? "none"})`,
      fatal: true,
      status: 200,
    };
  }

  return {
    tokens: {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_in: seconds(raw.expires_in),
      scope: raw.scope ?? "",
      token_type: raw.token_type ?? "bearer",
    },
  };
}

/**
 * The refresh_token grant. LENIENT about the returned refresh token, and
 * deliberately so.
 *
 * WHOOP rotates refresh tokens: the moment this call succeeds, the token we
 * sent is dead. If the response somehow carries no replacement, we have two
 * choices:
 *
 *   (a) treat it as fatal and revoke  → if we're wrong, we have just bricked
 *                                        a working connection, permanently
 *   (b) keep the old refresh token    → if we're wrong, the NEXT refresh
 *                                        fails with invalid_grant, which IS
 *                                        fatal, and the user reconnects
 *
 * (b) is strictly safer: its failure mode is (a)'s success mode, one hour
 * later. So we keep the old token and log loudly.
 *
 * `scope: offline` is sent on the refresh too — WHOOP's own docs recommend
 * requesting it both when getting an access token and when refreshing one.
 * Omit it and you risk exactly the no-refresh-token case above.
 */
export async function whoopRefresh(refreshToken: string): Promise<
  | {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    }
  | WhoopError
> {
  const creds = whoopCredentials();
  if (!creds) {
    return {
      error: "WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET is not set",
      fatal: false, // Our misconfiguration. Never punish the user's connection.
    };
  }

  const result = await postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: "offline",
  });

  if ("error" in result) return result;

  const raw = result.raw;

  if (!raw.access_token) {
    return {
      error: `whoop refresh returned no access_token (scope: ${raw.scope ?? "none"})`,
      status: 200,
      fatal: false,
    };
  }

  if (!raw.refresh_token) {
    console.error(
      "whoop refresh returned NO refresh_token. Keeping the old one — it is " +
        "probably already dead (rotation), but assuming so would brick the " +
        "connection on a guess. The next refresh will tell us for certain.",
    );
  }

  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token ?? refreshToken,
    expires_in: seconds(raw.expires_in),
    scope: raw.scope ?? "",
  };
}

// ────────────────────────────────────────────────────────────
// Data reads
// ────────────────────────────────────────────────────────────

export type WhoopPage<T> = {
  records: T[];
  nextToken: string | null;
  /** Requests left in the current minute window, per X-RateLimit-Remaining. */
  rateRemaining: number | null;
  /** Seconds until that window resets, per X-RateLimit-Reset. */
  rateResetSeconds: number | null;
};

export type WhoopGetFailure = WhoopError & {
  /** 'unauthorized' means the access token died mid-sync — refresh and retry ONCE. */
  kind: "unauthorized" | "rate_limited" | "transient" | "fatal";
};

/**
 * One page of a WHOOP collection.
 *
 * WHOOP rate-limits per CLIENT, not per user: 100/min and 10,000/day shared
 * across the entire user base. So the headers are not decoration — they are
 * the only warning you get before a 429 takes down sync for everybody at
 * once. The caller is expected to act on `rateRemaining`.
 */
export async function whoopGet<T>(
  path: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<{ page: WhoopPage<T> } | WhoopGetFailure> {
  const url = new URL(`${WHOOP_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHOOP_API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });

    // X-RateLimit-Limit looks like: "100, 100;window=60, 10000;window=86400"
    // We only need Remaining and Reset, both plain integers.
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const rateRemaining = Number.isFinite(remaining) ? remaining : null;
    const rateResetSeconds = Number.isFinite(reset) ? reset : null;

    if (res.status === 401) {
      return {
        kind: "unauthorized",
        error: `whoop ${path} 401`,
        status: 401,
        fatal: false, // The access token expired mid-flight. Refresh and retry.
      };
    }

    if (res.status === 429) {
      return {
        kind: "rate_limited",
        error: `whoop ${path} 429 (reset in ${rateResetSeconds ?? "?"}s)`,
        status: 429,
        fatal: false,
      };
    }

    if (!res.ok) {
      const detail = await res.text();
      return {
        // 4xx that isn't 401/429 usually means we asked for something wrong —
        // a scope we don't have, a malformed window. Retrying won't help, but
        // it is OUR bug, not a dead credential, so it must not revoke.
        kind: res.status < 500 ? "fatal" : "transient",
        error: `whoop ${path} ${res.status}: ${detail.slice(0, 300)}`,
        status: res.status,
        fatal: false,
      };
    }

    const body = await res.json();

    return {
      page: {
        records: (body?.records ?? []) as T[],
        // The query PARAM is nextToken; the response field is next_token.
        // Accept either — this has changed once already.
        nextToken: body?.next_token ?? body?.nextToken ?? null,
        rateRemaining,
        rateResetSeconds,
      },
    };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return {
      kind: "transient",
      error: aborted ? `whoop ${path} timed out` : String(e),
      fatal: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
