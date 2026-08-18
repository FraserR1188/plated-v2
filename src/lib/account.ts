// ============================================================
// src/lib/account.ts — client wrapper for in-app account deletion
//
// Same shape as whoop.ts / labelExtraction.ts: functions.invoke() attaches
// the JWT, a non-2xx hides the real { ok, error, message } body on
// error.context rather than error.message, so readErrorBody() unpacks it
// before falling back to a generic message.
//
// deleteAccount() returns WriteResult — { error: string | null } — the
// same shape as useStore's deleteEntries/updateEntry/saveGoals, so the
// screen calling it follows the pattern already established there rather
// than inventing a new result shape for one call site.
// ============================================================

import { supabase } from "./supabase";
import { reportError } from "./reportError";
import type { WriteResult } from "../store/useStore";

const GENERIC_FAILURE =
  "Couldn't delete your account. Check your connection and try again.";

/**
 * Digs the { ok, error, message } envelope out of a FunctionsHttpError.
 *
 * GOTCHA (same as whoop.ts / labelExtraction.ts): on a non-2xx,
 * supabase-js hands back an error whose .message is the useless "Edge
 * Function returned a non-2xx status code". The real body is on
 * error.context, which is a Response you have to read.
 */
async function readErrorBody(error: unknown): Promise<string | null> {
  const context = (error as any)?.context;
  if (!context || typeof context.json !== "function") return null;

  try {
    const body = await context.json();
    if (body && body.ok === false && typeof body.message === "string" && body.message) {
      return body.message;
    }
  } catch {
    // Body wasn't JSON, or was already consumed. Fall through.
  }
  return null;
}

/**
 * Deletes the current user's account: revokes WHOOP (best-effort),
 * deletes auth.users (cascading every FK-owned table), and sweeps their
 * Storage objects. See supabase/functions/delete-account/index.ts for the
 * full sequence and its ordering rationale.
 *
 * Caller is responsible for ending in a signed-out state on success — see
 * DeleteAccountScreen, which mirrors SettingsScreen's sign-out ordering
 * (reset() the store BEFORE the auth call resolves, since the user row is
 * already gone and a default-scope signOut() would just fail against a
 * revoked session).
 */
export async function deleteAccount(): Promise<WriteResult> {
  try {
    const { data, error } = await supabase.functions.invoke(
      "delete-account",
      { body: {} },
    );

    if (error) {
      const message = await readErrorBody(error);
      if (message) return { error: message };
      console.warn("delete-account:", error.message);
      return { error: GENERIC_FAILURE };
    }

    if (!data || typeof data !== "object" || (data as any).ok !== true) {
      console.warn("delete-account: unexpected payload", Object.keys(data ?? {}));
      reportError("deleteAccount:unexpected_payload", new Error("unexpected_payload"));
      return { error: GENERIC_FAILURE };
    }

    return { error: null };
  } catch (e: any) {
    console.warn("delete-account:", e?.message ?? e);
    return { error: GENERIC_FAILURE };
  }
}
