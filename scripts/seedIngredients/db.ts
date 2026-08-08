// ============================================================
// scripts/seedIngredients/db.ts — shared service-role Supabase client
//
// Split out of scripts/seedCoreIngredients.ts so scripts/seedIngredients/
// verify.ts can reuse the SAME connection/env handling without importing
// seedCoreIngredients.ts itself. That file is a self-executing script —
// its bottom line is `run().catch(...)` at MODULE SCOPE — so importing it
// for a helper would run the entire importer (argv parsing, "Usage: ..."
// throw, process.exit(1)) as a side effect of the import. A verification
// script must never risk triggering that.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
