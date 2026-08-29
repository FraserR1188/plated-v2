// ============================================================
// src/lib/healthConnectSync.ts — client sync module
//
// The client does NOT normalise, does NOT map to table columns, and does
// NOT decide ingest_transport/origin_package trustworthiness — it reads
// whatever Health Connect hands back, batches it by record type, and
// forwards it to health-connect-ingest, which does all of that. This
// module's only real logic is deciding WHAT to read and WHEN to consider
// it already-synced — everything downstream of "here is a raw record" is
// the Edge Function's job.
//
// ── WHERE THE CHANGES TOKEN LIVES, AND WHY ──────────────────────────────
//
// Task said "persist tokens where WHOOP-adjacent client state already
// lives" — that place doesn't exist. useStore.ts holds zero WHOOP state
// (checked, not assumed: grep for whoop/Whoop returns nothing), and
// WHOOP's own connection state is never cached client-side at all — it is
// re-read from whoop_connections on every mount (src/lib/whoop.ts:148-
// 167). There is no WHOOP-adjacent client persistence precedent to follow.
//
// A Health Connect changes token is, by its own nature, genuinely
// device-local: it is an opaque cursor into THIS device's Health Connect
// install, and restoring it on a different device or after a reinstall
// would reference OS-level state that simply does not exist there.
// Server-side storage would not even be meaningful. So it goes in this
// app's one existing device-local persistence mechanism —
// @react-native-async-storage/async-storage, already a dependency,
// currently used only inside src/lib/supabase.ts for the auth session —
// under its own key namespace, one key per record type.
//
// ── INITIAL SYNC VS INCREMENTAL SYNC ─────────────────────────────────────
//
// No stored token yet: readRecords() over a bounded time-range window
// (180 days, or 30 without PERMISSION_READ_HEALTH_DATA_HISTORY — Health
// Connect refuses anything older than 30 days without it regardless of
// what range is requested, so asking for more than that is pointless
// without the permission). A date-range query does not surface deletions
// at all, which is fine for a first pull — there is nothing yet to have
// been deleted FROM.
//
// Once a token exists: getChanges({changesToken, recordTypes}) instead.
// This is what propagates deletions (a plain readRecords() call never
// would) and only reads what actually changed since last time, rather
// than re-walking the whole window every sync.
//
// getChanges() invalidates a token after ~30 days of inactivity
// (changesTokenExpired: true). There is no way to resume from where an
// expired token left off — the only correct move is a BOUNDED re-pull
// (30 days, not the full 180-day initial window — re-importing a year of
// history for a user who simply hadn't opened the app in five weeks would
// be its own kind of wrong) plus minting a fresh token to pick up from now.
// ============================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  readRecords,
  getChanges,
  type RecordType,
} from "react-native-health-connect";
import { getHealthConnectGrantState, DOMAIN_RECORD_TYPE } from "./healthConnect";
import { supabase } from "./supabase";
import { reportError } from "./reportError";

const INITIAL_WINDOW_DAYS = 180;
const NO_HISTORY_WINDOW_DAYS = 30; // Health Connect's own hard floor without the history permission
const REPULL_WINDOW_DAYS = 30; // bounded fallback after a changes-token expiry — NOT the full 180
const PAGE_SIZE = 200;
const DAY_MS = 86_400_000;

type SyncableDomain = "sleep" | "hrv" | "resting_hr" | "workouts";
const SYNCABLE_DOMAINS: SyncableDomain[] = [
  "sleep",
  "hrv",
  "resting_hr",
  "workouts",
];

export type HealthConnectSyncResult = {
  ok: boolean;
  /** Records upserted per domain that was attempted. Domains with no grant are simply absent. */
  counts: Partial<Record<SyncableDomain, number>>;
  /** Domains that were granted but failed this pass. Others still ran. */
  errors: Partial<Record<SyncableDomain, string>>;
};

function tokenStorageKey(recordType: string): string {
  return `health_connect_changes_token:${recordType}`;
}

async function getStoredToken(recordType: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(tokenStorageKey(recordType));
  } catch (e) {
    reportError("healthConnectSync:getStoredToken", e);
    return null;
  }
}

async function setStoredToken(recordType: string, token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(tokenStorageKey(recordType), token);
  } catch (e) {
    reportError("healthConnectSync:setStoredToken", e);
  }
}

async function clearStoredToken(recordType: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(tokenStorageKey(recordType));
  } catch (e) {
    reportError("healthConnectSync:clearStoredToken", e);
  }
}

/**
 * Dig the { ok, error, message } envelope out of a FunctionsHttpError —
 * same GOTCHA as src/lib/whoop.ts:406-434: on a non-2xx, supabase-js's
 * error.message is a useless generic string, and the real body is on
 * error.context, a Response you have to read.
 */
async function readErrorMessage(error: unknown): Promise<string | null> {
  const context = (error as { context?: { json?: () => Promise<unknown> } })
    ?.context;
  if (!context || typeof context.json !== "function") return null;
  try {
    const body = (await context.json()) as { message?: unknown };
    if (typeof body?.message === "string" && body.message) return body.message;
  } catch {
    // Body wasn't JSON, or was already consumed.
  }
  return null;
}

/**
 * POSTs one batch to health-connect-ingest. Throws on any failure — the
 * caller decides what "a batch failed partway through a domain's sync"
 * means for that domain's changes-token bookkeeping (see syncRecordType:
 * the token is only advanced AFTER a successful post, so a thrown error
 * here naturally leaves the cursor exactly where a retry should resume).
 */
async function postBatch(
  recordType: string,
  upserts: unknown[],
  deletedRecordIds: string[],
): Promise<void> {
  const { data, error } = await supabase.functions.invoke(
    "health-connect-ingest",
    { body: { recordType, upserts, deletedRecordIds } },
  );

  if (error) {
    const message = await readErrorMessage(error);
    throw new Error(message ?? "health-connect-ingest request failed");
  }
  if (!data || typeof data !== "object" || (data as { ok?: unknown }).ok !== true) {
    throw new Error("health-connect-ingest: unexpected payload");
  }
}

/** Pages through readRecords() for one record type over one bounded window, posting each page as it arrives. */
async function boundedPull(
  recordType: RecordType,
  windowDays: number,
): Promise<number> {
  const now = Date.now();
  const startTime = new Date(now - windowDays * DAY_MS).toISOString();
  const endTime = new Date(now).toISOString();

  let pageToken: string | undefined;
  let total = 0;

  do {
    const page = await readRecords(recordType, {
      timeRangeFilter: { operator: "between", startTime, endTime },
      ascendingOrder: true,
      pageSize: PAGE_SIZE,
      pageToken,
    });

    if (page.records.length > 0) {
      await postBatch(recordType, page.records, []);
      total += page.records.length;
    }
    pageToken = page.pageToken;
  } while (pageToken);

  return total;
}

/** Mints a fresh changes-token anchor. Discards whatever it reports — there is no meaningful prior state to diff on a first call. */
async function bootstrapToken(recordType: RecordType): Promise<void> {
  const bootstrap = await getChanges({ recordTypes: [recordType] });
  await setStoredToken(recordType, bootstrap.nextChangesToken);
}

async function syncRecordType(
  recordType: RecordType,
  hasHistory: boolean,
): Promise<number> {
  const storedToken = await getStoredToken(recordType);

  if (!storedToken) {
    const windowDays = hasHistory ? INITIAL_WINDOW_DAYS : NO_HISTORY_WINDOW_DAYS;
    const total = await boundedPull(recordType, windowDays);
    await bootstrapToken(recordType);
    return total;
  }

  let currentToken = storedToken;
  let total = 0;

  for (;;) {
    const result = await getChanges({
      changesToken: currentToken,
      recordTypes: [recordType],
    });

    if (result.changesTokenExpired) {
      await clearStoredToken(recordType);
      total += await boundedPull(recordType, REPULL_WINDOW_DAYS);
      await bootstrapToken(recordType);
      return total;
    }

    const upserts = result.upsertionChanges.map((c) => c.record);
    const deletedRecordIds = result.deletionChanges.map((c) => c.recordId);

    if (upserts.length > 0 || deletedRecordIds.length > 0) {
      await postBatch(recordType, upserts, deletedRecordIds);
      total += upserts.length;
    }

    // Advanced ONLY after a successful post — see postBatch's doc comment.
    await setStoredToken(recordType, result.nextChangesToken);
    currentToken = result.nextChangesToken;

    if (!result.hasMore) break;
  }

  return total;
}

/**
 * Syncs every GRANTED domain. Ungranted domains are silently skipped —
 * that is the user's own choice from the permission dialog, not an error.
 * Unlike whoop-sync, one domain's failure does not abort the others: see
 * the module header on health-connect-ingest for why these four domains
 * have no cross-dependency the way WHOOP's cycle-linked collections do.
 *
 * Safe to call freely — there is no server-side throttle here (no
 * connections table exists for Health Connect in this commit), so the
 * caller (App foreground listener, "Sync now" button) is what paces this,
 * mirroring WHOOP's own cadence.
 */
export async function syncHealthConnect(): Promise<HealthConnectSyncResult> {
  const grants = await getHealthConnectGrantState();
  const counts: Partial<Record<SyncableDomain, number>> = {};
  const errors: Partial<Record<SyncableDomain, string>> = {};

  for (const domain of SYNCABLE_DOMAINS) {
    if (!grants[domain]) continue;

    const recordType = DOMAIN_RECORD_TYPE[domain] as RecordType;
    try {
      counts[domain] = await syncRecordType(recordType, grants.history);
    } catch (e) {
      reportError(`healthConnectSync:${domain}`, e);
      errors[domain] = e instanceof Error ? e.message : "Sync failed.";
    }
  }

  return { ok: Object.keys(errors).length === 0, counts, errors };
}
