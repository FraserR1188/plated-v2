// ============================================================
// src/lib/healthConnect.ts — availability check ONLY.
//
// No permission request, no record reads, no store wiring. This module
// answers exactly one question: "can this device even attempt a Health
// Connect connection right now?" — the same server-authoritative posture
// as WHOOP (src/lib/whoop.ts:139-141: the client never holds credentials
// or makes the trust decision itself) does not apply here in the same
// shape, since Health Connect has no server component at all — but the
// SCOPE discipline does: this file is deliberately as small as the
// question it answers, and reading data or requesting a runtime grant is
// a different commit's job, not this one's.
//
// Three real device states, not two:
//   'available'     — Health Connect is present and ready to use.
//   'not_installed' — the OS supports Health Connect, but the provider
//                      app isn't installed or needs updating (this is the
//                      normal case on Android 9-13, where Health Connect
//                      is a separate Play Store app rather than an OS
//                      component). ACTIONABLE: send the user to the Play
//                      Store listing.
//   'unsupported'   — the OS is too old for Health Connect at all (or,
//                      on iOS, the platform doesn't have it at all). NOT
//                      actionable — there is nothing to install.
// Collapsing 'not_installed' and 'unsupported' into one boolean would
// throw away exactly the distinction a caller needs to decide whether to
// show an "Install" button or nothing at all.
// ============================================================

import { Platform } from "react-native";
import * as Linking from "expo-linking";
import {
  getSdkStatus,
  SdkAvailabilityStatus,
  initialize,
  requestPermission,
  getGrantedPermissions,
  openHealthConnectSettings,
} from "react-native-health-connect";
import { reportError } from "./reportError";

export type HealthConnectAvailability =
  | { status: "available" }
  | { status: "not_installed" }
  | { status: "unsupported" };

const HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata";

/**
 * Never throws. Platform.OS !== 'android' resolves to 'unsupported'
 * without touching the native module at all — Health Connect is
 * Android-only, and a native-module call on a platform that doesn't have
 * it is exactly the kind of thing that should never reach production as
 * an uncaught rejection.
 */
export async function getHealthConnectAvailability(): Promise<HealthConnectAvailability> {
  if (Platform.OS !== "android") {
    return { status: "unsupported" };
  }

  try {
    const sdkStatus = await getSdkStatus();

    switch (sdkStatus) {
      case SdkAvailabilityStatus.SDK_AVAILABLE:
        return { status: "available" };
      case SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED:
        return { status: "not_installed" };
      case SdkAvailabilityStatus.SDK_UNAVAILABLE:
      default:
        return { status: "unsupported" };
    }
  } catch (e) {
    // getSdkStatus() is not documented to reject, but "never throws" is
    // the contract of this function regardless of what the native module
    // actually does today. That contract is about the RETURN VALUE, not
    // about silence: a genuine native failure here was previously
    // rendered as the confident, permanent "this device can't use Health
    // Connect" message with no trace anywhere that anything went wrong —
    // the same error-laundering class fixed in 5790543 for the grant-state
    // functions, just missed here.
    reportError("healthConnect:getAvailability", e);
    return { status: "unsupported" };
  }
}

/**
 * market:// so the OS opens the Play Store app directly rather than a
 * browser tab. Only meaningful when getHealthConnectAvailability()
 * returned 'not_installed' — there is nothing to install for
 * 'unsupported', and nothing to open for 'available'.
 */
export function getHealthConnectPlayStoreUrl(): string {
  return `market://details?id=${HEALTH_CONNECT_PACKAGE}`;
}

/**
 * https://play.google.com/... fallback for when market:// can't be opened
 * (no Play Store app on the device — rare, but getHealthConnectPlayStoreUrl()
 * on its own has no fallback, which is deliberately flagged as a gap in 4a).
 */
export function getHealthConnectPlayStoreWebUrl(): string {
  return `https://play.google.com/store/apps/details?id=${HEALTH_CONNECT_PACKAGE}`;
}

/**
 * Opens the Play Store listing for the Health Connect provider app, trying
 * market:// first (opens the Play Store app directly) and falling back to
 * the https:// web listing when canOpenURL says market:// won't resolve.
 * Never throws — a failed navigation here is not something the caller can
 * do anything about beyond "nothing happened," same as a user backing out
 * of the WHOOP browser sheet.
 */
export async function openHealthConnectPlayStore(): Promise<void> {
  const marketUrl = getHealthConnectPlayStoreUrl();
  const webUrl = getHealthConnectPlayStoreWebUrl();

  try {
    const canOpenMarket = await Linking.canOpenURL(marketUrl);
    await Linking.openURL(canOpenMarket ? marketUrl : webUrl);
  } catch (e) {
    reportError("healthConnect:openPlayStore", e);
    try {
      await Linking.openURL(webUrl);
    } catch {
      // Both attempts failed. Nothing left to try from inside the app.
    }
  }
}

// ============================================================
// Client initialisation.
//
// getSdkStatus() (above) calls the static HealthConnectClient.getSdkStatus()
// directly — no client instance involved — which is why availability checks
// have never needed this. EVERY other native call (requestPermission,
// getGrantedPermissions, readRecords, getChanges, ...) is gated on the
// native side by a `lateinit var healthConnectClient` that only initialize()
// assigns; calling any of them first rejects with error.code
// "CLIENT_NOT_INITIALIZED" (node_modules/react-native-health-connect/
// android/src/main/java/dev/matinzd/healthconnect/HealthConnectManager.kt:
// throwUnlessClientIsAvailable). Nothing in this module or
// healthConnectSync.ts called initialize() before now — every permission
// request and every grant-state read was rejecting on that check, which
// this file was then laundering into "nothing granted" (see
// getHealthConnectGrantState below).
//
// initialize() itself (HealthConnectClient.getOrCreate(...)) is safe to
// call repeatedly and from concurrent callers: it just reassigns that
// lateinit var to a fresh getOrCreate() result, and AndroidX's own
// getOrCreate() is documented as a cached-per-process singleton accessor.
// No hand-rolled single-flight guard, so — every function below that needs
// a live client calls this first, unconditionally, rather than relying on
// some other function in the call graph having already done so.
// ============================================================

export async function ensureHealthConnectInitialized(): Promise<void> {
  if (Platform.OS !== "android") return;
  await initialize();
}

function healthConnectErrorMessage(e: unknown): string {
  return e instanceof Error && e.message
    ? e.message
    : "Health Connect ran into a problem.";
}

/** Same __DEV__-gated pattern as healthConnectSync.ts's devLog (ef64bd5) — kept local rather than shared, matching how this file already duplicates small single-purpose helpers instead of introducing a cross-file utility for a three-line function. */
function devLog(operation: string, detail: unknown): void {
  if (__DEV__) console.log(operation, detail);
}

// ============================================================
// Permission request and grant state.
//
// The four domains below deliberately use the exact same names as
// biometric_source_preferences.domain (sleep/hrv/resting_hr/workouts) —
// both are naming the same four kinds of data, and keeping the vocabulary
// identical is what lets a future settings screen offer "prefer WHOOP for
// X, Health Connect for Y" without a translation layer.
//
// 'history' (PERMISSION_READ_HEALTH_DATA_HISTORY) is tracked SEPARATELY
// from the four domains, never folded into "fully denied": a user can
// grant all four domains and still decline history specifically (limiting
// reads to the last 30 days), and that is a legitimate partial grant, not
// a failure state.
//
// getHealthConnectGrantState() and requestHealthConnectAccess() both return
// a HealthConnectGrantResult rather than a bare HealthConnectGrantState —
// a native failure (CLIENT_NOT_INITIALIZED chief among them, but not the
// only one — SecurityException/IOException/etc. are all real, distinct
// failure modes on the native side, see errors.ts's rejectWithException)
// is NOT the same fact as "the user has legitimately granted nothing," and
// collapsing the two into one all-false shape is exactly the bug this
// module shipped with: a real error rendered, and behaved, as a permission
// state with a dead-end remedy.
// ============================================================

export type HealthConnectDomain = "sleep" | "hrv" | "resting_hr" | "workouts";

/** Exported so healthConnectSync.ts uses the exact same mapping — one source of truth. */
export const DOMAIN_RECORD_TYPE: Record<HealthConnectDomain, string> = {
  sleep: "SleepSession",
  hrv: "HeartRateVariabilityRmssd",
  resting_hr: "RestingHeartRate",
  workouts: "ExerciseSession",
};

export type HealthConnectGrantState = {
  sleep: boolean;
  hrv: boolean;
  resting_hr: boolean;
  workouts: boolean;
  /**
   * PERMISSION_READ_HEALTH_DATA_HISTORY. See module header for the
   * concept — but as of react-native-health-connect@4.1.3, THIS FIELD IS
   * ALWAYS FALSE, regardless of the real OS-level grant. Confirmed from
   * source: PermissionUtils.kt#mapPermissionResult()'s "handle special
   * permissions" section checks PERMISSION_WRITE_EXERCISE_ROUTE and
   * PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND, never
   * PERMISSION_READ_HEALTH_DATA_HISTORY — a result-reporting omission
   * present in both getGrantedPermissions() and requestPermission()'s own
   * return value, not fixed in any published version or the unreleased
   * main branch. The request side still works correctly (the OS genuinely
   * grants the permission when asked); only reading it back is broken.
   * healthConnectSync.ts does not consume this field for that reason — it
   * determines the equivalent fact empirically instead (see that module's
   * header, "WHICH WINDOW TO REQUEST"). Do not add a new consumer of this
   * field without re-reading that section first.
   */
  history: boolean;
};

const EMPTY_GRANTS: HealthConnectGrantState = {
  sleep: false,
  hrv: false,
  resting_hr: false,
  workouts: false,
  history: false,
};

/**
 * 'ok' with EMPTY_GRANTS covers both iOS (there is genuinely nothing to
 * grant) and a real read where the user has denied everything — both are
 * legitimate, non-error outcomes. 'error' is reserved for a native call
 * actually failing (init failure, permission-controller exception, etc.);
 * it must never be treated as, or default to, a permission state.
 */
export type HealthConnectGrantResult =
  | { status: "ok"; grants: HealthConnectGrantState }
  | { status: "error"; message: string };

/**
 * getGrantedPermissions()'s declared return type (as shipped in
 * react-native-health-connect@4.1.3's .d.ts) is
 * `(Permission | WriteExerciseRoutePermission | BackgroundAccessPermission)[]`
 * — it does NOT list ReadHealthDataHistoryPermission, even though
 * requestPermission() both accepts and returns it and the library's own
 * Kotlin side special-cases the pseudo record type 'ReadHealthDataHistory'.
 * Rather than fight or trust a possibly-incomplete .d.ts, every element is
 * read through this minimal shape instead of the library's own union.
 */
type AnyGrantedPermission = { accessType?: string; recordType?: string };

/**
 * Never throws — resolves to an 'error' result instead. Reads the CURRENT
 * OS-level grant state fresh every call; this is intentionally not cached
 * anywhere client-side (same reasoning as WHOOP's getWhoopConnection(): a
 * cached copy would go stale the moment a user revokes a permission from
 * Android's own Health Connect settings app, which this app cannot observe
 * any other way).
 */
export async function getHealthConnectGrantState(): Promise<HealthConnectGrantResult> {
  if (Platform.OS !== "android") return { status: "ok", grants: EMPTY_GRANTS };

  try {
    await ensureHealthConnectInitialized();
    const granted = (await getGrantedPermissions()) as AnyGrantedPermission[];
    // Raw and unfiltered, deliberately — this is what settles whether the
    // library's own result mapping ever reports history at all, as opposed
    // to what our .filter()/.map() below chooses to keep from it.
    devLog("healthConnect:rawGrantedPermissions", granted);
    const grantedTypes = new Set(
      granted
        .filter((p) => p.accessType === "read")
        .map((p) => p.recordType)
        .filter((t): t is string => typeof t === "string"),
    );

    return {
      status: "ok",
      grants: {
        sleep: grantedTypes.has(DOMAIN_RECORD_TYPE.sleep),
        hrv: grantedTypes.has(DOMAIN_RECORD_TYPE.hrv),
        resting_hr: grantedTypes.has(DOMAIN_RECORD_TYPE.resting_hr),
        workouts: grantedTypes.has(DOMAIN_RECORD_TYPE.workouts),
        history: grantedTypes.has("ReadHealthDataHistory"),
      },
    };
  } catch (e) {
    // Loud, deliberately: this is a genuine native failure (initialize()
    // failing, or getGrantedPermissions() itself rejecting), not a user
    // decision. CLIENT_NOT_INITIALIZED landing here means
    // ensureHealthConnectInitialized() above it also failed — reported
    // once, here, rather than swallowed and re-derived as "denied".
    reportError("healthConnect:getGrantState", e);
    return { status: "error", message: healthConnectErrorMessage(e) };
  }
}

/** True when none of the four real domains are granted. Ignores `history` — see module header. */
export function isHealthConnectFullyDenied(state: HealthConnectGrantState): boolean {
  return !state.sleep && !state.hrv && !state.resting_hr && !state.workouts;
}

/**
 * Requests all four record types plus history in ONE call — Android shows
 * a single consent screen listing everything, and the user grants/denies
 * per line item on that one screen. There is no separate "ask for history
 * after the rest" step.
 *
 * Never throws — resolves to an 'error' result instead. UNLIKE the
 * previous version of this function, a rejection from requestPermission()
 * is NOT swallowed-then-re-derived via getHealthConnectGrantState(): if the
 * request itself failed (most commonly because initialize() failed), no
 * dialog was ever shown and nothing was actually decided, so falling
 * through to read "what got granted" would report a stale or unrelated
 * prior state as if it were this request's outcome. Only a request that
 * genuinely completed — dialog resolved, one way or another — falls
 * through to getHealthConnectGrantState() for the authoritative read.
 */
export async function requestHealthConnectAccess(): Promise<HealthConnectGrantResult> {
  if (Platform.OS !== "android") return { status: "ok", grants: EMPTY_GRANTS };

  try {
    await ensureHealthConnectInitialized();
    await requestPermission([
      { accessType: "read", recordType: "SleepSession" },
      { accessType: "read", recordType: "HeartRateVariabilityRmssd" },
      { accessType: "read", recordType: "RestingHeartRate" },
      { accessType: "read", recordType: "ExerciseSession" },
      { accessType: "read", recordType: "ReadHealthDataHistory" },
    ]);
  } catch (e) {
    reportError("healthConnect:requestPermission", e);
    return { status: "error", message: healthConnectErrorMessage(e) };
  }

  return getHealthConnectGrantState();
}

/**
 * Opens the Health Connect app's own settings, where the user can grant
 * per-domain access directly. Offered as a SECONDARY path alongside
 * re-requesting, not a replacement for it: Android's permission system is
 * generally documented to auto-suppress a repeated request after enough
 * refusals, but requestPermission()'s own contract (see
 * requestHealthConnectAccess's doc comment) exposes no signal that
 * distinguishes "the wall is up" from "the user dismissed it once" — both
 * resolve identically, with an empty granted set. Do not resurrect a
 * one-shot "permanently denied" branch on the strength of that OS-level
 * claim; there is nothing in this library to verify it against per-call.
 */
export function openHealthConnectSettingsScreen(): void {
  openHealthConnectSettings();
}
