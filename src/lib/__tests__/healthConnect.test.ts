// ============================================================
// src/lib/__tests__/healthConnect.test.ts
//
// Locks the three-state (not two-state) availability contract in place.
// 'not_installed' and 'unsupported' must never collapse into each other —
// see the sabotage check performed while writing this file, recorded in
// the commit message: forcing SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED to
// fall through to 'available' failed exactly one test
// ("not_installed when the provider needs installing or updating"),
// confirming these tests actually exercise the branch and aren't
// vacuously green.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// react-native-health-connect is Android-only and not installed in the
// test environment's native layer — mocked entirely, same reasoning as
// vitest.setup.ts's expo-linking/expo-web-browser mocks for whoop.ts.
vi.mock("react-native-health-connect", () => ({
  getSdkStatus: vi.fn(),
  requestPermission: vi.fn(),
  getGrantedPermissions: vi.fn(),
  openHealthConnectSettings: vi.fn(),
  SdkAvailabilityStatus: {
    SDK_UNAVAILABLE: 1,
    SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED: 2,
    SDK_AVAILABLE: 3,
  },
}));

// react-native's own index.js is Flow syntax (same problem
// vitest.setup.ts documents for @sentry/react-native) — stubbed with a
// plain mutable object so each test can set Platform.OS directly.
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

// vitest.setup.ts already mocks expo-linking globally (just .parse(), for
// whoop.ts's redirect handling) — overridden here with the fuller surface
// openHealthConnectPlayStore() needs. A test-file-level vi.mock() for a
// module already mocked in setupFiles takes precedence for this file.
vi.mock("expo-linking", () => ({
  parse: vi.fn(() => ({ queryParams: {} })),
  canOpenURL: vi.fn(),
  openURL: vi.fn(),
}));

import { Platform } from "react-native";
import * as Linking from "expo-linking";
import {
  getSdkStatus,
  SdkAvailabilityStatus,
  requestPermission,
  getGrantedPermissions,
  openHealthConnectSettings,
} from "react-native-health-connect";
import {
  getHealthConnectAvailability,
  getHealthConnectPlayStoreUrl,
  getHealthConnectPlayStoreWebUrl,
  openHealthConnectPlayStore,
  getHealthConnectGrantState,
  requestHealthConnectAccess,
  isHealthConnectFullyDenied,
  openHealthConnectSettingsScreen,
  type HealthConnectGrantState,
} from "../healthConnect";

const FULL_GRANT = [
  { accessType: "read", recordType: "SleepSession" },
  { accessType: "read", recordType: "HeartRateVariabilityRmssd" },
  { accessType: "read", recordType: "RestingHeartRate" },
  { accessType: "read", recordType: "ExerciseSession" },
  { accessType: "read", recordType: "ReadHealthDataHistory" },
];

beforeEach(() => {
  vi.clearAllMocks();
  Platform.OS = "android";
});

describe("getHealthConnectAvailability", () => {
  it("is 'available' when the SDK reports SDK_AVAILABLE", async () => {
    vi.mocked(getSdkStatus).mockResolvedValue(
      SdkAvailabilityStatus.SDK_AVAILABLE,
    );

    await expect(getHealthConnectAvailability()).resolves.toEqual({
      status: "available",
    });
  });

  it("is 'not_installed' when the provider needs installing or updating", async () => {
    vi.mocked(getSdkStatus).mockResolvedValue(
      SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED,
    );

    await expect(getHealthConnectAvailability()).resolves.toEqual({
      status: "not_installed",
    });
  });

  it("is 'unsupported' when the SDK is unavailable outright", async () => {
    vi.mocked(getSdkStatus).mockResolvedValue(
      SdkAvailabilityStatus.SDK_UNAVAILABLE,
    );

    await expect(getHealthConnectAvailability()).resolves.toEqual({
      status: "unsupported",
    });
  });

  it("is 'unsupported' on iOS without ever calling the native module", async () => {
    Platform.OS = "ios";

    await expect(getHealthConnectAvailability()).resolves.toEqual({
      status: "unsupported",
    });
    expect(getSdkStatus).not.toHaveBeenCalled();
  });

  it("never throws — a getSdkStatus() rejection resolves to 'unsupported' instead", async () => {
    vi.mocked(getSdkStatus).mockRejectedValue(new Error("native boom"));

    await expect(getHealthConnectAvailability()).resolves.toEqual({
      status: "unsupported",
    });
  });
});

describe("getHealthConnectPlayStoreUrl", () => {
  it("points at the Health Connect provider app's package via a market:// deep link", () => {
    expect(getHealthConnectPlayStoreUrl()).toBe(
      "market://details?id=com.google.android.apps.healthdata",
    );
  });
});

describe("getHealthConnectPlayStoreWebUrl", () => {
  it("points at the same package via the https:// web listing", () => {
    expect(getHealthConnectPlayStoreWebUrl()).toBe(
      "https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata",
    );
  });
});

describe("openHealthConnectPlayStore", () => {
  it("opens market:// when the Play Store app can handle it", async () => {
    vi.mocked(Linking.canOpenURL).mockResolvedValue(true);

    await openHealthConnectPlayStore();

    expect(Linking.openURL).toHaveBeenCalledWith(
      "market://details?id=com.google.android.apps.healthdata",
    );
  });

  it("falls back to the https:// listing when canOpenURL says market:// won't resolve", async () => {
    vi.mocked(Linking.canOpenURL).mockResolvedValue(false);

    await openHealthConnectPlayStore();

    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata",
    );
  });

  it("never throws — falls back to the web listing even when canOpenURL itself rejects", async () => {
    vi.mocked(Linking.canOpenURL).mockRejectedValue(new Error("boom"));
    vi.mocked(Linking.openURL).mockResolvedValue(true as never);

    await expect(openHealthConnectPlayStore()).resolves.toBeUndefined();
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata",
    );
  });
});

describe("getHealthConnectGrantState", () => {
  it("reports every domain granted, including history, when all five are present", async () => {
    vi.mocked(getGrantedPermissions).mockResolvedValue(FULL_GRANT as never);

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      sleep: true,
      hrv: true,
      resting_hr: true,
      workouts: true,
      history: true,
    } satisfies HealthConnectGrantState);
  });

  it("reports a PARTIAL grant honestly — sleep granted, hrv denied, not collapsed to one flag", async () => {
    vi.mocked(getGrantedPermissions).mockResolvedValue([
      { accessType: "read", recordType: "SleepSession" },
    ] as never);

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      sleep: true,
      hrv: false,
      resting_hr: false,
      workouts: false,
      history: false,
    } satisfies HealthConnectGrantState);
  });

  it("ignores a write-access grant for a record type we only ever request read for", async () => {
    vi.mocked(getGrantedPermissions).mockResolvedValue([
      { accessType: "write", recordType: "SleepSession" },
    ] as never);

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      sleep: false,
      hrv: false,
      resting_hr: false,
      workouts: false,
      history: false,
    } satisfies HealthConnectGrantState);
  });

  it("is all-false on iOS without calling the native module", async () => {
    Platform.OS = "ios";

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      sleep: false,
      hrv: false,
      resting_hr: false,
      workouts: false,
      history: false,
    } satisfies HealthConnectGrantState);
    expect(getGrantedPermissions).not.toHaveBeenCalled();
  });

  it("never throws — a getGrantedPermissions() rejection resolves to all-false", async () => {
    vi.mocked(getGrantedPermissions).mockRejectedValue(new Error("boom"));

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      sleep: false,
      hrv: false,
      resting_hr: false,
      workouts: false,
      history: false,
    } satisfies HealthConnectGrantState);
  });
});

describe("isHealthConnectFullyDenied", () => {
  it("is true when all four domains are false, regardless of history", () => {
    expect(
      isHealthConnectFullyDenied({
        sleep: false,
        hrv: false,
        resting_hr: false,
        workouts: false,
        history: true,
      }),
    ).toBe(true);
  });

  it("is false when even one domain is granted", () => {
    expect(
      isHealthConnectFullyDenied({
        sleep: true,
        hrv: false,
        resting_hr: false,
        workouts: false,
        history: false,
      }),
    ).toBe(false);
  });
});

describe("requestHealthConnectAccess", () => {
  it("requests all four record types plus history in one call", async () => {
    vi.mocked(getGrantedPermissions).mockResolvedValue(FULL_GRANT as never);

    await requestHealthConnectAccess();

    expect(requestPermission).toHaveBeenCalledWith([
      { accessType: "read", recordType: "SleepSession" },
      { accessType: "read", recordType: "HeartRateVariabilityRmssd" },
      { accessType: "read", recordType: "RestingHeartRate" },
      { accessType: "read", recordType: "ExerciseSession" },
      { accessType: "read", recordType: "ReadHealthDataHistory" },
    ]);
  });

  it("returns getGrantedPermissions()'s answer, not requestPermission()'s own return value", async () => {
    // requestPermission() resolving with something does not mean that is
    // the truth — getHealthConnectGrantState() is always re-derived after.
    vi.mocked(requestPermission).mockResolvedValue(FULL_GRANT as never);
    vi.mocked(getGrantedPermissions).mockResolvedValue([] as never);

    await expect(requestHealthConnectAccess()).resolves.toEqual({
      sleep: false,
      hrv: false,
      resting_hr: false,
      workouts: false,
      history: false,
    } satisfies HealthConnectGrantState);
  });

  it("never throws — falls through to the real grant state even when requestPermission() rejects", async () => {
    vi.mocked(requestPermission).mockRejectedValue(new Error("boom"));
    vi.mocked(getGrantedPermissions).mockResolvedValue(FULL_GRANT as never);

    await expect(requestHealthConnectAccess()).resolves.toEqual({
      sleep: true,
      hrv: true,
      resting_hr: true,
      workouts: true,
      history: true,
    } satisfies HealthConnectGrantState);
  });

  it("does nothing on iOS — no native call at all", async () => {
    Platform.OS = "ios";

    await requestHealthConnectAccess();

    expect(requestPermission).not.toHaveBeenCalled();
    expect(getGrantedPermissions).not.toHaveBeenCalled();
  });
});

describe("openHealthConnectSettingsScreen", () => {
  it("delegates straight to the native openHealthConnectSettings()", () => {
    openHealthConnectSettingsScreen();
    expect(openHealthConnectSettings).toHaveBeenCalledTimes(1);
  });
});
