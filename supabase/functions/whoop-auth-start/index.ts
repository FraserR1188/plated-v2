// ============================================================
// supabase/functions/whoop-auth-start/index.ts
//
// Begins the OAuth round-trip.
//
// The client does NOT build the authorize URL. This function does, and it
// does so for a reason: the `state` nonce is only worth anything if the
// server generated it and the server remembers who it belongs to. A state
// the client invented and the client checks proves nothing at all.
//
// Returns { ok: true, authorizeUrl }. The client opens it and nothing more.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import {
  WHOOP_AUTH_URL,
  WHOOP_REDIRECT_URI,
  WHOOP_SCOPES,
  whoopCredentials,
} from "../_shared/whoop.ts";

// Long enough to sign in to WHOOP and read the consent screen; short
// enough that an abandoned nonce is not lying around for a day.
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * 32 hex chars = 128 bits. WHOOP's docs say the state "must be eight
 * characters long if you need to generate it yourself" — read as a
 * minimum, which is how every other OAuth server treats it. If WHOOP
 * turns out to mean it literally and rejects the authorize request,
 * drop this to 8 and note it here so nobody re-lengthens it.
 */
function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

  const admin = adminClient();

  // Opportunistic sweep. No cron, no scheduled function — the nonce table
  // is only ever written on a Connect tap, so cleaning it here keeps it
  // small for free. A failure is not worth failing the request over.
  const { error: sweepErr } = await admin
    .from("whoop_oauth_states")
    .delete()
    .lt("expires_at", new Date().toISOString());
  if (sweepErr) console.error("state sweep:", sweepErr.message);

  const state = generateState();

  // Explicit snake_case. Never spread a camelCase object into a Supabase
  // insert — it silently no-ops the columns that don't match.
  const { error: insertErr } = await admin.from("whoop_oauth_states").insert({
    state,
    user_id: userId,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });

  if (insertErr) {
    // This one DOES fail the request. Without a stored state, the callback
    // has nothing to verify against and would have to trust the client —
    // which is exactly the thing we are refusing to do.
    console.error("state insert:", insertErr.message);
    return fail("server_error", "Couldn't start the WHOOP connection.", 500);
  }

  const authorizeUrl = `${WHOOP_AUTH_URL}?${new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: WHOOP_REDIRECT_URI,
    scope: WHOOP_SCOPES,
    state,
  })}`;

  return json({ ok: true, authorizeUrl }, 200);
});
