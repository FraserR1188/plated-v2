import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dateKey,
  parseDateKey,
  addDays,
  resolveEatenAt,
  resolveEatenAtAndDate,
  sameTimeOnDay,
  willBePlanned,
  formatDayLabel,
  isFutureDay,
  PLANNING_GRACE_MINUTES,
} from "../time";

describe("dateKey / parseDateKey", () => {
  it("formats the LOCAL calendar day, not UTC", () => {
    // Local components, deliberately not a UTC-midnight-adjacent instant.
    const d = new Date(2026, 6, 27, 23, 45); // 27 Jul 2026, 23:45 local
    expect(dateKey(d)).toBe("2026-07-27");
  });

  it("pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5); // 5 Jan 2026
    expect(dateKey(d)).toBe("2026-01-05");
  });

  it("round-trips through parseDateKey to local midnight", () => {
    const key = "2026-07-27";
    const d = parseDateKey(key);
    expect(dateKey(d)).toBe(key);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});

describe("addDays", () => {
  it("shifts forward and backward across a month boundary", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
  });
});

describe("resolveEatenAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("GUESSES and rolls back a day when no explicit day is given and the time is >3h ahead", () => {
    // "Now" is 00:30 local. Picking 23:45 with no explicit day must mean LAST
    // night, not tonight.
    vi.setSystemTime(new Date(2026, 6, 27, 0, 30));

    const iso = resolveEatenAt(23, 45);
    const d = new Date(iso);

    expect(dateKey(d)).toBe("2026-07-26");
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(45);
  });

  it("does NOT roll back when the time is within the 3h grace window", () => {
    vi.setSystemTime(new Date(2026, 6, 27, 22, 0));

    const iso = resolveEatenAt(23, 45); // only 1h45 ahead
    expect(dateKey(new Date(iso))).toBe("2026-07-27");
  });

  it("does NOT roll back when an explicit day is given, even ~27h ahead", () => {
    // This is the planning case: tomorrow's 19:00 dinner, planned this
    // afternoon. Without the explicit-day escape hatch this would trip the
    // same rollback heuristic and silently land on TODAY at 19:00.
    vi.setSystemTime(new Date(2026, 6, 27, 16, 0));

    const tomorrow = parseDateKey(addDays(dateKey(), 1));
    const iso = resolveEatenAt(19, 0, tomorrow);

    expect(dateKey(new Date(iso))).toBe(addDays("2026-07-27", 1));
  });
});

describe("resolveEatenAtAndDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("always returns a date consistent with dateKey(eaten_at) — never a divergent pair", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 27, 12, 0));

    const day = parseDateKey("2026-07-30");
    const { eaten_at, date } = resolveEatenAtAndDate(9, 15, day);

    expect(date).toBe(dateKey(new Date(eaten_at)));
    expect(date).toBe("2026-07-30");
  });
});

describe("sameTimeOnDay", () => {
  it("rebuilds the same wall-clock hours/minutes on the requested day", () => {
    const iso = sameTimeOnDay({ hours: 12, minutes: 30 }, "2026-08-15");
    const d = new Date(iso);

    expect(dateKey(d)).toBe("2026-08-15");
    expect(d.getHours()).toBe(12);
    expect(d.getMinutes()).toBe(30);
  });

  it("does not roll back even when the target day is far in the future", () => {
    // sameTimeOnDay always passes an explicit day through to resolveEatenAt,
    // so the rollback heuristic must never fire here.
    const farFuture = addDays(dateKey(), 30);
    const iso = sameTimeOnDay({ hours: 7, minutes: 30 }, farFuture);
    expect(dateKey(new Date(iso))).toBe(farFuture);
  });
});

describe("willBePlanned", () => {
  it("is false for a time in the past", () => {
    const now = new Date(2026, 6, 27, 12, 0);
    const past = new Date(2026, 6, 27, 11, 0).toISOString();
    expect(willBePlanned(past, now)).toBe(false);
  });

  it("is false for a time inside the grace window", () => {
    const now = new Date(2026, 6, 27, 12, 0);
    const soon = new Date(
      now.getTime() + (PLANNING_GRACE_MINUTES - 1) * 60 * 1000,
    ).toISOString();
    expect(willBePlanned(soon, now)).toBe(false);
  });

  it("is true just beyond the grace window", () => {
    const now = new Date(2026, 6, 27, 12, 0);
    const later = new Date(
      now.getTime() + (PLANNING_GRACE_MINUTES + 1) * 60 * 1000,
    ).toISOString();
    expect(willBePlanned(later, now)).toBe(true);
  });
});

describe("formatDayLabel", () => {
  it("labels today, tomorrow and yesterday specially", () => {
    const now = new Date(2026, 6, 27);
    expect(formatDayLabel(dateKey(now), now)).toBe("Today");
    expect(formatDayLabel(addDays(dateKey(now), 1), now)).toBe("Tomorrow");
    expect(formatDayLabel(addDays(dateKey(now), -1), now)).toBe("Yesterday");
  });
});

describe("isFutureDay", () => {
  it("compares calendar days, not instants", () => {
    const now = new Date(2026, 6, 27, 23, 59);
    expect(isFutureDay(addDays(dateKey(now), 1), now)).toBe(true);
    expect(isFutureDay(dateKey(now), now)).toBe(false);
    expect(isFutureDay(addDays(dateKey(now), -1), now)).toBe(false);
  });
});
