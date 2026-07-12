// ============================================================
// src/lib/time.ts — helpers for eaten_at handling
// ============================================================

// Format an ISO timestamp as "HH:MM" (24h, matches UK convention).
export function formatTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

// Combine a picked wall-clock time (hours/minutes) with today's date,
// rolling back a day when the picked time is meaningfully in the future.
//
// Rationale: the picker is time-only and defaults to "today". Someone
// logging at 00:30 who picks 23:45 almost certainly means last night,
// not tonight — so if the resulting timestamp is more than ROLLBACK_H
// hours ahead of now, subtract a day.
const ROLLBACK_H = 3;

export function resolveEatenAt(hours: number, minutes: number): string {
  const now = new Date();
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    0,
    0,
  );

  const aheadMs = candidate.getTime() - now.getTime();
  if (aheadMs > ROLLBACK_H * 3600 * 1000) {
    candidate.setDate(candidate.getDate() - 1);
  }

  return candidate.toISOString();
}

/**
 * The app's calendar day, in the user's LOCAL timezone.
 *
 * This exists because there were two of these and they disagreed.
 * `src/lib/social.ts` had:
 *
 *     new Date().toISOString().split("T")[0]     // ← UTC
 *
 * ...while `useStore.todayKey()` used local Y/M/D components. In BST (UTC+1),
 * at 00:30 local on the 12th, toISOString() still says the 11th. A meal copied
 * at 00:30 got date = the 11th; TodayScreen filters on the 12th; the meal
 * vanished. An hour a night in the UK, up to thirteen in Auckland.
 *
 * `meal_entries.date` is the app's day. `eaten_at` is the instant. The WHOOP
 * join uses eaten_at and does not care about this function — but the UI does,
 * and the two must not disagree about what day it is.
 */
export function dateKey(d: Date = new Date()): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}
