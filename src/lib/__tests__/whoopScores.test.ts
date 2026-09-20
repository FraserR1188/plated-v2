import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/react-native";
import { supabase } from "../supabase";
import {
  getWhoopScoresForDate,
  formatStrainCaption,
  NO_SCORES,
} from "../whoopScores";

/** Wire supabase.from(...).select(...).eq(...).order(...).limit(...). */
function mockView(result: { data: unknown; error: unknown }) {
  const calls: { table?: string; eq?: [string, string]; order?: string } = {};
  const limit = vi.fn(async () => result);
  const order = vi.fn((col: string) => {
    calls.order = col;
    return { limit };
  });
  const eq = vi.fn((col: string, val: string) => {
    calls.eq = [col, val];
    return { order };
  });
  const select = vi.fn(() => ({ eq }));
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation(
    (table: string) => {
      calls.table = table;
      return { select };
    },
  );
  return calls;
}

function row(over: Record<string, unknown> = {}) {
  return {
    local_date: "2026-09-19",
    recovery_score: 62,
    recovery_score_state: "SCORED",
    sleep_performance: 88,
    sleep_score_state: "SCORED",
    strain: 12.34,
    strain_score_state: "SCORED",
    source_updated_at: "2026-09-19T13:05:00.000Z",
    period_start: "2026-09-19T05:00:00.000Z",
    ...over,
  };
}

const NOW = new Date(2026, 8, 20, 12, 0, 0); // 20 Sept 2026, local noon

beforeEach(() => {
  vi.mocked(supabase.from).mockReset();
  vi.mocked(Sentry.captureException).mockClear();
});

describe("getWhoopScoresForDate — reading the right thing", () => {
  it("reads biometric_periods_resolved, keyed on local_date", async () => {
    // PL-019: never is_current (not unique per user, and not a date), and
    // never biometric_periods.local_date (fall-asleep dating).
    const calls = mockView({ data: [row()], error: null });

    await getWhoopScoresForDate("2026-09-19", NOW);

    expect(calls.table).toBe("biometric_periods_resolved");
    expect(calls.eq).toEqual(["local_date", "2026-09-19"]);
  });

  it("orders so a doubled date resolves to the same row every time", async () => {
    // A user can hold two rows for a date when whoop-sync leaves a dropped
    // cycle open. An unstable pick would flicker between two values.
    const calls = mockView({ data: [row()], error: null });

    await getWhoopScoresForDate("2026-09-19", NOW);

    expect(calls.order).toBe("period_start");
  });
});

describe("getWhoopScoresForDate — what counts as a score", () => {
  it("SCORED yields values, with the documented rounding", async () => {
    mockView({ data: [row()], error: null });

    const s = await getWhoopScoresForDate("2026-09-19", NOW);

    expect(s.recovery).toBe(62); // integer %
    expect(s.sleep).toBe(88); // integer %
    expect(s.strain).toBe(12.3); // 1dp
  });

  it("rounds a fractional recovery and sleep to whole percent", async () => {
    mockView({
      data: [row({ recovery_score: 61.6, sleep_performance: 87.4 })],
      error: null,
    });

    const s = await getWhoopScoresForDate("2026-09-19", NOW);

    expect(s.recovery).toBe(62);
    expect(s.sleep).toBe(87);
  });

  for (const state of ["PENDING_SCORE", "UNSCORABLE", "SOMETHING_NEW", null]) {
    it(`a ${state ?? "NULL"} state is not a score`, async () => {
      // An unrecognised state is treated as not-a-score deliberately: a
      // state WHOOP invents later should show "–", not whatever happens
      // to be sitting in the value column.
      mockView({
        data: [
          row({
            recovery_score_state: state,
            sleep_score_state: state,
            strain_score_state: state,
          }),
        ],
        error: null,
      });

      const s = await getWhoopScoresForDate("2026-09-19", NOW);

      expect(s.recovery).toBeNull();
      expect(s.sleep).toBeNull();
      expect(s.strain).toBeNull();
    });
  }

  it("a SCORED state with a NULL value is still not a score", async () => {
    mockView({
      data: [row({ recovery_score: null, sleep_performance: null })],
      error: null,
    });

    const s = await getWhoopScoresForDate("2026-09-19", NOW);

    expect(s.recovery).toBeNull();
    expect(s.sleep).toBeNull();
    expect(s.strain).toBe(12.3); // unaffected
  });

  it("scores the three independently — one pending does not blank the others", async () => {
    mockView({
      data: [row({ recovery_score_state: "PENDING_SCORE" })],
      error: null,
    });

    const s = await getWhoopScoresForDate("2026-09-19", NOW);

    expect(s.recovery).toBeNull();
    expect(s.sleep).toBe(88);
    expect(s.strain).toBe(12.3);
  });
});

describe("getWhoopScoresForDate — rows that must not be placed", () => {
  it("no row at all gives all nulls", async () => {
    mockView({ data: [], error: null });

    expect(await getWhoopScoresForDate("2026-09-19", NOW)).toEqual(NO_SCORES);
  });

  it("an UNDATED row is not placed on the day", async () => {
    // local_date comes from the wake time plus the timezone offset. A
    // cycle missing either has no local day, and inferring one from
    // period_start would put a WHOOP frame on a date WHOOP never gave it.
    mockView({ data: [row({ local_date: null })], error: null });

    expect(await getWhoopScoresForDate("2026-09-19", NOW)).toEqual(NO_SCORES);
  });

  it("an orphan open cycle contributes nothing when it is undated", async () => {
    // PL-019's measured case: a cycle left open for 57.7 days.
    mockView({
      data: [row({ local_date: null, strain_score_state: "SCORED" })],
      error: null,
    });

    expect(await getWhoopScoresForDate("2026-09-19", NOW)).toEqual(NO_SCORES);
  });

  it("a FUTURE date returns nulls without querying at all", async () => {
    // Tomorrow cannot have been lived. Short-circuited before the round
    // trip, because swiping to a planned day is ordinary.
    const calls = mockView({ data: [row()], error: null });

    const s = await getWhoopScoresForDate("2026-09-21", NOW);

    expect(s).toEqual(NO_SCORES);
    expect(calls.table).toBeUndefined();
  });

  it("TODAY is not treated as future", async () => {
    mockView({ data: [row({ local_date: "2026-09-20" })], error: null });

    const s = await getWhoopScoresForDate("2026-09-20", NOW);

    expect(s.recovery).toBe(62);
  });

  it("the future check uses the LOCAL day, not UTC", async () => {
    // 2026-09-20T23:30Z is 00:30 on the 21st in London. Asking for the
    // 21st then is asking for TODAY, not tomorrow — a UTC comparison
    // would refuse to query and blank the panel for the first hour of
    // every BST day.
    const lateBst = new Date("2026-09-20T23:30:00.000Z");
    const calls = mockView({ data: [row({ local_date: "2026-09-21" })], error: null });

    const s = await getWhoopScoresForDate("2026-09-21", lateBst);

    expect(calls.table).toBe("biometric_periods_resolved");
    expect(s.recovery).toBe(62);
  });
});

describe("getWhoopScoresForDate — failure", () => {
  it("a failed read gives nulls and reports exactly once", async () => {
    mockView({ data: null, error: { message: "boom", code: "" } });

    const s = await getWhoopScoresForDate("2026-09-19", NOW);

    expect(s).toEqual(NO_SCORES);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { tags: { operation: string } },
    ];
    expect(ctx.tags.operation).toBe("getWhoopScoresForDate");
  });

  it("carries nothing stale forward — a failure after a good read is still nulls", async () => {
    mockView({ data: [row()], error: null });
    const good = await getWhoopScoresForDate("2026-09-19", NOW);
    expect(good.recovery).toBe(62);

    mockView({ data: null, error: { message: "boom", code: "" } });
    expect(await getWhoopScoresForDate("2026-09-19", NOW)).toEqual(NO_SCORES);
  });
});

describe("the strain caption's timestamp", () => {
  it("comes from the row, not from the connection", async () => {
    mockView({
      data: [row({ source_updated_at: "2026-09-19T13:05:00.000Z" })],
      error: null,
    });

    const s = await getWhoopScoresForDate("2026-09-19", NOW);

    expect(s.asOf).toBe("2026-09-19T13:05:00.000Z");
  });

  it("is null when there is no strain to caption", async () => {
    // "as of 14:05" under a "–" claims the dash is fresh.
    mockView({
      data: [row({ strain_score_state: "PENDING_SCORE" })],
      error: null,
    });

    expect((await getWhoopScoresForDate("2026-09-19", NOW)).asOf).toBeNull();
  });
});

describe("formatStrainCaption", () => {
  it("omits the day when the timestamp is the same LOCAL day", () => {
    const now = new Date(2026, 8, 20, 18, 0, 0);
    const at = new Date(2026, 8, 20, 14, 5, 0);

    expect(formatStrainCaption(at.toISOString(), now)).toBe("as of 14:05");
  });

  it("includes the short weekday on any other day", () => {
    const now = new Date(2026, 8, 20, 18, 0, 0); // Sunday
    const at = new Date(2026, 8, 18, 14, 5, 0); // Friday

    expect(formatStrainCaption(at.toISOString(), now)).toBe("as of Fri 14:05");
  });

  it("uses the LOCAL day for the same-day test, not UTC", () => {
    // 23:30Z on the 19th is 00:30 on the 20th in BST. Both of these are
    // the same local day as `now`, and a UTC comparison would call one of
    // them "yesterday" and print a weekday that contradicts the clock.
    const now = new Date("2026-09-20T10:00:00.000Z");
    const justAfterLocalMidnight = new Date("2026-09-19T23:30:00.000Z");

    expect(formatStrainCaption(justAfterLocalMidnight.toISOString(), now)).toBe(
      "as of 00:30",
    );
  });

  it("returns null for a missing or unparseable timestamp", () => {
    expect(formatStrainCaption(null)).toBeNull();
    expect(formatStrainCaption("not a date")).toBeNull();
  });

  it("pads to two digits so the caption does not jitter in width", () => {
    const now = new Date(2026, 8, 20, 18, 0, 0);
    const at = new Date(2026, 8, 20, 9, 5, 0);

    expect(formatStrainCaption(at.toISOString(), now)).toBe("as of 09:05");
  });
});
