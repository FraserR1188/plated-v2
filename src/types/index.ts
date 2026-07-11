// ============================================================
// src/types/index.ts — plated types
//
// VERIFIED against information_schema on 2026-07-11. Do not "tidy"
// these field names: they mirror the real Postgres columns exactly.
// The previous version had drifted (ingredient_name/created_at, which
// don't exist) and TypeScript was reporting errors on CORRECT code as
// a result. Schema is the source of truth; this file follows it.
// ============================================================

export type MealType = "breakfast" | "lunch" | "dinner" | "snacks";

// ─── Food & Logging ──────────────────────────────────────────

export interface FoodProduct {
  name: string;
  brand: string;
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
  sat_fat_per100?: number;
  salt_per100?: number;
  fibre_per100?: number;
  sugar_per100?: number;
  barcode?: string;
  off_id?: string;
  serving_label?: string;
  serving_g?: number;
  source?: ProductSource; // undefined = OFF (legacy paths)
  custom_food_id?: string; // set when source === "custom"
  unique_scans_n?: number; // OFF popularity — used as a ranking tiebreaker

  // ── Images (Session B) ──
  // image_url: a directly renderable URL (Open Food Facts).
  // image_path: a storage object path in the PRIVATE custom-food-images
  //   bucket — must be signed via getSignedImageUrl() before display.
  // Two fields, not one, so consumers never have to guess which they hold.
  image_url?: string;
  image_thumb_url?: string;
  image_path?: string;
}

// Mirrors public.meal_entries.
//
// NULLABILITY WARNING: salt, fibre, sugar and sat_fat are nullable in the
// DB — rows logged before those migrations have NULL. ALWAYS coalesce when
// summing (`e.salt ?? 0`), or a single old row turns the whole total into
// NaN. This has already bitten useStore/HistoryScreen/csv.
export interface MealEntry {
  id: string;
  user_id: string;
  date: string; // 'YYYY-MM-DD'
  logged_at: string; // when the row was created (NOT NULL)
  name: string; // NOT the old `ingredient_name`
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  source: string; // 'search' | 'barcode' | 'manual' | 'custom' (NOT NULL)

  barcode?: string | null;
  off_id?: string | null;
  serving_g: number; // nullable in DB, but every write path sets it
  meal_type: MealType; // nullable in DB, but every write path sets it
  brand?: string | null;

  // Nullable — see the warning above.
  salt?: number | null;
  fibre?: number | null;
  sugar?: number | null;
  sat_fat?: number | null;

  eaten_at?: string | null; // real eating time; falls back to logged_at
}

// Mirrors public.saved_ingredients ("My Library").
// Previously imported by AddIngredientScreen and useStore but NEVER DEFINED —
// it only worked because Babel strips type-only imports before bundling.
export interface SavedIngredient {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
  sat_fat_per100: number; // NOT NULL in DB
  salt_per100: number;
  fibre_per100: number;
  sugar_per100: number;
  barcode: string | null;
  off_id: string | null;
  use_count: number;
  created_at: string;
}

export interface Goals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  satFat: number;
  salt: number;
  fibre: number;
  sugar: number;
}

export interface DayTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  satFat: number;
  salt: number;
  fibre: number;
  sugar: number;
}

// ─── Custom foods ────────────────────────────────────────────

export type ProductSource = "off" | "custom";

export interface CustomFood {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
  sat_fat_per100: number;
  salt_per100: number;
  fibre_per100: number;
  sugar_per100: number;
  serving_g: number | null;
  serving_label: string | null; // e.g. "1 bowl (45g)"
  created_at: string;
  image_url: string | null; // Session B: storage object PATH, not a URL
  label_image_url: string | null;
}

// ─── Social / Profiles ───────────────────────────────────────

export interface Profile {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface ProfileWithFollowState extends Profile {
  is_following: boolean;
  follows_you: boolean;
  follower_count: number;
  following_count: number;
}

export interface FriendSummary {
  profile: Profile;
  today_calories: number;
  calorie_goal: number;
  is_following: boolean;
}

// ─── Copy actions ────────────────────────────────────────────

export type CopyScope = "ingredient" | "meal_section" | "full_day";

export interface CopyPayload {
  scope: CopyScope;
  entries: MealEntry[];
  sourceName: string; // e.g. "Alex's Breakfast"
  targetMeal: MealType | null; // null when full_day (preserve original meals)
}

// ─── Navigation ──────────────────────────────────────────────

export type RootStackParamList = {
  MainTabs: undefined;
  AddIngredient: { date: string; mealType: MealType };
  Scanner: { date: string; mealType: MealType };
  Product: {
    product: FoodProduct;
    date: string;
    mealType: MealType;
    editEntryId?: string;
    initialServingG?: number;
    initialEatenAt?: string;
  };

  ConnectedUserLog: {
    profile: Profile;
    date: string;
  };

  CopyConfirm: {
    payload: CopyPayload;
    date: string;
  };

  CreateFood: {
    date: string;
    mealType: MealType;
    barcode?: string;
    initialName?: string;
  };
};

export type BottomTabParamList = {
  Today: undefined;
  History: undefined;
  Friends: undefined;
  Settings: undefined;
};

// ─── Meal constants ───────────────────────────────────────────

export const MEAL_TYPES: MealType[] = [
  "breakfast",
  "lunch",
  "dinner",
  "snacks",
];

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snacks: "Snacks",
};

export const MEAL_ICONS: Record<MealType, string> = {
  breakfast: "🌅",
  lunch: "☀️",
  dinner: "🌙",
  snacks: "🍎",
};
