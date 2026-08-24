import { create } from "zustand";
import { supabase } from "../lib/supabase";
import {
  MealEntry,
  MealCompositionWithItems,
  SavedIngredient,
  SavedIngredientScored,
  Goals,
  DayTotals,
  MealType,
  FoodProduct,
  Workout,
  EntryDraft,
  CompositionKind,
} from "../types";
import { dateKey, TimeOfDay } from "../lib/time";
import { applyEntries, draftsFromDay, draftsForTarget } from "../lib/entries";
import * as compositionApi from "../lib/compositions";
import { reportError } from "../lib/reportError";

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

/**
 * Fields a caller is allowed to change on an existing entry.
 *
 * Deliberately NOT `Partial<MealEntry>`:
 *   - `date` is absent. It is DERIVED from `eaten_at` (see updateEntry). Letting a
 *     caller set it independently is how `date` and `eaten_at` diverged in D2 and
 *     put late-night meals on the wrong day.
 *   - `planned` is absent. It is set once, by the DB trigger, at insert. Moving a
 *     meal is not the same as saying you ate it.
 *   - `confirmed_at` / `skipped_at` are absent. Only confirmEntries / skipEntries
 *     may write them.
 *   - `id`, `user_id`, `logged_at` are absent. They are not editable.
 *
 * If you need one of those, add a purpose-built action. Do not widen this type.
 */
export type MealEntryPatch = Partial<
  Pick<
    MealEntry,
    | "name"
    | "brand"
    | "meal_type"
    | "serving_g"
    | "calories"
    | "protein"
    | "carbs"
    | "fat"
    | "sat_fat"
    | "salt"
    | "fibre"
    | "sugar"
    | "eaten_at"
    | "eaten_at_estimated"
    | "image_url"
    | "image_path"
  >
>;

/** One ingredient in an in-progress (unsaved) batch: a food (per-100g rate)
 *  plus how much of it, in grams. Same shape BatchIngredientInput wraps for
 *  the actual save call — see compositions.ts. */
export interface BatchDraftIngredient {
  key: string;
  product: FoodProduct;
  quantityG: number;
}

/**
 * The in-progress, unsaved batch being built on BatchEditorScreen.
 *
 * WHY THIS LIVES IN THE STORE, NOT SCREEN-LOCAL STATE
 *   BatchIngredientPickerScreen used to hand a picked product back to
 *   BatchEditorScreen via an `onPick` callback threaded through navigation
 *   params. React Navigation warns loudly about that ("Non-serializable
 *   values were found in the navigation state") because a function can't be
 *   JSON-serialised for state restore — so a killed-and-restored app with
 *   the picker on screen had a navigation stack it could never rebuild.
 *   Lifting the draft here means the picker calls addBatchIngredient(s)
 *   directly and pops itself; navigation params carry no callback at all.
 *
 * WHOLESALE STATE, NOT A SUPABASE ROW
 *   camelCase, client-only, never written directly — saving still goes
 *   through compositionApi.createBatchFromIngredients / updateBatch (see
 *   saveBatch/saveBatchEdits below), which is the ONLY place a batch's
 *   contents reach Postgres. This slice never touches meal_entries and
 *   never carries date/planned — those are trigger-owned, and a batch item
 *   has no date of its own until it's applied to one.
 *
 * LIFECYCLE
 *   Reset on every genuine exit from BatchEditorScreen (its `beforeRemove`
 *   listener — NOT blur, since losing focus to BatchIngredientPicker must
 *   NOT clear it), and hydrated from the existing composition once, at
 *   mount, when editing. See BatchEditorScreen.tsx for both.
 */
export interface BatchDraft {
  name: string;
  ingredients: BatchDraftIngredient[];
  totalYieldG: string;
  portionSizeG: string;
  portionLabel: string;
}

const EMPTY_BATCH_DRAFT: BatchDraft = {
  name: "",
  ingredients: [],
  totalYieldG: "",
  portionSizeG: "",
  portionLabel: "",
};

/**
 * One item in an in-progress apply-time quantity review (Phase 1).
 *
 * `originalDraft` is exactly what draftsFromComposition produced — anchored
 * onto the target day/time, but at the item's ORIGINAL saved quantity — and
 * is never mutated. `currentGramsG` is the user's live target for this
 * application only; scaleEntryDraftGrams always scales from
 * `originalDraft.serving_g` (the true denominator), never from a
 * previously-scaled value, so repeated edits can't compound rounding drift.
 *
 * `currentGramsG` starts equal to the item's own serving_g, which is null
 * for an item with no saved quantity — see scaleEntryDraftGrams's own
 * NULL/<=0 refusal for why that's what makes such an item "not rescalable,
 * applies unchanged" rather than needing a separate flag here.
 */
export interface CompositionApplyDraftItem {
  itemId: string;
  originalDraft: EntryDraft;
  currentGramsG: number | null;
}

/**
 * The in-progress, unsaved apply-time review for ONE bundle application.
 *
 * WHY THIS LIVES IN THE STORE, NOT NAVIGATION PARAMS OR SCREEN STATE
 *   Same reasoning as BatchDraft: React Navigation warns on non-serialisable
 *   params, and while an EntryDraft[] is itself plain data (unlike
 *   BatchDraft's old onPick callback), passing it through params would still
 *   mean a killed-and-restored app trying to rebuild a stack whose param
 *   blob doesn't round-trip cleanly. Lifting it into the store keeps
 *   BundleApplyReviewScreen's route paramless — it reads the draft, edits it
 *   in place via setCompositionApplyItemGrams, and applyCompositionDraft()
 *   reads it back out at confirm time.
 *
 * LIFECYCLE
 *   Built once by startCompositionApplyDraft, called from ApplyBundleSheet's
 *   time picker (the anchor step is unchanged — only what happens after it
 *   changed). Reset on every genuine exit from BundleApplyReviewScreen via a
 *   `beforeRemove` listener, same as BatchDraft — covers both Cancel (back)
 *   and a successful Confirm (which pops the screen too).
 */
export interface CompositionApplyDraft {
  compositionId: string;
  compositionName: string;
  /**
   * Captured from the composition at draft-build time, not re-derived —
   * Phase 2's save-back-to-definition is bundle-only (changing a batch
   * ingredient's grams alters the batch's yield/portion maths, a separate
   * problem — see updateBatch). Storing it here lets both
   * BundleApplyReviewScreen (whether to render the save-back control) and
   * saveCompositionApplyQuantities (whether to allow the write at all)
   * check the SAME captured value rather than trusting the caller twice.
   */
  compositionKind: CompositionKind;
  dayKey: string;
  items: CompositionApplyDraftItem[];
}

/**
 * True when `item` is rescalable AND its current target differs from the
 * item's own saved quantity. The single predicate both
 * saveCompositionApplyQuantities (which rows to write) and
 * BundleApplyReviewScreen (whether the save-back toggle has anything to do
 * — disabled when this is false for every item) need to agree on, so it
 * lives here rather than being reimplemented at each call site.
 *
 * Epsilon guard is float-comparison hygiene, not a meaningful gram
 * threshold: currentGramsG is always either the untouched originalServingG
 * or a value the user explicitly typed and committed.
 */
export function compositionApplyItemChanged(
  item: CompositionApplyDraftItem,
): boolean {
  const originalServingG = item.originalDraft.serving_g;
  if (originalServingG == null || originalServingG <= 0) return false;
  const targetGrams = item.currentGramsG ?? originalServingG;
  return Math.abs(targetGrams - originalServingG) > 1e-9;
}

/** Fresh key per add — same scheme BatchEditorScreen's local state used
 *  before this moved into the store. `i` guards addBatchIngredients: several
 *  items added in one synchronous call can share a Date.now() millisecond. */
const draftKey = (i = 0): string => `${Date.now()}-${i}-${Math.random()}`;

/** Macro totals split by whether the food has actually been eaten. */
export interface SplitTotals {
  /** Logged entries + confirmed planned entries. What actually went in you. */
  eaten: DayTotals;
  /** Planned entries not yet confirmed or skipped. The intention. */
  planned: DayTotals;
  /** eaten + planned. What the goal ring measures against. */
  total: DayTotals;
}

/** What a write action reports back. `null` error means it worked. */
export interface WriteResult {
  error: string | null;
}

interface AppState {
  userId: string | null;
  entries: MealEntry[];
  /** Read-only WHOOP workout spine — see fetchWorkouts. Never written here. */
  workouts: Workout[];
  compositions: MealCompositionWithItems[];
  savedIngredients: SavedIngredientScored[];
  goals: Goals;
  loading: boolean;

  /**
   * Incoming pending friend-request count — the Friends tab badge. Lives here
   * (not screen state) because TabBar needs it and FriendsScreen already has
   * the underlying rows. Deliberately eventually-consistent: refreshed on
   * app foreground, TabBar mount, and right after accept/decline on
   * FriendsScreen — never polled, there is no push infrastructure.
   */
  incomingRequestCount: number;
  fetchIncomingRequestCount: () => Promise<void>;

  setUserId: (id: string | null) => void;
  reset: () => void;
  fetchEntries: () => Promise<void>;
  fetchGoals: () => Promise<void>;
  fetchSavedIngredients: () => Promise<void>;
  fetchCompositions: () => Promise<void>;
  /** Unbounded, same caveat as fetchEntries — refetched on every screen focus. */
  fetchWorkouts: () => Promise<void>;

  /**
   * `planned`, `confirmed_at` and `skipped_at` are omitted on purpose: the DB
   * trigger derives them. The client never sends them, so no insert path — copy,
   * social, barcode, AI, anything written later — can get the rule wrong.
   */
  addEntry: (
    entry: Omit<
      MealEntry,
      "id" | "user_id" | "logged_at" | "planned" | "confirmed_at" | "skipped_at"
    >,
  ) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  /** Multi-delete, for selection mode. One round-trip, not N. */
  deleteEntries: (ids: string[]) => Promise<WriteResult>;

  /**
   * ⚠ RETURNS AN ERROR NOW. It used to swallow failures into console.warn and
   * return void — which was survivable until migration 5 gave the database a
   * reason to REFUSE an update (moving a logged meal into the future). A refusal
   * the UI can't see is a screen that closes as if it saved. Callers must check.
   */
  updateEntry: (id: string, patch: MealEntryPatch) => Promise<WriteResult>;
  saveGoals: (goals: Goals) => Promise<WriteResult>;

  /** "Yes, I ate these." Optionally correct the time while confirming. */
  confirmEntries: (
    ids: string[],
    correctedEatenAt?: Record<string, string>,
  ) => Promise<void>;
  /** "No, I didn't." Keeps the row as evidence; it counts toward nothing. */
  skipEntries: (ids: string[]) => Promise<void>;

  /**
   * Bulk retime, for selection mode. Writes ONLY eaten_at (+ derived date),
   * never a macro — so it cannot trip the ProductScreen round-trip that rewrites
   * calories on a time edit. Each row keeps its own calendar day; only the wall
   * clock moves. Returns an error so a no_future_logged refusal is visible.
   */
  retimeEntries: (
    ids: string[],
    hours: number,
    minutes: number,
  ) => Promise<WriteResult>;

  // ── D4 ──
  /** Copy entries onto another day, keeping each row's wall clock and section. */
  copyEntriesToDay: (
    entries: MealEntry[],
    targetDayKey: string,
  ) => Promise<WriteResult>;
  /**
   * Copy entries onto ONE chosen {day, meal_type, time} — the single-item
   * "Copy to…" sheet. Every entry passed in lands on the SAME slot; see
   * draftsForTarget in lib/entries.ts for why this isn't copyEntriesToDay.
   */
  copyEntriesTo: (
    entries: MealEntry[],
    target: { dayKey: string; meal_type: MealType; time: TimeOfDay },
  ) => Promise<WriteResult>;
  /** "Save these 4 as a bundle." */
  saveBundleFromEntries: (
    name: string,
    entries: MealEntry[],
  ) => Promise<WriteResult>;
  /** "Add these to an existing bundle." Why there is no bundle editor screen. */
  addEntriesToBundle: (
    composition: MealCompositionWithItems,
    entries: MealEntry[],
  ) => Promise<WriteResult>;
  renameComposition: (compositionId: string, name: string) => Promise<WriteResult>;
  removeCompositionItem: (
    compositionId: string,
    itemId: string,
  ) => Promise<WriteResult>;
  removeComposition: (compositionId: string) => Promise<WriteResult>;

  // ── Apply-time quantity review (Phase 1, pre-apply — see CompositionApplyDraft) ──
  compositionApplyDraft: CompositionApplyDraft | null;
  /** Builds the draft from draftsFromComposition. `anchor`, if given,
   *  re-times the whole bundle at once — see draftsFromComposition. */
  startCompositionApplyDraft: (
    composition: MealCompositionWithItems,
    targetDayKey: string,
    anchor?: TimeOfDay,
  ) => void;
  setCompositionApplyItemGrams: (itemId: string, grams: number) => void;
  resetCompositionApplyDraft: () => void;
  /** Scales every item off its own originalDraft/currentGramsG, inserts via
   *  applyCompositionDrafts, and mirrors the use-count bump locally. Does NOT
   *  clear compositionApplyDraft on success; BundleApplyReviewScreen's
   *  beforeRemove listener owns that, so the screen doesn't race its own
   *  "no draft" guard against a mid-confirm state change. THE only path that
   *  applies a bundle as of Phase 1 — ApplyBundleSheet's Add button always
   *  routes through BundleApplyReviewScreen first; there is no direct,
   *  un-reviewed apply. */
  applyCompositionDraft: () => Promise<WriteResult>;
  /**
   * Phase 2: "Also update this bundle." Independent of applyCompositionDraft
   * — the screen calls this SEPARATELY, after a successful apply (see
   * BundleApplyReviewScreen's handleConfirm for the ordering and why a
   * save-back failure must not undo or duplicate the apply). Bundle-only
   * (checks compositionKind), and only ever writes rows whose grams actually
   * changed from the item's own saved serving_g — an unrescalable item
   * (NULL/<=0 serving_g) is never included, same predicate as Phase 1's
   * read-only "applies unchanged" treatment.
   */
  saveCompositionApplyQuantities: () => Promise<WriteResult>;

  // ── Batches ──
  /** "Save these ingredients + yield/portion as a batch." */
  saveBatch: (input: compositionApi.BatchFormInput) => Promise<WriteResult>;
  /** Edit an existing batch — wholesale-replaces its ingredients. Never
   *  touches already-logged meal_entries; see updateBatch's own comment. */
  saveBatchEdits: (
    compositionId: string,
    input: compositionApi.BatchFormInput,
  ) => Promise<WriteResult>;
  /** Applies at `chosenAt` if given (date and time-of-day both come from
   *  that single instant), else applies right now — same as v1. */
  applyBatchNow: (
    composition: MealCompositionWithItems,
    chosenAt?: Date,
  ) => Promise<WriteResult>;

  // ── Batch draft (pre-save, client-only — see the BatchDraft type comment) ──
  batchDraft: BatchDraft;
  setBatchDraftName: (name: string) => void;
  setBatchDraftPortionLabel: (portionLabel: string) => void;
  setBatchDraftTotalYieldG: (totalYieldG: string) => void;
  setBatchDraftPortionSizeG: (portionSizeG: string) => void;
  /** Wholesale replace — used to hydrate from an existing composition when
   *  BatchEditorScreen opens in edit mode. */
  setBatchDraftIngredients: (ingredients: BatchDraftIngredient[]) => void;
  /** BatchIngredientPicker's single-add path. Also clears yield/portion —
   *  see BatchEditorScreen's YIELD-ON-EDIT note: the ingredient set changing
   *  invalidates any previously entered yield. */
  addBatchIngredient: (product: FoodProduct, quantityG: number) => void;
  /** Same, for several resolved ingredients at once — the shape the
   *  upcoming recipe-scan confirm screen needs (resolved ingredients arrive
   *  together, not one at a time). Do not build a picker-only add path that
   *  this can't also use. */
  addBatchIngredients: (
    items: { product: FoodProduct; quantityG: number }[],
  ) => void;
  removeBatchIngredient: (key: string) => void;
  updateBatchIngredientQuantity: (key: string, quantityG: number) => void;
  resetBatchDraft: () => void;

  /**
   * Cross-screen handoff for CreateFoodScreen → ProductScreen, opened as a
   * `returnToOpener` sheet from Phase 3's "Enter nutrition manually"
   * affordance. Exists because CLAUDE.md forbids functions through
   * navigation params — CreateFoodScreen can't just hand ProductScreen a
   * `setDraft` callback, so it writes the result here instead and
   * `goBack()`s; ProductScreen reads it back on refocus.
   *
   * Write-once / read-once / clear-on-read BY CONSTRUCTION:
   * consumeManualEntryResult() is the only way to read this, and it always
   * clears on the way out — there is no plain getter, so a stale value
   * can't be read twice or leak into an unrelated later session.
   */
  manualEntryResult: FoodProduct | null;
  setManualEntryResult: (product: FoodProduct) => void;
  /** Returns the pending result AND clears it in the same call. */
  consumeManualEntryResult: () => FoodProduct | null;

  saveIngredient: (product: FoodProduct) => Promise<SavedIngredientScored | null>;
  deleteIngredient: (id: string) => Promise<void>;

  /** Counts toward goals: logged + confirmed + unconfirmed-planned. Excludes skipped. */
  getTotalsForDate: (date: string) => DayTotals;
  /** Same set, split into eaten vs planned, for the two-arc ring. */
  getSplitTotalsForDate: (date: string) => SplitTotals;
  getEntriesForMeal: (date: string, mealType: MealType) => MealEntry[];
  /** Everything visible on a day, across all four sections. What copy-a-day copies. */
  getEntriesForDate: (date: string) => MealEntry[];
  /** WHOOP workouts on this LOCAL day, sorted by start time. Keys off
   *  localDate, not date — the spine column exposed for exactly this join. */
  getWorkoutsForDate: (date: string) => Workout[];
  /** Every planned meal awaiting an answer, any day. For the Review screen. */
  getPendingEntries: () => MealEntry[];
  /** Pending meals whose calendar day has ENDED. For the banner — never nags about today. */
  getDuePendingEntries: () => MealEntry[];
  getAllEntries: () => MealEntry[];
}

/** Re-exported for the screens that already import it from here. */
export const todayKey = (): string => dateKey();

/** Awaiting an answer: planned, neither confirmed nor skipped. Exported so
 *  callers outside the store (ConnectedUserLogScreen) don't redefine it. */
export const isPending = (e: MealEntry): boolean =>
  e.planned && !e.confirmed_at && !e.skipped_at;

/** Actually eaten: a normal logged entry, or a planned one the user confirmed. */
export const isEaten = (e: MealEntry): boolean => !e.planned || !!e.confirmed_at;

/** Answered "no". Counts toward nothing — not goals, not correlation, not sections. */
const isSkipped = (e: MealEntry): boolean => !!e.skipped_at;

const EMPTY_TOTALS: DayTotals = {
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  satFat: 0,
  salt: 0,
  fibre: 0,
  sugar: 0,
};

function sumMacros(entries: MealEntry[]): DayTotals {
  return entries.reduce<DayTotals>(
    (t, e) => ({
      calories: t.calories + e.calories,
      protein: t.protein + e.protein,
      carbs: t.carbs + e.carbs,
      fat: t.fat + e.fat,
      // Coalesce on the READ. A single NULL from an old row would otherwise turn
      // the whole total into NaN. (On a WRITE this idiom is destructive — see
      // the note in src/types/index.ts.)
      satFat: t.satFat + (e.sat_fat ?? 0),
      salt: t.salt + (e.salt ?? 0),
      fibre: t.fibre + (e.fibre ?? 0),
      sugar: t.sugar + (e.sugar ?? 0),
    }),
    { ...EMPTY_TOTALS },
  );
}

const addTotals = (a: DayTotals, b: DayTotals): DayTotals => ({
  calories: a.calories + b.calories,
  protein: a.protein + b.protein,
  carbs: a.carbs + b.carbs,
  fat: a.fat + b.fat,
  satFat: a.satFat + b.satFat,
  salt: a.salt + b.salt,
  fibre: a.fibre + b.fibre,
  sugar: a.sugar + b.sugar,
});

/** Chronological within a meal section. `logged_at` is useless here — five meal-prepped
 *  chillis are created in the same two seconds and would otherwise sort arbitrarily.
 *  Doubly so now: a bundle inserts all its items in ONE statement. */
const byEatenAt = (a: MealEntry, b: MealEntry): number =>
  a.eaten_at.localeCompare(b.eaten_at);

const msg = (e: unknown, fallback: string): string =>
  e instanceof Error ? e.message : fallback;

export const useStore = create<AppState>((set, get) => ({
  userId: null,
  entries: [],
  workouts: [],
  compositions: [],
  savedIngredients: [],
  goals: DEFAULT_GOALS,
  loading: false,
  incomingRequestCount: 0,
  batchDraft: EMPTY_BATCH_DRAFT,
  compositionApplyDraft: null,
  manualEntryResult: null,

  setUserId: (id) => set({ userId: id }),

  /** Wipe every trace of the signed-in user. Called on sign-out. */
  reset: () =>
    set({
      userId: null,
      entries: [],
      workouts: [],
      compositions: [],
      savedIngredients: [],
      goals: DEFAULT_GOALS,
      loading: false,
      incomingRequestCount: 0,
      batchDraft: EMPTY_BATCH_DRAFT,
      compositionApplyDraft: null,
      manualEntryResult: null,
    }),

  // NOTE: still unbounded. ~2,200 rows/year today; planning pushed that up and
  // bundles push it up again, re-fetched on every screen focus.
  //
  // D4 MITIGATION: every write path below now APPENDS the RETURNING rows to
  // local state instead of triggering a refetch. That's instant UI and it means
  // applying a five-item bundle costs one insert, not one insert plus a full
  // table scan. The unbounded fetchEntries() is still there on focus.
  //
  // The bounded query, when it lands, is "last N days + everything future +
  // everything pending" — not a flat date window, because a pending meal from
  // three weeks ago must still reach the banner.
  fetchEntries: async () => {
    const { userId } = get();
    if (!userId) return;
    set({ loading: true });
    const { data, error } = await supabase
      .from("meal_entries")
      .select("*")
      .eq("user_id", userId)
      .order("logged_at", { ascending: false });
    if (error) reportError("fetchEntries", error);
    if (!error && data) set({ entries: data as MealEntry[] });
    set({ loading: false });
  },

  fetchCompositions: async () => {
    const { userId } = get();
    if (!userId) return;
    try {
      set({ compositions: await compositionApi.getCompositions() });
    } catch (e) {
      reportError("fetchCompositions", e);
    }
  },

  // Read-only WHOOP spine, same unbounded-refetch-on-focus shape as
  // fetchEntries above (no windowed query here either). biometric_workouts
  // is security_invoker, so RLS already scopes it to the caller — the
  // explicit .eq mirrors fetchEntries rather than relying on that alone.
  fetchWorkouts: async () => {
    const { userId } = get();
    if (!userId) return;
    const { data, error } = await supabase
      .from("biometric_workouts")
      .select("*")
      .eq("user_id", userId);
    if (error) {
      reportError("fetchWorkouts", error);
      return;
    }
    if (!data) return;

    // EXPLICIT snake_case → camelCase mapping — no spread. NULL-faithful:
    // strain/HR/energy/distance are nullable on the spine and stay that way.
    const workouts: Workout[] = data.map((w) => ({
      id: w.source_workout_id,
      ingestSource: w.ingest_source,
      workoutStart: w.workout_start,
      workoutEnd: w.workout_end,
      timezoneOffset: w.timezone_offset,
      localDate: w.local_date,
      sportName: w.sport_name,
      strain: w.strain,
      averageHeartRate: w.average_heart_rate,
      maxHeartRate: w.max_heart_rate,
      energyKilojoule: w.energy_kilojoule,
      distanceMeter: w.distance_meter,
      strainScoreState: w.strain_score_state,
    }));
    set({ workouts });
  },

  fetchGoals: async () => {
    const { userId } = get();
    if (!userId) return;
    const { data, error } = await supabase
      .from("goals")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error) reportError("fetchGoals", error, { level: "error" });
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

  /**
   * Count only — head: true means PostgREST returns the count without the
   * matching rows, so this is a single-row response, not the full
   * getIncomingRequests() profile join FriendsScreen uses for its own list.
   * Log-only on failure: a badge that fails to load must never surface an
   * Alert or block the tab bar, so state is simply left at its last-known
   * value rather than reset to 0.
   */
  fetchIncomingRequestCount: async () => {
    const { userId } = get();
    if (!userId) return;
    const { count, error } = await supabase
      .from("follows")
      .select("*", { count: "exact", head: true })
      .eq("following_id", userId)
      .eq("status", "pending");
    if (error) {
      reportError("fetchIncomingRequestCount", error);
      return;
    }
    set({ incomingRequestCount: count ?? 0 });
  },

  fetchSavedIngredients: async () => {
    const { userId } = get();
    if (!userId) return;
    // saved_ingredients_scored, not the base table — adds decay_score
    // (recency-decayed use, computed from meal_entries) and last_used_at.
    // See 20260815100000_saved_ingredients_decay_score.sql.
    const { data, error } = await supabase
      .from("saved_ingredients_scored")
      .select("*")
      .eq("user_id", userId)
      .order("decay_score", { ascending: false });
    if (error) reportError("fetchSavedIngredients", error, { level: "error" });
    if (data) set({ savedIngredients: data as SavedIngredientScored[] });
  },

  addEntry: async (entry) => {
    const { userId } = get();
    if (!userId) return;

    // EXPLICIT snake_case mapping — do NOT spread. Listing every column makes a
    // forgotten one a compile error at the call site instead of a silent null.
    //
    // `planned` / `confirmed_at` / `skipped_at` are ABSENT by design. The BEFORE
    // INSERT trigger owns them, using the DATABASE clock. A phone with a skewed
    // clock cannot mislabel a meal, and a future insert path cannot forget the rule.
    // The derived value comes straight back in the RETURNING row below.
    const { data, error } = await supabase
      .from("meal_entries")
      .insert({
        user_id: userId,
        logged_at: new Date().toISOString(),

        date: entry.date, // LOCAL day, from dateKey(). Never derived in SQL.
        meal_type: entry.meal_type,
        name: entry.name,
        brand: entry.brand ?? null,
        source: entry.source,

        serving_g: entry.serving_g,
        calories: entry.calories,
        protein: entry.protein,
        carbs: entry.carbs,
        fat: entry.fat,

        // `?? null`, NOT `?? 0`. NULL means "unknown"; 0 means "zero grams".
        // Coalescing to 0 here would destroy that distinction permanently.
        sat_fat: entry.sat_fat ?? null,
        salt: entry.salt ?? null,
        fibre: entry.fibre ?? null,
        sugar: entry.sugar ?? null,

        barcode: entry.barcode ?? null,
        off_id: entry.off_id ?? null,

        // An explicit NULL here would DEFEAT the column default — Postgres only
        // applies a default when the column is omitted. eaten_at is NOT NULL and
        // required by the type, so this cannot be forgotten any more.
        eaten_at: entry.eaten_at,
        eaten_at_estimated: entry.eaten_at_estimated,

        image_url: entry.image_url ?? null,
        image_path: entry.image_path ?? null,
        custom_food_id: entry.custom_food_id ?? null,
      })
      .select()
      .single();

    if (error) {
      reportError("addEntry", error, { level: "error" });
      return;
    }
    if (data) set((s) => ({ entries: [data as MealEntry, ...s.entries] }));
  },

  deleteEntry: async (id) => {
    const { error } = await supabase.from("meal_entries").delete().eq("id", id);
    if (error) {
      // Do NOT drop it locally. A failed delete that vanishes from the UI comes
      // back to life on the next fetch, which looks like a ghost.
      reportError("deleteEntry", error, { level: "error" });
      return;
    }
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  deleteEntries: async (ids) => {
    if (ids.length === 0) return { error: null };
    const { error } = await supabase
      .from("meal_entries")
      .delete()
      .in("id", ids);
    if (error) {
      reportError("deleteEntries", error, { level: "error" });
      return { error: "Couldn't remove those. Check your connection." };
    }
    const gone = new Set(ids);
    set((s) => ({ entries: s.entries.filter((e) => !gone.has(e.id)) }));
    return { error: null };
  },

  updateEntry: async (id, patch) => {
    // `date` is DERIVED, never passed in. If eaten_at moves, the day follows it.
    // This is the only place that relationship is enforced, and MealEntryPatch is
    // shaped so a caller cannot bypass it.
    const next: Record<string, unknown> = { ...patch };
    if (patch.eaten_at !== undefined) {
      next.date = dateKey(new Date(patch.eaten_at));
    }

    const { data, error } = await supabase
      .from("meal_entries")
      .update(next)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      reportError("updateEntry", error, { level: "error" });

      // Migration 5's meal_entries_no_future_logged_bu raises when you try to
      // move a LOGGED meal into the future. That refusal is correct — a plan is
      // not a fact, and time must not launder one into the other in either
      // direction — but the user needs to be TOLD, and offered the thing they
      // actually wanted, which is a copy.
      //
      // Matched on the message rather than the SQLSTATE because PostgREST
      // surfaces a plpgsql RAISE as a generic error; if you tighten the trigger's
      // errcode later, tighten this with it.
      if (/cannot move a logged meal into the future/i.test(error.message)) {
        return {
          error:
            "You've already eaten this, so it can't be moved to a future day — that would tell the app you ate it then. Copy it to that day instead.",
        };
      }
      return { error: "Couldn't save that change. Check your connection." };
    }

    if (data) {
      set((s) => ({
        entries: s.entries.map((e) => (e.id === id ? (data as MealEntry) : e)),
      }));
    }
    return { error: null };
  },

  confirmEntries: async (ids, correctedEatenAt) => {
    if (ids.length === 0) return;
    const now = new Date().toISOString();

    // Meals whose time the user corrected while confirming need a per-row update:
    // eaten_at moved, so `date` must follow, and the time is no longer a guess.
    const corrected = correctedEatenAt ?? {};
    const plainIds = ids.filter((id) => !corrected[id]);

    const updates: Promise<void>[] = Object.entries(corrected)
      .filter(([id]) => ids.includes(id))
      .map(async ([id, eatenAt]) => {
        const { data, error } = await supabase
          .from("meal_entries")
          .update({
            eaten_at: eatenAt,
            date: dateKey(new Date(eatenAt)),
            eaten_at_estimated: false, // they told us the real time
            confirmed_at: now,
          })
          .eq("id", id)
          .select()
          .single();
        if (error) {
          reportError("confirmEntries", error, { level: "error" });
          return;
        }
        if (data)
          set((s) => ({
            entries: s.entries.map((e) =>
              e.id === id ? (data as MealEntry) : e,
            ),
          }));
      });

    if (plainIds.length > 0) {
      updates.push(
        (async () => {
          // eaten_at_estimated stays TRUE: they said "yes" to the whole batch, not
          // to a specific clock time. It fails safe, which is the point of the column.
          const { data, error } = await supabase
            .from("meal_entries")
            .update({ confirmed_at: now })
            .in("id", plainIds)
            .select();
          if (error) {
            reportError("confirmEntries", error, { level: "error" });
            return;
          }
          if (data) {
            const byId = new Map(
              (data as MealEntry[]).map((e) => [e.id, e] as const),
            );
            set((s) => ({
              entries: s.entries.map((e) => byId.get(e.id) ?? e),
            }));
          }
        })(),
      );
    }

    await Promise.all(updates);
  },

  skipEntries: async (ids) => {
    if (ids.length === 0) return;
    // NOT a delete. The row persists as evidence of a plan abandoned — which is
    // what makes "you skip your planned dinner 40% of Thursdays" possible later.
    // It counts toward nothing: not goals, not sections, not the correlation.
    const { data, error } = await supabase
      .from("meal_entries")
      .update({ skipped_at: new Date().toISOString() })
      .in("id", ids)
      .select();
    if (error) {
      reportError("skipEntries", error, { level: "error" });
      return;
    }
    if (data) {
      const byId = new Map(
        (data as MealEntry[]).map((e) => [e.id, e] as const),
      );
      set((s) => ({ entries: s.entries.map((e) => byId.get(e.id) ?? e) }));
    }
  },

  retimeEntries: async (ids, hours, minutes) => {
    if (ids.length === 0) return { error: null };
    const { entries } = get();
    const nowMs = Date.now();

    // One time, applied per row. Each keeps its OWN calendar day: we take that
    // row's existing eaten_at and swap only the hours/minutes, so retiming a
    // selection that spans days doesn't drag everything onto one date.
    const results = await Promise.all(
      ids.map(async (id) => {
        const cur = entries.find((e) => e.id === id);
        if (!cur) return { id, ok: false as const, reason: "not found" };

        const next = new Date(cur.eaten_at);
        next.setHours(hours, minutes, 0, 0);

        const nextPatch: Record<string, unknown> = {
          eaten_at: next.toISOString(),
          date: dateKey(next), // LOCAL day, follows eaten_at. Never in SQL.
        };
        // A PAST time is a real time — the user is recording when they actually
        // ate, so it stops being an estimate. A future time is still a forecast,
        // so leave the flag alone. (This mirrors ProductScreen's rule.)
        if (next.getTime() <= nowMs) nextPatch.eaten_at_estimated = false;

        const { data, error } = await supabase
          .from("meal_entries")
          .update(nextPatch)
          .eq("id", id)
          .select()
          .single();

        if (error) {
          reportError("retimeEntries", error, { level: "error" });
          return { id, ok: false as const, reason: error.message };
        }
        return { id, ok: true as const, row: data as MealEntry };
      }),
    );

    const updated = new Map(
      results.flatMap((r) => (r.ok ? [[r.id, r.row] as const] : [])),
    );
    if (updated.size > 0) {
      set((s) => ({ entries: s.entries.map((e) => updated.get(e.id) ?? e) }));
    }

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      // Same refusal ProductScreen's edit path handles: the no_future_logged
      // trigger rejects moving an EATEN meal (logged, or a confirmed plan) into
      // the future. Matched on message, in step with updateEntry above.
      const futureRefusal = failures.some(
        (f) =>
          !f.ok && /cannot move a logged meal into the future/i.test(f.reason),
      );
      return {
        error: futureRefusal
          ? "Some of these are already eaten, so they can't move to a future time. Copy them to that day instead."
          : "Couldn't set the time on some of those. Check your connection.",
      };
    }
    return { error: null };
  },

  // ─── D4 ────────────────────────────────────────────────────

  copyEntriesToDay: async (entries, targetDayKey) => {
    if (entries.length === 0) return { error: null };
    try {
      // The rows come back with the trigger's `planned` already decided. Append
      // THOSE, never a guess — copying to a future day produces planned = true,
      // and a store that assumed false would put a plan into your correlation.
      const inserted = await applyEntries(draftsFromDay(entries, targetDayKey));
      set((s) => ({ entries: [...inserted, ...s.entries] }));
      return { error: null };
    } catch (e) {
      reportError("copyEntriesToDay", e, { level: "error" });
      return { error: msg(e, "Couldn't copy those. Check your connection.") };
    }
  },

  copyEntriesTo: async (entries, target) => {
    if (entries.length === 0) return { error: null };
    try {
      // Same rule as copyEntriesToDay: append the trigger's own `planned`
      // from the RETURNING row, never a guess — a target slot in the future
      // comes back planned = true regardless of what the source rows were.
      const inserted = await applyEntries(draftsForTarget(entries, target));
      set((s) => ({ entries: [...inserted, ...s.entries] }));
      return { error: null };
    } catch (e) {
      reportError("copyEntriesTo", e, { level: "error" });
      return { error: msg(e, "Couldn't copy that. Check your connection.") };
    }
  },

  saveBundleFromEntries: async (name, entries) => {
    try {
      const composition = await compositionApi.createBundleFromEntries(
        name,
        entries,
      );
      set((s) => ({ compositions: [composition, ...s.compositions] }));
      return { error: null };
    } catch (e) {
      reportError("saveBundleFromEntries", e, { level: "error" });
      return { error: msg(e, "Couldn't save the bundle.") };
    }
  },

  addEntriesToBundle: async (composition, entries) => {
    try {
      const items = await compositionApi.appendEntriesToBundle(
        composition,
        entries,
      );
      set((s) => ({
        compositions: s.compositions.map((c) =>
          c.id === composition.id
            ? {
                ...c,
                items: [...c.items, ...items].sort(
                  (a, z) => a.position - z.position,
                ),
              }
            : c,
        ),
      }));
      return { error: null };
    } catch (e) {
      reportError("addEntriesToBundle", e, { level: "error" });
      return { error: msg(e, "Couldn't add those to the bundle.") };
    }
  },

  startCompositionApplyDraft: (composition, targetDayKey, anchor) => {
    const drafts = compositionApi.draftsFromComposition(
      composition,
      targetDayKey,
      anchor,
    );
    set({
      compositionApplyDraft: {
        compositionId: composition.id,
        compositionName: composition.name,
        compositionKind: composition.kind,
        dayKey: targetDayKey,
        // 1:1 with drafts — draftsFromComposition maps composition.items in
        // order without filtering, so index i is always item i's own draft.
        items: composition.items.map((item, i) => ({
          itemId: item.id,
          originalDraft: drafts[i],
          currentGramsG: item.serving_g,
        })),
      },
    });
  },

  setCompositionApplyItemGrams: (itemId, grams) =>
    set((s) => {
      if (!s.compositionApplyDraft) return {};
      return {
        compositionApplyDraft: {
          ...s.compositionApplyDraft,
          items: s.compositionApplyDraft.items.map((it) =>
            it.itemId === itemId ? { ...it, currentGramsG: grams } : it,
          ),
        },
      };
    }),

  resetCompositionApplyDraft: () => set({ compositionApplyDraft: null }),

  applyCompositionDraft: async () => {
    const draft = get().compositionApplyDraft;
    if (!draft) return { error: "Nothing to apply." };
    try {
      const finalDrafts = draft.items.map((it) =>
        compositionApi.scaleEntryDraftGrams(
          it.originalDraft,
          it.originalDraft.serving_g,
          it.currentGramsG ?? it.originalDraft.serving_g ?? 0,
        ),
      );
      const inserted = await compositionApi.applyCompositionDrafts(
        draft.compositionId,
        finalDrafts,
      );
      set((s) => ({
        entries: [...inserted, ...s.entries],
        // Mirror bump_composition_use's effect locally so the compositions
        // list re-sorts (last_used_at desc, then use_count desc) immediately,
        // rather than jumping around on the next fetch.
        compositions: s.compositions
          .map((c) =>
            c.id === draft.compositionId
              ? {
                  ...c,
                  use_count: c.use_count + 1,
                  last_used_at: new Date().toISOString(),
                }
              : c,
          )
          .sort((a, z) => {
            const al = a.last_used_at ?? "";
            const zl = z.last_used_at ?? "";
            if (al !== zl) return zl.localeCompare(al);
            return z.use_count - a.use_count;
          }),
      }));
      return { error: null };
    } catch (e) {
      reportError("applyCompositionDraft", e, { level: "error" });
      return { error: msg(e, "Couldn't apply the bundle.") };
    }
  },

  saveCompositionApplyQuantities: async () => {
    const draft = get().compositionApplyDraft;
    if (!draft) return { error: "Nothing to save." };

    // Bundle-only — see the CompositionApplyDraft.compositionKind comment.
    // Belt-and-braces against BundleApplyReviewScreen's own gating on the
    // same field, same "don't trust the caller filtered first" posture as
    // previewComposition's kind check in compositions.ts.
    if (draft.compositionKind !== "bundle") {
      return { error: "Only bundles can be updated this way." };
    }

    // Only rescalable AND actually-changed items — never write a row
    // nothing changed, and never write a row that was never rescalable in
    // the first place (no denominator to have scaled from).
    const updates: compositionApi.CompositionItemQuantityUpdate[] = [];
    for (const it of draft.items) {
      if (!compositionApplyItemChanged(it)) continue;

      const originalServingG = it.originalDraft.serving_g as number; // non-null, non-zero — guaranteed by the check above
      const targetGrams = it.currentGramsG ?? originalServingG;

      const scaled = compositionApi.scaleEntryDraftGrams(
        it.originalDraft,
        originalServingG,
        targetGrams,
      );
      updates.push({
        itemId: it.itemId,
        serving_g: targetGrams,
        calories: scaled.calories,
        protein: scaled.protein,
        carbs: scaled.carbs,
        fat: scaled.fat,
        sat_fat: scaled.sat_fat,
        salt: scaled.salt,
        fibre: scaled.fibre,
        sugar: scaled.sugar,
      });
    }

    if (updates.length === 0) return { error: null }; // nothing changed — not an error

    try {
      await compositionApi.updateCompositionItemQuantities(updates);
      set((s) => ({
        // In-place cache update, not a refetch — matches every other
        // composition write in this store (addEntriesToBundle,
        // applyCompositionDraft, removeCompositionItem, etc). This is also
        // what keeps ApplyBundleSheet's "N items · Xkcal" subtitle
        // (computed fresh from bundle.items at render) correct immediately,
        // without a round-trip.
        compositions: s.compositions.map((c) =>
          c.id === draft.compositionId
            ? {
                ...c,
                items: c.items.map((item) => {
                  const u = updates.find((x) => x.itemId === item.id);
                  return u
                    ? {
                        ...item,
                        serving_g: u.serving_g,
                        calories: u.calories,
                        protein: u.protein,
                        carbs: u.carbs,
                        fat: u.fat,
                        sat_fat: u.sat_fat,
                        salt: u.salt,
                        fibre: u.fibre,
                        sugar: u.sugar,
                      }
                    : item;
                }),
              }
            : c,
        ),
      }));
      return { error: null };
    } catch (e) {
      reportError("saveCompositionApplyQuantities", e, { level: "error" });
      return { error: msg(e, "Couldn't update the bundle.") };
    }
  },

  renameComposition: async (compositionId, name) => {
    try {
      const updated = await compositionApi.renameComposition(
        compositionId,
        name,
      );
      set((s) => ({
        compositions: s.compositions.map((c) =>
          c.id === compositionId ? { ...c, name: updated.name } : c,
        ),
      }));
      return { error: null };
    } catch (e) {
      reportError("renameComposition", e, { level: "error" });
      return { error: msg(e, "Couldn't rename that.") };
    }
  },

  removeCompositionItem: async (compositionId, itemId) => {
    try {
      await compositionApi.deleteCompositionItem(itemId);
      set((s) => ({
        compositions: s.compositions.map((c) =>
          c.id === compositionId
            ? { ...c, items: c.items.filter((i) => i.id !== itemId) }
            : c,
        ),
      }));
      return { error: null };
    } catch (e) {
      reportError("removeCompositionItem", e, { level: "error" });
      return { error: msg(e, "Couldn't remove that item.") };
    }
  },

  removeComposition: async (compositionId) => {
    try {
      await compositionApi.deleteComposition(compositionId);
      set((s) => ({
        compositions: s.compositions.filter((c) => c.id !== compositionId),
      }));
      return { error: null };
    } catch (e) {
      reportError("removeComposition", e, { level: "error" });
      return { error: msg(e, "Couldn't delete that bundle.") };
    }
  },

  // ─── Batches ─────────────────────────────────────────────────

  saveBatch: async (input) => {
    try {
      const composition = await compositionApi.createBatchFromIngredients(input);
      set((s) => ({ compositions: [composition, ...s.compositions] }));
      return { error: null };
    } catch (e) {
      reportError("saveBatch", e, { level: "error" });
      return { error: msg(e, "Couldn't save the batch.") };
    }
  },

  saveBatchEdits: async (compositionId, input) => {
    try {
      const updated = await compositionApi.updateBatch(compositionId, input);
      set((s) => ({
        compositions: s.compositions.map((c) =>
          c.id === compositionId ? updated : c,
        ),
      }));
      return { error: null };
    } catch (e) {
      reportError("saveBatchEdits", e, { level: "error" });
      return { error: msg(e, "Couldn't save those changes.") };
    }
  },

  applyBatchNow: async (composition, chosenAt) => {
    try {
      // No chosenAt: original v1 call, unchanged — applyBatch defaults `now`
      // itself and there's no picked instant to pass. With chosenAt: `now` is
      // left at its default (the real clock) deliberately — it's what
      // eaten_at_estimated is judged against, and reusing chosenAt for it
      // would compare the picked time against itself and never come out
      // planned. See draftsFromBatch's comment.
      const inserted = chosenAt
        ? await compositionApi.applyBatch(
            composition,
            { date: dateKey(chosenAt) },
            new Date(),
            chosenAt,
          )
        : await compositionApi.applyBatch(composition, { date: todayKey() });
      set((s) => ({
        entries: [inserted, ...s.entries],
        // Mirror bump_composition_use's effect locally, same as
        // applyCompositionDraft.
        compositions: s.compositions
          .map((c) =>
            c.id === composition.id
              ? {
                  ...c,
                  use_count: c.use_count + 1,
                  last_used_at: new Date().toISOString(),
                }
              : c,
          )
          .sort((a, z) => {
            const al = a.last_used_at ?? "";
            const zl = z.last_used_at ?? "";
            if (al !== zl) return zl.localeCompare(al);
            return z.use_count - a.use_count;
          }),
      }));
      return { error: null };
    } catch (e) {
      reportError("applyBatchNow", e, { level: "error" });
      return { error: msg(e, "Couldn't log that.") };
    }
  },

  // ─── Batch draft ────────────────────────────────────────────

  setBatchDraftName: (name) =>
    set((s) => ({ batchDraft: { ...s.batchDraft, name } })),
  setBatchDraftPortionLabel: (portionLabel) =>
    set((s) => ({ batchDraft: { ...s.batchDraft, portionLabel } })),
  setBatchDraftTotalYieldG: (totalYieldG) =>
    set((s) => ({ batchDraft: { ...s.batchDraft, totalYieldG } })),
  setBatchDraftPortionSizeG: (portionSizeG) =>
    set((s) => ({ batchDraft: { ...s.batchDraft, portionSizeG } })),
  setBatchDraftIngredients: (ingredients) =>
    set((s) => ({ batchDraft: { ...s.batchDraft, ingredients } })),

  addBatchIngredient: (product, quantityG) =>
    set((s) => ({
      batchDraft: {
        ...s.batchDraft,
        ingredients: [
          ...s.batchDraft.ingredients,
          { key: draftKey(), product, quantityG },
        ],
        totalYieldG: "",
        portionSizeG: "",
      },
    })),

  addBatchIngredients: (items) =>
    set((s) => ({
      batchDraft: {
        ...s.batchDraft,
        ingredients: [
          ...s.batchDraft.ingredients,
          ...items.map((item, i) => ({
            key: draftKey(i),
            product: item.product,
            quantityG: item.quantityG,
          })),
        ],
        totalYieldG: "",
        portionSizeG: "",
      },
    })),

  removeBatchIngredient: (key) =>
    set((s) => ({
      batchDraft: {
        ...s.batchDraft,
        ingredients: s.batchDraft.ingredients.filter((i) => i.key !== key),
        totalYieldG: "",
        portionSizeG: "",
      },
    })),

  updateBatchIngredientQuantity: (key, quantityG) =>
    set((s) => ({
      batchDraft: {
        ...s.batchDraft,
        ingredients: s.batchDraft.ingredients.map((i) =>
          i.key === key ? { ...i, quantityG } : i,
        ),
        totalYieldG: "",
        portionSizeG: "",
      },
    })),

  resetBatchDraft: () => set({ batchDraft: EMPTY_BATCH_DRAFT }),

  setManualEntryResult: (product) => set({ manualEntryResult: product }),
  consumeManualEntryResult: () => {
    const product = get().manualEntryResult;
    if (product) set({ manualEntryResult: null });
    return product;
  },

  // ─── Saved ingredients ─────────────────────────────────────

  saveGoals: async (goals) => {
    const { userId } = get();
    if (!userId) return { error: null };
    const { error } = await supabase.from("goals").upsert({
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
    if (error) {
      reportError("saveGoals", error, { level: "error" });
      return { error: "Couldn't save your goals. Check your connection." };
    }
    set({ goals });
    return { error: null };
  },

  saveIngredient: async (product) => {
    const { userId, savedIngredients } = get();
    if (!userId) return null;

    const existing = savedIngredients.find(
      (i) =>
        i.name.toLowerCase() === product.name.toLowerCase() &&
        (i.brand ?? "") === (product.brand ?? ""),
    );

    if (existing) {
      // ⚠ READ-MODIFY-WRITE off LOCAL state. Two devices logging the same food
      // in the same minute lose an increment. Left as-is because it only affects
      // list ORDER, but note that meal_compositions deliberately does NOT do
      // this — it calls the atomic bump_composition_use() RPC instead. If
      // saved_ingredients ever gets an RPC of its own, use it.
      const { error } = await supabase
        .from("saved_ingredients")
        .update({ use_count: existing.use_count + 1 })
        .eq("id", existing.id);
      if (error) {
        reportError("saveIngredient", error, { level: "error" });
        return null;
      }
      const updated = { ...existing, use_count: existing.use_count + 1 };
      set((s) => ({
        savedIngredients: s.savedIngredients.map((i) =>
          i.id === existing.id ? updated : i,
        ),
      }));
      return updated;
    }

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
      // Written straight to the base table, not the scored view — a brand
      // new save has no meal_entries yet, so it starts exactly where any
      // zero-match row does: decay_score 0, never logged.
      const inserted: SavedIngredientScored = {
        ...(data as SavedIngredient),
        decay_score: 0,
        last_used_at: null,
      };
      set((s) => ({
        savedIngredients: [inserted, ...s.savedIngredients],
      }));
      return inserted;
    }
    if (error) reportError("saveIngredient", error);
    return null;
  },

  deleteIngredient: async (id) => {
    const { error } = await supabase
      .from("saved_ingredients")
      .delete()
      .eq("id", id);
    if (error) {
      // Do NOT drop it locally. A failed delete that vanishes from the UI
      // comes back on the next fetchSavedIngredients(), which looks like a ghost.
      reportError("deleteIngredient", error, { level: "error" });
      return;
    }
    set((s) => ({
      savedIngredients: s.savedIngredients.filter((i) => i.id !== id),
    }));
  },

  // ─── Selectors ─────────────────────────────────────────────

  getTotalsForDate: (date) => {
    const totals = get().getSplitTotalsForDate(date);
    return totals.total;
  },

  getSplitTotalsForDate: (date) => {
    const relevant = get().entries.filter(
      (e) => e.date === date && !isSkipped(e),
    );
    const eaten = sumMacros(relevant.filter(isEaten));
    const planned = sumMacros(relevant.filter(isPending));
    return { eaten, planned, total: addTotals(eaten, planned) };
  },

  getEntriesForMeal: (date, mealType) =>
    get()
      .entries.filter(
        (e) => e.date === date && e.meal_type === mealType && !isSkipped(e),
      )
      .sort(byEatenAt),

  // "Copy what you can SEE." Skipped rows are hidden from the sections, so they
  // are excluded here too — and therefore from copy-a-day and from bundles, for
  // free. Pending and future-planned rows ARE included: copying Monday's planned
  // lunch onto Tuesday is the whole point.
  getEntriesForDate: (date) =>
    get()
      .entries.filter((e) => e.date === date && !isSkipped(e))
      .sort(byEatenAt),

  // Keys off localDate, not date — meal_entries and biometric_workouts are
  // different grains with different column names for the same idea (the
  // wall-clock day), and localDate is the spine column exposed for exactly
  // this join. A future day has no WHOOP workouts, so this returns []
  // there for free — nothing further needs to special-case planned days.
  getWorkoutsForDate: (date) =>
    get()
      .workouts.filter((w) => w.localDate === date)
      .sort((a, b) => a.workoutStart.localeCompare(b.workoutStart)),

  getPendingEntries: () => get().entries.filter(isPending).sort(byEatenAt),

  // The banner only ever asks about days that are OVER. A lunch you planned for
  // 13:00 today is not something the app should be interrogating you about at 14:00 —
  // it just joins tomorrow's batch, which is one tap you're already making.
  getDuePendingEntries: () => {
    const today = todayKey();
    return get()
      .entries.filter((e) => isPending(e) && e.date < today)
      .sort(byEatenAt);
  },

  getAllEntries: () => get().entries,
}));
