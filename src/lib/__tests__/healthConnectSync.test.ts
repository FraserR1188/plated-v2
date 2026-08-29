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
