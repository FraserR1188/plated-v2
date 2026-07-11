// ============================================================
// supabase/functions/_shared/auth.ts
//
// Resolves the calling user from the Authorization header that
// supabase.functions.invoke() attaches automatically.
//
// WHY THIS EXISTS AT ALL:
// verify_jwt (on by default) already rejects requests without a valid
// JWT — but it does NOT tell us WHO called. We need the user id for the
// rate limit and the extraction log, so we resolve it ourselves.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected into every Edge Function automatically. Do NOT set them as
// secrets — the SUPABASE_ prefix is reserved and `secrets set` will
// reject it.
// ============================================================

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** The caller's user id, or null if we can't establish one. */
export async function getCallerId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * Service-role client. BYPASSES RLS — only ever use it for writes the
 * user is not allowed to make themselves (here: the extraction log,
 * which must not be forgeable, or the rate limit is decorative).
 *
 * Never hand this client user-supplied filters.
 */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
