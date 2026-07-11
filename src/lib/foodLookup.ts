// ============================================================
// src/lib/foodLookup.ts — barcode/name resolution across sources
// Session B (Half 2): custom food images threaded through.
//   • CreateCustomFoodInput makes image_url optional (it's set
//     AFTER insert, once we have an id to build the path from)
//   • createCustomFood uses EXPLICIT snake_case mapping, not a
//     spread — spreads have silently no-opped new columns before
//   • setCustomFoodImage persists the storage path post-upload
// ============================================================

import { supabase } from "./supabase";
import { lookupBarcode } from "./openfoodfacts";
import { useStore } from "../store/useStore";
import { CustomFood, FoodProduct, MealEntry } from "../types";

// ─── Mapping ─────────────────────────────────────────────────

export function customFoodToProduct(cf: CustomFood): FoodProduct {
  return {
    name: cf.name,
    brand: cf.brand ?? "",
    cal_per100: cf.cal_per100,
    protein_per100: cf.protein_per100,
    carbs_per100: cf.carbs_per100,
    fat_per100: cf.fat_per100,
    sat_fat_per100: cf.sat_fat_per100,
    salt_per100: cf.salt_per100,
    fibre_per100: cf.fibre_per100,
    sugar_per100: cf.sugar_per100,
    barcode: cf.barcode ?? undefined,
    serving_g: cf.serving_g ?? undefined,
    serving_label: cf.serving_label ?? undefined,
    source: "custom",
    custom_food_id: cf.id,
    // NOTE: image_path, not image_url. The bucket is private, so this is
    // a storage OBJECT PATH that must be signed before it can be rendered.
    // image_url stays reserved for directly-renderable URLs (i.e. OFF).
    image_path: cf.image_url ?? undefined,
  };
}

// Rebuild per-100g values from a logged entry (which stores
// per-serving values + serving_g). Lets ProductScreen edit an
// existing entry with zero extra data fetching.
export function mealEntryToProduct(e: MealEntry): FoodProduct {
  const g = e.serving_g > 0 ? e.serving_g : 100;
  const per100 = (v: number | undefined | null) => ((v ?? 0) / g) * 100;

  return {
    name: e.name,
    brand: e.brand ?? "",
    cal_per100: Math.round(per100(e.calories)),
    protein_per100: +per100(e.protein).toFixed(1),
    carbs_per100: +per100(e.carbs).toFixed(1),
    fat_per100: +per100(e.fat).toFixed(1),
    sat_fat_per100: +per100(e.sat_fat).toFixed(1),
    salt_per100: +per100(e.salt).toFixed(2),
    fibre_per100: +per100(e.fibre).toFixed(1),
    sugar_per100: +per100(e.sugar).toFixed(1),
    barcode: e.barcode ?? undefined,
    off_id: e.off_id ?? undefined,

    // ── ADD ──
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
  }

  // 2) Open Food Facts
  try {
    const product = await lookupBarcode(barcode);
    if (product) {
      return { status: "found", product: { ...product, source: "off" } };
    }
    return { status: "not_found" };
  } catch {
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
    console.warn("findCustomFoodByBarcode:", error.message);
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
      sat_fat_per100: input.sat_fat_per100,
      salt_per100: input.salt_per100,
      fibre_per100: input.fibre_per100,
      sugar_per100: input.sugar_per100,
      serving_g: input.serving_g,
      serving_label: input.serving_label,
      image_url: input.image_url ?? null,
      label_image_url: input.label_image_url ?? null,
    })
    .select()
    .single();

  if (error) {
    console.warn("createCustomFood:", error.message);
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

  // Explicit snake_case, and only the columns we actually have. Building the
  // patch object by hand (rather than spreading) keeps this in line with the
  // rest of the file — spreads have silently no-opped new columns before.
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
    console.warn("setCustomFoodImages:", error.message);
    return { food: null, error: "Couldn't save the photo." };
  }
  return { food: data as CustomFood, error: null };
}

// For AddIngredientScreen (phase 1b): user's own foods in name search.
export async function searchCustomFoods(query: string): Promise<CustomFood[]> {
  const userId = useStore.getState().userId;
  if (!userId || !query.trim()) return [];

  const { data, error } = await supabase
    .from("custom_foods")
    .select("*")
    .eq("user_id", userId)
    .ilike("name", `%${query.trim()}%`)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.warn("searchCustomFoods:", error.message);
    return [];
  }
  return (data as CustomFood[]) ?? [];
}
