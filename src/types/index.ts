// ============================================================
// src/types/index.ts — plated types
//
// VERIFIED against information_schema on 2026-07-13 (post-migration-5).
// Do not "tidy" these field names: they mirror the real Postgres columns
// exactly. Schema is the source of truth; this file follows it.
//
// D4 CORRECTED THREE DIVERGENCES. If you are reading an older copy of this
// file, or a comment that contradicts what's below, THIS file is right:
//
//   1. eaten_at was `?: string | null`. It is NOT NULL in the DB, and the `?`
//      was the dangerous half — see the comment on the field.
//   2. serving_g was `number`. It is NULLABLE in the DB.
//   3. meal_type carried a comment claiming it was nullable. It is NOT NULL
//      as of migration 3.
// ============================================================

export type MealType = "breakfast" | "lunch" | "dinner" | "snacks";

/**
 * Where an entry came from.
 *
 * There is NO check constraint on meal_entries.source, so adding a value here
 * needs no migration — which is why 'bundle' could just appear.
 *
 * MealEntry.source is typed `string`, not this union, and that is deliberate:
 * the DB will hand you back whatever is in the column, including values written
 * before this union existed. Type your READS wide and your WRITES narrow. Use
 * EntrySource when constructing a row; accept `string` when reading one.
 */
export type EntrySource =
  | "search"
  | "barcode"
  | "manual"
  | "custom"
  | "copied"
  | "bundle"
  | "batch"
  | "ai_photo";

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

  /**
   * Present ONLY for a draft built from scan-meal-photo
   * (mealScanToFoodProduct). Nothing else sets this.
   *
   * Two jobs: (1) ProductScreen shows it as a confidence/alternatives
   * notice, since this product's macros are an AI estimate rather than a
   * lookup; (2) it's how ProductScreen's addEntry call picks the
   * "ai_photo" EntrySource — this product has no barcode and isn't
   * source: "custom", so without this flag it would silently fall through
   * to "search" and the estimate's provenance would be lost.
   */
  aiEstimate?: {
    alternatives: string[];
    confidence: "high" | "medium" | "low";
    notes: string[];
    /** Only set on a labelled re-estimate. See mealRecognition.ts. */
    identityDivergence?: boolean;
    /**
     * The JPEG bytes (base64) that produced this estimate. Retained so a
     * correction can resend the SAME photo to scan-meal-photo with a new
     * user_dish_label, without reopening the camera. This is client-side
     * retention only — never uploaded to Storage, never spread into a
     * Supabase insert (aiEstimate isn't a column on meal_entries or
     * saved_ingredients; both write paths list columns explicitly).
     */
    sourceImageBase64: string;
    /**
     * true once the user has corrected the identification at least once.
     * Drives ProductScreen's banner (header/subtext/badge/alternatives) and
     * is the one flag that distinguishes "first AI guess" from "AI
     * estimate under a user-asserted name" — the identity is certain either
     * way the macros came from the model, so this does NOT mean the
     * macros are more trustworthy, only that the NAME is.
     */
    userCorrected: boolean;
  };
}

/**
 * Mirrors public.meal_entries.
 *
 * ─── NULLABILITY: THE SAME `?? 0` MEANS TWO OPPOSITE THINGS ───
 *
 * salt, fibre, sugar and sat_fat are NULLABLE with a DEFAULT of 0. So:
 *
 *     NULL  =  we do not know how much fibre this had
 *     0     =  we know, and it had none
 *
 * READING — always coalesce. `e.salt ?? 0` when summing, or a single old row
 *   turns the whole total into NaN. This has already bitten useStore,
 *   HistoryScreen and csv.
 *
 * WRITING — NEVER coalesce. `sat_fat: entry.sat_fat ?? 0` in an INSERT does not
 *   protect anything; it DESTROYS the distinction, permanently, replacing
 *   "unknown" with the assertion "zero grams" — which then feeds your goals and
 *   your WHOOP correlation and propagates into every copy. Pass `?? null`.
 *
 * Same three characters, opposite consequences. useStore.addEntry gets this
 * right (`?? null`); social.ts's copy path does not (`?? 0`). addEntry is the
 * house style.
 */
export interface MealEntry {
  id: string;
  user_id: string;
  date: string; // 'YYYY-MM-DD' — LOCAL. Always dateKey(new Date(eaten_at)).
  logged_at: string; // when the ROW was created (NOT NULL). Not when you ate.
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;

  /** NOT NULL. See EntrySource — read wide, write narrow. */
  source: string;

  barcode?: string | null;
  off_id?: string | null;

  /**
   * NULLABLE in the DB, and `number` was a lie.
   *
   * Every write path sets it, which is why nobody noticed — but a row that ever
   * got a null renders as "0g" in TodayScreen (Math.round(null) === 0) and,
   * worse, makes foodLookup.mealEntryToProduct fall back to `g = 100`, which
   * silently rescales every macro by 100/actual on the next edit.
   *
   * Typing it honestly turns both of those into compile errors. They are real
   * bugs, not new ones.
   */
  serving_g: number | null;

  /** NOT NULL, default 'breakfast', as of migration 3. */
  meal_type: MealType;

  brand?: string | null;

  // Nullable. NULL = unknown, 0 = zero grams. See the warning above.
  salt?: number | null;
  fibre?: number | null;
  sugar?: number | null;
  sat_fat?: number | null;

  /**
   * NOT NULL, default now(), as of migration 3. Required and non-null HERE.
   *
   * The `?` was the dangerous half of the old type, not the `| null`. An
   * explicit null now RAISES, loudly, thanks to the trigger. But OPTIONAL means
   * OMITTABLE, and an omitted column is exactly when a DEFAULT fires — so a
   * draft that simply forgot eaten_at would not crash. It would silently land
   * the meal at now(), derive planned = false, and walk into the WHOOP
   * correlation as a meal you ate.
   *
   * This is the join key for the entire product. It should be the hardest field
   * in this interface to get wrong, not the softest.
   */
  eaten_at: string;

  /** DERIVED by the DB trigger from eaten_at, at insert. NEVER set client-side. */
  planned: boolean;
  /** "yes, I ate it" — the only way a plan enters the correlation. */
  confirmed_at: string | null;
  /** "no, I didn't" — evidence. Counts toward nothing. */
  skipped_at: string | null;

  // ── Images (snapshotted at log time, like the macros above) ──
  // Same split as FoodProduct: image_url is directly renderable (OFF);
  // image_path is a storage object PATH in the private bucket and must be
  // signed via getSignedImageUrl() before display.
  image_url?: string | null;
  image_path?: string | null;

  // Provenance. Not needed to render the thumbnail — the image is snapshotted.
  // ON DELETE SET NULL (verified): deleting a custom food does not delete your
  // history, it just orphans the link.
  custom_food_id?: string | null;

  /** Fails safe: true means "we guessed when you ate this". */
  eaten_at_estimated: boolean;
}

// ─── D4: the shared apply path ───────────────────────────────

/**
 * A fully-resolved row destined for meal_entries. The caller has ALREADY
 * decided when this was (or will be) eaten; applyEntries() just writes it.
 *
 * This is the single shape that bundles, copy-a-day and the social copy all
 * flow through. They differ ONLY in which builder produces the draft.
 *
 * ─── WHAT THIS TYPE DELIBERATELY CANNOT EXPRESS ───
 *
 *   date       Derived from eaten_at INSIDE applyEntries, via local dateKey().
 *              Carrying both would let a caller construct a divergent pair —
 *              which is the D2 bug, and it shipped. resolveEatenAtAndDate()
 *              protects the CALLER from making a bad pair; this omission
 *              protects the TABLE from ever receiving one, no matter who writes
 *              the next builder.
 *
 *   planned    Derived by the BEFORE INSERT trigger from eaten_at, on the
 *              DATABASE clock. Applying a bundle to Thursday produces planned
 *              meals with no flag, no argument and no awareness of planning
 *              anywhere in the bundle code. If you find yourself wanting to add
 *              `planned` here, you have misunderstood the trigger.
 *
 *   targetMeal There isn't one. Copy-a-day must preserve EACH ROW's own
 *              meal_type (Monday's lunch → Tuesday's lunch), so meal_type is
 *              per-draft. The social path's "put their curry in my dinner"
 *              override is resolved by ITS builder, before it gets here.
 *
 *   user_id / id / logged_at    The DB owns all three.
 *
 * Same philosophy as MealEntryPatch: divergence is unrepresentable, not merely
 * discouraged. Do not widen it.
 */
export interface EntryDraft {
  name: string;
  brand: string | null;
  serving_g: number | null;

  calories: number;
  protein: number;
  carbs: number;
  fat: number;

  // null = UNKNOWN. 0 = zero grams. Do NOT coalesce on the way in.
  sat_fat: number | null;
  salt: number | null;
  fibre: number | null;
  sugar: number | null;

  meal_type: MealType;

  /**
   * ISO instant. REQUIRED. The caller resolved it — via sameTimeOnDay() for
   * bundles and copy-a-day, or new Date() for the social copy.
   *
   * Never build this with `+ 24h`. Across a DST boundary that lands Monday's
   * 12:30 lunch at 11:30 or 13:30 on Tuesday. sameTimeOnDay() goes through the
   * local Date constructor, which knows about clock changes.
   */
  eaten_at: string;

  /** Always true for an applied bundle: it's a prediction, however precise. */
  eaten_at_estimated: boolean;

  source: EntrySource;
  barcode: string | null;
  off_id: string | null;

  /**
   * ⚠ image_path and custom_food_id are CARRIED by draftsFromDay and
   * draftsFromComposition, and DROPPED by draftsFromFeedEntry.
   *
   * This is not an inconsistency to clean up. It falls out of storage RLS:
   * a bundle is YOUR food, so the private-bucket path is under YOUR folder and
   * getSignedImageUrl() will sign it. A friend's custom food lives under THEIR
   * folder and cannot be signed by you — you'd render a broken placeholder AND
   * embed their user id in your row for nothing. Same columns, two different
   * correct answers. Read the comment in src/lib/social.ts before unifying the
   * builders.
   */
  image_url: string | null;
  image_path: string | null;
  custom_food_id: string | null;
}

// ─── D4: compositions (bundle OR batch, as of migration 2) ───────────────

/** 'bundle': N independently loggable items. 'batch': N ingredients + a
 *  yield/portion → ONE merged output at apply. See meal_compositions.kind. */
export type CompositionKind = "bundle" | "batch";

/**
 * Mirrors public.meal_compositions (migration 5, renamed from meal_bundles by
 * the Batches feature's migration 1; kind/yield_g/portion_g/portion_label
 * added by migration 2 — see both migrations' comments).
 */
export interface MealComposition {
  id: string;
  user_id: string;
  name: string;

  /**
   * Ordering. use_count ALONE ossifies — January's bundle sits at the top
   * forever — so the list sorts by last_used_at first. Both are bumped
   * atomically by the bump_composition_use() RPC, never read-modify-written
   * from local state the way saved_ingredients does it (that pattern silently
   * loses increments across two devices).
   */
  use_count: number;
  last_used_at: string | null;

  created_at: string;
  // NOTE: no updated_at. The DB has two competing touch functions
  // (handle_updated_at, set_updated_at) and no trigger wired to either. A
  // column nothing maintains is a column that lies. last_used_at earns its keep.

  kind: CompositionKind;

  /**
   * BATCH ONLY — NULL for a bundle, enforced by meal_compositions_batch_shape,
   * not just convention. yield_g: total finished weight, grams. portion_g:
   * average single-portion weight, grams, always <= yield_g. portion_label:
   * display convenience ("1 pancake"), optional even for a batch — never used
   * in the macro math.
   *
   * Per-portion macro = (sum of ingredient macros) * portion_g / yield_g,
   * computed FRESH at apply time by draftsFromBatch — never stored, never
   * round-tripped.
   */
  yield_g: number | null;
  portion_g: number | null;
  portion_label: string | null;
}

/**
 * Mirrors public.meal_composition_items (migration 5, renamed from
 * meal_bundle_items — see meal_compositions above).
 *
 * SNAPSHOT, not a reference. Consistent with meal_entries. An OFF product's
 * values change under you; a custom food gets edited or deleted. A reference
 * rots; a snapshot cannot. Accepted cost: editing your "usual porridge" custom
 * food does NOT update the bundle that contains it.
 */
export interface MealCompositionItem {
  id: string;
  composition_id: string;
  user_id: string; // denormalised for RLS
  position: number;

  name: string;
  brand: string | null;
  serving_g: number | null;

  calories: number;
  protein: number;
  carbs: number;
  fat: number;

  // Same rule as MealEntry. NULL = unknown, 0 = zero grams.
  sat_fat: number | null;
  salt: number | null;
  fibre: number | null;
  sugar: number | null;

  /**
   * REQUIRED for a bundle item (each independently loggable), NULL for a
   * batch item (only the merged output gets a section, chosen at apply) —
   * enforced by meal_composition_items_validate_kind_biu (migration 2), not a
   * CHECK, because the rule depends on the PARENT composition's kind. See
   * lib/compositions.ts's bundleItemTime() before reading this for a bundle
   * item — it's guaranteed non-null there, but the type can't say so without
   * a discriminated union this file deliberately doesn't use.
   */
  meal_type: MealType | null;

  /**
   * A LOCAL WALL CLOCK, with no day attached. PostgREST hands it back as
   * "07:30:00" — use parseTimeOfDay() from src/lib/time.ts, never
   * `new Date(eaten_time)`.
   *
   * This is the type that makes bundles DST-safe by construction. An instant or
   * an offset would shift "07:30 porridge" by an hour across a clock change.
   * A `time` has no such opinion — the client rebuilds the instant on the target
   * day, and the platform handles the rest.
   *
   * REQUIRED for a bundle item, NULL for a batch item — same trigger, same
   * reason as meal_type above.
   */
  eaten_time: string | null;

  barcode: string | null;
  off_id: string | null;
  image_url: string | null;
  image_path: string | null;
  custom_food_id: string | null;
}

/** What getCompositions() returns: the composition with its items, ordered by position. */
export interface MealCompositionWithItems extends MealComposition {
  items: MealCompositionItem[];
}

/** A new item, before the DB has given it an id or a parent. */
export type MealCompositionItemDraft = Omit<
  MealCompositionItem,
  "id" | "composition_id" | "user_id"
>;

// ─── Saved ingredients ───────────────────────────────────────

// Mirrors public.saved_ingredients ("My Library").
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

  /**
   * ⚠ MISNAMED COLUMN. This is a storage object PATH into the private
   * custom-food-images bucket, NOT a URL. There is no image_path column on
   * custom_foods — the path lives here.
   *
   * foodLookup.customFoodToProduct() maps it to FoodProduct.image_PATH, which is
   * correct and is what keeps a private path out of meal_entries.image_url. Do
   * not "fix" that mapping to match the column name.
   */
  image_url: string | null;
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

/**
 * The SOCIAL copy payload. It is a NAVIGATION type, not a data-layer one —
 * CopyConfirmScreen receives it and turns it into EntryDrafts.
 *
 * targetMeal stops at the builder. It never reaches meal_entries: applyEntries
 * takes per-row meal_type, because copy-a-day has to preserve each row's own
 * section and a payload-level override cannot express that.
 */
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
  /**
   * Two unrelated callers, two shapes:
   *   - log flow (AddIngredientScreen): {date, mealType} — a found product
   *     replaces this screen with Product, targeting that meal.
   *   - batch-ingredient-picker flow: {onScanned} — a found product is
   *     handed back via callback and this screen pops, exactly like
   *     BatchIngredientPicker's own onPick (see the comment on that route
   *     below for why a callback param, not store state).
   * ScannerScreen branches on which key is present; never both.
   */
  Scanner:
    | { date: string; mealType: MealType; onScanned?: undefined }
    | { onScanned: (product: FoodProduct) => void; date?: undefined; mealType?: undefined };
  Product: {
    product: FoodProduct;
    date: string;
    mealType: MealType;
    editEntryId?: string;
    // now `| null` because MealEntry.serving_g is honestly nullable
    initialServingG?: number | null;
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

  /** Create when compositionId is omitted; edit that batch when given. */
  BatchEditor: { compositionId?: string };

  /**
   * ⚠ THE ONE ROUTE PARAM IN THIS LIST THAT ISN'T PLAIN DATA.
   *
   * A batch ingredient has no {date, mealType} target to navigate onward
   * with — unlike every food-adding flow above, it isn't going into a day at
   * all, just a draft ingredient list still being built on BatchEditorScreen.
   * Passing a callback closure back through the param is the standard React
   * Navigation pattern for "this picker screen hands a value back to
   * whoever opened it" when there's no shared store state to write into
   * instead — deliberately NOT threading a global batch-draft slice through
   * useStore for what is purely one screen's transient, unsaved form state.
   */
  BatchIngredientPicker: {
    onPick: (product: FoodProduct, quantityG: number) => void;
  };
};

export type BottomTabParamList = {
  Today: undefined;
  History: undefined;
  Friends: undefined;
  Batches: undefined;
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

// NOTE: DEFAULT_HOUR used to live in ProductScreen. It is now in
// src/lib/time.ts — it is a policy about TIME, and bundles need the same answer.

export type WhoopScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE";

/** One row of public.whoop_correlation. Column names are snake_case — this is
 *  read straight from a view, not through the camelCase mapping layer. */
export type WhoopCorrelationRow = {
  user_id: string;
  cycle_id: number;
  cycle_start: string;
  cycle_end: string | null;
  is_in_progress: boolean;
  cycle_local_date: string;

  // Same cycle: nutrition(N) fuelled strain(N).
  strain: number | null;
  kcal_same_cycle: number;
  protein_same_cycle: number;
  carbs_same_cycle: number;
  fat_same_cycle: number;
  sat_fat_same_cycle: number;
  salt_same_cycle: number;
  fibre_same_cycle: number;
  sugar_same_cycle: number;
  meal_count_same_cycle: number;

  // Lagged: nutrition(N-1) preceded recovery(N) and sleep(N). THE USP.
  prev_cycle_id: number | null;
  kcal_prev_cycle: number | null;
  protein_prev_cycle: number | null;
  carbs_prev_cycle: number | null;
  fat_prev_cycle: number | null;
  sat_fat_prev_cycle: number | null;
  salt_prev_cycle: number | null;
  fibre_prev_cycle: number | null;
  sugar_prev_cycle: number | null;
  meal_count_prev_cycle: number | null;
  last_meal_before_sleep_at: string | null;

  recovery_score: number | null;
  hrv_rmssd_milli: number | null;
  resting_heart_rate: number | null;
  spo2_percentage: number | null;
  skin_temp_celsius: number | null;
  user_calibrating: boolean | null;

  sleep_id: string | null;
  sleep_performance_percentage: number | null;
  sleep_efficiency_percentage: number | null;
  respiratory_rate: number | null;
  total_in_bed_time_milli: number | null;
  total_slow_wave_sleep_time_milli: number | null;
  total_rem_sleep_time_milli: number | null;
  disturbance_count: number | null;

  // Filter on these before you draw a single conclusion.
  cycle_scored: boolean;
  recovery_scored: boolean | null;
  sleep_scored: boolean | null;
  nutrition_present: boolean;
  prev_nutrition_present: boolean;
  prev_cycle_contiguous: boolean;
  timing_estimated_same_cycle: boolean;
  timing_estimated_prev_cycle: boolean;
};
