// ============================================================
// src/lib/time.ts — the app's one source of truth about "when"
//
// Two different questions live in here and must not be confused:
//
//   eaten_at  — an INSTANT. What the WHOOP correlation joins on, by UTC
//               interval containment. Timezone-correct by construction.
//   date      — the app's CALENDAR DAY, LOCAL. What TodayScreen filters on.
//               Never derived in SQL: Postgres does not know what timezone
//               the phone is in.
//
// `date` must always be dateKey(new Date(eaten_at)). Deriving it any other
// way is how D2 put late-night meals on the wrong day.
// ============================================================

/** Format an ISO timestamp as "HH:MM" (24h, matches UK convention). */
export function formatTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
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
 * There is exactly one of these. Keep it that way.
 */
export function dateKey(d: Date = new Date()): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The inverse of dateKey: "2026-07-14" → local midnight on the 14th.
 *
 * DO NOT use `new Date("2026-07-14")`. A bare date string is parsed as UTC
 * midnight, so west of Greenwich it lands on the 13th and the whole date
 * navigation slides a day. This is the same class of bug as the one above,
 * approached from the opposite direction — and now that the app can walk
 * backwards and forwards through dates, it has somewhere to bite.
 */
export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Shift a date key by n days, staying in local time. Use for ‹ › navigation. */
export function addDays(key: string, n: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/**
 * How far ahead a meal can be before it stops being "I'm about to eat this"
 * and starts being a plan.
 *
 * ⚠ ADVISORY ONLY. The DATABASE decides. `meal_entries_derive_planned()` owns
 * this rule, using the database clock, so a skewed phone clock cannot mislabel
 * a meal and no insert path can forget it. This constant exists purely so the
 * UI can PREVIEW the decision ("this will be saved as planned") before the row
 * comes back. If you change one, change both — and if they ever disagree,
 * the database is right.
 */
export const PLANNING_GRACE_MINUTES = 30;

/** Preview of what the DB trigger will decide. Never persist this. */
export function willBePlanned(
  eatenAtIso: string,
  now: Date = new Date(),
): boolean {
  return (
    new Date(eatenAtIso).getTime() >
    now.getTime() + PLANNING_GRACE_MINUTES * 60 * 1000
  );
}

/**
 * A time-only picker has to guess which day you meant. Someone logging at 00:30
 * who picks 23:45 means LAST night, not tonight — so a candidate more than
 * ROLLBACK_H hours ahead of now gets rolled back a day.
 *
 * The heuristic is right, and it is also lethal to planning: tomorrow's 19:00
 * dinner is ~27 hours ahead, which trips the rollback and silently returns
 * TODAY at 19:00. The feature would look broken with nothing visible to blame.
 *
 * So the rule is: GUESS ONLY WHEN NOT TOLD. Pass `day` and the heuristic is
 * off — an explicit date is not a guess to be second-guessed. Omit `day` and
 * the old behaviour is preserved exactly, which is what every existing caller
 * relies on.
 */
const ROLLBACK_H = 3;

export function resolveEatenAt(
  hours: number,
  minutes: number,
  /** The day the user explicitly chose. Omit to mean "today, and guess". */
  day?: Date,
): string {
  const now = new Date();
  const base = day ?? now;

  const candidate = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hours,
    minutes,
    0,
    0,
  );

  // Only guess when we weren't told.
  if (!day) {
    const aheadMs = candidate.getTime() - now.getTime();
    if (aheadMs > ROLLBACK_H * 3600 * 1000) {
      candidate.setDate(candidate.getDate() - 1);
    }
  }

  return candidate.toISOString();
}

/**
 * The single call every insert path should make. Returns the pair, already
 * consistent — `date` is derived FROM the resolved instant, never picked
 * alongside it. That divergence is the D2 bug, and the only way to make it
 * unreachable is to stop offering the two values separately.
 */
export function resolveEatenAtAndDate(
  hours: number,
  minutes: number,
  day?: Date,
): { eaten_at: string; date: string } {
  const eaten_at = resolveEatenAt(hours, minutes, day);
  return { eaten_at, date: dateKey(new Date(eaten_at)) };
}

/** "Today" / "Tomorrow" / "Yesterday" / "Sat 18 Jul" — for the date header. */
export function formatDayLabel(key: string, now: Date = new Date()): string {
  const today = dateKey(now);
  if (key === today) return "Today";
  if (key === addDays(today, 1)) return "Tomorrow";
  if (key === addDays(today, -1)) return "Yesterday";

  const d = parseDateKey(key);
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** True when the key is a calendar day after today. Purely for UI copy. */
export function isFutureDay(key: string, now: Date = new Date()): boolean {
  return key > dateKey(now); // YYYY-MM-DD sorts chronologically as a string
}
