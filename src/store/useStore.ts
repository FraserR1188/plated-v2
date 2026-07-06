import { create } from "zustand";
import { supabase } from "../lib/supabase";
import {
  MealEntry,
  SavedIngredient,
  Goals,
  DayTotals,
  MealType,
  FoodProduct,
} from "../types";

const DEFAULT_GOALS: Goals = {
  calories: 2000,
  protein: 150,
  carbs: 200,
  fat: 65,
  satFat: 20,
  salt: 6,
  fibre: 30,
  sugar: 30,
};

interface AppState {
  userId: string | null;
  entries: MealEntry[];
  savedIngredients: SavedIngredient[];
  goals: Goals;
  loading: boolean;

  setUserId: (id: string | null) => void;
  fetchEntries: () => Promise<void>;
  fetchGoals: () => Promise<void>;
  fetchSavedIngredients: () => Promise<void>;

  addEntry: (
    entry: Omit<MealEntry, "id" | "user_id" | "logged_at">,
  ) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  saveGoals: (goals: Goals) => Promise<void>;

  // Save an ingredient to the library (or increment use_count if it exists)
  saveIngredient: (product: FoodProduct) => Promise<SavedIngredient | null>;
  deleteIngredient: (id: string) => Promise<void>;

  getTotalsForDate: (date: string) => DayTotals;
  getEntriesForMeal: (date: string, mealType: MealType) => MealEntry[];
  getAllEntries: () => MealEntry[];
}

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sumMacros(entries: MealEntry[]): DayTotals {
  return {
    calories: entries.reduce((s, e) => s + e.calories, 0),
    protein: entries.reduce((s, e) => s + e.protein, 0),
    carbs: entries.reduce((s, e) => s + e.carbs, 0),
    fat: entries.reduce((s, e) => s + e.fat, 0),
    satFat: entries.reduce((s, e) => s + (e.sat_fat ?? 0), 0),
    salt: entries.reduce((s, e) => s + e.salt, 0),
    fibre: entries.reduce((s, e) => s + e.fibre, 0),
    sugar: entries.reduce((s, e) => s + e.sugar, 0),
  };
}

export const useStore = create<AppState>((set, get) => ({
  userId: null,
  entries: [],
  savedIngredients: [],
  goals: DEFAULT_GOALS,
  loading: false,

  setUserId: (id) => set({ userId: id }),

  fetchEntries: async () => {
    const { userId } = get();
    if (!userId) return;
    set({ loading: true });
    const { data, error } = await supabase
      .from("meal_entries")
      .select("*")
      .eq("user_id", userId)
      .order("logged_at", { ascending: false });
    if (!error && data) set({ entries: data as MealEntry[] });
    set({ loading: false });
  },

  fetchGoals: async () => {
    const { userId } = get();
    if (!userId) return;
    const { data } = await supabase
      .from("goals")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (data)
      set({
        goals: {
          calories: data.calories,
          protein: data.protein,
          carbs: data.carbs,
          fat: data.fat,
          satFat: data.sat_fat ?? 20,
          salt: data.salt,
          fibre: data.fibre,
          sugar: data.sugar,
        },
      });
  },

  fetchSavedIngredients: async () => {
    const { userId } = get();
    if (!userId) return;
    const { data } = await supabase
      .from("saved_ingredients")
      .select("*")
      .eq("user_id", userId)
      .order("use_count", { ascending: false });
    if (data) set({ savedIngredients: data as SavedIngredient[] });
  },

  addEntry: async (entry) => {
    const { userId } = get();
    if (!userId) return;
    const newEntry = {
      ...entry,
      user_id: userId,
      logged_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from("meal_entries")
      .insert(newEntry)
      .select()
      .single();
    if (!error && data)
      set((s) => ({ entries: [data as MealEntry, ...s.entries] }));
  },

  deleteEntry: async (id) => {
    await supabase.from("meal_entries").delete().eq("id", id);
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  updateEntry: (id: string, patch: Partial<MealEntry>) => Promise<void>;

  saveGoals: async (goals) => {
    const { userId } = get();
    if (!userId) return;
    await supabase.from("goals").upsert({
      user_id: userId,
      calories: goals.calories,
      protein: goals.protein,
      carbs: goals.carbs,
      fat: goals.fat,
      sat_fat: goals.satFat, // camelCase → snake_case
      salt: goals.salt,
      fibre: goals.fibre,
      sugar: goals.sugar,
      updated_at: new Date().toISOString(),
    });
    set({ goals });
  },

  saveIngredient: async (product) => {
    const { userId, savedIngredients } = get();
    if (!userId) return null;

    // Check if already saved (match by name + brand)
    const existing = savedIngredients.find(
      (i) =>
        i.name.toLowerCase() === product.name.toLowerCase() &&
        (i.brand ?? "") === (product.brand ?? ""),
    );

    if (existing) {
      // Increment use count
      await supabase
        .from("saved_ingredients")
        .update({ use_count: existing.use_count + 1 })
        .eq("id", existing.id);
      const updated = { ...existing, use_count: existing.use_count + 1 };
      set((s) => ({
        savedIngredients: s.savedIngredients.map((i) =>
          i.id === existing.id ? updated : i,
        ),
      }));
      return updated;
    }

    // Insert new
    const { data, error } = await supabase
      .from("saved_ingredients")
      .insert({
        user_id: userId,
        name: product.name,
        brand: product.brand,
        cal_per100: product.cal_per100,
        protein_per100: product.protein_per100,
        carbs_per100: product.carbs_per100,
        fat_per100: product.fat_per100,
        sat_fat_per100: product.sat_fat_per100 ?? 0,
        salt_per100: product.salt_per100,
        fibre_per100: product.fibre_per100,
        sugar_per100: product.sugar_per100,
        barcode: product.barcode,
        off_id: product.off_id,
      })
      .select()
      .single();

    if (!error && data) {
      set((s) => ({
        savedIngredients: [data as SavedIngredient, ...s.savedIngredients],
      }));
      return data as SavedIngredient;
    }
    return null;
  },

  deleteIngredient: async (id) => {
    await supabase.from("saved_ingredients").delete().eq("id", id);
    set((s) => ({
      savedIngredients: s.savedIngredients.filter((i) => i.id !== id),
    }));
  },

  getTotalsForDate: (date) =>
    sumMacros(get().entries.filter((e) => e.date === date)),
  getEntriesForMeal: (date, mealType) =>
    get().entries.filter((e) => e.date === date && e.meal_type === mealType),
  getAllEntries: () => get().entries,
}));
