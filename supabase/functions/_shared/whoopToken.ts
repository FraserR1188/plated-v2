// ============================================================
// supabase/functions/_shared/whoopToken.ts
//
// getValidToken(userId) — the ONLY way any WHOOP-touching function should
// obtain an access token.
//
// ── WHY THIS FILE IS FIDDLIER THAN IT LOOKS ─────────────────────────────
//
// WHOOP rotates refresh tokens. Using one invalidates the old access AND
// refresh token. So if two invocations refresh at the same time:
//
//   invocation A: exchanges refresh_1 -> gets refresh_2. Fine.
//   invocation B: exchanges refresh_1 -> WHOOP: "that token is dead".
//                 The connection is now UNRECOVERABLE without a manual
//                 reconnect that the user has no reason to suspect they need.
//
// A `SELECT ... FOR UPDATE` does not prevent this. The row lock dies with the
// transaction, and the HTTP exchange happens outside it — supabase-js is
// auto-commit per statement, so there is no transaction to hold it in.
//
// What DOES survive the commit is a LEASE, written into
// whoop_tokens.refresh_locked_until by the whoop_token_lease() RPC. The RPC
// takes the row lock, checks, and writes the lease inside one transaction, so
// a concurrent caller blocks, re-reads the committed row, and is told 'busy'.
// It then waits and re-reads rather than presenting a token that is already
// dead.
//
// The lease expires on its own, so a crashed Edge Function cannot wedge a
// connection permanently.
//
// ── AND WHY 'REVOKED' IS RARER THAN D1 ASSUMED ──────────────────────────
//
// D1's rule was "refresh failure = revoked, not retryable". Applied to a
// WHOOP outage, that rule revokes every connection in the app — and because
// rotation makes revocation irreversible, they all stay revoked after WHOOP
// comes back. We only revoke on `fatal`: a 401, or a 400 that actually says
// invalid_grant. Everything else is transient and the sync simply fails.
// ============================================================

import { whoopRefresh, sleep } from "./whoop.ts";

// deno-lint-ignore no-explicit-any
type Admin = any; // SupabaseClient from _shared/auth.ts adminClient()

export type TokenResult =
  | { ok: true; accessToken: string }
  /** No token row at all — the user never connected, or disconnected. */
  | { ok: false; kind: "missing"; message: string }
  /** The refresh token is genuinely dead. status is now 'revoked'. */
  | { ok: false; kind: "revoked"; message: string }
  /** WHOOP is unwell, or another invocation is mid-refresh. Try again later. */
  | { ok: false; kind: "transient"; message: string };

/** How long to wait for another invocation's refresh to land, before giving up. */
const BUSY_WAIT_MS = 1_000;
const BUSY_ATTEMPTS = 5;

/**
 * Mark the connection dead and destroy the credentials.
 *
 * ONLY called on a fatal refresh failure. Settings already renders a
 * "Reconnect" state for status = 'revoked'.
 */
async function revoke(admin: Admin, userId: string, reason: string) {
  console.error(`whoop connection revoked for ${userId}: ${reason}`);

  // Tokens first. A dead refresh token is worse than useless — leaving it in
  // place invites a later retry that cannot possibly succeed.
  const { error: delErr } = await admin
    .from("whoop_tokens")
    .delete()
    .eq("user_id", userId);
  if (delErr) console.error("revoke: token delete:", delErr.message);

  const { error: connErr } = await admin
    .from("whoop_connections")
    .update({
      status: "revoked",
      last_sync_error: "token_revoked",
    })
    .eq("user_id", userId);
  if (connErr) console.error("revoke: connection update:", connErr.message);
}

export async function getValidToken(
  admin: Admin,
  userId: string,
): Promise<TokenResult> {
  for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt++) {
    const { data, error } = await admin
      .rpc("whoop_token_lease", { p_user_id: userId })
      .maybeSingle();

    if (error) {
      console.error("whoop_token_lease:", error.message);
      return {
        ok: false,
        kind: "transient",
        message: "Couldn't read the WHOOP connection.",
      };
    }

    if (!data) {
      return { ok: false, kind: "missing", message: "No WHOOP tokens stored." };
    }

    const outcome = data.outcome as "valid" | "leased" | "busy" | "missing";

    if (outcome === "missing") {
      return { ok: false, kind: "missing", message: "No WHOOP tokens stored." };
    }

    if (outcome === "valid") {
      return { ok: true, accessToken: data.access_token as string };
    }

    if (outcome === "busy") {
      // Another invocation holds the lease. Do NOT refresh — that is the exact
      // race that kills the connection. Wait for them to commit, then re-read:
      // the next lease call should come back 'valid' with their new token.
      await sleep(BUSY_WAIT_MS);
      continue;
    }

    // outcome === 'leased' — we own the refresh.
    const refreshed = await whoopRefresh(data.refresh_token as string);

    if ("error" in refreshed) {
      if (refreshed.fatal) {
        // The credential itself is finished. Nothing to release — the row is
        // about to be deleted.
        await revoke(admin, userId, refreshed.error);
        return {
          ok: false,
          kind: "revoked",
          message: "Your WHOOP connection expired. Reconnect in Settings.",
        };
      }

      // WHOOP is unwell, or we timed out, or we are misconfigured. Drop the
      // lease so the next invocation can try, and leave the connection ALONE.
      console.error(
        `whoop refresh (transient) for ${userId}: ${refreshed.error}`,
      );
      const { error: relErr } = await admin.rpc("whoop_token_release", {
        p_user_id: userId,
      });
      if (relErr) console.error("whoop_token_release:", relErr.message);

      return {
        ok: false,
        kind: "transient",
        message: "WHOOP isn't responding. We'll try again shortly.",
      };
    }

    // Persist the ROTATED pair IMMEDIATELY — before doing anything else with
    // the new access token. If we crashed between here and the first API call,
    // the old refresh token would already be dead and the new one unrecorded:
    // the connection would be gone with nothing in the database to show why.
    const expiresAt = new Date(
      Date.now() + refreshed.expires_in * 1000,
    ).toISOString();

    const { error: commitErr } = await admin.rpc("whoop_token_commit", {
      p_user_id: userId,
      p_access_token: refreshed.access_token,
      p_refresh_token: refreshed.refresh_token,
      p_expires_at: expiresAt,
    });

    if (commitErr) {
      // The worst case in this file. We hold a live rotated token pair that we
      // cannot write down. Log everything except the tokens themselves and let
      // the next invocation fail cleanly on invalid_grant.
      console.error(
        `whoop_token_commit FAILED for ${userId} after a successful rotation. ` +
          `The old refresh token is now dead and the new one is unrecorded. ` +
          `This connection will fail on next refresh and require a reconnect. ` +
          `Cause: ${commitErr.message}`,
      );
      return {
        ok: false,
        kind: "transient",
        message: "Couldn't save the refreshed WHOOP token.",
      };
    }

    return { ok: true, accessToken: refreshed.access_token };
  }

  // Five seconds of 'busy'. Either a refresh is genuinely wedged (the lease
  // will expire on its own within 30s) or something is very wrong. Either way
  // this is not our turn.
  return {
    ok: false,
    kind: "transient",
    message: "A WHOOP token refresh is already in progress.",
  };
}
