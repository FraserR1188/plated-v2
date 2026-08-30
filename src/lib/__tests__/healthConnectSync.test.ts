// ============================================================
// src/lib/__tests__/healthConnectSync.test.ts
//
// Covers four rounds of fixes to healthConnectSync.ts:
//
//   1. (CLIENT_NOT_INITIALIZED fix) syncHealthConnect() must stop on a
//      genuine grant-state 'error' result rather than treating it as
//      "everything denied", and syncRecordType() calls
//      ensureHealthConnectInitialized() before any readRecords()/
//      getChanges() call.
//   2. (the "Nothing new." masking bug) a sync where every attempted
//      domain failed must produce a DIFFERENT counts/errors shape than
//      one that genuinely found nothing new.
//   3/4. (the late-history-grant backfill, then the hasHistory-always-
//      false fix) a pre-migration bare-string token must be read without
//      throwing and without being treated as "no stored token"; a stored
//      baseline narrower than the full window triggers exactly one
//      bounded backfill attempt covering the gap and widens the stored
//      baseline on success; and the token-expiry re-pull reaches the
//      same depth a first sync would.
//   5. (the four-syncs-on-one-launch fix) two near-simultaneous calls to
//      syncHealthConnect() must collapse into one real sync via a
//      single-flight guard; a forced (manual button) repeat within a
//      short floor reuses the just-completed result instead of running
//      again; and the automatic (non-forced) path is NEVER time-throttled
//      — see healthConnectSync.ts's guard section for why that last part
//      is a deliberate divergence from WHOOP's own shape, not an
//      oversight.
//
// IMPORTANT — why these are NOT mock-matches-implementation tests:
// getHealthConnectGrantState().grants.history is confirmed to always be
// false on a real device (react-native-health-connect@4.1.3's own
// mapPermissionResult() never reports it — see healthConnect.ts and
// healthConnectSync.ts's module headers). So this module no longer asks
// a permission API at all for the backfill decision — it attempts the
// real 180-day read and reacts to whether Health Connect allows it,
// distinguishing a permission-shaped rejection (error.code
// "PERMISSION_ERROR", assumed from a SecurityException — see
// isHistoryPermissionDenied()'s doc comment) from any other failure.
// The tests below exercise BOTH sides of that discrminator with a
// REALISTIC native error shape ({code, message}, matching
// errors.ts's rejectWithException contract) — not just the happy path a
// hand-built mock could trivially satisfy either way. Critically, one
// test asserts that an UNRELATED error code does NOT fall back silently
// but propagates as a genuine failure — that's the side of the boundary
// a mock "shaped to match the implementation" would never bother
// checking, and it's exactly the kind of bug (treating any read failure
// as "no history") this design has to not have.
//
// What these tests CANNOT prove: that "PERMISSION_ERROR" is actually the
// code react-native-health-connect/AndroidX returns for this specific
// 30-day-floor rejection in reality. That is a fact about the real
// native module, not about this file's logic, and only a device run can
// confirm it — see healthConnectSync:widestAvailable's devLog output
// (failed:true, code:<whatever it really is>) the first time a sync
// actually hits this path without history granted.
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

// The real native rejection shape (RN's Promise.reject(code, message, ...)
// surfaces as an Error with a `.code` string property — see errors.ts's
// rejectWithException). Building rejections this way, rather than a bare
// Error, is what makes the discrimination tests meaningful.
function nativeError(code: string, message = "native error"): Error {
  return Object.assign(new Error(message), { code });
}

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
    vi.mocked(readRecords).mockRejectedValue(nativeError("IO_EXCEPTION", "Health Connect read failed"));

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
      throw nativeError("IO_EXCEPTION", "hrv read failed");
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

// ── Late-history-grant backfill: determined empirically, not by asking ──
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
      grants: { ...EMPTY_GRANTS, sleep: true },
    });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue("legacy-bare-token");
    // Isolate this test to the migration property alone: the assumed
    // 30-day baseline (< 180) means a backfill attempt fires regardless —
    // deny it here so this test's only claim is "the legacy token itself
    // survives and is reused", not anything about backfill window math
    // (covered separately below).
    vi.mocked(readRecords).mockRejectedValue(nativeError("PERMISSION_ERROR"));
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    const result = await syncHealthConnect();

    expect(result.ok).toBe(true);
    expect(getChanges).toHaveBeenCalledWith(
      expect.objectContaining({ changesToken: "legacy-bare-token" }),
    );
  });

  it("a legacy token's assumed 30-day baseline, when the wide read is actually allowed, triggers exactly one backfill covering 31-180 days back", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
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
  it("baseline 30 + the wide read is actually allowed: exactly one backfill covering 31-180 days back", async () => {
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

  it("baseline 180: no backfill is even attempted — already at full depth, regardless of what a read would do", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
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

  it("baseline 30, the wide read is denied (PERMISSION_ERROR): baseline stays unwidened so the next sync retries", async () => {
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
    vi.mocked(readRecords).mockRejectedValue(nativeError("PERMISSION_ERROR"));
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);

    const result = await syncHealthConnect();

    // Denied, but NOT a failure — this is the expected "not available yet"
    // outcome, not an error to report.
    expect(result.ok).toBe(true);
    // The incremental loop still ran on the preserved token.
    expect(getChanges).toHaveBeenCalledWith(
      expect.objectContaining({ changesToken: "tok-1" }),
    );
    // No widened baseline was ever persisted.
    const writtenBaselines = vi
      .mocked(AsyncStorage.setItem)
      .mock.calls.map((call) => JSON.parse(call[1] as string).baselineWindowDays);
    expect(writtenBaselines).not.toContain(180);
  });

  it("the wide read fails with an UNRELATED code (not a permission denial): propagates as a genuine domain failure, is NOT silently treated as 'no history'", async () => {
    // This is the test a mock built to match the implementation would
    // never bother writing: it proves the discrimination has two sides,
    // not just "catch and assume the friendly case".
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
    vi.mocked(readRecords).mockRejectedValue(nativeError("IO_EXCEPTION", "network blip"));

    const result = await syncHealthConnect();

    expect(result.ok).toBe(false);
    expect(result.errors.sleep).toBe("network blip");
    // The incremental loop never even ran — the failure propagated out of
    // syncRecordType before reaching it.
    expect(getChanges).not.toHaveBeenCalled();
  });

  it("loses then regains access: a baseline already widened to 180 stays put once access is lost, and regaining it triggers no second backfill", async () => {
    // "Loses access" and "regains access" are modeled the only way this
    // module can observe them at all: by whether the wide read itself
    // succeeds. There is deliberately no separate permission flag to get
    // out of sync with reality.
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        token: "tok-1",
        baselineWindowDays: 180,
        baselineAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
    });
    vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);
    // If a backfill attempt happened at all here, it would find the wide
    // read denied — but baseline 180 means it must never even be tried.
    vi.mocked(readRecords).mockRejectedValue(nativeError("PERMISSION_ERROR"));

    await syncHealthConnect();
    expect(readRecords).not.toHaveBeenCalled();

    // "Regains access": the wide read would now succeed too. Still never
    // attempted, for the same reason — baseline is still 180 in storage,
    // and losing/regaining access never touched it.
    vi.mocked(readRecords).mockResolvedValue({
      records: [],
      pageToken: undefined,
    } as never);
    await syncHealthConnect();
    expect(readRecords).not.toHaveBeenCalled();
  });
});

describe("syncHealthConnect — token-expiry re-pull depth is determined empirically", () => {
  it("re-pulls a 180-day window when the wide read is actually allowed", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
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

  it("falls back to a 30-day window when the wide read is denied — previously hardcoded to 30 regardless, this now merely coincides with it", async () => {
    vi.mocked(getHealthConnectGrantState).mockResolvedValue({
      status: "ok",
      grants: { ...EMPTY_GRANTS, sleep: true },
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
    vi.mocked(readRecords)
      .mockRejectedValueOnce(nativeError("PERMISSION_ERROR"))
      .mockResolvedValueOnce({ records: [], pageToken: undefined } as never);

    await syncHealthConnect();

    // Two calls: the denied wide attempt, then the narrow fallback.
    expect(readRecords).toHaveBeenCalledTimes(2);
    const { startTime } = readRecordsCall(1).timeRangeFilter;
    expect(daysAgoMs(startTime)).toBeGreaterThan(29 * DAY_MS);
    expect(daysAgoMs(startTime)).toBeLessThan(31 * DAY_MS);
  });
});

// ── Concurrency / repeat-invocation guard ────────────────────────────────
//
// syncHealthConnect()'s guard state (inFlightSync / lastSyncCompletedAt /
// lastSyncResult) lives in healthConnectSync.ts's own module scope, NOT
// behind a mock — beforeEach's vi.clearAllMocks() does not, and cannot,
// reset it. Each test below is written to be correct regardless of
// whatever a PRIOR test left behind: the concurrency test never touches
// `force`, so the floor logic (gated on `options.force &&`) never even
// reads the leaked state; the floor tests use fake timers and set the
// clock explicitly from their own first call, overwriting whatever real
// wall-clock timestamp an earlier test's real-time run left in
// lastSyncCompletedAt before the comparison that matters runs.
function healthyMocks() {
  vi.mocked(getHealthConnectGrantState).mockResolvedValue({
    status: "ok",
    grants: { ...EMPTY_GRANTS, sleep: true },
  });
  vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  vi.mocked(readRecords).mockResolvedValue({
    records: [],
    pageToken: undefined,
  } as never);
  vi.mocked(getChanges).mockResolvedValue(OK_NO_CHANGES);
}

describe("syncHealthConnect — concurrency and repeat-invocation guard", () => {
  it("single-flight: two near-simultaneous calls collapse into one real sync and share the exact same result", async () => {
    healthyMocks();

    const [r1, r2] = await Promise.all([
      syncHealthConnect(),
      syncHealthConnect(),
    ]);

    expect(r1).toBe(r2); // the SAME object — one shared promise, not two separately-run syncs that happen to agree
    expect(getHealthConnectGrantState).toHaveBeenCalledTimes(1);
    expect(readRecords).toHaveBeenCalledTimes(1);
  });

  // A fixed, far-future instant per test — not "now plus a margin" (a
  // margin measured from vi.useFakeTimers()'s own real-time start point
  // is only as safe as knowing what real time was when the PREVIOUS
  // test's fake clock was torn down, which is fragile to reason about
  // across tests), and not the SAME far-future instant reused across
  // tests either (confirmed the hard way: two tests both anchored at the
  // same fixed instant still collide, because the first test's own
  // internal advance leaves lastSyncCompletedAt slightly AFTER that
  // instant, which the second test's un-advanced start then reads as
  // "within the floor" of). Each test gets its own anchor, far enough
  // apart that neither a real wall clock nor a leaked fake one from
  // another test can ever land within FORCED_REPEAT_FLOOR_MS of it.
  function farFutureAnchor(offsetMinutes: number): Date {
    return new Date(
      new Date("2030-01-01T00:00:00.000Z").getTime() + offsetMinutes * 60_000,
    );
  }

  it("a forced repeat within the floor reuses the just-completed result instead of running again", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(farFutureAnchor(0));
      healthyMocks();

      const first = await syncHealthConnect({ force: true });
      vi.advanceTimersByTime(1_000); // well inside FORCED_REPEAT_FLOOR_MS
      const second = await syncHealthConnect({ force: true });

      expect(second).toBe(first); // reused, not a freshly computed result
      expect(getHealthConnectGrantState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a forced repeat AFTER the floor has elapsed runs a genuine new sync", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(farFutureAnchor(10)); // 10 minutes clear of the previous test's anchor
      healthyMocks();

      await syncHealthConnect({ force: true });
      vi.advanceTimersByTime(10_000); // past FORCED_REPEAT_FLOOR_MS
      await syncHealthConnect({ force: true });

      expect(getHealthConnectGrantState).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the automatic (non-forced) path is NEVER floor-throttled — two sequential calls with zero elapsed time both run for real", async () => {
    // This is the test for the design decision itself: unlike WHOOP's
    // THROTTLE_MS, the automatic path has no time-based floor at all.
    // Proven with fake timers advanced by nothing, so this isn't passing
    // by accident of however long the test itself took to run.
    vi.useFakeTimers();
    try {
      healthyMocks();

      await syncHealthConnect();
      await syncHealthConnect();

      expect(getHealthConnectGrantState).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
