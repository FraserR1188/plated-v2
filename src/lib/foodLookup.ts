// ============================================================
// src/lib/foodLookup.ts — barcode/name resolution across sources
//
// D4 CHANGE: mealEntryToProduct() can now return NULL, and callers must handle
// it. See the comment on that function — it was silently rewriting every macro
// on any entry whose serving_g was null.
// ============================================================

import { supabase } from "./supabase";
import { lookupBarcode } from "./openfoodfacts";
import { useStore } from "../store/useStore";
import { CustomFood, FoodProduct, MealEntry } from "../types";
import { reportError } from "./reportError";

// ─── Mapping ─────────────────────────────────────────────────

export function customFoodToProduct(cf: CustomFood): FoodProduct {
  return {
    name: cf.name,
    brand: cf.brand ?? "",
    cal_per100: cf.cal_per100,
    protein_per100: cf.protein_per100,
    carbs_per100: cf.carbs_per100,
    fat_per100: cf.fat_per100,
    // CustomFood's small-four are `number | null` (DB is nullable — see
    // 20260814100000_custom_foods_null_not_zero.sql); FoodProduct's are
    // `number | undefined`. This is a sentinel translation, not a coercion —
    // a real NULL must still read as "we don't know" on the other side, not
    // become 0.
    sat_fat_per100: cf.sat_fat_per100 ?? undefined,
    salt_per100: cf.salt_per100 ?? undefined,
    fibre_per100: cf.fibre_per100 ?? undefined,
    sugar_per100: cf.sugar_per100 ?? undefined,
    barcode: cf.barcode ?? undefined,
    serving_g: cf.serving_g ?? undefined,
    serving_label: cf.serving_label ?? undefined,
    source: "custom",
    custom_food_id: cf.id,

    // ⚠ image_PATH, not image_url — even though the COLUMN is called image_url.
    //
    // custom_foods.image_url stores a storage OBJECT PATH into the PRIVATE
    // bucket. It must be signed via getSignedImageUrl() before it can be
    // rendered. FoodProduct.image_url is reserved for directly-renderable URLs
    // (Open Food Facts).
    //
    // This line is load-bearing for a PRIVACY guarantee, not just a rendering
    // one. social.ts's copy path deliberately drops image_path and copies
    // image_url — so if this mapped to image_url instead, every copy of a
    // friend's homemade food would carry THEIR private bucket path into YOUR
    // row (rendering broken, since you can't sign it, which is why nobody would
    // notice). Do NOT "fix" this to match the column name.
    image_path: cf.image_url ?? undefined,
  };
}

/**
 * Rebuild per-100g values from a logged entry, so ProductScreen can edit it.
 *
 * ⚠ RETURNS NULL WHEN serving_g IS MISSING. Handle it.
 *
 * This used to be:
 *
 *     const g = e.serving_g > 0 ? e.serving_g : 100;
 *
 * MealEntry.serving_g was typed `number`, but the COLUMN is nullable. And
 * `null > 0` is false — so an entry with no serving weight silently fell back
 * to g = 100, and every macro was reconstructed as though the entry had weighed
 * 100g. Open that entry in ProductScreen, change nothing, hit Update, and all
 * eight macros are rewritten by a factor of 100/actual. Not drift — a rewrite.
 *
 * There is no correct fallback, because a snapshot with no weight genuinely
 * cannot be un-multiplied. So it refuses, and the caller offers to delete and
 * re-add instead.
 *
 * ─── AND EVEN WHEN serving_g IS VALID, THIS IS LOSSY ───
 *
 * Math.round() and toFixed() below mean the round-trip does not commute. A 250g
 * entry at 437 kcal → 175 kcal/100g → 437.5 kcal. Small, but it compounds on
 * every edit, and ProductScreen.handleSubmit rebuilds ALL macros from the
 * product even when only the time changed.
 *
 * Which is why bundles snapshot MealEntry → meal_composition_items DIRECTLY and
 * never come through here. If you find yourself routing a bundle through
 * FoodProduct, stop.
 */
export function mealEntryToProduct(e: MealEntry): FoodProduct | null {
  if (e.serving_g == null || e.serving_g <= 0) return null;

  const g = e.serving_g;

  // Small four are nullable — NULL must survive the reconstruction. `?? 0`
  // here would fabricate a zero for a macro we genuinely don't know, exactly
  // the mistake this function used to make. Same discipline as
  // itemFromIngredient's `!= null ? v * f : null` in
  // src/lib/compositions.ts:1053-1056, applied to the reverse
  // (per-serving -> per-100g) direction.
  const per100 = (v: number | null | undefined) =>
    v == null ? undefined : (v / g) * 100;

  // Big four are NOT NULL on MealEntry — per100() can never actually return
  // undefined for these four calls; the `!` documents that guarantee rather
  // than asserting past a real possibility.
  const satFat100 = per100(e.sat_fat);
  const salt100 = per100(e.salt);
  const fibre100 = per100(e.fibre);
  const sugar100 = per100(e.sugar);

  return {
    name: e.name,
    brand: e.brand ?? "",
    cal_per100: Math.round(per100(e.calories)!),
    protein_per100: +per100(e.protein)!.toFixed(1),
    carbs_per100: +per100(e.carbs)!.toFixed(1),
    fat_per100: +per100(e.fat)!.toFixed(1),
    sat_fat_per100: satFat100 != null ? +satFat100.toFixed(1) : undefined,
    salt_per100: salt100 != null ? +salt100.toFixed(2) : undefined,
    fibre_per100: fibre100 != null ? +fibre100.toFixed(1) : undefined,
    sugar_per100: sugar100 != null ? +sugar100.toFixed(1) : undefined,
    barcode: e.barcode ?? undefined,
    off_id: e.off_id ?? undefined,

    // Provenance and imagery, snapshotted on the entry at log time. Without
    // these, editing a logged entry produced a FoodProduct with no picture and
    // no idea where it came from — so ProductThumb fell back to the placeholder
    // and the thumbnail "disappeared" on edit.
    image_url: e.image_url ?? undefined,
    image_path: e.image_path ?? undefined,
    custom_food_id: e.custom_food_id ?? undefined,
    source: e.source === "custom" ? "custom" : "off",
  };
}

// ─── Barcode lookup orchestrator ─────────────────────────────

export type BarcodeLookupResult =
  | { status: "found"; product: FoodProduct }
  | { status: "not_found" } // both sources answered: product unknown
  | { status: "network_error" }; // OFF unreachable — retry is the only safe offer

export async function lookupFood(
  barcode: string,
): Promise<BarcodeLookupResult> {
  // 1) User's own custom foods — cheap, and keeps their foods
  //    scannable even with no internet connection.
  try {
    const cf = await findCustomFoodByBarcode(barcode);
    if (cf) return { status: "found", product: customFoodToProduct(cf) };
  } catch {
    // Supabase unreachable — fall through and let OFF try anyway.
    console.warn("lookupFood: custom-barcode lookup failed, falling through");
  }

  // 2) Open Food Facts
  try {
    const product = await lookupBarcode(barcode);
    if (product) {
      return { status: "found", product: { ...product, source: "off" } };
    }
    return { status: "not_found" };
  } catch {
    console.warn("lookupFood: OFF lookup failed");
    return { status: "network_error" };
  }
}

// ─── custom_foods data access ────────────────────────────────

export async function findCustomFoodByBarcode(
  barcode: string,
): Promise<CustomFood | null> {
  const userId = useStore.getState().userId;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("custom_foods")
    .select("*")
    .eq("user_id", userId)
    .eq("barcode", barcode)
    .maybeSingle(); // 0 rows → null, no error thrown

  if (error) {
    reportError("findCustomFoodByBarcode", error);
    throw new Error(error.message);
  }
  return (data as CustomFood) ?? null;
}

export type CreateCustomFoodInput = Omit<
  CustomFood,
  "id" | "user_id" | "created_at" | "image_url" | "label_image_url"
> & {
  image_url?: string | null;
  label_image_url?: string | null;
};

export async function createCustomFood(
  input: CreateCustomFoodInput,
): Promise<{ food: CustomFood | null; error: string | null }> {
  const userId = useStore.getState().userId;
  if (!userId) return { food: null, error: "Not signed in." };

  // EXPLICIT snake_case mapping — do NOT spread objects into Supabase
  // inserts. Spreads have silently no-opped new columns on this project
  // before; listing every column makes that class of bug impossible.
  const { data, error } = await supabase
    .from("custom_foods")
    .insert({
      user_id: userId,
      name: input.name,
      brand: input.brand,
      barcode: input.barcode,
      cal_per100: input.cal_per100,
      protein_per100: input.protein_per100,
      carbs_per100: input.carbs_per100,
      fat_per100: input.fat_per100,
      // `?? null`, NOT `?? 0` — see 20260814100000_custom_foods_null_not_zero.sql.
      // The column has no default any more, so an omitted key would also
      // land NULL, but explicit beats implicit: this is the same discipline
      // applyEntries()/addEntry() already use for meal_entries' small-four.
      sat_fat_per100: input.sat_fat_per100 ?? null,
      salt_per100: input.salt_per100 ?? null,
      fibre_per100: input.fibre_per100 ?? null,
      sugar_per100: input.sugar_per100 ?? null,
      serving_g: input.serving_g,
      serving_label: input.serving_label,
      image_url: input.image_url ?? null,
      label_image_url: input.label_image_url ?? null,
    })
    .select()
    .single();

  if (error) {
    reportError("createCustomFood", error);
    // 23505 = unique violation → this barcode already has a custom food
    const msg =
      error.code === "23505"
        ? "You've already created a food with this barcode."
        : "Couldn't save — check your connection and try again.";
    return { food: null, error: msg };
  }
  return { food: data as CustomFood, error: null };
}

/**
 * Persist storage object paths on a custom food, after the photos have been
 * uploaded. Separate from createCustomFood because the paths contain the row's
 * id — which doesn't exist until the row does.
 *
 * Takes both kinds so a food with a front photo AND a label photo costs one
 * round-trip, not two.
 *
 * Returns the updated row so callers can navigate on with fresh data.
 */
export async function setCustomFoodImages(
  customFoodId: string,
  paths: { front?: string | null; label?: string | null },
): Promise<{ food: CustomFood | null; error: string | null }> {
  const userId = useStore.getState().userId;
  if (!userId) return { food: null, error: "Not signed in." };

  const patch: { image_url?: string; label_image_url?: string } = {};
  if (paths.front) patch.image_url = paths.front;
  if (paths.label) patch.label_image_url = paths.label;

  // Nothing to write. Not an error — the user just didn't add a photo.
  if (Object.keys(patch).length === 0) {
    return { food: null, error: null };
  }

  const { data, error } = await supabase
    .from("custom_foods")
    .update(patch)
    .eq("id", customFoodId)
    .eq("user_id", userId) // belt-and-braces alongside RLS
    .select()
    .single();

  if (error) {
    reportError("setCustomFoodImages", error);
    return { food: null, error: "Couldn't save the photo." };
  }
  return { food: data as CustomFood, error: null };
}
