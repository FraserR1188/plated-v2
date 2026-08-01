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
  earliestTimeOfDay,
  anchorTimesOfDay,
  sectionForTime,
} from "../time";
import type { MealType } from "../../types";

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

  // ─── The D2 bug class: UTC-vs-local at a BST midnight boundary ───────────
  //
  // The bug this file's header comment documents (`new Date().toISOString()
  // .split("T")[0]` — UTC — vs dateKey() — local) is invisible on a machine
  // whose local timezone happens to equal UTC, because both approaches agree
  // there. It only diverges under a POSITIVE UTC offset, at a moment shortly
  // after local midnight. So this suite pins TZ=Europe/London (BST, UTC+1 in
  // July) for the duration of these two tests — not because the app assumes
  // that timezone, but because it's the one place these two approaches can be
  // proven to disagree, which is the entire point of dateKey existing.
  describe("at a BST midnight boundary (UTC+1)", () => {
    const originalTZ = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = "Europe/London";
    });
    afterEach(() => {
      process.env.TZ = originalTZ;
    });

    it("dateKey reports the correct LOCAL day just after midnight", () => {
      // 00:30 local on the 27th, which is 23:30 UTC on the 26th.
      const d = new Date(2026, 6, 27, 0, 30);
      expect(dateKey(d)).toBe("2026-07-27");
    });

    it("documents why the naive toISOString().split UTC approach is wrong here", () => {
      // Same instant as above. This is the exact shape of the bug fixed in
      // ConnectedUserLogScreen.tsx (was a local `todayKey` shadow using this
      // pattern) and FriendsScreen.tsx (same shadow, not yet fixed) — proof
      // that the naive approach lands on the WRONG (previous) calendar day
      // at exactly the boundary dateKey exists to get right.
      const d = new Date(2026, 6, 27, 0, 30);
      const naive = d.toISOString().split("T")[0];
      expect(naive).toBe("2026-07-26"); // wrong — a day behind
      expect(dateKey(d)).toBe("2026-07-27"); // correct
      expect(naive).not.toBe(dateKey(d));
    });
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

describe("earliestTimeOfDay", () => {
  it("returns null for an empty set", () => {
    expect(earliestTimeOfDay([])).toBeNull();
  });

  it("finds the earliest of several times, regardless of input order", () => {
    const times = [
      { hours: 8, minutes: 5 },
      { hours: 8, minutes: 0 },
      { hours: 8, minutes: 20 },
    ];
    expect(earliestTimeOfDay(times)).toEqual({ hours: 8, minutes: 0 });
  });
});

describe("anchorTimesOfDay", () => {
  it("shifts every time by the same offset from the earliest one", () => {
    const times = [
      { hours: 8, minutes: 0 },
      { hours: 8, minutes: 5 },
      { hours: 8, minutes: 20 },
    ];
    const shifted = anchorTimesOfDay(times, { hours: 7, minutes: 0 });
    expect(shifted).toEqual([
      { hours: 7, minutes: 0 },
      { hours: 7, minutes: 5 },
      { hours: 7, minutes: 20 },
    ]);
  });

  it("preserves offsets when the anchor is LATER than the saved earliest time", () => {
    const times = [
      { hours: 8, minutes: 0 },
      { hours: 8, minutes: 30 },
    ];
    const shifted = anchorTimesOfDay(times, { hours: 9, minutes: 15 });
    expect(shifted).toEqual([
      { hours: 9, minutes: 15 },
      { hours: 9, minutes: 45 },
    ]);
  });

  it("picking the saved earliest time as the anchor is a no-op", () => {
    const times = [
      { hours: 8, minutes: 0 },
      { hours: 8, minutes: 5 },
    ];
    expect(anchorTimesOfDay(times, { hours: 8, minutes: 0 })).toEqual(times);
  });

  // ⚠ INTENDED BEHAVIOUR, not "whatever the modulo produces": a
  // midnight-crossing bundle is NOT preserved across the day boundary. An
  // item that would shift past 24:00 wraps around to early the SAME target
  // day instead of spilling onto a next-day date nobody asked for. Bundles
  // are a same-day feature — see the comment on anchorTimesOfDay in time.ts.
  it("wraps an over-midnight shift to early the same day, by design", () => {
    // Saved 20:00 / 23:50 (offsets 0 / 230 minutes). Anchored at 23:00:
    // 23:00 + 0   = 23:00
    // 23:00 + 230 = 26:50 → wraps to 02:50
    const times = [
      { hours: 20, minutes: 0 },
      { hours: 23, minutes: 50 },
    ];
    const shifted = anchorTimesOfDay(times, { hours: 23, minutes: 0 });
    expect(shifted).toEqual([
      { hours: 23, minutes: 0 },
      { hours: 2, minutes: 50 },
    ]);
  });

  it("returns an empty array for an empty set", () => {
    expect(anchorTimesOfDay([], { hours: 7, minutes: 0 })).toEqual([]);
  });
});

describe("anchored bundle apply stays on the explicit target day (roll-back bypass)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not roll back even when the naive (no-day) heuristic would", () => {
    // "Now" is 00:10 — exactly the window where the naive/no-day heuristic
    // rolls an early-morning pick back a day (it's >3h "ahead" of a
    // just-past-midnight now). Prove the trap is real first...
    vi.setSystemTime(new Date(2026, 6, 27, 0, 10));
    const naive = resolveEatenAt(7, 0);
    expect(dateKey(new Date(naive))).toBe("2026-07-26"); // wrongly rolled back

    // ...then prove the anchored-bundle path — which always resolves through
    // sameTimeOnDay with the sheet's EXPLICIT target day — does not fall into
    // it. Bundle saved at 07:00 / 07:05 / 07:20; applied with the picker's
    // default (the saved earliest time), to today.
    const itemTimes = [
      { hours: 7, minutes: 0 },
      { hours: 7, minutes: 5 },
      { hours: 7, minutes: 20 },
    ];
    const anchor = { hours: 7, minutes: 0 };
    const shifted = anchorTimesOfDay(itemTimes, anchor);

    const targetDayKey = "2026-07-27"; // the sheet's explicit day — today
    const isos = shifted.map((t) => sameTimeOnDay(t, targetDayKey));

    isos.forEach((iso, i) => {
      const d = new Date(iso);
      expect(dateKey(d)).toBe(targetDayKey); // correct day, NOT rolled back
      expect(d.getHours()).toBe(itemTimes[i].hours);
      expect(d.getMinutes()).toBe(itemTimes[i].minutes);
    });
  });

  it("preserves offsets AND bypasses roll-back when the anchor differs from the saved time", () => {
    vi.setSystemTime(new Date(2026, 6, 27, 0, 10));

    const itemTimes = [
      { hours: 8, minutes: 0 },
      { hours: 8, minutes: 5 },
      { hours: 8, minutes: 20 },
    ];
    const anchor = { hours: 7, minutes: 0 }; // picked earlier than saved
    const shifted = anchorTimesOfDay(itemTimes, anchor);

    const targetDayKey = "2026-07-27";
    const isos = shifted.map((t) => sameTimeOnDay(t, targetDayKey));
    const expected = [
      { hours: 7, minutes: 0 },
      { hours: 7, minutes: 5 },
      { hours: 7, minutes: 20 },
    ];

    isos.forEach((iso, i) => {
      const d = new Date(iso);
      expect(dateKey(d)).toBe(targetDayKey);
      expect(d.getHours()).toBe(expected[i].hours);
      expect(d.getMinutes()).toBe(expected[i].minutes);
    });
  });
});

describe("sectionForTime", () => {
  // Fixed local day; only hours/minutes vary between cases.
  const at = (hours: number, minutes: number): string =>
    new Date(2026, 6, 27, hours, minutes).toISOString();

  it.each<[string, number, number, MealType]>([
    ["00:00 → breakfast", 0, 0, "breakfast"],
    ["12:00 exactly → breakfast (explicit noon rule)", 12, 0, "breakfast"],
    ["12:01 → lunch", 12, 1, "lunch"],
    ["17:00 → lunch", 17, 0, "lunch"],
    ["17:01 → dinner", 17, 1, "dinner"],
    ["23:59 → dinner", 23, 59, "dinner"],
  ])("%s", (_label, hours, minutes, expected) => {
    expect(sectionForTime(at(hours, minutes))).toBe(expected);
  });

  it("never returns snacks, across the full range of the day", () => {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        expect(sectionForTime(at(h, m))).not.toBe("snacks");
      }
    }
  });
});
