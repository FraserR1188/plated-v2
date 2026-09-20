// ============================================================
// src/lib/syncRefetch.ts — PL-018: re-read what a foreground sync wrote.
//
// App.tsx fires syncWhoop() and syncHealthConnect() fire-and-forget on
// session set and on every AppState -> active. Nothing observed either
// promise, and TodayScreen's focus effect (TodayScreen.tsx:231-237) runs
// BEFORE the sync lands — so the first render after foregrounding showed
// the previous sync's rows, and the ones just written weren't read until
// the next focus or a pull-to-refresh.
//
// ── WHAT GETS REFETCHED, AND WHAT CAN'T CHANGE ──────────────────────────
//
// Only workouts. whoop-sync writes whoop_cycles/sleeps/recoveries/workouts;
// health-connect-ingest writes the biometric_* tables. NEITHER touches
// meal_entries or meal_compositions, so Today's meals and bundles cannot
// change as a result of a sync, and refetching them here would be an
// unbounded query on every foreground for data that provably did not move.
// The caller passes the refetch in, so when the WHOOP day-score panel
// lands it joins that one callback rather than this module growing a
// dependency on the store.
//
// ── WHY THE "WROTE NOTHING" TEST IS WORTH HAVING ────────────────────────
//
// The common foreground is: WHOOP throttled (15-minute server floor) and
// Health Connect finds nothing new. Both report that precisely enough to
// tell apart from a sync that landed rows, so the refetch is skipped on
// the overwhelmingly common path rather than costing a query every time
// the app comes forward.
//
// Where the answer is genuinely unknown, this errs toward refetching: one
// extra SELECT is cheaper than showing a user data we know might be stale.
// Each such case is named at its predicate below.
//
// ── NO COALESCING BETWEEN THE TWO SYNCS ─────────────────────────────────
//
// Each sync gets its own trigger, so a foreground where BOTH wrote data
// costs two refetches. Deliberate: WHOOP's pull can take tens of seconds
// while Health Connect's is local and quick, and making the fast one wait
// for the slow one to save a single query would delay the data reaching
// the screen — which is the whole point of this module. Reusing one
// in-flight refetch would be worse still: it can only return rows read
// BEFORE the second sync's write.
// ============================================================

import type { SyncResponse } from "./whoop";
import type { HealthConnectSyncResult } from "./healthConnectSync";

/**
 * WHOOP failure codes that are decided before any row could be written —
 * the client never reached the function, or the function returned before
 * its first pull. Anything NOT listed here (notably "transient" and
 * "server_error") can fail partway through a collection that has already
 * upserted earlier pages, so those count as "may have written".
 */
const WHOOP_ERRORS_BEFORE_ANY_WRITE: ReadonlySet<string> = new Set([
  "network_error",
  "unauthorized",
  "not_connected",
  "bad_request",
  "revoked",
  "cancelled",
  "denied",
  "state_invalid",
  "exchange_failed",
]);

/** Did this whoop-sync response leave new rows behind for Today to read? */
export function whoopSyncWroteData(result: SyncResponse): boolean {
  if (!result.ok) return !WHOOP_ERRORS_BEFORE_ANY_WRITE.has(result.error);

  // 'throttled' and 'revoked' both return before the pull loop.
  if (result.skipped) return false;

  // A success is expected to carry counts. If it somehow doesn't, that's
  // unknown rather than empty — refetch.
  if (result.counts == null) return true;

  return Object.values(result.counts).some((n) => n > 0);
}

const sum = (m: Partial<Record<string, number>>): number =>
  Object.values(m).reduce<number>((a, b) => a + (b ?? 0), 0);

/** Did this Health Connect pass leave new rows behind — or remove any? */
export function healthConnectSyncWroteData(
  result: HealthConnectSyncResult,
): boolean {
  // A domain that threw has no count recorded, but postBatch may already
  // have succeeded for earlier pages of that domain.
  if (Object.keys(result.errors).length > 0) return true;

  return sum(result.counts) + sum(result.deletions) > 0;
}

export type RefetchOutcome =
  | "refetched"
  | "skipped"
  | "sync-failed"
  | "refetch-failed";

type RefetchDeps = {
  /** Re-read whatever Today shows that this sync could have changed. */
  refetch: () => Promise<void>;
  report: (operation: string, error: unknown) => void;
};

/**
 * Awaits a sync that is already running and refetches if it wrote
 * anything. Never rejects and never blocks the caller — App.tsx voids it.
 *
 * A REJECTED SYNC IS NOT REPORTED HERE. Its own .catch at the call site
 * already reports it, and reporting again is exactly the double-report
 * PL-014 is about. Likewise, the store's fetch actions report their own
 * query failures internally and resolve rather than throwing, so the catch
 * below only ever fires for an error that escaped unreported.
 */
export async function refetchIfSyncWroteData<T>(
  sync: Promise<T>,
  wroteData: (result: T) => boolean,
  deps: RefetchDeps,
): Promise<RefetchOutcome> {
  let result: T;
  try {
    result = await sync;
  } catch {
    return "sync-failed";
  }

  if (!wroteData(result)) return "skipped";

  try {
    await deps.refetch();
    return "refetched";
  } catch (e) {
    deps.report("todayRefetchAfterSync", e);
    return "refetch-failed";
  }
}
