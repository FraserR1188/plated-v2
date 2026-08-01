// ============================================================
// src/lib/compositions.ts — saved groups of foods
//
// Renamed from bundles.ts by the Batches feature's migration 1 (rename only —
// see supabase/migrations/20260801100000_rename_meal_bundles_to_compositions.sql).
// Everything below is still exactly the BUNDLE behaviour it was before the
// rename: every composition today is a bundle (kind doesn't exist yet), a
// NAMED SET OF SNAPSHOTS with per-item times. Apply it to a day and you get
// real meal_entries at those times on that day.
//
// It composes with planning FOR FREE, and it is worth understanding why before
// you touch anything here: meal_entries.planned is derived by a BEFORE INSERT
// trigger from eaten_at, using the DATABASE clock. So applying a bundle to
// Thursday produces PLANNED meals with no flag, no argument, and not one line
// of planning-awareness in this file. Applying the same bundle to this morning
// produces LOGGED meals. There is no `planned` parameter anywhere below, and if
// you find yourself wanting one, you have misunderstood the trigger.
// ============================================================

import { supabase } from "./supabase";
import {
  EntryDraft,
  MealComposition,
  MealCompositionItem,
  MealCompositionItemDraft,
  MealCompositionWithItems,
  MealEntry,
} from "../types";
import {
  anchorTimesOfDay,
  formatTimeOfDay,
  localHM,
  parseTimeOfDay,
  sameTimeOnDay,
  sectionForTime,
  TimeOfDay,
  willBePlanned,
} from "./time";
import { applyEntries } from "./entries";

// ─── Reads ───────────────────────────────────────────────────

/**
 * Every composition, with its items, in the order you'd want to see them.
 *
 * ORDERING: last_used_at first, THEN use_count. use_count alone ossifies —
 * whatever you used most in January sits at the top until the heat death of the
 * app. Recency is what actually earns the top slot.
 *
 * Items come back sorted by position CLIENT-SIDE. PostgREST can order an
 * embedded table, but the syntax has changed between supabase-js versions
 * (foreignTable → referencedTable) and a silent ordering regression here would
 * shuffle your porridge and your coffee. Sorting an array of four items costs
 * nothing.
 */
export async function getCompositions(): Promise<MealCompositionWithItems[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("meal_compositions")
    .select("*, items:meal_composition_items(*)")
    .eq("user_id", user.id)
    .order("last_used_at", { ascending: false, nullsFirst: false })
    .order("use_count", { ascending: false });

  if (error) {
    console.warn("getCompositions:", error.message);
    throw error;
  }

  return ((data ?? []) as MealCompositionWithItems[]).map((c) => ({
    ...c,
    items: [...(c.items ?? [])].sort((a, z) => a.position - z.position),
  }));
}

// ─── Snapshotting an entry into an item ──────────────────────

/**
 * MealEntry → MealCompositionItemDraft. A DIRECT copy.
 *
 * ⚠ DO NOT ROUTE THIS THROUGH FoodProduct.
 *
 * foodLookup.mealEntryToProduct() reconstructs per-100g values from a
 * per-serving snapshot, with Math.round() and toFixed(). It is lossy: a 250g
 * entry at 437 kcal comes back as 175 kcal/100g and multiplies out to 437.5.
 * Round-tripping a bundle through it would erode the numbers a little more on
 * every save-and-apply cycle, invisibly.
 *
 * meal_entries is a snapshot table. meal_composition_items is a snapshot table.
 * Snapshot to snapshot is a straight copy. Keep it that way.
 */
function itemFromEntry(e: MealEntry, position: number): MealCompositionItemDraft {
  return {
    position,

    name: e.name,
    brand: e.brand ?? null,
    serving_g: e.serving_g,

    calories: e.calories,
    protein: e.protein,
    carbs: e.carbs,
    fat: e.fat,

    // `?? null` normalises undefined → null. It does NOT collapse null → 0.
    // NULL means "we don't know how much fibre this had". 0 means "none".
    sat_fat: e.sat_fat ?? null,
    salt: e.salt ?? null,
    fibre: e.fibre ?? null,
    sugar: e.sugar ?? null,

    meal_type: e.meal_type,

    // The item keeps a LOCAL WALL CLOCK, not an instant. "My breakfast" is
    // 07:30 porridge and 08:15 coffee, and applying it to Thursday must produce
    // those times on Thursday — not those times shifted by whatever the clock
    // did in between. See src/lib/time.ts.
    eaten_time: formatTimeOfDay(localHM(e.eaten_at)),

    barcode: e.barcode ?? null,
    off_id: e.off_id ?? null,

    // KEPT, unlike the social copy path. This is your own food: the private
    // bucket path is under your folder and getSignedImageUrl() will sign it.
    image_url: e.image_url ?? null,
    image_path: e.image_path ?? null,
    custom_food_id: e.custom_food_id ?? null,
  };
}

// ─── Writes ──────────────────────────────────────────────────

/**
 * "Save these 4 as a bundle."
 *
 * Two round-trips, not one: the items need a composition_id, which doesn't
 * exist until the composition does. Same shape as the custom-food image upload.
 *
 * If the items insert fails, the empty composition is deleted rather than left
 * behind. A composition with no items is not a thing the UI can do anything
 * with, and RLS lets us clean up our own mess.
 */
export async function createBundleFromEntries(
  name: string,
  entries: MealEntry[],
): Promise<MealCompositionWithItems> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmed = name.trim();
  if (!trimmed) throw new Error("A bundle needs a name.");
  if (entries.length === 0)
    throw new Error("A bundle needs at least one item.");

  const { data: composition, error: compositionErr } = await supabase
    .from("meal_compositions")
    .insert({ user_id: user.id, name: trimmed })
    .select()
    .single();

  if (compositionErr || !composition) {
    console.warn("createBundleFromEntries (composition):", compositionErr?.message);
    throw compositionErr ?? new Error("Couldn't save the bundle.");
  }

  const items = entries.map((e, i) => itemFromEntry(e, i));

  // Explicit snake_case. The drafts are already snake_case throughout, but they
  // are spread here into a row that also carries composition_id and user_id —
  // and a spread of a snake_case object is safe precisely because there is no
  // camel to lose. Do not "improve" itemFromEntry into camelCase.
  const { data: saved, error: itemsErr } = await supabase
    .from("meal_composition_items")
    .insert(
      items.map((it) => ({
        composition_id: (composition as MealComposition).id,
        user_id: user.id,
        position: it.position,
        name: it.name,
        brand: it.brand,
        serving_g: it.serving_g,
        calories: it.calories,
        protein: it.protein,
        carbs: it.carbs,
        fat: it.fat,
        sat_fat: it.sat_fat,
        salt: it.salt,
        fibre: it.fibre,
        sugar: it.sugar,
        meal_type: it.meal_type,
        eaten_time: it.eaten_time,
        barcode: it.barcode,
        off_id: it.off_id,
        image_url: it.image_url,
        image_path: it.image_path,
        custom_food_id: it.custom_food_id,
      })),
    )
    .select();

  if (itemsErr) {
    console.warn("createBundleFromEntries (items):", itemsErr.message);
    // Don't strand an empty composition in the user's list.
    await supabase
      .from("meal_compositions")
      .delete()
      .eq("id", (composition as MealComposition).id);
    throw itemsErr;
  }

  return {
    ...(composition as MealComposition),
    items: ((saved ?? []) as MealCompositionItem[]).sort(
      (a, z) => a.position - z.position,
    ),
  };
}

/**
 * "Add these to an existing bundle." This is what makes a dedicated bundle
 * EDITOR unnecessary: adding is done from a day, where the food already is.
 */
export async function appendEntriesToBundle(
  composition: MealCompositionWithItems,
  entries: MealEntry[],
): Promise<MealCompositionItem[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  if (entries.length === 0) return [];

  const start =
    composition.items.length === 0
      ? 0
      : Math.max(...composition.items.map((i) => i.position)) + 1;

  const items = entries.map((e, i) => itemFromEntry(e, start + i));

  const { data, error } = await supabase
    .from("meal_composition_items")
    .insert(
      items.map((it) => ({
        composition_id: composition.id,
        user_id: user.id,
        position: it.position,
        name: it.name,
        brand: it.brand,
        serving_g: it.serving_g,
        calories: it.calories,
        protein: it.protein,
        carbs: it.carbs,
        fat: it.fat,
        sat_fat: it.sat_fat,
        salt: it.salt,
        fibre: it.fibre,
        sugar: it.sugar,
        meal_type: it.meal_type,
        eaten_time: it.eaten_time,
        barcode: it.barcode,
        off_id: it.off_id,
        image_url: it.image_url,
        image_path: it.image_path,
        custom_food_id: it.custom_food_id,
      })),
    )
    .select();

  if (error) {
    console.warn("appendEntriesToBundle:", error.message);
    throw error;
  }
  return (data ?? []) as MealCompositionItem[];
}

/** Inline rename. There is no bundle editor screen and there doesn't need to be. */
export async function renameComposition(
  compositionId: string,
  name: string,
): Promise<MealComposition> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A bundle needs a name.");

  const { data, error } = await supabase
    .from("meal_compositions")
    .update({ name: trimmed })
    .eq("id", compositionId)
    .select()
    .single();

  if (error) {
    console.warn("renameComposition:", error.message);
    throw error;
  }
  return data as MealComposition;
}

/** Remove one item. The common edit: a coffee you no longer drink. */
export async function deleteCompositionItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from("meal_composition_items")
    .delete()
    .eq("id", itemId);
  if (error) {
    console.warn("deleteCompositionItem:", error.message);
    throw error;
  }
}

/** Items go with it (ON DELETE CASCADE). No meal_entries are touched. */
export async function deleteComposition(compositionId: string): Promise<void> {
  const { error } = await supabase
    .from("meal_compositions")
    .delete()
    .eq("id", compositionId);
  if (error) {
    console.warn("deleteComposition:", error.message);
    throw error;
  }
}

// ─── Apply ───────────────────────────────────────────────────

/**
 * A composition item, resolved against a target day. What the UI previews
 * BEFORE it commits, and what applyComposition actually inserts.
 */
export interface CompositionItemPreview {
  item: MealCompositionItem;
  /** The instant this item will land on. */
  eaten_at: string;
  /**
   * What the DB trigger will decide. ADVISORY — the database is the authority,
   * and this reads the phone's clock, so within ~30 minutes of the boundary the
   * two can disagree. Fine for a label; never persist it.
   */
  planned: boolean;
}

/**
 * ⚠ THE REASON THIS EXISTS.
 *
 * A bundle item at 07:30. It is 19:00. Apply the bundle to TODAY and that item
 * lands in the PAST — so the trigger derives planned = false, and it enters the
 * WHOOP correlation as a meal you ATE. Silently. Through the front door of the
 * feature.
 *
 * You cannot fix that with a `planned` argument: the trigger owns the column,
 * correctly. You fix it by SHOWING the user, before they commit, that 2 of
 * their 5 items are about to be recorded as eaten. The sheet renders a
 * Logged/Planned pill per item, and the language matches ProductScreen's
 * existing chips exactly.
 *
 * ⚠ DELIBERATELY UN-ANCHORED. This always previews the bundle's SAVED times,
 * never a picked apply-time anchor — there is no "preview with the new
 * anchor" step in the apply flow. The anchor (see draftsFromComposition,
 * applyComposition) only exists between tapping Add and the picker resolving;
 * it never becomes UI state this function could read.
 */
export function previewComposition(
  composition: MealCompositionWithItems,
  targetDayKey: string,
  now: Date = new Date(),
): CompositionItemPreview[] {
  return composition.items.map((item) => {
    const eaten_at = sameTimeOnDay(
      parseTimeOfDay(item.eaten_time),
      targetDayKey,
    );
    return { item, eaten_at, planned: willBePlanned(eaten_at, now) };
  });
}

/**
 * The composition's items, resolved onto a day, ready for applyEntries.
 *
 * `anchor`, if given, re-times the whole set at once: the earliest item lands
 * on `anchor` and every other item keeps its offset from it (anchorTimesOfDay,
 * in time.ts). Omit it and every item uses its own saved eaten_time, exactly
 * as before — this is what keeps every OTHER caller of this function
 * unaffected by the apply-time picker.
 */
export function draftsFromComposition(
  composition: MealCompositionWithItems,
  targetDayKey: string,
  anchor?: TimeOfDay,
): EntryDraft[] {
  const shifted = anchor
    ? anchorTimesOfDay(
        composition.items.map((item) => parseTimeOfDay(item.eaten_time)),
        anchor,
      )
    : null;

  return composition.items.map((item, i) => {
    // shifted[i], when present, is already the anchored TimeOfDay for this
    // item (see anchorTimesOfDay) — sameTimeOnDay is what resolves it onto
    // targetDayKey AND is what bypasses resolveEatenAt's roll-back heuristic,
    // by passing that day through explicitly. Same call either way; only the
    // TimeOfDay fed into it differs.
    const eaten_at = sameTimeOnDay(
      shifted ? shifted[i] : parseTimeOfDay(item.eaten_time),
      targetDayKey,
    );

    return {
      name: item.name,
      brand: item.brand,
      serving_g: item.serving_g,

      calories: item.calories,
      protein: item.protein,
      carbs: item.carbs,
      fat: item.fat,

      // Straight through. NULL stays NULL.
      sat_fat: item.sat_fat,
      salt: item.salt,
      fibre: item.fibre,
      sugar: item.sugar,

      // ⚠ DERIVED FROM THIS APPLY'S eaten_at, NOT item.meal_type.
      //
      // item.meal_type is whatever was saved when the bundle was CREATED —
      // stale the moment an anchor shifts the time (a breakfast-shaped bundle
      // applied at 18:00 must not still land in Breakfast). The apply flow
      // only ever asks the user to confirm a TIME (the picker), never a
      // section, so there is no explicit section for this new row either way
      // — anchored or not. That's exactly the "no explicit section" case
      // sectionForTime exists for. item.meal_type itself is untouched by
      // this — still what previewComposition shows, still the bundle's own
      // bookkeeping.
      meal_type: sectionForTime(eaten_at),

      eaten_at,

      // ALWAYS true. An applied bundle is a PREDICTION, however precisely the
      // time was specified. You did not tell us you ate this at 07:30 — you told
      // us your porridge is usually at 07:30. Those are different claims and the
      // correlation cares which one it's got.
      eaten_at_estimated: true,

      source: "bundle",
      barcode: item.barcode,
      off_id: item.off_id,

      image_url: item.image_url,
      image_path: item.image_path,
      custom_food_id: item.custom_food_id,
    };
  });
}

/**
 * Apply a bundle to a day. Returns the inserted rows, WITH the trigger's
 * `planned` decision already in them.
 *
 * `anchor`, if given, re-times the whole bundle at once — see
 * draftsFromComposition. Optional so every other caller (none exist today,
 * but the signature shouldn't force one into existing) is unaffected.
 *
 * The use-count bump happens AFTER the insert succeeds, and its failure is
 * swallowed: a bundle you applied is a bundle you used, and a bundle whose
 * ordering hint didn't increment is not worth failing the user's meal over.
 */
export async function applyComposition(
  composition: MealCompositionWithItems,
  targetDayKey: string,
  anchor?: TimeOfDay,
): Promise<MealEntry[]> {
  const drafts = draftsFromComposition(composition, targetDayKey, anchor);
  const inserted = await applyEntries(drafts);

  // Atomic, server-side. NOT a read-modify-write off local state the way
  // saveIngredient does it — that pattern silently loses increments when the
  // same composition is applied from two devices.
  const { error } = await supabase.rpc("bump_composition_use", {
    p_composition_id: composition.id,
  });
  if (error) console.warn("bump_composition_use:", error.message);

  return inserted;
}
