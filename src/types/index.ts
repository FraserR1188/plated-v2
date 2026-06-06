// ================================================================
// Shared TypeScript types
// ================================================================

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snacks'];

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch:     'Lunch',
  dinner:    'Dinner',
  snacks:    'Snacks',
};

export const MEAL_ICONS: Record<MealType, string> = {
  breakfast: '🌅',
  lunch:     '☀️',
  dinner:    '🌙',
  snacks:    '🍎',
};

export interface MealEntry {
  id: string;
  user_id: string;
  date: string;         // 'YYYY-MM-DD'
  logged_at: string;
  meal_type: MealType;
  name: string;
  brand?: string;
  serving_g: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  salt: number;
  fibre: number;
  sugar: number;
  source: 'manual' | 'search' | 'barcode' | 'library';
  barcode?: string;
  off_id?: string;
  saved_ingredient_id?: string;
}

export interface SavedIngredient {
  id: string;
  user_id: string;
  name: string;
  brand?: string;
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
  salt_per100: number;
  fibre_per100: number;
  sugar_per100: number;
  barcode?: string;
  off_id?: string;
  use_count: number;
  created_at: string;
}

export interface Goals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  salt: number;
  fibre: number;
  sugar: number;
}

export interface DayTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  salt: number;
  fibre: number;
  sugar: number;
}

// A food product from Open Food Facts or manual entry
export interface FoodProduct {
  name: string;
  brand: string;
  cal_per100: number;
  protein_per100: number;
  carbs_per100: number;
  fat_per100: number;
  salt_per100: number;
  fibre_per100: number;
  sugar_per100: number;
  barcode?: string;
  off_id?: string;
}

// Navigation
export type RootStackParamList = {
  MainTabs:      undefined;
  AddIngredient: { date: string; mealType: MealType };
  Scanner:       undefined;
  Product:       { product: FoodProduct; date: string; mealType: MealType };
};

export type BottomTabParamList = {
  Today:    undefined;
  History:  undefined;
  Settings: undefined;
};
