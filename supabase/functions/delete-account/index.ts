// ============================================================
// supabase/functions/delete-account/index.ts
//
// The full account-deletion sequence: ledger row -> WHOOP revoke
// (best-effort) -> auth.users deletion -> Storage sweep. Each stage is
// deliberately ordered by how RETRYABLE it stays if it fails, not by any
// notion of "logical" order:
//
//   1. Ledger insert    — must happen before anything is destroyed. If
//      this fails, nothing else runs: a deletion with no retry material
//      is worse than a deletion that never started.
//
//   2. WHOOP revoke     — best-effort, recorded either way. A revoke
//      failure must never trap the user in a connected state (see
//      whoop-disconnect's header for the same reasoning) — but it must
//      also never look like it succeeded when it didn't, hence the ledger
//      write.
//
//   3. auth.users delete — the moment the user's guarantee is satisfied.
//      Everything in public.* keyed to auth.users(id) ON DELETE CASCADE
//      disappears in the same statement, server-side. If THIS step fails,
//      the account still exists and the whole call is safely retryable
//      from the top.
//
//   4. Storage sweep    — LAST, on purpose. It is the slowest, most
//      pagination-prone, most likely-to-time-out leg, and it is also the
//      ONE step that stays retryable forever: service_role bypasses
//      Storage RLS, so a future run can sweep {user_id}/ with no session,
//      no token, and no auth row — using nothing but the uuid the ledger
//      preserved. Running it before step 3 would mean a mid-sweep timeout
//      leaves the account intact after a partial teardown; running it
//      after means a mid-sweep timeout leaves the account genuinely gone
//      with some image bytes behind — recoverable later, not user-facing.
//
// WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
//
//   - Call the whoop-disconnect function. Revoking is duplicated here
//     (a ~15-line fetch, not worth factoring out across two functions
//     that must remain independently retryable) rather than invoked,
//     and whoop_tokens is NEVER deleted here directly — the
//     auth.users cascade in step 3 removes it a moment later. Deleting
//     it here would burn the only retry credential while reporting
//     success, which is exactly the amnesia the ledger exists to avoid.
//
//   - Walk image_url / image_path columns to find Storage objects. That
//     convention is INVERTED between custom_foods and meal_entries (see
//     the investigation this shipped alongside), and a routine that gets
//     it backwards deletes nothing and returns clean. The sweep lists by
//     PATH PREFIX instead — structurally guaranteed complete by the
//     bucket's own INSERT policy, which requires the first path segment
//     to equal auth.uid() — and it also catches orphans no row ever
//     referenced (an upload that succeeded before its row insert failed).
//
//   - Reuse deleteCustomFoodImage() from the client lib. It returns void
//     and swallows failures — a sweep built on it could not populate
//     storage_objects_removed.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import { WHOOP_API_BASE, WHOOP_TIMEOUT_MS } from "../_shared/whoop.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "custom-food-images";
const STORAGE_PAGE = 100; // supabase-js default; explicit so pagination is visible.
const REMOVE_BATCH = 1000; // Storage's own ceiling on a single remove() call.

// ─── WHOOP revoke ──────────────────────────────────────────────
//
// Deliberately duplicated from whoop-disconnect/index.ts rather than
// imported or invoked — see the file header. Same endpoint, same
// best-effort contract: a non-2xx or thrown error is logged and treated
// as `false`, never thrown onward.

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

// ─── Ledger helpers ────────────────────────────────────────────

/**
 * Every ledger UPDATE goes through here so each call site asserts exactly
 * one row was affected. service_role bypasses RLS, so a mismatch here
 * always means a wrong id, never a policy — it is a bug signal, not a
 * runtime branch, so it logs loudly rather than changing control flow.
 */
async function updateLedger(
  admin: SupabaseClient,
  ledgerId: string,
  patch: Record<string, unknown>,
  context: string,
): Promise<void> {
  const { data, error } = await admin
    .from("account_deletions")
    .update(patch)
    .eq("id", ledgerId)
    .select("id");

  if (error) {
    console.error(`ledger update (${context}):`, error.message);
    return;
  }
  if (!data || data.length !== 1) {
    console.error(
      `ledger update (${context}): expected 1 row affected, got ${data?.length ?? 0}`,
    );
  }
}

/** Stage label + short code only. Never the raw error body — see the
 *  migration's comment on account_deletions.last_error. */
function stageError(stage: string, e: unknown): string {
  const code =
    (e as any)?.status ?? (e as any)?.statusCode ?? (e as any)?.name ?? "error";
  return `${stage}:${code}`;
}

// ─── Storage sweep ─────────────────────────────────────────────
//
// Two levels deep: {userId}/ lists per-custom-food folders, and each of
// those lists the actual objects. Paginated because a heavy custom-food
// user can exceed the default page size; batched on remove() because
// Storage caps a single call at 1000 paths.

async function listUserObjectPaths(
  admin: SupabaseClient,
  userId: string,
): Promise<{ paths: string[]; error: string | null }> {
  const paths: string[] = [];

  const folders: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await admin.storage
      .from(BUCKET)
      .list(userId, { limit: STORAGE_PAGE, offset });
    if (error) return { paths, error: stageError("storage_list", error) };
    if (!data || data.length === 0) break;
    // A "folder" entry in supabase-js's list() has id === null.
    for (const entry of data) if (entry.id === null) folders.push(entry.name);
    if (data.length < STORAGE_PAGE) break;
    offset += STORAGE_PAGE;
  }

  for (const folder of folders) {
    let subOffset = 0;
    for (;;) {
      const { data, error } = await admin.storage
        .from(BUCKET)
        .list(`${userId}/${folder}`, { limit: STORAGE_PAGE, offset: subOffset });
      if (error) return { paths, error: stageError("storage_list", error) };
      if (!data || data.length === 0) break;
      for (const entry of data) {
        if (entry.id !== null) paths.push(`${userId}/${folder}/${entry.name}`);
      }
      if (data.length < STORAGE_PAGE) break;
      subOffset += STORAGE_PAGE;
    }
  }

  return { paths, error: null };
}

async function removeObjectPaths(
  admin: SupabaseClient,
  paths: string[],
): Promise<{ removed: number; error: string | null }> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const chunk = paths.slice(i, i + REMOVE_BATCH);
    const { data, error } = await admin.storage.from(BUCKET).remove(chunk);
    if (error) return { removed, error: stageError("storage_remove", error) };
    removed += data?.length ?? chunk.length;
  }
  return { removed, error: null };
}

// ─── Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return fail("bad_request", "Method not allowed.", 405);
  }

  // Caller id ONLY comes from the JWT. Never from the request body — that
  // is what makes "delete someone else's account" unrepresentable rather
  // than merely unauthorised.
  const userId = await getCallerId(req);
  if (!userId) {
    return fail("unauthorized", "Please sign in and try again.", 401);
  }

  const admin = adminClient();

  // ── 1. Ledger row, before anything is destroyed ─────────────
  const { data: ledgerRow, error: ledgerErr } = await admin
    .from("account_deletions")
    .insert({ user_id: userId })
    .select("id")
    .single();

  if (ledgerErr || !ledgerRow) {
    console.error("ledger insert:", ledgerErr?.message);
    return fail(
      "server_error",
      "Couldn't start account deletion. Try again.",
      500,
    );
  }
  const ledgerId = ledgerRow.id as string;

  // ── 2. WHOOP revoke, best-effort, recorded ───────────────────
  const { data: tokenRow, error: tokenErr } = await admin
    .from("whoop_tokens")
    .select("access_token")
    .eq("user_id", userId)
    .maybeSingle();

  let whoopRevoked: boolean | null = null;

  if (tokenErr) {
    // Not fatal to the deletion — logged only. whoop_tokens is cascaded
    // away regardless once step 3 runs.
    console.error("whoop token lookup:", tokenErr.message);
  } else if (tokenRow?.access_token) {
    whoopRevoked = await revokeAtWhoop(tokenRow.access_token);
    await updateLedger(
      admin,
      ledgerId,
      { whoop_revoke_attempted: true, whoop_revoked: whoopRevoked },
      "whoop_revoke",
    );
  }
  // NOT deleting whoop_tokens / whoop_connections here. Step 3's cascade
  // does it a moment later — see the file header.

  // ── 3. auth.users deletion ────────────────────────────────────
  //
  // shouldSoftDelete is EXPLICITLY false. A soft delete does not free the
  // email address, and would permanently burn play-review@fraseranalytics.com
  // the first time a reviewer exercises this feature — Google Play requires
  // account deletion to actually free the account for re-registration.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(
    userId,
    false,
  );

  if (deleteErr) {
    // Stateless access tokens stay valid up to an hour after the row
    // behind them is gone, so a RETRY can legitimately resolve a caller
    // id that no longer exists. Treat "not found" as already-deleted,
    // not as a failure — that's what makes this function idempotent
    // rather than merely re-runnable.
    const status = (deleteErr as any)?.status;
    const notFound =
      status === 404 || /not.?found/i.test(deleteErr.message ?? "");

    if (!notFound) {
      await updateLedger(
        admin,
        ledgerId,
        { last_error: stageError("auth_delete", deleteErr) },
        "auth_delete_failure",
      );
      console.error("auth delete:", deleteErr.message);
      // The account still exists. The whole call is retryable from the top.
      return fail(
        "server_error",
        "Couldn't delete your account. Try again.",
        500,
      );
    }
    // Already gone — fall through to step 4 as a successful retry.
  }

  await updateLedger(
    admin,
    ledgerId,
    { auth_deleted_at: new Date().toISOString() },
    "auth_deleted_at",
  );

  // ── 4. Storage sweep, last ────────────────────────────────────
  //
  // Best-effort from here on: the account guarantee is already satisfied
  // by step 3. A sweep failure is recorded, not surfaced as a function
  // failure — this is the one stage that stays retryable forever, with
  // nothing but the ledger's uuid.
  let storageObjectsRemoved = 0;

  const { paths, error: listErr } = await listUserObjectPaths(admin, userId);

  if (listErr) {
    await updateLedger(
      admin,
      ledgerId,
      { storage_objects_found: paths.length, last_error: listErr },
      "storage_list_failure",
    );
  } else {
    const { removed, error: removeErr } = await removeObjectPaths(
      admin,
      paths,
    );
    storageObjectsRemoved = removed;

    await updateLedger(
      admin,
      ledgerId,
      {
        storage_objects_found: paths.length,
        storage_objects_removed: removed,
        storage_swept_at: new Date().toISOString(),
        ...(removeErr ? { last_error: removeErr } : {}),
      },
      "storage_swept",
    );
  }

  return json(
    { ok: true, whoop_revoked: whoopRevoked, storage_objects_removed: storageObjectsRemoved },
    200,
  );
});
