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

import { Platform } from "react-native";
import {
  getSdkStatus,
  SdkAvailabilityStatus,
} from "react-native-health-connect";
import {
  getHealthConnectAvailability,
  getHealthConnectPlayStoreUrl,
} from "../healthConnect";

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
