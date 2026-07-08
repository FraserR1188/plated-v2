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
