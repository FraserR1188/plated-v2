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
import {
  getSdkStatus,
  SdkAvailabilityStatus,
} from "react-native-health-connect";

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
