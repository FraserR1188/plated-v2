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
// expired token left off — the only correct move is a bounded re-pull, at
// whatever depth hasHistory currently supports (currentWindowDays() below
// — this used to be hardcoded to 30 regardless of hasHistory, which meant
// the expiry recovery path could never reach as deep as a first sync
// would; see the backfill section below for why that mattered), plus
// minting a fresh token to pick up from now.
//
// ── STORED VALUE SHAPE, AND THE LATE-HISTORY-GRANT BACKFILL ─────────────
//
// The stored value is a HealthConnectTokenRecord, not a bare token string:
// { token, baselineWindowDays, baselineAt }. baselineWindowDays records how
// far back the pull that most recently re-anchored this token actually
// reached — NOT just "when was this token last written" (every ordinary
// incremental advance rewrites the token but does not change what the
// baseline covered).
//
// Why this exists: hasHistory (PERMISSION_READ_HEALTH_DATA_HISTORY) used
// to be consulted in exactly one place — choosing 180 vs 30 days when
// there was no stored token yet, i.e. only on the very first sync ever
// for that record type. Once a token existed, every later sync took the
// incremental getChanges() branch, which never looked at hasHistory again
// and had no record of what window its baseline had covered. A user who
// granted history AFTER that first sync was then permanently capped at
// 30 days, with no code path that ever revisited the 31-180 day gap —
// confirmed on-device (oldest sleep session exactly 30 days back despite
// "Access past data" being on).
//
// The fix: every sync compares the CURRENT hasHistory against the stored
// baselineWindowDays. If history is granted now and the baseline was ever
// narrower than the full window, one bounded pull covers exactly the gap
// (31-180 days back), then the stored baseline widens so it doesn't
// repeat. This is a comparison against live permission state, not a
// separate "have I backfilled" flag — a flag can drift from what's
// actually granted; recomputing "is the stored baseline still narrower
// than what's available now" from scratch every time cannot. A user who
// revokes history after backfilling and later re-grants it lands
// correctly for the same reason: baselineWindowDays stays at 180 across
// the revoke (nothing about revoking un-syncs already-ingested data), so
// the comparison correctly finds nothing left to backfill on re-grant.
//
// Re-reading records the backfill may have already synced (e.g. a partial
// prior attempt, or a shorter re-run) is safe: health-connect-ingest
// upserts on (user_id, origin_package, provider_record_id), so replaying
// an already-ingested record is an idempotent overwrite, not a duplicate.
// ============================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  readRecords,
  getChanges,
  type RecordType,
} from "react-native-health-connect";
import {
  getHealthConnectGrantState,
  ensureHealthConnectInitialized,
  DOMAIN_RECORD_TYPE,
} from "./healthConnect";
import { supabase } from "./supabase";
import { reportError } from "./reportError";

const INITIAL_WINDOW_DAYS = 180;
const NO_HISTORY_WINDOW_DAYS = 30; // Health Connect's own hard floor without the history permission
const PAGE_SIZE = 200;
const DAY_MS = 86_400_000;

/** The window a fresh bounded pull should use right now, given the current history grant. Used for the very first sync AND for the token-expiry re-pull — both are "start over at whatever depth is available today". */
function currentWindowDays(hasHistory: boolean): number {
  return hasHistory ? INITIAL_WINDOW_DAYS : NO_HISTORY_WINDOW_DAYS;
}

/**
 * Dev-only diagnostic logging. This module's actual behaviour (which
 * window got read, whether a backfill fired, what the final result was)
 * was previously unobservable on-device — reportError/console only ever
 * fired on error, so a correct run and a silently-wrong one looked
 * identical from a logcat tail. __DEV__ keeps this out of production
 * builds entirely; it is not a substitute for reportError, which stays
 * on every actual failure path in this file unchanged.
 */
function devLog(operation: string, detail: unknown): void {
  if (__DEV__) console.log(operation, detail);
}

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

type HealthConnectTokenRecord = {
  token: string;
  /** How many days back the pull that most recently re-anchored `token` actually reached — not merely when `token` was last written. */
  baselineWindowDays: number;
  /** ISO timestamp of that pull, or "unknown" for a record migrated from a pre-backfill-fix installation (see parseStoredTokenRecord). */
  baselineAt: string;
};

/**
 * Distinguishes a genuine HealthConnectTokenRecord from a pre-migration
 * bare token string. Returns null for anything that isn't a well-formed
 * record — including a plain string, which JSON.parse either throws on
 * (not valid JSON) or happily parses into something with no `.token`
 * field (e.g. a numeric-looking string) — so the caller has one place to
 * decide what "not a record" means, rather than duplicating the shape
 * check at every read site.
 */
function parseStoredTokenRecord(raw: string): HealthConnectTokenRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { token?: unknown }).token === "string" &&
      typeof (parsed as { baselineWindowDays?: unknown }).baselineWindowDays ===
        "number"
    ) {
      const p = parsed as { token: string; baselineWindowDays: number; baselineAt?: unknown };
      return {
        token: p.token,
        baselineWindowDays: p.baselineWindowDays,
        baselineAt: typeof p.baselineAt === "string" ? p.baselineAt : "unknown",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reading must not throw, and a pre-migration bare string must NOT be
 * treated as "no stored token" (null) — that would silently discard a
 * perfectly valid existing changes-token cursor and restart this record
 * type's sync from scratch. It's read instead as a legacy token whose
 * baseline is deliberately ASSUMED to be the narrower 30-day window: the
 * true baseline of a pre-migration token is unrecoverable (nothing about
 * its era recorded what window it covered), and assuming 30 is what makes
 * the backfill below trigger for exactly the installs this bug affects.
 * Assuming 180 instead would silently perpetuate the bug for anyone who
 * happened to grant history after their first-ever sync — which is the
 * whole population this fix exists for.
 */
async function getStoredTokenRecord(
  recordType: string,
): Promise<HealthConnectTokenRecord | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(tokenStorageKey(recordType));
  } catch (e) {
    reportError("healthConnectSync:getStoredToken", e);
    return null;
  }
  if (!raw) {
    devLog("healthConnectSync:tokenRead", { recordType, raw: null });
    return null;
  }

  const parsed = parseStoredTokenRecord(raw);
  const record =
    parsed ?? {
      token: raw,
      baselineWindowDays: NO_HISTORY_WINDOW_DAYS,
      baselineAt: "unknown",
    };
  devLog("healthConnectSync:tokenRead", {
    recordType,
    raw,
    interpretedAs: parsed ? "record" : "legacy-bare-string",
    baselineWindowDays: record.baselineWindowDays,
    baselineAt: record.baselineAt,
  });
  return record;
}

async function setStoredTokenRecord(
  recordType: string,
  record: HealthConnectTokenRecord,
): Promise<void> {
  try {
    await AsyncStorage.setItem(tokenStorageKey(recordType), JSON.stringify(record));
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

/** Pages through readRecords() for one record type over an explicit [startTime, endTime) window, posting each page as it arrives. */
async function pullTimeRange(
  recordType: RecordType,
  startTime: string,
  endTime: string,
): Promise<number> {
  devLog("healthConnectSync:readWindow", { recordType, startTime, endTime });

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

/** The common case: a bounded pull from `windowDays` ago through now. */
async function boundedPull(
  recordType: RecordType,
  windowDays: number,
): Promise<number> {
  const now = Date.now();
  return pullTimeRange(
    recordType,
    new Date(now - windowDays * DAY_MS).toISOString(),
    new Date(now).toISOString(),
  );
}

/**
 * Covers exactly the gap between what an existing, narrower baseline
 * already reached and the full history window now available — NOT a
 * re-pull of the whole 180 days, which boundedPull() would do and which
 * would needlessly re-read the 0-30-day range a normal sync already keeps
 * current via getChanges(). Re-reading anything already ingested here is
 * harmless: health-connect-ingest upserts on
 * (user_id, origin_package, provider_record_id), so replaying a record
 * that's already in the database is an idempotent overwrite, not a
 * duplicate row — see the module header for why that's what makes this
 * safe to compute purely from the old baseline depth.
 */
async function backfillHistoryGap(
  recordType: RecordType,
  previousBaselineWindowDays: number,
): Promise<number> {
  const now = Date.now();
  return pullTimeRange(
    recordType,
    new Date(now - INITIAL_WINDOW_DAYS * DAY_MS).toISOString(),
    new Date(now - previousBaselineWindowDays * DAY_MS).toISOString(),
  );
}

/** Mints a fresh changes-token anchor and records what window the pull preceding it covered. Discards the changes payload itself — there is no meaningful prior state to diff on a first call. */
async function bootstrapToken(
  recordType: RecordType,
  baselineWindowDays: number,
): Promise<void> {
  const bootstrap = await getChanges({ recordTypes: [recordType] });
  await setStoredTokenRecord(recordType, {
    token: bootstrap.nextChangesToken,
    baselineWindowDays,
    baselineAt: new Date().toISOString(),
  });
}

async function syncRecordType(
  recordType: RecordType,
  hasHistory: boolean,
): Promise<number> {
  // Belt-and-braces: syncHealthConnect() below already calls this
  // transitively (via getHealthConnectGrantState()) before ever reaching
  // this function, but readRecords()/getChanges() have the exact same
  // native precondition as getGrantedPermissions() — a live client — and
  // this function should not depend on a caller upstream having happened
  // to satisfy it first. initialize() is idempotent (see healthConnect.ts),
  // so this costs nothing when it's already been done.
  await ensureHealthConnectInitialized();

  const stored = await getStoredTokenRecord(recordType);

  if (!stored) {
    const windowDays = currentWindowDays(hasHistory);
    const total = await boundedPull(recordType, windowDays);
    await bootstrapToken(recordType, windowDays);
    return total;
  }

  let total = 0;
  let baselineWindowDays = stored.baselineWindowDays;
  let baselineAt = stored.baselineAt;

  // The late-history-grant backfill: see the module header. Comparing
  // against the CURRENT hasHistory every sync — not a one-shot flag — is
  // what makes a later revoke-then-re-grant land correctly, since
  // baselineWindowDays only ever widens and a re-grant after an earlier
  // successful backfill finds nothing left to do.
  const backfillNeeded = hasHistory && baselineWindowDays < INITIAL_WINDOW_DAYS;
  devLog("healthConnectSync:backfillDecision", {
    recordType,
    hasHistory,
    baselineWindowDays,
    backfillNeeded,
    reason: backfillNeeded
      ? undefined
      : !hasHistory
        ? "history not currently granted"
        : `baseline (${baselineWindowDays}) already at or beyond the full window (${INITIAL_WINDOW_DAYS})`,
  });
  if (backfillNeeded) {
    total += await backfillHistoryGap(recordType, baselineWindowDays);
    baselineWindowDays = INITIAL_WINDOW_DAYS;
    baselineAt = new Date().toISOString();
    // Persisted immediately, before the incremental loop below: if that
    // loop fails partway through, the backfill itself already landed
    // (postBatch succeeded for every page it read) and must not be
    // redone on the next attempt just because this sync pass overall
    // errored.
    await setStoredTokenRecord(recordType, {
      token: stored.token,
      baselineWindowDays,
      baselineAt,
    });
  }

  let currentToken = stored.token;

  for (;;) {
    const result = await getChanges({
      changesToken: currentToken,
      recordTypes: [recordType],
    });

    if (result.changesTokenExpired) {
      await clearStoredToken(recordType);
      const windowDays = currentWindowDays(hasHistory);
      total += await boundedPull(recordType, windowDays);
      await bootstrapToken(recordType, windowDays);
      return total;
    }

    const upserts = result.upsertionChanges.map((c) => c.record);
    const deletedRecordIds = result.deletionChanges.map((c) => c.recordId);

    if (upserts.length > 0 || deletedRecordIds.length > 0) {
      await postBatch(recordType, upserts, deletedRecordIds);
      total += upserts.length;
    }

    // Advanced ONLY after a successful post — see postBatch's doc comment.
    // baselineWindowDays/baselineAt are carried through unchanged here —
    // an ordinary incremental advance doesn't change what window the
    // baseline covers, only the cursor position within it.
    await setStoredTokenRecord(recordType, {
      token: result.nextChangesToken,
      baselineWindowDays,
      baselineAt,
    });
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
  const grantResult = await getHealthConnectGrantState();
  // A native failure reading grant state, not a legitimate "nothing
  // granted" — getHealthConnectGrantState() has already reported it.
  // There is nothing trustworthy to sync against, so stop here rather than
  // treating the error as "every domain denied."
  if (grantResult.status === "error") {
    const result: HealthConnectSyncResult = { ok: false, counts: {}, errors: {} };
    devLog("healthConnectSync:result", {
      ...result,
      stoppedBeforeAnyDomain: true,
      grantStateError: grantResult.message,
    });
    return result;
  }
  const grants = grantResult.grants;

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

  const result: HealthConnectSyncResult = {
    ok: Object.keys(errors).length === 0,
    counts,
    errors,
  };
  devLog("healthConnectSync:result", result);
  return result;
}
