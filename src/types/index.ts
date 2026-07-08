// ============================================================
// src/types.ts — plated types including social feature
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
}

export interface MealEntry {
  id: string;
  user_id: string;
  date: string; // 'YYYY-MM-DD'
  meal_type: MealType;
  ingredient_name: string;
  brand?: string;
  serving_g: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  sat_fat?: number; // NULL on entries logged before the migration
  salt?: number;
  fibre?: number;
  sugar?: number;
  created_at?: string;
  eaten_at?: string; // real eating time; falls back to logged_at on old rows
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
}

// ─── Social / Profiles ───────────────────────────────────────

export interface Profile {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

// Profile enriched with follow state — used in FriendsScreen
export interface ProfileWithFollowState extends Profile {
  is_following: boolean; // viewer follows this user
  follows_you: boolean; // this user follows the viewer (for "follows you" badge)
  follower_count: number;
  following_count: number;
}

// Summary row shown on the Friends list
export interface FriendSummary {
  profile: Profile;
  today_calories: number; // sum of their entries for today
  calorie_goal: number; // their calorie goal (if shared; 0 if not available)
  is_following: boolean;
}

// ─── Copy actions ────────────────────────────────────────────

export type CopyScope = "ingredient" | "meal_section" | "full_day";

export interface CopyPayload {
  scope: CopyScope;
  entries: MealEntry[]; // the entries to copy
  sourceName: string; // e.g. "Alex's Breakfast" or "Alex's full day"
  targetMeal: MealType | null; // null when scope is full_day (preserve original meals)
}

// ─── Navigation ──────────────────────────────────────────────

// Stack navigator — full screen stack that wraps the tabs
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
    initialEatenAt?: string; // ← NEW: entry's eaten_at when editing
  };

  // ── Social screens (pushed onto the root stack, not tabs) ──

  // Full log view for a connected user — pushed from FriendsScreen
  ConnectedUserLog: {
    profile: Profile;
    date: string; // defaults to today, date-picker available on screen
  };

  // Confirm + execute a copy action
  CopyConfirm: {
    payload: CopyPayload;
    date: string; // target date on the viewer's log
  };

  CreateFood: {
    date: string;
    mealType: MealType;
    barcode?: string; // pre-filled from a failed scan
    initialName?: string; // pre-filled from a failed name search (phase 1b)
  };
};

// Bottom tab navigator
export type BottomTabParamList = {
  Today: undefined;
  History: undefined;
  Friends: undefined; // ← new tab
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
