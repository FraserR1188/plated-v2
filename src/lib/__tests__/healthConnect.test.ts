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
  initialize: vi.fn().mockResolvedValue(true),
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

// Spied on directly (rather than relying on vitest.setup.ts's Sentry mock
// underneath it) so tests can assert a native failure was actually
// reported, not just that the function resolved to some fallback value.
vi.mock("../reportError", () => ({ reportError: vi.fn() }));

import { Platform } from "react-native";
import * as Linking from "expo-linking";
import {
  getSdkStatus,
  initialize,
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
  ensureHealthConnectInitialized,
  getHealthConnectGrantState,
  requestHealthConnectAccess,
  isHealthConnectFullyDenied,
  openHealthConnectSettingsScreen,
  type HealthConnectGrantState,
  type HealthConnectGrantResult,
} from "../healthConnect";
import { reportError } from "../reportError";

const FULL_GRANT = [
  { accessType: "read", recordType: "SleepSession" },
  { accessType: "read", recordType: "HeartRateVariabilityRmssd" },
  { accessType: "read", recordType: "RestingHeartRate" },
  { accessType: "read", recordType: "ExerciseSession" },
  { accessType: "read", recordType: "ReadHealthDataHistory" },
];

const EMPTY_GRANTS_OBJECT: HealthConnectGrantState = {
  sleep: false,
  hrv: false,
  resting_hr: false,
  workouts: false,
  history: false,
};

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

  it("reports a getSdkStatus() rejection via reportError — a genuine native failure must not be silent just because the fallback value happens to look like a normal, permanent state", async () => {
    vi.mocked(getSdkStatus).mockRejectedValue(new Error("native boom"));

    await getHealthConnectAvailability();

    expect(reportError).toHaveBeenCalledWith(
      "healthConnect:getAvailability",
      expect.any(Error),
    );
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

describe("ensureHealthConnectInitialized", () => {
  it("calls the native initialize() on Android", async () => {
    await ensureHealthConnectInitialized();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("does nothing on iOS — no native call at all", async () => {
    Platform.OS = "ios";

    await ensureHealthConnectInitialized();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("propagates a rejection — callers decide how to handle init failure, this does not swallow it", async () => {
    vi.mocked(initialize).mockRejectedValue(
      Object.assign(new Error("Health Connect client is not initialized"), {
        code: "CLIENT_NOT_INITIALIZED",
      }),
    );

    await expect(ensureHealthConnectInitialized()).rejects.toThrow(
      "Health Connect client is not initialized",
    );
  });
});

describe("getHealthConnectGrantState", () => {
  it("initializes the client BEFORE reading granted permissions — the bug this module shipped with was calling getGrantedPermissions() first", async () => {
    const order: string[] = [];
    vi.mocked(initialize).mockImplementation(async () => {
      order.push("initialize");
      return true;
    });
    vi.mocked(getGrantedPermissions).mockImplementation(async () => {
      order.push("getGrantedPermissions");
      return FULL_GRANT as never;
    });

    await getHealthConnectGrantState();

    expect(order).toEqual(["initialize", "getGrantedPermissions"]);
  });

  it("reports every domain granted, including history, when all five are present", async () => {
    vi.mocked(getGrantedPermissions).mockResolvedValue(FULL_GRANT as never);

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      status: "ok",
      grants: {
        sleep: true,
        hrv: true,
        resting_hr: true,
        workouts: true,
        history: true,
      },
    } satisfies HealthConnectGrantResult);
  });

  it("reports a PARTIAL grant honestly — sleep granted, hrv denied, not collapsed to one flag", async () => {
    vi.mocked(getGrantedPermissions).mockResolvedValue([
      { accessType: "read", recordType: "SleepSession" },
    ] as never);

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      status: "ok",
      grants: {
        sleep: true,
        hrv: false,
        resting_hr: false,
        workouts: false,
        history: false,
      },
    } satisfies HealthConnectGrantResult);
  });

  it("ignores a write-access grant for a record type we only ever request read for", async () => {
    vi.mocked(getGrantedPermissions).mockResolvedValue([
      { accessType: "write", recordType: "SleepSession" },
    ] as never);

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      status: "ok",
      grants: {
        sleep: false,
        hrv: false,
        resting_hr: false,
        workouts: false,
        history: false,
      },
    } satisfies HealthConnectGrantResult);
  });

  it("is 'ok' with all-false on iOS without calling the native module — nothing to grant, not an error", async () => {
    Platform.OS = "ios";

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      status: "ok",
      grants: {
        sleep: false,
        hrv: false,
        resting_hr: false,
        workouts: false,
        history: false,
      },
    } satisfies HealthConnectGrantResult);
    expect(getGrantedPermissions).not.toHaveBeenCalled();
  });

  it("never throws — a getGrantedPermissions() rejection resolves to an 'error' result, NOT all-false", async () => {
    vi.mocked(getGrantedPermissions).mockRejectedValue(new Error("boom"));

    await expect(getHealthConnectGrantState()).resolves.toEqual({
      status: "error",
      message: "boom",
    } satisfies HealthConnectGrantResult);
  });

  it("CLIENT_NOT_INITIALIZED from a failed initialize() surfaces as an 'error' result, never as empty grants — this is the exact bug being fixed", async () => {
    vi.mocked(initialize).mockRejectedValue(
      Object.assign(new Error("Health Connect client is not initialized"), {
        code: "CLIENT_NOT_INITIALIZED",
      }),
    );

    const result = await getHealthConnectGrantState();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Health Connect client is not initialized");
    }
    // The native read must never even be attempted once init has failed.
    expect(getGrantedPermissions).not.toHaveBeenCalled();
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
  it("initializes the client BEFORE requesting permission (and again before the grant-state re-read that follows — initialize() is idempotent, so both calls are deliberate, not a bug)", async () => {
    const order: string[] = [];
    vi.mocked(initialize).mockImplementation(async () => {
      order.push("initialize");
      return true;
    });
    vi.mocked(requestPermission).mockImplementation(async () => {
      order.push("requestPermission");
      return FULL_GRANT as never;
    });
    vi.mocked(getGrantedPermissions).mockImplementation(async () => {
      order.push("getGrantedPermissions");
      return FULL_GRANT as never;
    });

    await requestHealthConnectAccess();

    expect(order).toEqual([
      "initialize",
      "requestPermission",
      "initialize",
      "getGrantedPermissions",
    ]);
  });

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
      status: "ok",
      grants: {
        sleep: false,
        hrv: false,
        resting_hr: false,
        workouts: false,
        history: false,
      },
    } satisfies HealthConnectGrantResult);
  });

  it("never throws, but does NOT fall through to grant state when requestPermission() itself rejects — nothing was actually decided", async () => {
    // This is the behavior that changed: the previous version reported
    // and swallowed this rejection, then re-derived an answer from
    // getGrantedPermissions() as if the request had genuinely completed.
    // A request that never reached the OS must not be reported as a
    // completed, denied one.
    vi.mocked(requestPermission).mockRejectedValue(
      Object.assign(new Error("Health Connect client is not initialized"), {
        code: "CLIENT_NOT_INITIALIZED",
      }),
    );
    vi.mocked(getGrantedPermissions).mockResolvedValue(FULL_GRANT as never);

    await expect(requestHealthConnectAccess()).resolves.toEqual({
      status: "error",
      message: "Health Connect client is not initialized",
    } satisfies HealthConnectGrantResult);
    expect(getGrantedPermissions).not.toHaveBeenCalled();
  });

  it("does nothing on iOS — no native call at all", async () => {
    Platform.OS = "ios";

    await expect(requestHealthConnectAccess()).resolves.toEqual({
      status: "ok",
      grants: {
        sleep: false,
        hrv: false,
        resting_hr: false,
        workouts: false,
        history: false,
      },
    } satisfies HealthConnectGrantResult);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getGrantedPermissions).not.toHaveBeenCalled();
  });

  it("can be called again after a fully-denied result — nothing in this module blocks a retry (there is no signal from the library to key a permanent block on; see openHealthConnectSettingsScreen's doc comment)", async () => {
    // Explicit resolved values for both — a prior test in this file leaves
    // requestPermission mocked to reject, and vi.clearAllMocks() in
    // beforeEach clears call history but not a mock's implementation.
    vi.mocked(requestPermission).mockResolvedValue([] as never);
    vi.mocked(getGrantedPermissions).mockResolvedValue([] as never);

    const first = await requestHealthConnectAccess();
    const second = await requestHealthConnectAccess();

    expect(first).toEqual({ status: "ok", grants: EMPTY_GRANTS_OBJECT });
    expect(second).toEqual({ status: "ok", grants: EMPTY_GRANTS_OBJECT });
    // Both attempts genuinely reached the OS — a real dialog would have
    // been (re-)shown both times, or Android silently re-denied both
    // times; either way, this module never short-circuits the second call
    // on the strength of the first one's outcome.
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });
});

describe("openHealthConnectSettingsScreen", () => {
  it("delegates straight to the native openHealthConnectSettings()", () => {
    openHealthConnectSettingsScreen();
    expect(openHealthConnectSettings).toHaveBeenCalledTimes(1);
  });
});
