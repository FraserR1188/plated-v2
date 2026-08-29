// ============================================================
// src/lib/entries.ts — THE apply path
//
// Every bulk write into meal_entries goes through here. There are four
// callers and they differ in exactly one thing: where eaten_at (and, for the
// two copy builders, meal_type) comes from.
//
//   social copy      → now().                    "You are eating this NOW."
//   copy-a-day       → same wall clock, new day. "Monday's lunch, on Tuesday."
//   copy-to-a-slot   → one CHOSEN time and section, for every entry passed in.
//                                                 "Put this at Lunch, 13:30, Tuesday."
//   bundle apply     → the item's stored time.   "07:30 porridge, on Thursday."
//
// That's it. That is the whole of "bundles and copy are one feature with
// multiple sources" — four builders, one insert.
//
// A STRATEGY FLAG WAS THE OBVIOUS DESIGN AND IT IS WRONG. It would need four
// values today and a fifth the moment anything else copies a meal, and the
// social rule ("now") cannot even see a target day, so the flag would have to
// carry one optionally. Resolve in the caller; pass a finished row.
//
// draftsFromDay and draftsForTarget look similar and are NOT interchangeable:
// draftsFromDay preserves each row's OWN meal_type/time and moves only the
// day — the multi-select "copy this whole selection, keeping each item's
// slot" case. draftsForTarget forces every entry passed in onto ONE chosen
// {meal_type, time} — the single-item "put this at Lunch instead" case. Using
// the wrong one silently either merges a multi-select into one slot, or
// leaves a single copy stuck in its source section. Do not collapse them.
// ============================================================

import { supabase } from "./supabase";
import { DayTotals, EntryDraft, MealEntry, MealType } from "../types";
import { dateKey, localHM, sameTimeOnDay, TimeOfDay } from "./time";
import { reportError } from "./reportError";
// Store → lib/entries already runs the other way (applyEntries etc. are
// imported by useStore.ts), so this closes a cycle. Safe here because both
// bindings are only ever read inside a function body below (getDaySummary),
// never at module-evaluation time — by the time either runs, both modules
// have finished loading. Reused rather than reimplemented so this selector's
// eaten/pending split can never drift from the store's own definitions.
import { isEaten, isPending } from "../store/useStore";

/**
 * Insert a set of fully-resolved drafts into the current user's log.
 *
 * ─── THE THREE THINGS THIS FUNCTION OWNS ───
 *
 * 1. `date` is DERIVED HERE, from eaten_at, via local dateKey().
 *    EntryDraft has no date field, so a caller CANNOT hand us a divergent pair.
 *    That divergence shipped once (D2: late-night meals on the wrong day) and
 *    the only durable fix is to stop offering the two values separately.
 *
 * 2. `planned` is NEVER SENT. The BEFORE INSERT trigger derives it from
 *    eaten_at, on the DATABASE clock. This is why applying a bundle to Thursday
 *    produces planned meals with no flag, no argument, and no awareness of
 *    planning anywhere in the bundle code. Ditto confirmed_at / skipped_at.
 *
 * 3. It `.select()`s. The trigger's decision comes back in the RETURNING row,
 *    and the store appends THAT — not a guess. The old copyEntriesToMyLog
 *    didn't select, which was harmless only because a social copy always lands
 *    on now() and is therefore always planned = false. A bundle applied to
 *    Thursday is not, and a store that assumed false would put a plan straight
 *    into your correlation.
 *
 * Explicit snake_case, every column listed. Do NOT spread a draft in here:
 * spreads have silently no-opped new columns on this project before, and a
 * forgotten column becomes a silent null instead of a compile error.
 */
export async function applyEntries(drafts: EntryDraft[]): Promise<MealEntry[]> {
  if (drafts.length === 0) return [];

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const now = new Date().toISOString();

  const rows = drafts.map((d) => ({
    user_id: user.id,

    // When the ROW was created. Not when you ate. These are different questions
    // and meal_entries has a column for each.
    logged_at: now,

    // ⚠ DERIVED. Never taken from the caller — see (1) above.
    date: dateKey(new Date(d.eaten_at)),

    meal_type: d.meal_type,
    name: d.name,
    brand: d.brand,
    serving_g: d.serving_g,

    calories: d.calories,
    protein: d.protein,
    carbs: d.carbs,
    fat: d.fat,

    // Passed THROUGH, not coalesced. `?? 0` here would replace "we don't know
    // how much fibre this had" with the assertion "it had zero grams of fibre",
    // permanently, and then feed that into your goals and your correlation.
    // The old social copy path did exactly this. useStore.addEntry does not.
    sat_fat: d.sat_fat,
    salt: d.salt,
    fibre: d.fibre,
    sugar: d.sugar,

    source: d.source,
    barcode: d.barcode,
    off_id: d.off_id,

    eaten_at: d.eaten_at,
    eaten_at_estimated: d.eaten_at_estimated,

    image_url: d.image_url,
    image_path: d.image_path,
    custom_food_id: d.custom_food_id,

    // planned / confirmed_at / skipped_at: ABSENT BY DESIGN. See (2) above.
  }));

  const { data, error } = await supabase
    .from("meal_entries")
    .insert(rows)
    .select();

  if (error) {
    reportError("applyEntries", error, { level: "error" });
    throw error;
  }

  return (data ?? []) as MealEntry[];
}

/**
 * COPY-A-DAY. Take entries you can see on one day and put them on another.
 *
 * ─── ONE RULE: COPY WHAT YOU CAN SEE ───
 *
 * Logged, confirmed, and future-planned rows are all fair game. ESPECIALLY
 * future-planned — "Monday's lunch, also on Tuesday" is the single most
 * important gesture in this feature, and it is just a copy from one future day
 * to another.
 *
 * PENDING rows (past, unanswered) need no special case either. The copy is a
 * NEW row, and the trigger derives its `planned` from ITS OWN eaten_at.
 * Nothing about the source's unresolved state propagates. Skipped rows are
 * already hidden from the sections, so they're excluded for free.
 *
 * ─── WALL CLOCK, NOT ARITHMETIC ───
 *
 * sameTimeOnDay(), not `eaten_at + 24h`. Across a DST boundary the arithmetic
 * lands Monday's 12:30 lunch at 11:30 or 13:30 on Tuesday — twice a year, at
 * exactly the point where WHOOP cycles are already confusing, and nobody would
 * notice for months.
 *
 * ─── IMAGES AND PROVENANCE ARE KEPT ───
 *
 * Unlike the social copy, which drops image_path and custom_food_id. This is
 * YOUR food being copied within YOUR log: the private-bucket path is under your
 * folder and getSignedImageUrl() will sign it. See the comment in social.ts.
 */
export function draftsFromDay(
  entries: MealEntry[],
  targetDayKey: string,
): EntryDraft[] {
  return entries.map((e) => ({
    name: e.name,
    brand: e.brand ?? null,
    serving_g: e.serving_g,

    calories: e.calories,
    protein: e.protein,
    carbs: e.carbs,
    fat: e.fat,

    // `?? null` normalises undefined → null. It does NOT collapse null → 0.
    sat_fat: e.sat_fat ?? null,
    salt: e.salt ?? null,
    fibre: e.fibre ?? null,
    sugar: e.sugar ?? null,

    // The row's OWN section. Monday's lunch becomes Tuesday's LUNCH. There is
    // no targetMeal override — that's the social path's idea, and it cannot
    // express this.
    meal_type: e.meal_type,

    eaten_at: sameTimeOnDay(localHM(e.eaten_at), targetDayKey),

    // You have not eaten the copy. Whatever the source's timing certainty, the
    // copy's timing is a forecast. Fails safe.
    eaten_at_estimated: true,

    source: "copied",
    barcode: e.barcode ?? null,
    off_id: e.off_id ?? null,

    image_url: e.image_url ?? null,
    image_path: e.image_path ?? null,
    custom_food_id: e.custom_food_id ?? null,
  }));
}

/**
 * COPY-TO-A-SLOT. Take entries and put copies at one explicit
 * {day, meal_type, time} target — the single-item "Copy to…" sheet, not the
 * multi-select day picker above.
 *
 * ─── THE ONE DIFFERENCE FROM draftsFromDay ───
 *
 * draftsFromDay changes only the day; every row keeps ITS OWN meal_type and
 * wall clock — correct when copying a whole selection and preserving each
 * item's slot. This builder is the opposite: EVERY entry passed in lands on
 * the SAME chosen section and time, because choosing that target is the
 * entire point of this path. Required argument, not an optional override —
 * same reasoning as EntryDraft omitting a `date` field for applyEntries.
 *
 * ─── WALL CLOCK, NOT ARITHMETIC ───
 *
 * Same DST-safety as draftsFromDay: sameTimeOnDay() goes through the local
 * Date constructor, not `+24h`. Only the TimeOfDay fed to it differs — the
 * TARGET's time, not localHM(source.eaten_at).
 */
/**
 * Do every one of these entries already agree on a meal_type? Returns that
 * shared type, or null if they don't (or there's nothing to compare).
 *
 * This is the multi-select "Copy to…" sheet's smart default: three items
 * that are ALL breakfast open pre-set to merge into one slot ("all these to
 * lunch, one tap"); a mixed selection opens defaulted to keep-each-slot
 * instead, since there's no single section to preselect. A single entry
 * trivially "shares" its own meal_type with itself — the caller decides
 * whether to show the mode toggle at all (only when length > 1), not this
 * function.
 */
export function sharedMealType(entries: MealEntry[]): MealType | null {
  if (entries.length === 0) return null;
  const first = entries[0].meal_type;
  return entries.every((e) => e.meal_type === first) ? first : null;
}

export function draftsForTarget(
  entries: MealEntry[],
  target: { dayKey: string; meal_type: MealType; time: TimeOfDay },
): EntryDraft[] {
  return entries.map((e) => ({
    name: e.name,
    brand: e.brand ?? null,
    serving_g: e.serving_g,

    calories: e.calories,
    protein: e.protein,
    carbs: e.carbs,
    fat: e.fat,

    sat_fat: e.sat_fat ?? null,
    salt: e.salt ?? null,
    fibre: e.fibre ?? null,
    sugar: e.sugar ?? null,

    // The CHOSEN section, not the row's own — see the comment above.
    meal_type: target.meal_type,

    eaten_at: sameTimeOnDay(target.time, target.dayKey),

    // You have not eaten the copy. Fails safe.
    eaten_at_estimated: true,

    source: "copied",
    barcode: e.barcode ?? null,
    off_id: e.off_id ?? null,

    image_url: e.image_url ?? null,
    image_path: e.image_path ?? null,
    custom_food_id: e.custom_food_id ?? null,
  }));
}

// ============================================================
// D7 — getDaySummary: the one place a day total should be computed
//
// History's average card, Today's ring, Today's macro panel and the
// past-day view each grew their own answer to "what happened on this day",
// and disagreed (History counted skipped/pending rows the ring didn't).
// This is the shared selector: filter once, split once, hand back typed
// buckets. It does not decide what any screen DISPLAYS — only what the
// numbers ARE.
// ============================================================

/**
 * A day's macro sum, plus how many rows contributed.
 *
 * Deliberately NOT `DayTotals & { count: number }`. calories/protein/carbs/
 * fat are NOT NULL on MealEntry, so their sum is always a number — 0 for
 * zero rows is the truth, not a guess. satFat/salt/fibre/sugar are NULLABLE
 * per row (NULL = unknown, 0 = zero grams — see the NULLABILITY comment on
 * MealEntry in src/types/index.ts), so a bucket where every contributing row
 * is null for one of those must itself stay null: coalescing to 0 would
 * silently assert "definitely zero" where the truth is "we don't know".
 * DayTotals types all eight fields as plain `number` and can't express that.
 */
export type DayBucket = Omit<
  DayTotals,
  "satFat" | "salt" | "fibre" | "sugar"
> & {
  satFat: number | null;
  salt: number | null;
  fibre: number | null;
  sugar: number | null;
  count: number;
};

export interface DaySummary {
  /** Logged entries + confirmed planned entries. What actually went in you. */
  eaten: DayBucket;
  /** Planned, unconfirmed, unskipped. The intention, not yet acted on. */
  pending: DayBucket;
  /** Whether `date`'s calendar day has already ended, relative to `now`. */
  isSettled: boolean;
  /**
   * What should count toward the day's goal. A day still in progress counts
   * its pending plans too (CLAUDE.md: "Plans count toward daily goals").
   * Once the day is settled, an unconfirmed plan never happened — only
   * `eaten` counts, so this equals `eaten` exactly.
   */
  towardGoal: DayBucket;
}

/** Sums one bucket of rows. Null-per-row macros stay null until the first
 *  non-null contribution — a null row contributes nothing and does NOT, on
 *  its own, turn the running total into 0. See the DayBucket comment. */
function sumBucket(rows: MealEntry[]): DayBucket {
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let satFat: number | null = null;
  let salt: number | null = null;
  let fibre: number | null = null;
  let sugar: number | null = null;

  for (const e of rows) {
    calories += e.calories;
    protein += e.protein;
    carbs += e.carbs;
    fat += e.fat;
    if (e.sat_fat != null) satFat = (satFat ?? 0) + e.sat_fat;
    if (e.salt != null) salt = (salt ?? 0) + e.salt;
    if (e.fibre != null) fibre = (fibre ?? 0) + e.fibre;
    if (e.sugar != null) sugar = (sugar ?? 0) + e.sugar;
  }

  return {
    calories,
    protein,
    carbs,
    fat,
    satFat,
    salt,
    fibre,
    sugar,
    count: rows.length,
  };
}

/** Null-safe bucket addition: null + null stays null; either side non-null
 *  sums with the other coalesced to 0 — the same "a null contributes
 *  nothing" rule as sumBucket, applied across two already-summed buckets. */
function addBuckets(a: DayBucket, b: DayBucket): DayBucket {
  const addNullable = (x: number | null, y: number | null): number | null =>
    x == null && y == null ? null : (x ?? 0) + (y ?? 0);

  return {
    calories: a.calories + b.calories,
    protein: a.protein + b.protein,
    carbs: a.carbs + b.carbs,
    fat: a.fat + b.fat,
    satFat: addNullable(a.satFat, b.satFat),
    salt: addNullable(a.salt, b.salt),
    fibre: addNullable(a.fibre, b.fibre),
    sugar: addNullable(a.sugar, b.sugar),
    count: a.count + b.count,
  };
}

/**
 * The shared day-total selector. `now` is an explicit parameter — never
 * read from the clock in here — so callers control it and this stays
 * trivially testable across a midnight boundary.
 */
export function getDaySummary(
  entries: MealEntry[],
  date: string,
  now: Date,
): DaySummary {
  // Skipped rows are evidence a plan was abandoned, not activity — dropped
  // before the split so they land in neither bucket. useStore's isSkipped
  // isn't exported, so the equivalent check is inlined rather than adding a
  // second, competing definition of "skipped" here.
  const relevant = entries.filter((e) => e.date === date && !e.skipped_at);

  const eaten = sumBucket(relevant.filter(isEaten));
  const pending = sumBucket(relevant.filter(isPending));

  // LOCAL calendar-day comparison — never toISOString().split('T')[0]. See
  // dateKey()'s comment in lib/time.ts for the BST bug that rule prevents.
  const isSettled = dateKey(now) > date;

  const towardGoal = isSettled ? eaten : addBuckets(eaten, pending);

  return { eaten, pending, isSettled, towardGoal };
}
