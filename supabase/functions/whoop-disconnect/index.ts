// ============================================================
// supabase/functions/whoop-disconnect/index.ts
//
// Tears the connection down at BOTH ends.
//
// The order matters and it is the opposite of what feels natural:
// revoke at WHOOP FIRST, delete our tokens SECOND. Delete first and a
// failed revoke leaves a live access token in WHOOP's system that we no
// longer hold and can never revoke — orphaned, indefinitely. That is not
// what a person means when they tap Disconnect.
//
// But a revoke failure must not TRAP the user in a connected state
// either. So: try to revoke, log loudly if it fails, delete our side
// regardless. The user's intent wins; the log tells us if WHOOP's
// endpoint is misbehaving.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import { WHOOP_API_BASE, WHOOP_TIMEOUT_MS } from "../_shared/whoop.ts";

/**
 * WHOOP's own revoke endpoint. Best-effort: a non-2xx here is logged and
 * swallowed. Revoking also stops any webhooks for this user, which is
 * exactly what we want.
 */
async function revokeAtWhoop(accessToken: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHOOP_TIMEOUT_MS);
  try {
    const res = await fetch(`${WHOOP_API_BASE}/user/access`, {
      method: "DELETE",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error(
        `whoop revoke ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error("whoop revoke failed:", e);
    return false;
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

  const admin = adminClient();

  // The token may be expired — we don't refresh it just to revoke it. An
  // expired access token is already useless to WHOOP, and if the revoke
  // 401s we still delete our side, which is the outcome the user asked
  // for. Not worth a token round-trip to make a teardown marginally
  // tidier.
  const { data: tokenRow, error: tokenErr } = await admin
    .from("whoop_tokens")
    .select("access_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (tokenErr) {
    console.error("token lookup:", tokenErr.message);
    return fail("server_error", "Couldn't disconnect WHOOP.", 500);
  }

  if (tokenRow?.access_token) {
    await revokeAtWhoop(tokenRow.access_token);
  }

  // Our side comes down regardless of what WHOOP said.
  const { error: delTokenErr } = await admin
    .from("whoop_tokens")
    .delete()
    .eq("user_id", userId);

  if (delTokenErr) {
    // This one DOES fail the request. Leaving tokens behind after the
    // user asked us not to have them is the one outcome we cannot ship.
    console.error("token delete:", delTokenErr.message);
    return fail("server_error", "Couldn't disconnect WHOOP.", 500);
  }

  const { error: delConnErr } = await admin
    .from("whoop_connections")
    .delete()
    .eq("user_id", userId);

  if (delConnErr) {
    // Tokens are gone, which is the part that matters. A stranded
    // connection row would show "Connected" with nothing behind it, so
    // log it — but the user is safe.
    console.error("connection delete:", delConnErr.message);
    return fail(
      "server_error",
      "Disconnected, but couldn't tidy up. Try again.",
      500,
    );
  }

  return json({ ok: true }, 200);
});
