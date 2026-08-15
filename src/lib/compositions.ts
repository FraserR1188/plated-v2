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
  FoodProduct,
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
import { reportError } from "./reportError";

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
    reportError("getCompositions", error, { level: "error" });
    throw error;
  }

  return ((data ?? []) as MealCompositionWithItems[]).map((c) => ({
    ...c,
    items: [...(c.items ?? [])].sort((a, z) => a.position - z.position),
  }));
}

/**
 * Bundle-only view of a composition list. getCompositions() deliberately
 * returns BOTH kinds — it's the one shared fetch behind both the Bundles
 * sheet (TodayScreen) and the Batches tab, and narrowing it there would
 * break the other consumer. Every bundle-apply/preview UI must filter
 * through this (or bundlesOnly) before handing compositions to
 * previewComposition/draftsFromComposition, which assume bundle-shaped items.
 *
 * Pulled out to a named, exported function rather than left as an inline
 * `.filter()` in TodayScreen specifically so it's unit-testable without
 * rendering a screen — this IS the fix for a real incident: an unfiltered
 * list reached previewComposition with a batch composition in it, and
 * bundleItemTime threw on the batch item's (correctly) NULL eaten_time,
 * during render, crashing every launch. "There is exactly one place this
 * filter needs to happen" only holds if that place has a name.
 */
export function bundlesOnly(
  compositions: MealCompositionWithItems[],
): MealCompositionWithItems[] {
  return compositions.filter((c) => c.kind === "bundle");
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
    reportError("createBundleFromEntries", compositionErr, { level: "error" });
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
    reportError("createBundleFromEntries", itemsErr, { level: "error" });
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
    reportError("appendEntriesToBundle", error, { level: "error" });
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
    reportError("renameComposition", error, { level: "error" });
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
    reportError("deleteCompositionItem", error, { level: "error" });
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
    reportError("deleteComposition", error, { level: "error" });
    throw error;
  }
}

// ─── Apply ───────────────────────────────────────────────────

/**
 * `eaten_time` is typed `string | null` because a BATCH item's is genuinely
 * NULL — but every function below this point only ever deals in BUNDLE
 * items, where the DB trigger (meal_composition_items_validate_kind_biu)
 * guarantees it's NOT NULL. Rather than thread a discriminated union through
 * MealComposition/MealCompositionItem for that one guarantee, this turns a
 * violation into a loud, specific error instead of a silent NaN out of
 * parseTimeOfDay(null) — same shape as mealEntryToProduct's null-serving_g
 * refusal.
 */
function bundleItemTime(item: MealCompositionItem): TimeOfDay {
  if (item.eaten_time == null) {
    throw new Error(
      `Composition item ${item.id} has no eaten_time — not a valid bundle item ` +
        `(the DB trigger should have prevented this).`,
    );
  }
  return parseTimeOfDay(item.eaten_time);
}

/**
 * A composition item, resolved against a target day. What the UI previews
 * BEFORE it commits, and (once scaled per-item — see draftsFromComposition,
 * scaleEntryDraftGrams) what actually gets inserted.
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
 * anchor" step in the apply flow. The anchor (see draftsFromComposition)
 * only exists between tapping Add and the picker resolving; it never
 * becomes UI state this function could read.
 *
 * ⚠ RENDER PATH — DEGRADES, NEVER THROWS.
 *
 * TodayScreen's Bundles sheet now filters to kind === 'bundle' before this is
 * ever called (see the `bundles` filter there) — that filter is the actual
 * fix for a real incident: an unfiltered composition list let a batch reach
 * this function, bundleItemTime threw on the batch item's (correctly) NULL
 * eaten_time, and the throw happened during RENDER, crashing the app on
 * every launch. "The caller filters first" is exactly the assumption that
 * broke that time, so this function no longer trusts it: a non-bundle
 * composition returns an empty preview, and a malformed item (NULL
 * eaten_time on what claims to be a bundle) is skipped, not thrown on.
 *
 * Contrast with draftsFromComposition below, which stays on bundleItemTime
 * and keeps its throw — that path only runs from an explicit user action
 * (tapping Add), never from render, so refusing loudly there is correct:
 * better to fail the write than silently apply nothing.
 */
export function previewComposition(
  composition: MealCompositionWithItems,
  targetDayKey: string,
  now: Date = new Date(),
): CompositionItemPreview[] {
  if (composition.kind !== "bundle") return [];

  return composition.items.flatMap((item) => {
    if (item.eaten_time == null) {
      console.warn(
        `previewComposition: composition ${composition.id} item ${item.id} ` +
          `has no eaten_time — skipping rather than crashing the render.`,
      );
      return [];
    }
    const eaten_at = sameTimeOnDay(parseTimeOfDay(item.eaten_time), targetDayKey);
    return [{ item, eaten_at, planned: willBePlanned(eaten_at, now) }];
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
    ? anchorTimesOfDay(composition.items.map(bundleItemTime), anchor)
    : null;

  return composition.items.map((item, i) => {
    // shifted[i], when present, is already the anchored TimeOfDay for this
    // item (see anchorTimesOfDay) — sameTimeOnDay is what resolves it onto
    // targetDayKey AND is what bypasses resolveEatenAt's roll-back heuristic,
    // by passing that day through explicitly. Same call either way; only the
    // TimeOfDay fed into it differs.
    const eaten_at = sameTimeOnDay(
      shifted ? shifted[i] : bundleItemTime(item),
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
 * Insert already-resolved drafts for a composition and bump its use count.
 * The only caller is useStore's applyCompositionDraft — the review flow
 * builds its own drafts via draftsFromComposition + per-item scaling (see
 * scaleEntryDraftGrams below) and then has nothing left to do but this.
 *
 * The use-count bump happens AFTER the insert succeeds, and its failure is
 * swallowed: a bundle you applied is a bundle you used, and a bundle whose
 * ordering hint didn't increment is not worth failing the user's meal over.
 */
export async function applyCompositionDrafts(
  compositionId: string,
  drafts: EntryDraft[],
): Promise<MealEntry[]> {
  const inserted = await applyEntries(drafts);

  // Atomic, server-side. NOT a read-modify-write off local state the way
  // saveIngredient does it — that pattern silently loses increments when the
  // same composition is applied from two devices.
  const { error } = await supabase.rpc("bump_composition_use", {
    p_composition_id: compositionId,
  });
  if (error) reportError("bumpCompositionUse", error);

  return inserted;
}

// ─── Apply-time quantity adjustment (Phase 1) ───────────────────────────
//
// Ratio scaling off the item's stored absolute macros, NOT a per-100g
// reconstruction. meal_composition_items has no per-100g column (see the
// schema comment on itemFromEntry above) — reconstructing a rate via
// mealEntryToProduct-style (value / servingG) * 100 rounds on the way out
// AND on the way back in, eroding precision twice for no reason when the
// ratio can be applied directly. mealEntryToProduct() itself must never
// appear in this path for a second reason: its `(v ?? 0) / g` coalesces a
// NULL nutrient to zero before dividing, which would silently assert "zero
// fibre" for an item where fibre was genuinely unknown.

/**
 * Scale one nutrient value by a ratio, preserving NULL.
 *
 * NULL means "we don't know how much of this the item had" — scaling an
 * unknown by any ratio is still unknown, never zero. `v == null` (not
 * strict `===`) catches `undefined` too, same convention as the rest of
 * this file. Used for every nutrient field, including the NOT-NULL ones
 * (calories/protein/carbs/fat): those are never actually null, so they
 * just take the multiply branch — one helper, no special-casing needed.
 */
export function scaleNutrient(
  v: number | null | undefined,
  ratio: number,
): number | null {
  return v == null ? null : v * ratio;
}

/**
 * The eight macro fields, shared shape between EntryDraft and
 * MealCompositionItem (both are absolute-macros-for-a-quantity rows — see
 * itemFromEntry's doc comment above for why that's not a coincidence).
 * scaleEntryDraftGrams and scaleCompositionItem are two thin wrappers around
 * the SAME ratio arithmetic on this shape — this is the "shared arithmetic"
 * both scale to, so there is exactly one place that multiplies a macro by a
 * ratio, not two copies that could drift.
 */
interface ScalableMacros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  sat_fat: number | null;
  salt: number | null;
  fibre: number | null;
  sugar: number | null;
}

function scaleMacros<T extends ScalableMacros>(macros: T, ratio: number): T {
  return {
    ...macros,
    calories: macros.calories * ratio,
    protein: macros.protein * ratio,
    carbs: macros.carbs * ratio,
    fat: macros.fat * ratio,

    sat_fat: scaleNutrient(macros.sat_fat, ratio),
    salt: scaleNutrient(macros.salt, ratio),
    fibre: scaleNutrient(macros.fibre, ratio),
    sugar: scaleNutrient(macros.sugar, ratio),
  };
}

/**
 * Rescale an EntryDraft's macros (and serving_g) from `originalServingG` to
 * `targetGrams`. `originalServingG` is the item's TRUE saved quantity — the
 * denominator the draft's current absolute macros are already for — never
 * whatever grams the user last typed, so repeated edits in a review screen
 * always scale from the same fixed basis and never compound rounding drift
 * (nothing here rounds anyway: full float precision in, full float
 * precision out — round only at the point of display).
 *
 * Not rescalable when `originalServingG` is NULL or <= 0 (no denominator to
 * divide by): returns `draft` UNCHANGED rather than guessing a default
 * weight. This is what makes it safe to call unconditionally from a review
 * screen without a separate "is this item rescalable" branch at every call
 * site — the function itself refuses silently and correctly.
 */
export function scaleEntryDraftGrams(
  draft: EntryDraft,
  originalServingG: number | null,
  targetGrams: number,
): EntryDraft {
  if (originalServingG == null || originalServingG <= 0) return draft;
  const ratio = targetGrams / originalServingG;
  return { ...scaleMacros(draft, ratio), serving_g: targetGrams };
}

/**
 * Rescale a MealCompositionItem's macros (and serving_g) to `targetGrams`,
 * from the item's OWN serving_g — there is no anchor-shifting concept for a
 * standalone item the way a bundle-apply anchor exists for an EntryDraft, so
 * unlike scaleEntryDraftGrams there is nothing else the denominator could
 * legitimately be.
 *
 * Same contract as scaleEntryDraftGrams in every other respect: NULL in,
 * NULL out (via scaleNutrient); full float precision, no rounding — round
 * only at display; refuses (returns `item` UNCHANGED) when serving_g is
 * NULL or <= 0.
 *
 * THE REASON THIS EXISTS: BatchEditorScreen's productFromItem used to
 * reconstruct a per-100g rate from a saved batch ingredient by dividing by
 * serving_g and rounding to display precision (.toFixed(dp)) — the exact
 * round-trip-erodes-precision trap this file's Phase 1 comment already
 * warns about for mealEntryToProduct, reintroduced by a different route.
 * `scaleCompositionItem(item, 100)` replaces that: an EXACT ratio-scale to
 * a 100g basis with no intermediate rounding, reshaped into FoodProduct by
 * the caller. The FoodProduct shape itself is still genuinely needed there
 * — BatchEditorScreen's save path (itemFromIngredient) re-derives EVERY
 * ingredient's absolute macros from rate × quantity on every Save, edited
 * or not (updateBatch wholesale-replaces, never diffs) — so this is a
 * narrower fix than returning a MealCompositionItem there would be: what
 * changes is that the rate is now exact, not that the rate goes away.
 */
export function scaleCompositionItem(
  item: MealCompositionItem,
  targetGrams: number,
): MealCompositionItem {
  if (item.serving_g == null || item.serving_g <= 0) return item;
  const ratio = targetGrams / item.serving_g;
  return { ...scaleMacros(item, ratio), serving_g: targetGrams };
}

// ─── Persisting an apply-time adjustment back to the bundle (Phase 2) ────

/**
 * One item's post-scaling row, ready for an in-place UPDATE onto
 * meal_composition_items. Explicit field list, not EntryDraft reused
 * directly — EntryDraft carries meal_type/eaten_at/source/etc that don't
 * exist as columns on this table; spreading it into an update payload would
 * either error on unknown columns or (worse, if Postgrest ever became lax
 * about it) silently write nonsense. Building this narrow shape at the call
 * site is what keeps that impossible.
 */
export interface CompositionItemQuantityUpdate {
  itemId: string;
  serving_g: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  sat_fat: number | null;
  salt: number | null;
  fibre: number | null;
  sugar: number | null;
}

/**
 * Persist adjusted quantities onto an existing bundle's own items — Phase 2
 * of apply-time quantity adjustment. The FIRST in-place UPDATE this
 * codebase issues against meal_composition_items: every prior "edit"
 * (updateBatch) wholesale deletes and reinserts instead, which is safe
 * there only because nothing keys off a batch ingredient's row id (see
 * updateBatch's own comment). A bundle item doesn't get that luxury for
 * THIS operation — the caller already filtered `updates` down to the
 * SPECIFIC rows that changed (see useStore.ts's
 * saveCompositionApplyQuantities), and reinserting the whole set would
 * needlessly recycle ids for rows nothing here needed to touch. RLS
 * (meal_composition_items_update_own) is what makes a plain UPDATE safe to
 * issue directly from the client — no RPC needed, same as every other
 * composition write in this file.
 *
 * ONE UPDATE PER ROW, SEQUENTIAL, STOPS ON THE FIRST FAILURE. Not
 * Promise.all: that would keep firing the remaining updates even after one
 * is already known to have failed. Not a single bulk statement either:
 * Postgrest has no "N different values into N different rows" UPDATE
 * without an RPC, and this phase doesn't add one. A failure partway through
 * can leave a real mix — some items updated, one failed, the rest never
 * attempted — surfaced to the caller as a thrown error, never swallowed.
 * That partial state is accepted here because this write is independent of,
 * and runs strictly after, the apply that already logged the meal (see
 * useStore.ts's saveCompositionApplyQuantities) — retrying is just calling
 * this again with the same (still-correct) `updates`.
 *
 * ⚠ A ZERO-ROW RESULT IS A FAILURE, NOT SUCCESS. Manually verified against
 * the real table: a foreign auth.uid() attempting this same UPDATE gets NO
 * error — meal_composition_items_update_own's USING clause just filters the
 * row out of the update set, so Postgrest reports normal success with zero
 * rows affected. Without `.select("id")` here, that's indistinguishable
 * from every row genuinely being updated: the caller would believe an edit
 * saved when nothing was written at all. `.select("id")` gets the affected
 * row(s) back in the response, so an empty result can be checked for and
 * thrown on explicitly, same as any other failure.
 */
export async function updateCompositionItemQuantities(
  updates: CompositionItemQuantityUpdate[],
): Promise<void> {
  for (const u of updates) {
    const { data, error } = await supabase
      .from("meal_composition_items")
      .update({
        serving_g: u.serving_g,
        calories: u.calories,
        protein: u.protein,
        carbs: u.carbs,
        fat: u.fat,
        sat_fat: u.sat_fat,
        salt: u.salt,
        fibre: u.fibre,
        sugar: u.sugar,
      })
      .eq("id", u.itemId)
      .select("id");

    if (error) {
      reportError("updateCompositionItemQuantities", error, { level: "error" });
      throw error;
    }

    if (!data || data.length === 0) {
      const zeroRowError = new Error(
        `updateCompositionItemQuantities: item ${u.itemId} matched zero rows. ` +
          `Not necessarily an error from Postgrest's point of view (RLS can ` +
          `filter a row out of an UPDATE's target set without raising one), ` +
          `but nothing was actually saved — treated as a failure rather than ` +
          `silent success.`,
      );
      reportError("updateCompositionItemQuantities", zeroRowError, {
        level: "error",
      });
      throw zeroRowError;
    }
  }
}

// ─── Batches ─────────────────────────────────────────────────
//
// A batch's ingredients are created through createBatchFromIngredients (a
// future step, alongside the Batches tab UI) — deliberately NOT through
// itemFromEntry/createBundleFromEntries above. A bundle item snapshots an
// EXISTING meal_entries row (it already has real macros); a batch ingredient
// comes from a search result plus a chosen quantity (a per-100g rate that
// needs multiplying out). Different input shapes, different builders, same
// table — not merged, and this comment is the reason not to.

interface BatchMacroTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  sat_fat: number | null;
  salt: number | null;
  fibre: number | null;
  sugar: number | null;
}

/**
 * Raw (unrounded, unscaled) sums across a batch's ingredients.
 *
 * NULL-POISONS-TOTAL: the moment ANY ingredient's value for an optional
 * macro is null ("we don't know how much of this it had"), the batch's total
 * for that macro is null too — never coalesced to 0. Checked with `== null`,
 * not truthiness: a real 0 (this ingredient genuinely has zero grams of it)
 * sums normally: only null poisons. Required macros (calories/protein/carbs/
 * fat) are NOT NULL by schema, so they just sum — no null handling needed or
 * possible.
 */
function sumBatchMacros(items: MealCompositionItem[]): BatchMacroTotals {
  const calories = items.reduce((s, i) => s + i.calories, 0);
  const protein = items.reduce((s, i) => s + i.protein, 0);
  const carbs = items.reduce((s, i) => s + i.carbs, 0);
  const fat = items.reduce((s, i) => s + i.fat, 0);

  const sumOrPoison = (
    pick: (i: MealCompositionItem) => number | null,
  ): number | null => {
    let total = 0;
    for (const item of items) {
      const v = pick(item);
      if (v == null) return null; // short-circuit: unknown poisons the total
      total += v;
    }
    return total;
  };

  return {
    calories,
    protein,
    carbs,
    fat,
    sat_fat: sumOrPoison((i) => i.sat_fat),
    salt: sumOrPoison((i) => i.salt),
    fibre: sumOrPoison((i) => i.fibre),
    sugar: sumOrPoison((i) => i.sugar),
  };
}

/**
 * A batch, resolved into exactly ONE EntryDraft — the merged output at
 * portion_g grams. Ingredients are summed and scaled FRESH every call;
 * nothing about this is ever stored or round-tripped (see the comment on
 * MealComposition.yield_g in types/index.ts) — the round-trip-erodes-numbers
 * trap that itemFromEntry's doc comment warns about for bundles doesn't even
 * have a place to hide here, because there is no snapshot of a snapshot: the
 * ingredients are the only source of truth, every time.
 *
 * `now` plays TWO roles, and they matter precisely because they can
 * disagree: it supplies the hours/minutes for eaten_at (paired with
 * `target.date`, which supplies the day), AND it's the clock willBePlanned
 * compares eaten_at against to decide eaten_at_estimated below. For the
 * ORIGINAL log-now caller these are the same instant by construction
 * (target.date is always todayKey(), now is always "right now"), so eaten_at
 * always equals now exactly and the willBePlanned check always reads false —
 * that's WHY hardcoding false was correct in v1, not a coincidence this
 * refactor has to preserve by other means.
 *
 * `chosenAt`, if given, is a user-picked instant and takes over eaten_at
 * entirely (`target`/the hour-minute half of `now` are ignored for it) — but
 * `now` keeps its SECOND role, the actual current clock, unaltered. This is
 * the whole reason chosenAt is a separate parameter rather than reusing `now`
 * for the picked value too: doing that would compare the picked time against
 * itself and eaten_at_estimated would always read false, silently, even for
 * a batch planned hours into the future. Callers passing chosenAt should
 * leave `now` at its default (the real clock) precisely so this comparison
 * means something.
 *
 * meal_type is derived from THIS apply's own eaten_at via sectionForTime,
 * exactly like draftsFromComposition's bundle items — never inherited from
 * any ingredient. There is nothing to inherit from: batch items have no
 * meal_type at all, by the DB trigger.
 */
export function draftsFromBatch(
  composition: MealCompositionWithItems,
  target: { date: string },
  now: Date = new Date(),
  chosenAt?: Date,
): EntryDraft {
  if (
    composition.kind !== "batch" ||
    composition.yield_g == null ||
    composition.portion_g == null
  ) {
    throw new Error(
      `draftsFromBatch: composition ${composition.id} is not a valid batch ` +
        `(kind=${composition.kind}, yield_g=${composition.yield_g}, ` +
        `portion_g=${composition.portion_g}) — meal_compositions_batch_shape ` +
        `should have made this unreachable.`,
    );
  }
  if (composition.items.length === 0) {
    throw new Error("A batch needs at least one ingredient.");
  }

  const totals = sumBatchMacros(composition.items); // raw, unrounded
  const scale = composition.portion_g / composition.yield_g;

  const eaten_at = chosenAt
    ? chosenAt.toISOString()
    : sameTimeOnDay(
        { hours: now.getHours(), minutes: now.getMinutes() },
        target.date,
      );

  // Scaled AND rounded ONCE, here — never round the sum and round again after
  // scaling. Same granularity as mealEntryToProduct/ProductScreen's preview:
  // whole kcal, 1dp for protein/carbs/fat/sat_fat/fibre/sugar, 2dp for salt.
  const scaled = (v: number, dp: number): number => +(v * scale).toFixed(dp);
  const scaledNullable = (v: number | null, dp: number): number | null =>
    v == null ? null : scaled(v, dp);

  return {
    name: composition.name,
    brand: null,
    serving_g: composition.portion_g,

    calories: Math.round(totals.calories * scale),
    protein: scaled(totals.protein, 1),
    carbs: scaled(totals.carbs, 1),
    fat: scaled(totals.fat, 1),

    sat_fat: scaledNullable(totals.sat_fat, 1),
    salt: scaledNullable(totals.salt, 2),
    fibre: scaledNullable(totals.fibre, 1),
    sugar: scaledNullable(totals.sugar, 1),

    meal_type: sectionForTime(eaten_at),
    eaten_at,

    // Same rule as ProductScreen's new-entry path and retimeEntries: a
    // future eaten_at is still a forecast (you have not eaten this yet,
    // however deliberately you picked the time), so it stays an estimate
    // until the trigger's planned=false catches up with the clock. A past
    // or present eaten_at is a fact — "you are eating this now" — same as
    // v1's old always-false. willBePlanned is the one place that boundary
    // is decided; do not re-derive it here.
    eaten_at_estimated: willBePlanned(eaten_at, now),

    source: "batch",
    barcode: null,
    off_id: null,

    // A batch's merged output isn't any one ingredient's identity — no
    // photo, no barcode, no OFF id, no custom-food link.
    image_url: null,
    image_path: null,
    custom_food_id: null,
  };
}

/**
 * Apply a batch: exactly one meal_entries row, through the SAME applyEntries
 * path as everything else in this file — no new insert site.
 *
 * Call with just `composition` and `{ date: todayKey() }` for the original
 * log-now behaviour — `now` defaults to the real clock and there's no
 * `chosenAt`, so eaten_at lands on right now, same as v1.
 *
 * A caller with a user-picked instant (BatchesScreen's eat-time sheet) passes
 * it as `chosenAt` and leaves `now` at its default — see draftsFromBatch's
 * comment for why `now` must stay the real clock rather than being reused for
 * the picked value (it's also what eaten_at_estimated is judged against).
 * `target.date` is still required but is only load-bearing when `chosenAt`
 * is absent; pass `{ date: dateKey(chosenAt) }` for symmetry regardless.
 */
export async function applyBatch(
  composition: MealCompositionWithItems,
  target: { date: string },
  now: Date = new Date(),
  chosenAt?: Date,
): Promise<MealEntry> {
  const draft = draftsFromBatch(composition, target, now, chosenAt);
  const [inserted] = await applyEntries([draft]);

  // Same atomic RPC bundles use — generic across kind since migration 1.
  const { error } = await supabase.rpc("bump_composition_use", {
    p_composition_id: composition.id,
  });
  if (error) reportError("bumpCompositionUse", error);

  return inserted;
}

/** kcal for ONE portion, for display (the Batches list row) — the EXACT same
 *  formula draftsFromBatch uses for `calories`, so the number shown never
 *  disagrees with the number that gets logged. Returns null for anything
 *  that isn't a fully-formed batch (not a batch, no yield/portion, no
 *  ingredients) rather than throwing — this is a display helper, not an
 *  apply-time invariant check. */
export function batchPortionCalories(
  composition: MealCompositionWithItems,
): number | null {
  if (
    composition.kind !== "batch" ||
    composition.yield_g == null ||
    composition.portion_g == null ||
    composition.items.length === 0
  ) {
    return null;
  }
  const totalCalories = composition.items.reduce((s, i) => s + i.calories, 0);
  return Math.round((totalCalories * composition.portion_g) / composition.yield_g);
}

// ─── Batch create / edit ───────────────────────────────────────

/** One ingredient going into a batch: a food (with per-100g rates) plus how
 *  much of it, grams. Distinct from a bundle's source (an already-logged
 *  MealEntry with real totals) — see the file-level comment above. */
export interface BatchIngredientInput {
  product: FoodProduct;
  quantityG: number;
}

export interface BatchFormInput {
  name: string;
  yieldG: number;
  portionG: number;
  portionLabel: string | null;
  ingredients: BatchIngredientInput[];
}

/**
 * FoodProduct (a per-100g RATE) + a chosen quantity → an absolute-macro item
 * draft, meal_type/eaten_time NULL (the DB trigger requires this for a batch
 * item — an ingredient has no independent section or time).
 *
 * `!= null ? v * f : null` throughout, NEVER `(v ?? 0) * f`: a product with
 * no salt_per100 on record means "we don't know", not "zero salt", and
 * multiplying an assumed zero through is exactly the write-side coalesce
 * this codebase's null=unknown/0=known-zero rule exists to prevent.
 */
function itemFromIngredient(
  input: BatchIngredientInput,
  position: number,
): MealCompositionItemDraft {
  const { product, quantityG } = input;
  const f = quantityG / 100;

  return {
    position,

    name: product.name,
    brand: product.brand || null,
    serving_g: quantityG,

    calories: product.cal_per100 * f,
    protein: product.protein_per100 * f,
    carbs: product.carbs_per100 * f,
    fat: product.fat_per100 * f,

    sat_fat: product.sat_fat_per100 != null ? product.sat_fat_per100 * f : null,
    salt: product.salt_per100 != null ? product.salt_per100 * f : null,
    fibre: product.fibre_per100 != null ? product.fibre_per100 * f : null,
    sugar: product.sugar_per100 != null ? product.sugar_per100 * f : null,

    meal_type: null,
    eaten_time: null,

    barcode: product.barcode ?? null,
    off_id: product.off_id ?? null,

    image_url: product.image_url ?? null,
    image_path: product.image_path ?? null,
    custom_food_id: product.custom_food_id ?? null,
  };
}

function validateBatchForm(input: BatchFormInput): string {
  const trimmed = input.name.trim();
  if (!trimmed) throw new Error("A batch needs a name.");
  if (input.ingredients.length === 0)
    throw new Error("A batch needs at least one ingredient.");
  if (!(input.yieldG > 0)) throw new Error("Yield must be greater than zero.");
  if (!(input.portionG > 0))
    throw new Error("Portion size must be greater than zero.");
  if (input.portionG > input.yieldG)
    throw new Error("Portion size can't be more than the total yield.");
  return trimmed;
}

/** Explicit snake_case row builder shared by create and update below — the
 *  same "list every column, never spread" discipline as every insert in this
 *  file, just factored out because create/update both need it verbatim. */
function batchItemRow(
  it: MealCompositionItemDraft,
  compositionId: string,
  userId: string,
) {
  return {
    composition_id: compositionId,
    user_id: userId,
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
    meal_type: it.meal_type, // null — the trigger requires this for kind='batch'
    eaten_time: it.eaten_time, // null
    barcode: it.barcode,
    off_id: it.off_id,
    image_url: it.image_url,
    image_path: it.image_path,
    custom_food_id: it.custom_food_id,
  };
}

/**
 * "Save these ingredients as a batch." Two round-trips, not one — same shape
 * as createBundleFromEntries and the custom-food image upload: the items
 * need a composition_id that doesn't exist until the composition does.
 *
 * NOT createBundleFromEntries with a different input mapped in. Deliberately
 * a separate function feeding the same two tables — see the file-level
 * comment above "Batches" for why they aren't merged.
 */
export async function createBatchFromIngredients(
  input: BatchFormInput,
): Promise<MealCompositionWithItems> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmed = validateBatchForm(input);

  const { data: composition, error: compositionErr } = await supabase
    .from("meal_compositions")
    .insert({
      user_id: user.id,
      name: trimmed,
      kind: "batch",
      yield_g: input.yieldG,
      portion_g: input.portionG,
      portion_label: input.portionLabel,
    })
    .select()
    .single();

  if (compositionErr || !composition) {
    reportError("createBatchFromIngredients", compositionErr, { level: "error" });
    throw compositionErr ?? new Error("Couldn't save the batch.");
  }

  const items = input.ingredients.map((ing, i) => itemFromIngredient(ing, i));

  const { data: saved, error: itemsErr } = await supabase
    .from("meal_composition_items")
    .insert(
      items.map((it) =>
        batchItemRow(it, (composition as MealComposition).id, user.id),
      ),
    )
    .select();

  if (itemsErr) {
    reportError("createBatchFromIngredients", itemsErr, { level: "error" });
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
 * Edit an existing batch: update the composition row, then WHOLESALE REPLACE
 * its items — delete every existing meal_composition_items row for it and
 * insert the current draft fresh, rather than diffing add/remove/reorder.
 *
 * Safe, not just convenient: a composition item is pure bookkeeping input to
 * draftsFromBatch, and NOTHING else references one (no FK from meal_entries
 * back to a composition or its items — applies are full, independent
 * snapshots). There is no id/ordering continuity an in-place diff would be
 * protecting. This is also WHY an edit can never touch anything already
 * logged: past applies already have their own meal_entries rows, computed
 * and inserted at apply time, with no live link back here to be disturbed.
 */
export async function updateBatch(
  compositionId: string,
  input: BatchFormInput,
): Promise<MealCompositionWithItems> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmed = validateBatchForm(input);

  const { data: composition, error: compositionErr } = await supabase
    .from("meal_compositions")
    .update({
      name: trimmed,
      yield_g: input.yieldG,
      portion_g: input.portionG,
      portion_label: input.portionLabel,
    })
    .eq("id", compositionId)
    .select()
    .single();

  if (compositionErr || !composition) {
    reportError("updateBatch", compositionErr, { level: "error" });
    throw compositionErr ?? new Error("Couldn't save the batch.");
  }

  const { error: deleteErr } = await supabase
    .from("meal_composition_items")
    .delete()
    .eq("composition_id", compositionId);
  if (deleteErr) {
    reportError("updateBatch", deleteErr, { level: "error" });
    throw deleteErr;
  }

  const items = input.ingredients.map((ing, i) => itemFromIngredient(ing, i));

  const { data: saved, error: itemsErr } = await supabase
    .from("meal_composition_items")
    .insert(items.map((it) => batchItemRow(it, compositionId, user.id)))
    .select();

  if (itemsErr) {
    reportError("updateBatch", itemsErr, { level: "error" });
    throw itemsErr;
  }

  return {
    ...(composition as MealComposition),
    items: ((saved ?? []) as MealCompositionItem[]).sort(
      (a, z) => a.position - z.position,
    ),
  };
}
