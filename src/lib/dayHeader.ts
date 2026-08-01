// ============================================================
// src/lib/dayHeader.ts — pure logic behind the Today header's day identity
//
// Extracted out of TodayScreen so "is this today" and "what does the header
// say" can be unit tested without mounting a screen, and so the component
// can't accidentally freeze either at a stale value (see the `now` param —
// always pass a freshly-read Date, never one captured once at mount).
// ============================================================

import { dateKey, parseDateKey } from "./time";

/** "Good morning" / "Good afternoon" / "Good evening", by the 24h clock. */
export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export interface DayHeaderInfo {
  /** Whether `selected` is the LOCAL calendar day of `now`. */
  isToday: boolean;
  /** Small line above the anchor: a greeting on today, "Viewing" otherwise. */
  eyebrow: string;
  /** The bold headline: "Today" on today, the weekday name otherwise. */
  anchor: string;
}

/**
 * The Today header's day-identity copy, derived from `selected` (a
 * `dateKey()` string) against `now`. Always pass a live `now` — computing it
 * once and reusing it is how this drifts wrong across a midnight boundary.
 */
export function dayHeaderInfo(
  selected: string,
  now: Date = new Date(),
): DayHeaderInfo {
  const isToday = selected === dateKey(now);

  if (isToday) {
    return { isToday, eyebrow: greetingForHour(now.getHours()), anchor: "Today" };
  }

  const anchor = parseDateKey(selected).toLocaleDateString("en-GB", {
    weekday: "long",
  });
  return { isToday, eyebrow: "Viewing", anchor };
}
