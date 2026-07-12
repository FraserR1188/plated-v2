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
// CHANGED IN D2 — three bugs, all silent:
//
//   1. The state was READ, then DELETED, and a failed delete was logged and
//      ignored — leaving exactly the replayable nonce the header promised
//      would not exist. The delete is now the GATE: one atomic
//      delete-where-mine-and-unexpired-returning. A returned row is proof of
//      every check at once, and no row means no exchange.
//
//   2. whoop_user_id was written from a BEST-EFFORT profile fetch that
//      returns null on failure — clobbering a good stored value whenever
//      WHOOP's profile endpoint hiccupped. It is now only written when the
//      fetch actually succeeded.
//
//   3. Reconnecting with a DIFFERENT WHOOP account merged two people's
//      biometrics under one plated user: the data tables are keyed on
//      (user_id, id), so account B's cycles upserted straight over account
//      A's, and the correlation view cheerfully joined B's recovery to A's
//      dinner. An account change is now detected and the stale WHOOP data
//      purged before the new connection is written.
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

/** Every table holding WHOOP-account-scoped rows. Purged on account change. */
const WHOOP_DATA_TABLES = [
  "whoop_cycles",
  "whoop_sleeps",
  "whoop_recoveries",
  "whoop_workouts",
] as const;

/**
 * WHOOP's user id (int64), for our records. Best-effort: a connection that
 * works but doesn't know its WHOOP user id is fine; a connection that fails
 * because a nice-to-have profile call 500'd is not.
 *
 * Returns null on ANY failure — which is why the caller must never write a
 * null straight into the column. See fix (2) above.
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

  // ─── 2. Consume the state — atomically ─────────────────────
  //
  // The DELETE is the check. Exists AND belongs to this caller AND not
  // expired, in one statement, with the row returned as proof. The old
  // read-then-delete let two concurrent callbacks both pass validation
  // before either had deleted anything.
  //
  // Consumed BEFORE the exchange: a failed exchange costs the user a re-tap
  // rather than leaving a replayable nonce on the table.
  const { data: consumed, error: consumeErr } = await admin
    .from("whoop_oauth_states")
    .delete()
    .eq("state", state)
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .select("state");

  if (consumeErr) {
    console.error("state consume:", consumeErr.message);
    return fail("server_error", "Couldn't verify that WHOOP response.", 500);
  }

  if (!consumed || consumed.length === 0) {
    // Unknown state, someone else's state, an expired one, or a replay. All
    // four get the same answer — never tell a caller WHICH of those it was.
    //
    // The diagnostic read only happens on the failure path, so it costs
    // nothing in the happy case.
    const { data: orphan } = await admin
      .from("whoop_oauth_states")
      .select("user_id")
      .eq("state", state)
      .maybeSingle();

    if (orphan && orphan.user_id !== userId) {
      // Worth a loud log: this is either a bug or an attack, and it is
      // never a normal user doing normal things.
      console.error(
        `state user mismatch: state belongs to ${orphan.user_id}, caller is ${userId}`,
      );
    }

    return fail(
      "state_invalid",
      "That WHOOP connection expired. Tap Connect and try again.",
      400,
    );
  }

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

  // ─── 4. Store the tokens ───────────────────────────────────
  // Tokens first. If the connection row write fails after this, the user
  // sees "not connected" and re-taps, which overwrites cleanly. The other
  // order would show "Connected" with no tokens behind it — a state the
  // app has no way to recover from.
  //
  // refresh_locked_until is explicitly nulled: a lease left stranded by a
  // crashed refresh must not survive a reconnect. (It would expire on its
  // own, but a fresh connection should start clean.)
  const { error: tokenErr } = await admin.from("whoop_tokens").upsert(
    {
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiryFrom(tokens.expires_in),
      refresh_locked_until: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (tokenErr) {
    console.error("token upsert:", tokenErr.message);
    return fail("server_error", "Couldn't save the WHOOP connection.", 500);
  }

  // ─── 5. Detect an account change ───────────────────────────
  //
  // The data tables are keyed on (user_id, id) — OUR user id, not WHOOP's.
  // If this plated user has reconnected as a DIFFERENT WHOOP member (shared
  // strap, replacement device, a test account), the old member's cycles are
  // still sitting in those rows, and the new member's data is about to
  // upsert on top of them. Two people's biometrics, one plated user, no
  // error message.
  //
  // Cheap to fix and cheap to be wrong about: the sync window is 7 days, so
  // a purge costs ~4 requests to refill.
  const { data: existing, error: existingErr } = await admin
    .from("whoop_connections")
    .select("whoop_user_id, last_sync_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingErr) {
    console.error("connection read:", existingErr.message);
    return fail("server_error", "Couldn't save the WHOOP connection.", 500);
  }

  const whoopUserId = await fetchWhoopUserId(tokens.access_token);

  const previousWhoopUserId = existing?.whoop_user_id ?? null;
  const accountChanged =
    whoopUserId !== null &&
    previousWhoopUserId !== null &&
    whoopUserId !== previousWhoopUserId;

  if (accountChanged) {
    console.error(
      `whoop account changed for ${userId}: ${previousWhoopUserId} -> ${whoopUserId}. Purging synced data.`,
    );
    for (const table of WHOOP_DATA_TABLES) {
      const { error: purgeErr } = await admin
        .from(table)
        .delete()
        .eq("user_id", userId);
      if (purgeErr) {
        // Do NOT proceed. A partial purge is worse than no purge: it leaves
        // a plausible-looking mixture rather than an obvious mess.
        console.error(`purge ${table}:`, purgeErr.message);
        return fail("server_error", "Couldn't save the WHOOP connection.", 500);
      }
    }
  }

  // ─── 6. Store the connection ───────────────────────────────
  //
  // Explicit snake_case, every column listed. No spreads — they have
  // silently no-opped new columns on this project before.
  const connectionRow: Record<string, unknown> = {
    user_id: userId,
    scopes: tokens.scope ?? null,
    status: "connected",
    connected_at: new Date().toISOString(),
    // A reconnect has not synced anything yet.
    last_sync_attempt_at: null,
    last_sync_error: null,
  };

  // Only write whoop_user_id when we actually learned it. A best-effort
  // fetch that returned null must never overwrite a good stored value —
  // that null is the difference between detecting an account change and
  // merging two people's health data.
  if (whoopUserId !== null) {
    connectionRow.whoop_user_id = whoopUserId;
  }

  // last_sync_at is deliberately LEFT ALONE on a same-account reconnect: a
  // stale value lets the sync window reach back and fill the gap the
  // disconnection left. On an account change it is meaningless and must be
  // cleared, or the next sync would ask WHOOP for a window anchored to
  // somebody else's history.
  if (accountChanged) {
    connectionRow.last_sync_at = null;
  }

  const { error: connErr } = await admin
    .from("whoop_connections")
    .upsert(connectionRow, { onConflict: "user_id" });

  if (connErr) {
    console.error("connection upsert:", connErr.message);
    return fail("server_error", "Couldn't save the WHOOP connection.", 500);
  }

  return json(
    {
      ok: true,
      whoopUserId,
      scopes: tokens.scope ?? null,
      // The client can use this to explain why the log looks empty after a
      // reconnect, rather than letting the user think the app lost their data.
      dataPurged: accountChanged,
    },
    200,
  );
});
