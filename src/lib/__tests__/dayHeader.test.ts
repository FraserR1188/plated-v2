import { describe, it, expect } from "vitest";
import { greetingForHour, dayHeaderInfo } from "../dayHeader";
import { dateKey, addDays } from "../time";

describe("greetingForHour", () => {
  it("is morning before noon", () => {
    expect(greetingForHour(0)).toBe("Good morning");
    expect(greetingForHour(11)).toBe("Good morning");
  });

  it("is afternoon from noon up to (not including) 17:00", () => {
    expect(greetingForHour(12)).toBe("Good afternoon");
    expect(greetingForHour(16)).toBe("Good afternoon");
  });

  it("is evening from 17:00 onward", () => {
    expect(greetingForHour(17)).toBe("Good evening");
    expect(greetingForHour(23)).toBe("Good evening");
  });
});

describe("dayHeaderInfo", () => {
  // Wednesday 29 July 2026, deliberately not a UTC-midnight-adjacent instant.
  const now = new Date(2026, 6, 29, 9, 30);
  const today = dateKey(now);

  it("reads Today with a morning greeting when selected is today", () => {
    const info = dayHeaderInfo(today, now);
    expect(info).toEqual({
      isToday: true,
      eyebrow: "Good morning",
      anchor: "Today",
    });
  });

  it("reads the weekday name, muted 'Viewing', for a past day", () => {
    const yesterday = addDays(today, -1); // Tue 28 Jul 2026
    const info = dayHeaderInfo(yesterday, now);
    expect(info).toEqual({
      isToday: false,
      eyebrow: "Viewing",
      anchor: "Tuesday",
    });
  });

  it("reads the weekday name, muted 'Viewing', for a future (planned) day", () => {
    const tomorrow = addDays(today, 1); // Thu 30 Jul 2026
    const info = dayHeaderInfo(tomorrow, now);
    expect(info).toEqual({
      isToday: false,
      eyebrow: "Viewing",
      anchor: "Thursday",
    });
  });

  it("re-evaluates against `now` rather than any cached value — crossing midnight flips it", () => {
    const justBeforeMidnight = new Date(2026, 6, 29, 23, 59);
    const justAfterMidnight = new Date(2026, 6, 30, 0, 1);
    const selected = dateKey(justBeforeMidnight); // "2026-07-29"

    expect(dayHeaderInfo(selected, justBeforeMidnight).isToday).toBe(true);
    expect(dayHeaderInfo(selected, justAfterMidnight).isToday).toBe(false);
    expect(dayHeaderInfo(selected, justAfterMidnight).anchor).toBe("Wednesday");
  });
});
