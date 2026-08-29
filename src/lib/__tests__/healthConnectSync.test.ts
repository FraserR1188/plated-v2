// ============================================================
// src/lib/__tests__/healthConnectSync.test.ts
//
// Covers the two things that changed in healthConnectSync.ts as part of
// the CLIENT_NOT_INITIALIZED bug fix:
//   1. syncHealthConnect() must stop on a genuine grant-state 'error'
//      result rather than treating it as "everything denied" (mirrors the
//      same distinction now made in healthConnect.test.ts, at the one
//      call site inside this module that consumes it).
//   2. syncRecordType() calls ensureHealthConnectInitialized() before any
//      readRecords()/getChanges() call — those have the exact same native
//      precondition as getGrantedPermissions() (a live client), and this
//      module's own native calls were just as broken as the permission
//      flow's before this fix, just not what the reported bug happened to
//      exercise on-device.
//
// Everything else in this module (token persistence, pagination, the
// changes-token expiry re-pull) is unchanged by this fix and untested
// here — this file adds coverage for what changed, not a full retest of
// the sync module.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("react-native-health-connect", () => ({
  readRecords: vi.fn(),
  getChanges: vi.fn(),
}));

vi.mock("../healthConnect", () => ({
  getHealthConnectGrantState: vi.fn(),
  ensureHealthConnectInitialized: vi.fn().mockResolvedValue(undefined),
  DOMAIN_RECORD_TYPE: {
    sleep: "SleepSession",
    hrv: "HeartRateVariabilityRmssd",
    resting_hr: "RestingHeartRate",
    workouts: "ExerciseSession",
  },
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { readRecords, getChanges } from "react-native-health-connect";
import {
  getHealthConnectGrantState,
  ensureHealthConnectInitialized,
} from "../healthConnect";
import { syncHealthConnect } from "../healthConnectSync";

const EMPTY_GRANTS = {
  sleep: false,
  hrv: false,
  resting_hr: false,
  workouts: false,
  history: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncHealthConnect — grant-state result handling", () => {
  it("stops immediately on a grant-state 'error' result — does not touch any domain, and does NOT report it as 'everything denied'", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "error",
      message: "Health Connect client is not initialized",
    });

    const result = await syncHealthConnect();

    expect(result).toEqual({ ok: false, counts: {}, errors: {} });
    expect(readRecords).not.toHaveBeenCalled();
    expect(getChanges).not.toHaveBeenCalled();
  });

  it("proceeds normally, syncing only granted domains, when grant state is 'ok'", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    vi.mocked(readRecords).mockResolvedValue({
      records: [],
      pageToken: undefined,
    } as never);
    vi.mocked(getChanges).mockResolvedValue({
      upsertionChanges: [],
      deletionChanges: [],
      nextChangesToken: "tok1",
      hasMore: false,
      changesTokenExpired: false,
    } as never);

    const result = await syncHealthConnect();

    expect(result.ok).toBe(true);
    expect(readRecords).toHaveBeenCalledWith(
      "SleepSession",
      expect.any(Object),
    );
    // Only the granted domain was touched.
    expect(readRecords).toHaveBeenCalledTimes(1);
  });
});

describe("syncHealthConnect — distinguishing outcomes (the 'Nothing new.' masking bug)", () => {
  // SettingsScreen.handleSyncHealthConnect previously rendered "Nothing
  // new." any time result.counts summed to zero — which is ALSO true when
  // every domain failed (counts stays {}), so a total outage and a
  // genuinely empty, successful sync were shown identically, with the
  // real failure only visible as separate, easy-to-miss error text. These
  // three shapes are what SettingsScreen now branches on to tell the
  // difference; they must actually be different.

  it("nothing to fetch: ok:true, with a REAL zero recorded per attempted domain — not the same shape as a failure", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, hrv: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    vi.mocked(readRecords).mockResolvedValue({
      records: [],
      pageToken: undefined,
    } as never);
    vi.mocked(getChanges).mockResolvedValue({
      upsertionChanges: [],
      deletionChanges: [],
      nextChangesToken: "tok1",
      hasMore: false,
      changesTokenExpired: false,
    } as never);

    const result = await syncHealthConnect();

    expect(result).toEqual({
      ok: true,
      counts: { sleep: 0, hrv: 0 },
      errors: {},
    });
  });

  it("every attempted domain failed: ok:false, counts stays EMPTY (nothing succeeded) — must not collapse to the same shape as 'nothing to fetch'", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, hrv: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    vi.mocked(readRecords).mockRejectedValue(new Error("Health Connect read failed"));

    const result = await syncHealthConnect();

    expect(result.ok).toBe(false);
    expect(result.counts).toEqual({}); // nothing succeeded — distinct from { sleep: 0, hrv: 0 } above
    expect(Object.keys(result.errors).sort()).toEqual(["hrv", "sleep"]);
  });

  it("partial failure: one domain succeeds, one fails — both counts AND errors are non-empty, distinguishable from either pure outcome", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, hrv: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    vi.mocked(readRecords).mockImplementation(async (recordType: unknown) => {
      if (recordType === "SleepSession") {
        return { records: [], pageToken: undefined } as never;
      }
      throw new Error("hrv read failed");
    });

    const result = await syncHealthConnect();

    expect(result.ok).toBe(false);
    expect(result.counts).toEqual({ sleep: 0 });
    expect(Object.keys(result.errors)).toEqual(["hrv"]);
  });
});

describe("syncHealthConnect — client initialisation", () => {
  it("initializes the client before reading any granted domain's records — the same precondition getGrantedPermissions() has, which this module never satisfied before this fix", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, workouts: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);

    const order: string[] = [];
    vi.mocked(ensureHealthConnectInitialized).mockImplementation(async () => {
      order.push("ensureHealthConnectInitialized");
    });
    vi.mocked(readRecords).mockImplementation(async () => {
      order.push("readRecords");
      return { records: [], pageToken: undefined } as never;
    });
    vi.mocked(getChanges).mockResolvedValue({
      upsertionChanges: [],
      deletionChanges: [],
      nextChangesToken: "tok1",
      hasMore: false,
      changesTokenExpired: false,
    } as never);

    await syncHealthConnect();

    expect(order[0]).toBe("ensureHealthConnectInitialized");
    expect(order).toContain("readRecords");
  });
});
