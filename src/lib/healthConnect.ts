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
  } catch {
    // getSdkStatus() is not documented to reject, but "never throws" is
    // the contract of this function regardless of what the native module
    // actually does today.
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
// ============================================================

export type HealthConnectDomain = "sleep" | "hrv" | "resting_hr" | "workouts";

const DOMAIN_RECORD_TYPE: Record<HealthConnectDomain, string> = {
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
  /** PERMISSION_READ_HEALTH_DATA_HISTORY. See module header. */
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
 * Never throws. Reads the CURRENT OS-level grant state fresh every call —
 * this is intentionally not cached anywhere client-side (same reasoning as
 * WHOOP's getWhoopConnection(): a cached copy would go stale the moment a
 * user revokes a permission from Android's own Health Connect settings
 * app, which this app cannot observe any other way).
 */
export async function getHealthConnectGrantState(): Promise<HealthConnectGrantState> {
  if (Platform.OS !== "android") return EMPTY_GRANTS;

  try {
    const granted = (await getGrantedPermissions()) as AnyGrantedPermission[];
    const grantedTypes = new Set(
      granted
        .filter((p) => p.accessType === "read")
        .map((p) => p.recordType)
        .filter((t): t is string => typeof t === "string"),
    );

    return {
      sleep: grantedTypes.has(DOMAIN_RECORD_TYPE.sleep),
      hrv: grantedTypes.has(DOMAIN_RECORD_TYPE.hrv),
      resting_hr: grantedTypes.has(DOMAIN_RECORD_TYPE.resting_hr),
      workouts: grantedTypes.has(DOMAIN_RECORD_TYPE.workouts),
      history: grantedTypes.has("ReadHealthDataHistory"),
    };
  } catch (e) {
    reportError("healthConnect:getGrantState", e);
    return EMPTY_GRANTS;
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
 * Never throws: a rejection from requestPermission() itself is reported
 * and swallowed, and either way the function falls through to
 * getHealthConnectGrantState() for the real answer — what the OS actually
 * recorded is the only trustworthy source, not whether the request call
 * itself resolved cleanly.
 */
export async function requestHealthConnectAccess(): Promise<HealthConnectGrantState> {
  if (Platform.OS !== "android") return EMPTY_GRANTS;

  try {
    await requestPermission([
      { accessType: "read", recordType: "SleepSession" },
      { accessType: "read", recordType: "HeartRateVariabilityRmssd" },
      { accessType: "read", recordType: "RestingHeartRate" },
      { accessType: "read", recordType: "ExerciseSession" },
      { accessType: "read", recordType: "ReadHealthDataHistory" },
    ]);
  } catch (e) {
    reportError("healthConnect:requestPermission", e);
  }

  return getHealthConnectGrantState();
}

/**
 * Opens the Health Connect app's own settings, where the user can grant
 * per-domain access directly. This is the escape hatch for Android's
 * "two denials permanently suppresses the dialog" rule: once
 * requestHealthConnectAccess() comes back fully denied, calling it again
 * either shows nothing or silently re-denies — the only way forward is
 * sending the user here, not re-prompting into a wall.
 */
export function openHealthConnectSettingsScreen(): void {
  openHealthConnectSettings();
}
