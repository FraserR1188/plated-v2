// ============================================================
// src/lib/foodLookup.ts — barcode/name resolution across sources
// Session A update: sat_fat_per100 flows through the mapper.
// ============================================================

import { supabase } from "./supabase";
import { lookupBarcode } from "./openfoodfacts";
import { useStore } from "../store/useStore";
import { CustomFood, FoodProduct } from "../types";

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
  "id" | "user_id" | "created_at"
>;

export async function createCustomFood(
  input: CreateCustomFoodInput,
): Promise<{ food: CustomFood | null; error: string | null }> {
  const userId = useStore.getState().userId;
  if (!userId) return { food: null, error: "Not signed in." };

  const { data, error } = await supabase
    .from("custom_foods")
    .insert({ user_id: userId, ...input })
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
