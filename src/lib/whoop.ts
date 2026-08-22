// ============================================================
// src/lib/whoop.ts — client wrapper for the WHOOP connection
//
// Same shape as labelExtraction.ts: functions.invoke() attaches the JWT,
// non-2xx hides the real body on error.context, every function answers
// { ok: true, ... } or { ok: false, error, message } and the caller
// switches on the code and shows `message` verbatim.
//
// What is DIFFERENT here, and worth understanding before you edit it:
//
//   The client never builds the authorize URL and never invents the
//   `state`. It asks the server for a URL, opens it, and hands back
//   whatever came out the other end. The whole point of `state` is that
//   the SERVER remembers who it belongs to — a nonce the client makes up
//   and the client checks proves nothing.
//
//   The client secret is never here. It never leaves the Edge Function.
//   An APK is a zip file with extra steps.
//
// ── ADDED IN D2 ─────────────────────────────────────────────────────────
//
//   syncWhoop() — and one non-obvious thing about it. whoop-sync answers
//   HTTP 200 for outcomes that are NOT successes: a throttled call, and a
//   revoked connection. Both are ordinary states, not errors, and 503-ing
//   the client for "you already synced four minutes ago" would be absurd.
//
//   So a 200 does not mean ok. You have to read the body. See below.
// ============================================================

import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "./supabase";
import { reportError } from "./reportError";

// Must match _shared/whoop.ts and the WHOOP dashboard, character for
// character. No trailing slash.
const REDIRECT_URI = "plated://whoop-callback";

// ─── Types ───────────────────────────────────────────────────

export type WhoopStatus = "connected" | "revoked";

/** Mirrors public.whoop_connections. Snake_case: these are real columns. */
export type WhoopConnection = {
  user_id: string;
  whoop_user_id: number | null;
  scopes: string | null;
  status: WhoopStatus;
  connected_at: string;

  /** Last SUCCESSFUL sync. Anchors the sync window. Never moves on failure. */
  last_sync_at: string | null;
  /** Last ATTEMPT. The throttle key. Moves whether or not the sync worked. */
  last_sync_attempt_at: string | null;
  /**
   * Null when the last sync fully succeeded. "partial" when it hit its time
   * budget mid-pull but otherwise worked — not a failure. Anything else is a
   * real failure code (a collection failure like "cycles:transient", a token
   * failure like "missing" or "token_revoked", etc). See
   * classifySyncStatus() rather than reading this raw.
   */
  last_sync_error: string | null;
};

export type WhoopSyncStatus = "healthy" | "partial" | "failing";

/**
 * Classifies last_sync_error for display. "partial" is the one non-null
 * value that isn't a failure — the sync hit its time budget but otherwise
 * completed, and will pick up the rest next time. Everything else, INCLUDING
 * a code we don't recognise, is "failing": an unfamiliar value from the
 * server must not silently read as healthy.
 */
export function classifySyncStatus(
  lastSyncError: string | null,
): WhoopSyncStatus {
  if (lastSyncError === null) return "healthy";
  if (lastSyncError === "partial") return "partial";
  return "failing";
}

export type WhoopErrorCode =
  | "unauthorized"
  | "bad_request"
  | "state_invalid"
  | "exchange_failed"
  | "not_connected"
  | "server_error"
  | "revoked" // the refresh token is dead; user must reconnect
  | "transient" // WHOOP is unwell, or we timed out. Retry later.
  | "cancelled" // client-side: user backed out of the browser
  | "denied" // WHOOP-side: user tapped Deny on the consent screen
  | "network_error"; // client-side: never reached the function

export type WhoopFailure = {
  ok: false;
  error: WhoopErrorCode;
  message: string;
};

export type ConnectSuccess = {
  ok: true;
  whoopUserId: number | null;
  scopes: string | null;
  /** True when reconnecting under a DIFFERENT WHOOP account wiped the old data. */
  dataPurged: boolean;
};

export type SyncSuccess = {
  ok: true;
  /** 'throttled' — too soon since the last attempt. Not an error; say nothing. */
  skipped: "throttled" | "revoked" | null;
  /** A sync that ran out of budget mid-pull. Rows landed, but the window did not advance. */
  partial: boolean;
  lastSyncAt: string | null;
  counts: Record<string, number> | null;
};

export type ConnectResponse = ConnectSuccess | WhoopFailure;
export type DisconnectResponse = { ok: true } | WhoopFailure;
export type SyncResponse = SyncSuccess | WhoopFailure;

const GENERIC_FAILURE: WhoopFailure = {
  ok: false,
  error: "network_error",
  message: "Couldn't reach WHOOP. Check your connection and try again.",
};

// ─── Read the current connection ─────────────────────────────

/**
 * Reads whoop_connections directly — no Edge Function needed. RLS gives
 * the user SELECT on their own row and nothing else, and this table holds
 * no secrets by design. The tokens live in whoop_tokens, which the client
 * cannot read at all.
 *
 * Returns null when there has never been a connection. A row with
 * status 'revoked' means there WAS one and it died — the UI must say
 * "Reconnect", not "Connect", because the difference is the difference
 * between "you never set this up" and "your data stopped flowing".
 */
export async function getWhoopConnection(): Promise<WhoopConnection | null> {
  try {
    const { data, error } = await supabase
      .from("whoop_connections")
      .select(
        "user_id, whoop_user_id, scopes, status, connected_at, " +
          "last_sync_at, last_sync_attempt_at, last_sync_error",
      )
      .maybeSingle();

    if (error) {
      console.warn("getWhoopConnection:", error.message);
      return null;
    }
    return (data as unknown as WhoopConnection) ?? null;
  } catch (e: any) {
    console.warn("getWhoopConnection:", e?.message ?? e);
    return null;
  }
}

// ─── Connect ─────────────────────────────────────────────────

/**
 * The full OAuth round-trip, from a Connect tap to stored tokens.
 *
 *   1. ask the server for an authorize URL (it mints and stores the state)
 *   2. open it — openAuthSessionAsync gives us the redirect URL back
 *      rather than making us listen on a Linking subscription
 *   3. hand { code, state } to the server, which signs the exchange with
 *      the client secret and stores the tokens
 *
 * Everything a user could reasonably do — cancel, deny, background the
 * app — comes back as a typed failure rather than an exception.
 */
export async function connectWhoop(): Promise<ConnectResponse> {
  // 1) Authorize URL.
  let authorizeUrl: string;
  try {
    const { data, error } = await supabase.functions.invoke(
      "whoop-auth-start",
      {
        body: {},
      },
    );

    if (error) {
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;
      console.warn("whoop-auth-start:", error.message);
      return GENERIC_FAILURE;
    }

    if (
      !data ||
      typeof data !== "object" ||
      typeof (data as any).authorizeUrl !== "string"
    ) {
      console.warn("whoop-auth-start: unexpected payload", Object.keys(data ?? {}));
      reportError("whoopAuthStart:unexpected_payload", new Error("unexpected_payload"));
      return GENERIC_FAILURE;
    }

    authorizeUrl = (data as any).authorizeUrl;
  } catch (e: any) {
    console.warn("whoop-auth-start:", e?.message ?? e);
    return GENERIC_FAILURE;
  }

  // 2) Browser round-trip.
  let redirectUrl: string;
  try {
    const result = await WebBrowser.openAuthSessionAsync(
      authorizeUrl,
      REDIRECT_URI,
    );

    // 'dismiss' is the user swiping the sheet away; 'cancel' is the OS
    // closing it. Neither is an error worth shouting about — the caller
    // should just put the button back and say nothing.
    if (result.type !== "success") {
      return {
        ok: false,
        error: "cancelled",
        message: "WHOOP connection cancelled.",
      };
    }

    redirectUrl = result.url;
  } catch (e: any) {
    console.warn("openAuthSessionAsync:", e?.message ?? e);
    return GENERIC_FAILURE;
  }

  // 3) Pull code + state off the redirect.
  const { queryParams } = Linking.parse(redirectUrl);
  const code = typeof queryParams?.code === "string" ? queryParams.code : "";
  const state = typeof queryParams?.state === "string" ? queryParams.state : "";
  const denied =
    typeof queryParams?.error === "string" ? queryParams.error : "";

  if (denied) {
    // WHOOP sends ?error=access_denied when the user taps Deny.
    return {
      ok: false,
      error: "denied",
      message: "WHOOP access wasn't granted.",
    };
  }

  if (!code || !state) {
    console.warn("whoop redirect missing code/state:", redirectUrl);
    return GENERIC_FAILURE;
  }

  // 4) Exchange, server-side.
  try {
    const { data, error } = await supabase.functions.invoke(
      "whoop-auth-callback",
      {
        body: { code, state },
      },
    );

    if (error) {
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;
      console.warn("whoop-auth-callback:", error.message);
      return GENERIC_FAILURE;
    }

    if (!data || typeof data !== "object" || (data as any).ok !== true) {
      console.warn("whoop-auth-callback: unexpected payload", Object.keys(data ?? {}));
      reportError("whoopAuthCallback:unexpected_payload", new Error("unexpected_payload"));
      return GENERIC_FAILURE;
    }

    return {
      ok: true,
      whoopUserId: (data as any).whoopUserId ?? null,
      scopes: (data as any).scopes ?? null,
      dataPurged: (data as any).dataPurged === true,
    };
  } catch (e: any) {
    console.warn("whoop-auth-callback:", e?.message ?? e);
    return GENERIC_FAILURE;
  }
}

// ─── Sync ────────────────────────────────────────────────────

/**
 * Pull the last 7 days of cycles, sleeps, recoveries and workouts.
 *
 * Call this freely. The throttle lives on the SERVER — 15 minutes for an
 * automatic sync, 60 seconds for a forced one — and it is keyed on
 * last_sync_attempt_at, so it engages even when WHOOP is down. Rate-limiting
 * in the client would just be a second, worse copy of a decision the server
 * has already made correctly.
 *
 * `force: true` is the "Sync now" button. Fire-and-forget on app foreground
 * with no options.
 *
 * THE 200-IS-NOT-OK TRAP: whoop-sync answers 200 for a throttled call and
 * for a revoked connection, because neither is an error. supabase-js will
 * NOT populate `error` for those. Read `data.ok`.
 */
export async function syncWhoop(
  opts: { force?: boolean; days?: number } = {},
): Promise<SyncResponse> {
  try {
    const { data, error } = await supabase.functions.invoke("whoop-sync", {
      body: {
        force: opts.force === true,
        ...(opts.days ? { days: opts.days } : {}),
      },
    });

    if (error) {
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;
      console.warn("whoop-sync:", error.message);
      return GENERIC_FAILURE;
    }

    if (!data || typeof data !== "object") {
      console.warn("whoop-sync: unexpected payload", Object.keys(data ?? {}));
      reportError("whoopSync:unexpected_payload", new Error("unexpected_payload"));
      return GENERIC_FAILURE;
    }

    const body = data as any;

    // A 200 with ok:false. The connection died and getValidToken already
    // marked it revoked — the UI's job is to show "Reconnect", not to panic.
    if (body.ok !== true) {
      return {
        ok: false,
        error: (body.error as WhoopErrorCode) ?? "server_error",
        message:
          typeof body.message === "string" && body.message
            ? body.message
            : GENERIC_FAILURE.message,
      };
    }

    return {
      ok: true,
      skipped: body.skipped ?? null,
      partial: body.partial === true,
      lastSyncAt: body.lastSyncAt ?? null,
      counts: body.counts ?? null,
    };
  } catch (e: any) {
    console.warn("whoop-sync:", e?.message ?? e);
    return GENERIC_FAILURE;
  }
}

// ─── Disconnect ──────────────────────────────────────────────

/**
 * Revokes at WHOOP's end AND deletes the tokens at ours. Both matter:
 * deleting our copy without revoking leaves a live token in WHOOP's
 * system that we've simply forgotten about, which is not what a user
 * means when they tap Disconnect.
 */
export async function disconnectWhoop(): Promise<DisconnectResponse> {
  try {
    const { data, error } = await supabase.functions.invoke(
      "whoop-disconnect",
      {
        body: {},
      },
    );

    if (error) {
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;
      console.warn("whoop-disconnect:", error.message);
      return GENERIC_FAILURE;
    }

    if (!data || typeof data !== "object" || (data as any).ok !== true) {
      console.warn("whoop-disconnect: unexpected payload", Object.keys(data ?? {}));
      reportError("whoopDisconnect:unexpected_payload", new Error("unexpected_payload"));
      return GENERIC_FAILURE;
    }

    return { ok: true };
  } catch (e: any) {
    console.warn("whoop-disconnect:", e?.message ?? e);
    return GENERIC_FAILURE;
  }
}

// ─── Shared ──────────────────────────────────────────────────

/**
 * Dig our error envelope out of a FunctionsHttpError.
 *
 * GOTCHA (same as labelExtraction.ts): on a non-2xx, supabase-js hands
 * you an error whose .message is the useless "Edge Function returned a
 * non-2xx status code". The real { ok, error, message } body is on
 * error.context, which is a Response you have to read.
 */
async function readErrorBody(error: unknown): Promise<WhoopFailure | null> {
  const context = (error as any)?.context;
  if (!context || typeof context.json !== "function") return null;

  try {
    const body = await context.json();
    if (body && body.ok === false && typeof body.error === "string") {
      return {
        ok: false,
        error: body.error as WhoopErrorCode,
        message:
          typeof body.message === "string" && body.message
            ? body.message
            : GENERIC_FAILURE.message,
      };
    }
  } catch {
    // Body wasn't JSON, or was already consumed. Fall through.
  }
  return null;
}
