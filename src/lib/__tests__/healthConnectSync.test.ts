// ============================================================
// src/lib/__tests__/healthConnectSync.test.ts
//
// Covers three rounds of fixes to healthConnectSync.ts:
//
//   1. (CLIENT_NOT_INITIALIZED fix) syncHealthConnect() must stop on a
//      genuine grant-state 'error' result rather than treating it as
//      "everything denied", and syncRecordType() calls
//      ensureHealthConnectInitialized() before any readRecords()/
//      getChanges() call.
//   2. (the "Nothing new." masking bug) a sync where every attempted
//      domain failed must produce a DIFFERENT counts/errors shape than
//      one that genuinely found nothing new.
//   3. (the late-history-grant backfill) a pre-migration bare-string
//      token must be read without throwing and without being treated as
//      "no stored token"; a stored baseline narrower than the current
//      history grant triggers exactly one bounded backfill covering the
//      gap, widens the stored baseline so it does not repeat, and does
//      so purely by comparing live grant state against the stored
//      baseline rather than a separate one-shot flag; and the
//      token-expiry re-pull depth now follows hasHistory instead of
//      being hardcoded to 30.
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

// ── Late-history-grant backfill ──────────────────────────────────────────
//
// A day-count constant, kept independent of healthConnectSync.ts's own
// DAY_MS — an assertion built from the same constant it's checking would
// pass even if that constant were wrong.
const DAY_MS = 86_400_000;

function readRecordsCall(index = 0) {
  const call = vi.mocked(readRecords).mock.calls[index];
  return call[1] as { timeRangeFilter: { startTime: string; endTime: string } };
}

function daysAgoMs(iso: string): number {
  return Date.now() - Date.parse(iso);
}

const OK_NO_CHANGES = {
  upsertionChanges: [],
  deletionChanges: [],
  nextChangesToken: "tok-next",
  hasMore: false,
  changesTokenExpired: false,
} as never;

describe("syncHealthConnect — legacy token migration", () => {
  it("a pre-migration bare-string token is read without throwing and is NOT treated as 'no stored token' — the incremental branch runs using it as the token", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true }, // history stays off
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue("legacy-bare-token");
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    const result = await syncHealthConnect();

    expect(result.ok).toBe(true);
    expect(getChanges).toHaveBeenCalledWith(
      expect.objectContaining({ changesToken: "legacy-bare-token" }),
    );
    // Did NOT restart from scratch — that would show up as a readRecords() call.
    expect(readRecords).not.toHaveBeenCalled();
  });

  it("a legacy token, when history is granted NOW, triggers exactly one backfill — its unrecorded baseline is assumed to have been 30 days, not 180", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, history: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue("legacy-bare-token");
    vi.mocked(readRecords).mockResolvedValue({
      records: [],
      pageToken: undefined,
    } as never);
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    await syncHealthConnect();

    expect(readRecords).toHaveBeenCalledTimes(1);
    const { startTime, endTime } = readRecordsCall().timeRangeFilter;
    // Gap = 31..180 days back, i.e. the range a 30-day-assumed baseline left uncovered.
    expect(daysAgoMs(startTime)).toBeGreaterThan(179 * DAY_MS);
    expect(daysAgoMs(startTime)).toBeLessThan(181 * DAY_MS);
    expect(daysAgoMs(endTime)).toBeGreaterThan(29 * DAY_MS);
    expect(daysAgoMs(endTime)).toBeLessThan(31 * DAY_MS);

    const written = JSON.parse(
      vi.mocked(AsyncStorage.setItem).mock.calls[0][1] as string,
    );
    expect(written.token).toBe("legacy-bare-token"); // the existing cursor is PRESERVED
    expect(written.baselineWindowDays).toBe(180); // widened so this doesn't repeat
  });
});

describe("syncHealthConnect — late-history-grant backfill (recorded baseline)", () => {
  it("baseline 30 + history now granted: exactly one backfill covering 31-180 days back", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, history: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        token: "tok-1",
        baselineWindowDays: 30,
        baselineAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    vi.mocked(readRecords).mockResolvedValue({
      records: [],
      pageToken: undefined,
    } as never);
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    await syncHealthConnect();

    expect(readRecords).toHaveBeenCalledTimes(1);
    const { startTime, endTime } = readRecordsCall().timeRangeFilter;
    expect(daysAgoMs(startTime)).toBeGreaterThan(179 * DAY_MS);
    expect(daysAgoMs(startTime)).toBeLessThan(181 * DAY_MS);
    expect(daysAgoMs(endTime)).toBeGreaterThan(29 * DAY_MS);
    expect(daysAgoMs(endTime)).toBeLessThan(31 * DAY_MS);

    const written = JSON.parse(
      vi.mocked(AsyncStorage.setItem).mock.calls[0][1] as string,
    );
    expect(written.token).toBe("tok-1");
    expect(written.baselineWindowDays).toBe(180);
  });

  it("baseline 180: no backfill, even with history granted — already at full depth", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, history: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        token: "tok-1",
        baselineWindowDays: 180,
        baselineAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    await syncHealthConnect();

    expect(readRecords).not.toHaveBeenCalled();
  });

  it("baseline 30, history NOT granted: no backfill — nothing available to backfill with", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        token: "tok-1",
        baselineWindowDays: 30,
        baselineAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    await syncHealthConnect();

    expect(readRecords).not.toHaveBeenCalled();
  });

  it("revoke then re-grant: a baseline already widened to 180 stays put across a revoke, and re-granting triggers no second backfill", async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        token: "tok-1",
        baselineWindowDays: 180,
        baselineAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    // Revoked: history now false.
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
    });
    await syncHealthConnect();
    expect(readRecords).not.toHaveBeenCalled();

    // Re-granted. AsyncStorage.getItem is still mocked to return the SAME
    // 180-baseline record — simulating that a revoke never resets it —
    // so a real backfill trigger would be a genuine regression here, not
    // an artifact of the mock.
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, history: true },
    });
    await syncHealthConnect();
    expect(readRecords).not.toHaveBeenCalled();
  });
});

describe("syncHealthConnect — token-expiry re-pull depth follows hasHistory", () => {
  it("re-pulls a 180-day window when history is currently granted", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true, history: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        token: "tok-1",
        baselineWindowDays: 180,
        baselineAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    vi.mocked(getChanges)
      .mockResolvedValueOnce({ changesTokenExpired: true } as never)
      .mockResolvedValueOnce({ nextChangesToken: "tok-3" } as never);
    vi.mocked(readRecords).mockResolvedValue({
      records: [],
      pageToken: undefined,
    } as never);

    await syncHealthConnect();

    expect(readRecords).toHaveBeenCalledTimes(1);
    const { startTime } = readRecordsCall().timeRangeFilter;
    expect(daysAgoMs(startTime)).toBeGreaterThan(179 * DAY_MS);
    expect(daysAgoMs(startTime)).toBeLessThan(181 * DAY_MS);
  });

  it("re-pulls only a 30-day window when history is NOT granted — previously hardcoded to 30 regardless, this now merely coincides with it", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        token: "tok-1",
        baselineWindowDays: 30,
        baselineAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    vi.mocked(getChanges)
      .mockResolvedValueOnce({ changesTokenExpired: true } as never)
      .mockResolvedValueOnce({ nextChangesToken: "tok-3" } as never);
    vi.mocked(readRecords).mockResolvedValue({
      records: [],
      pageToken: undefined,
    } as never);

    await syncHealthConnect();

    expect(readRecords).toHaveBeenCalledTimes(1);
    const { startTime } = readRecordsCall().timeRangeFilter;
    expect(daysAgoMs(startTime)).toBeGreaterThan(29 * DAY_MS);
    expect(daysAgoMs(startTime)).toBeLessThan(31 * DAY_MS);
  });
});
