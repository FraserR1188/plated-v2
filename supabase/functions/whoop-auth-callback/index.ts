// ============================================================
// supabase/functions/whoop-auth-callback/index.ts
//
// Completes the OAuth round-trip.
//
// Receives { code, state } from the app after WHOOP redirects back to
// plated://whoop-callback, and does the one thing the app cannot: signs
// the token exchange with the client secret.
//
// THE SECURITY DECISION, stated once:
//   The state is not checked for "does this string exist". It is checked
//   for "does this string belong to the user who is calling me right now".
//   Skip the second half and you have built a machine for attaching WHOOP
//   accounts to the wrong plated users.
//
// The state is consumed (deleted) the moment it validates, BEFORE the
// exchange is attempted. A failed exchange therefore costs the user a
// re-tap rather than leaving a replayable nonce on the table.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import {
  WHOOP_API_BASE,
  WHOOP_REDIRECT_URI,
  WHOOP_TIMEOUT_MS,
  expiryFrom,
  whoopCredentials,
  whoopTokenRequest,
} from "../_shared/whoop.ts";

/**
 * WHOOP's user id (int64), for our records. Best-effort: a connection that
 * works but doesn't know its WHOOP user id is fine; a connection that fails
 * because a nice-to-have profile call 500'd is not.
 */
async function fetchWhoopUserId(accessToken: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHOOP_TIMEOUT_MS);
  try {
    const res = await fetch(`${WHOOP_API_BASE}/user/profile/basic`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error(`whoop profile ${res.status}`);
      return null;
    }
    const body = await res.json();
    const id = Number(body?.user_id);
    return Number.isFinite(id) ? id : null;
  } catch (e) {
    console.error("whoop profile fetch failed:", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return fail("bad_request", "Method not allowed.", 405);
  }

  const userId = await getCallerId(req);
  if (!userId) {
    return fail("unauthorized", "Please sign in and try again.", 401);
  }

  const creds = whoopCredentials();
  if (!creds) {
    console.error("WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET is not set");
    return fail("server_error", "WHOOP isn't available right now.", 500);
  }

  // ─── 1. Body ───────────────────────────────────────────────
  let code: string;
  let state: string;
  try {
    const body = await req.json();
    code = String(body?.code ?? "");
    state = String(body?.state ?? "");
  } catch {
    return fail("bad_request", "Couldn't read that request.", 400);
  }

  if (!code || !state) {
    return fail("bad_request", "The WHOOP response was incomplete.", 400);
  }

  const admin = adminClient();

  // ─── 2. Verify the state ───────────────────────────────────
  const { data: stateRow, error: stateErr } = await admin
    .from("whoop_oauth_states")
    .select("state, user_id, expires_at")
    .eq("state", state)
    .maybeSingle();

  if (stateErr) {
    console.error("state lookup:", stateErr.message);
    return fail("server_error", "Couldn't verify that WHOOP response.", 500);
  }

  // Unknown state, someone else's state, or an expired one. All three get
  // the same answer — never tell a caller WHICH of those it was.
  const stateValid =
    stateRow &&
    stateRow.user_id === userId &&
    new Date(stateRow.expires_at).getTime() > Date.now();

  if (!stateValid) {
    if (stateRow && stateRow.user_id !== userId) {
      // Worth a loud log: this is either a bug or an attack, and it is
      // never a normal user doing normal things.
      console.error(
        `state user mismatch: state belongs to ${stateRow.user_id}, caller is ${userId}`,
      );
    }
    return fail(
      "state_invalid",
      "That WHOOP connection expired. Tap Connect and try again.",
      400,
    );
  }

  // Consume it. Single use, before the exchange — a replayed code against
  // a still-live nonce is not a thing we want to be possible.
  const { error: delErr } = await admin
    .from("whoop_oauth_states")
    .delete()
    .eq("state", state);
  if (delErr) console.error("state delete:", delErr.message);

  // ─── 3. Exchange the code ──────────────────────────────────
  const result = await whoopTokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: WHOOP_REDIRECT_URI,
  });

  if ("error" in result) {
    // Server-side only. WHOOP's error text can describe the credential
    // setup; it never goes to the client.
    console.error(result.error);
    return fail(
      "exchange_failed",
      "WHOOP couldn't complete the connection. Try again.",
      502,
    );
  }

  const tokens = result.tokens;

  // ─── 4. Store ──────────────────────────────────────────────
  // Tokens first. If the connection row write fails after this, the user
  // sees "not connected" and re-taps, which overwrites cleanly. The other
  // order would show "Connected" with no tokens behind it — a state the
  // app has no way to recover from.
  const { error: tokenErr } = await admin.from("whoop_tokens").upsert(
    {
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiryFrom(tokens.expires_in),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (tokenErr) {
    console.error("token upsert:", tokenErr.message);
    return fail("server_error", "Couldn't save the WHOOP connection.", 500);
  }

  const whoopUserId = await fetchWhoopUserId(tokens.access_token);

  const { error: connErr } = await admin.from("whoop_connections").upsert(
    {
      user_id: userId,
      whoop_user_id: whoopUserId,
      scopes: tokens.scope ?? null,
      status: "connected",
      connected_at: new Date().toISOString(),
      // Deliberately NOT touching last_sync_at — a reconnect has not synced
      // anything yet, and pretending otherwise would skip the backfill.
    },
    { onConflict: "user_id" },
  );

  if (connErr) {
    console.error("connection upsert:", connErr.message);
    return fail("server_error", "Couldn't save the WHOOP connection.", 500);
  }

  return json({ ok: true, whoopUserId, scopes: tokens.scope ?? null }, 200);
});
