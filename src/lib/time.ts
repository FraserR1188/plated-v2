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
//
// D4 adds a THIRD question, and it is genuinely different from both:
//
//   eaten_time — a LOCAL WALL CLOCK, with no day attached. "07:30".
//                What a bundle item stores. It is not an instant and it is
//                not a day; it is the thing you rebuild an instant FROM,
//                once you know which day you're rebuilding it on.
//
// That third type is what makes bundles DST-correct for free. See the
// comment on sameTimeOnDay() below — it's the whole reason bundles are safe.
// ============================================================

import { MealType } from "../types";

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
 *
 * As of migration 5 there is a THIRD copy of this rule, in
 * meal_entries_no_future_logged(). Change all three or none.
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
 *
 * D4 NOTE: applyEntries() derives `date` from `eaten_at` again, internally,
 * and EntryDraft has no `date` field at all. That is not redundancy. This
 * function protects the CALLER from producing a bad pair; EntryDraft protects
 * the TABLE from ever receiving one, no matter who writes the next builder.
 * Callers take `eaten_at` from the pair and discard `date`.
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

// ============================================================
// D4 — wall-clock time, detached from any day
// ============================================================

/**
 * Where a meal sits in a day when nobody has said otherwise.
 *
 * MOVED HERE FROM ProductScreen, which is the only reason this comment is
 * long: it now has two callers with different needs, and it is a policy about
 * TIME, not about a screen.
 *
 *   ProductScreen — planning Thursday's dinner on Sunday, "now" is nonsense.
 *                   It would file it at 16:43 because that's when you opened
 *                   the app. A meal has a shape; start from it.
 *
 *   Bundles       — an item saved from an entry inherits that entry's real
 *                   time. This is the fallback for an item that somehow has
 *                   none, and the seed for any future "build a bundle from
 *                   scratch" path.
 *
 * These must not drift apart. One definition.
 */
export const DEFAULT_HOUR: Record<MealType, number> = {
  breakfast: 8,
  lunch: 13,
  dinner: 19,
  snacks: 15,
};

/** A local wall clock with no day attached. What meal_composition_items.eaten_time is. */
export interface TimeOfDay {
  hours: number;
  minutes: number;
}

/**
 * The LOCAL wall clock of an instant. The inverse of resolveEatenAt's inputs.
 *
 * Note getHours(), not getUTCHours(). A meal eaten at 12:30 BST is 11:30Z, and
 * copying it to Tuesday must produce 12:30 on Tuesday — the number the user saw,
 * not the number the server stored.
 */
export function localHM(iso: string): TimeOfDay {
  const d = new Date(iso);
  return { hours: d.getHours(), minutes: d.getMinutes() };
}

/**
 * The LOCAL wall-clock minute-of-day of an instant — the sort key behind
 * "which of these entries has the earliest time?" comparisons that need to
 * keep hold of the winning ENTRY (not just its TimeOfDay, which is what
 * earliestTimeOfDay above already covers). One definition, so a multi-select
 * merge's default time and any future "earliest of these instants" caller
 * can't quietly compute it two different ways.
 */
export function minutesSinceLocalMidnight(iso: string): number {
  const { hours, minutes } = localHM(iso);
  return hours * 60 + minutes;
}

/**
 * The inverse of DEFAULT_HOUR: given a real time, which section does it
 * belong in by default?
 *
 *   00:00–12:00  Breakfast   (noon exactly is Breakfast, not Lunch)
 *   12:01–17:00  Lunch
 *   17:01–23:59  Dinner
 *
 * NEVER returns Snacks — there is no time-of-day signal for "this was a
 * snack", and guessing one would be a worse default than not defaulting at
 * all. Snacks is only ever set manually.
 *
 * ⚠ A DEFAULT AT CREATION, NOT A RE-DERIVATION. This is called ONLY at the
 * moment a NEW meal_entries row is about to be created and no section was
 * otherwise chosen for it. It must never run on an existing row's update path
 * (retimeEntries, ProductScreen's edit flow) — moving an already-logged
 * meal's time must not silently relabel its section, and a manually-chosen
 * section (including Snacks) must never be overridden by this. There is
 * exactly one call site that matters: a creation path with no explicit
 * section falls through to this; a path WITH one never calls it at all.
 */
export function sectionForTime(eatenAtIso: string): MealType {
  const { hours, minutes } = localHM(eatenAtIso);
  const m = hours * 60 + minutes;
  if (m <= 12 * 60) return "breakfast";
  if (m <= 17 * 60) return "lunch";
  return "dinner";
}

/**
 * Postgres `time` → TimeOfDay.
 *
 * PostgREST hands back "07:30:00", not "07:30". Seconds are discarded: a bundle
 * item is a prediction, and a prediction accurate to the second is a lie about
 * its own precision.
 */
export function parseTimeOfDay(t: string): TimeOfDay {
  const [h, m] = t.split(":").map(Number);
  return { hours: h ?? 0, minutes: m ?? 0 };
}

/** TimeOfDay → Postgres `time`. "07:30" is accepted by a `time` column. */
export function formatTimeOfDay({ hours, minutes }: TimeOfDay): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Rebuild an instant: this wall-clock time, on that day.
 *
 * ⚠ THIS IS WHY BUNDLES AND COPY-A-DAY ARE DST-SAFE, so don't "simplify" it
 * into arithmetic.
 *
 * The obvious implementation of copy-a-day is `new Date(eaten_at + 24h)`. It is
 * wrong twice a year: across a clock change, Monday's 12:30 lunch lands at 11:30
 * or 13:30 on Tuesday. Nobody would notice for months, and the meals would sit
 * in the wrong WHOOP cycle at exactly the boundary where cycles are already
 * confusing.
 *
 * Going through the local Date constructor — which is what resolveEatenAt does —
 * asks the platform "what instant is 12:30 local on this date?", and the platform
 * knows about DST. So the time survives the day change, which is what the user
 * meant.
 *
 * The explicit `day` also switches OFF resolveEatenAt's roll-back heuristic,
 * which is essential: tomorrow's 19:00 is ~27h ahead and would otherwise be
 * rolled straight back into today.
 *
 * Both D4 sources reduce to this call. They differ only in where the TimeOfDay
 * comes from — an entry's eaten_at, or a bundle item's eaten_time.
 */
export function sameTimeOnDay(t: TimeOfDay, dayKey: string): string {
  return resolveEatenAt(t.hours, t.minutes, parseDateKey(dayKey));
}

// ============================================================
// My Library — recency label for saved_ingredients_scored.last_used_at
// ============================================================

/**
 * "Used today" / "Used 3d ago" / "Not logged yet" — the My Library badge.
 *
 * Deliberately an ELAPSED-TIME formatter, not a calendar-day one: last_used_at
 * is a timestamptz instant (meal_entries.eaten_at), and the library's sort key
 * (decay_score, see 20260815100000_saved_ingredients_decay_score.sql) is
 * itself a continuous decay over elapsed time, not calendar-day buckets. A
 * dateKey()-based "Today"/"Yesterday" label would quantise at local-midnight
 * boundaries the sort doesn't recognise, so this counts hours/days directly
 * from the instant instead — same reasoning as the SQL side, applied here.
 */
export function formatLastUsed(
  iso: string | null,
  now: Date = new Date(),
): string {
  if (!iso) return "Not logged yet";
  const hours = (now.getTime() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 24) return "Used today";
  const days = Math.floor(hours / 24);
  if (days === 1) return "Used yesterday";
  if (days < 7) return `Used ${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `Used ${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `Used ${months}mo ago`;
}

// ============================================================
// Bundle-apply anchor — re-time a whole bundle at once, preserving spacing
// ============================================================

/**
 * The earliest of a set of wall-clock times, or null for an empty set.
 *
 * Used to seed the apply-time picker with "the bundle's usual start time",
 * so applying at the usual time is one confirmation, not a full time entry.
 */
export function earliestTimeOfDay(times: TimeOfDay[]): TimeOfDay | null {
  if (times.length === 0) return null;
  const toMinutes = (t: TimeOfDay) => t.hours * 60 + t.minutes;
  return times.reduce((min, t) => (toMinutes(t) < toMinutes(min) ? t : min));
}

/**
 * Shift every time by the same offset from the EARLIEST one, so the earliest
 * lands on `anchor` and the rest keep their spacing relative to it.
 *
 * [08:00, 08:05, 08:20] anchored at 07:00 → [07:00, 07:05, 07:20]. Offsets are
 * computed as whole minutes-of-day (hours*60+minutes) — never a Date, never
 * milliseconds. There is nothing here for DST to get wrong, because nothing
 * here touches a calendar day at all; that only happens later, when the
 * caller resolves each shifted time via sameTimeOnDay() onto an explicit
 * target day (which is also where resolveEatenAt's roll-back heuristic gets
 * bypassed, automatically, by that call already passing a day).
 *
 * ⚠ WRAPS AT 24H, ON PURPOSE, RATHER THAN ROLLING INTO A NEW DAY.
 *
 * This function has no day to roll into — it only ever returns an
 * {hours, minutes} in [0, 1440) minutes. If shifting pushes a time past
 * midnight, it wraps around to early the SAME day rather than "spilling"
 * onto a next-day date the caller never asked for. This is a deliberate
 * design decision, not an accident of the modulo: every item in a bundle is
 * pinned to the SAME explicit target day by draftsFromComposition, and a
 * midnight-crossing bundle (e.g. a very late anchor pushing a late item past
 * 24:00) is not preserved across that boundary. It lands early on the same
 * target day instead. Bundles are a same-day feature; if that stops being
 * true, this is the function that needs to change, not the caller working
 * around it.
 */
export function anchorTimesOfDay(
  times: TimeOfDay[],
  anchor: TimeOfDay,
): TimeOfDay[] {
  if (times.length === 0) return [];

  const toMinutes = (t: TimeOfDay) => t.hours * 60 + t.minutes;
  const earliest = Math.min(...times.map(toMinutes));
  const anchorMinutes = toMinutes(anchor);

  return times.map((t) => {
    const offset = toMinutes(t) - earliest;
    const shifted = (((anchorMinutes + offset) % 1440) + 1440) % 1440;
    return { hours: Math.floor(shifted / 60), minutes: shifted % 60 };
  });
}
