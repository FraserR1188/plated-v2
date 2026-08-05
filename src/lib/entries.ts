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
import { EntryDraft, MealEntry, MealType } from "../types";
import { dateKey, localHM, sameTimeOnDay, TimeOfDay } from "./time";

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
    console.warn("applyEntries:", error.message);
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
