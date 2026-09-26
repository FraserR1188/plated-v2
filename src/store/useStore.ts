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
import {
  applyEntries,
  draftsFromDay,
  draftsForTarget,
  getDaySummary,
  DaySummary,
  DayBucket,
} from "../lib/entries";
import * as compositionApi from "../lib/compositions";
import { reportError, noteBreadcrumb } from "../lib/reportError";
import { getWhoopConnection } from "../lib/whoop";
import {
  readWhoopConnectionCache,
  writeWhoopConnectionCache,
  clearWhoopConnectionCache,
} from "../lib/whoopConnectionCache";
import { clearTrendsPrefs } from "../lib/trendsPrefs";
import { fetchAllPages } from "../lib/paging";

/**
 * PL-050. Rows per fetchEntries request. Must stay below PostgREST's
 * max_rows (2000 hosted and in supabase/config.toml since 2026-09-26; 1000
 * before that): a page the server cuts short reads as the last page, and
 * the loop would stop there. Pinned below both by fetchEntriesPaging.test.ts.
 */
export const ENTRIES_PAGE_SIZE = 500;

/** PL-056. Rows per fetchWorkouts request; same rule as ENTRIES_PAGE_SIZE,
 *  pinned below max_rows and 1000 by fetchWorkoutsPaging.test.ts. */
export const WORKOUTS_PAGE_SIZE = 500;

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
 * PL-023. Whether the store actually KNOWS the user's targets.
 *
 *   loading — not read yet. Nothing may be written from this.
 *   loaded  — a real row is in `goals`. Writable, as a partial update.
 *   absent  — read succeeded WITH a session and there is no row (P-TF01b).
 *             `goals` holds DEFAULT_GOALS. Writable, as a full insert.
 *   error   — the read failed, or ran without a session. `goals` may hold
 *             DEFAULT_GOALS for DISPLAY ONLY. Nothing may be written.
 *
 * The distinction exists because DEFAULT_GOALS is indistinguishable from a
 * user whose targets happen to be the defaults, and Settings seeds its form
 * from whatever is in `goals`. Without this, a failed read plus one edit
 * persisted the defaults over the user's real row.
 */
export type GoalsState = "loading" | "loaded" | "absent" | "error";

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
  /** PL-023: whether `goals` is real, defaulted, or unknown. */
  goalsState: GoalsState;
  /**
   * Bumped when a sync writes biometric rows (PL-018's post-sync refetch).
   * Today's WHOOP panel watches it so a foreground sync that lands new
   * scores re-reads them, rather than showing the pre-sync numbers until
   * the next focus. A counter rather than a timestamp: it only ever needs
   * to be DIFFERENT from last time.
   */
  biometricRefreshToken: number;
  /**
   * Whether WHOOP is connected. Drives Today's LAYOUT (the scores column
   * beside the ring), not just its content, which is why it is seeded from
   * a local cache before any network read. `revoked` counts as false.
   */
  whoopConnected: boolean;
  loading: boolean;

  /**
   * The day TodayScreen is showing. Lives here, not TodayScreen's local
   * `useState`, so History's per-day card can set it and switch tabs in one
   * action: setViewedDate(date) then navigation.navigate("Today"). Not a
   * route param — BottomTabParamList.Today stays `undefined` on purpose. A
   * tab screen stays mounted across tab switches (it isn't remounted on
   * navigate), so a param handed to it once would go stale the moment you
   * left and came back without a fresh navigate call; store state doesn't
   * have that problem. Same handoff convention as compositionApplyDraft.
   * Defaults to todayKey(); TodayScreen's "Return to today" sets it back.
   */
  viewedDate: string;
  setViewedDate: (date: string) => void;

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
  /** Tell the biometric surfaces a sync wrote something. */
  bumpBiometricRefresh: () => void;
  /** Seed from cache, then reconcile against the connection row. */
  loadWhoopConnection: () => Promise<void>;
  /** Settings' connect/disconnect. Writes the store and the cache together. */
  setWhoopConnected: (connected: boolean) => Promise<void>;
  fetchSavedIngredients: () => Promise<void>;
  fetchCompositions: () => Promise<void>;
  /** Unbounded, same caveat as fetchEntries — refetched on every screen focus. */
  fetchWorkouts: () => Promise<void>;

  /**
   * `planned`, `confirmed_at` and `skipped_at` are omitted on purpose: the DB
   * trigger derives them. The client never sends them, so no insert path — copy,
   * social, barcode, AI, anything written later — can get the rule wrong.
   *
   * Resolves to the inserted row; REJECTS on failure (no signed-in user, or
   * the insert itself), same contract as applyEntries. An insert error is
   * already reported to Sentry in here — callers surface it, never re-report.
   */
  addEntry: (
    entry: Omit<
      MealEntry,
      "id" | "user_id" | "logged_at" | "planned" | "confirmed_at" | "skipped_at"
    >,
  ) => Promise<MealEntry>;
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

  /**
   * ⚠ DEAD as of D7: no in-app caller. `total` sums eaten + planned
   * UNCONDITIONALLY, which is exactly the ambiguous, date-independent
   * meaning that let History fold unconfirmed plans into daily intake — see
   * getDaySummaryForDate below for the settled-day-aware replacement.
   * Kept only as a thin wrapper so nothing importing it breaks.
   */
  getTotalsForDate: (date: string) => DayTotals;
  /**
   * ⚠ DEAD as of D7: no in-app caller (TodayScreen now reads
   * getDaySummaryForDate). Kept as a thin wrapper over it — `total` here
   * still means "eaten + planned, always", not the settled-day-aware
   * `towardGoal`. Do not add new callers; use getDaySummaryForDate.
   */
  getSplitTotalsForDate: (date: string) => SplitTotals;
  /**
   * THE day-total selector. Splits a day into what was actually eaten vs
   * what's still pending, and derives `towardGoal` from whether the day has
   * settled (see DaySummary in lib/entries.ts): a live day's goal still
   * counts its pending plans, a settled day's doesn't. Every screen showing
   * a day total should read from this, not recompute its own.
   */
  getDaySummaryForDate: (date: string) => DaySummary;
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

/**
 * getSplitTotalsForDate's legacy shape (DayTotals: every macro a plain
 * `number`) predates DayBucket's null-vs-zero distinction. Coalesce on the
 * READ here — same idiom sumMacros used, same reason: a single unknown row
 * must not turn a straggling caller's total into NaN, and this wrapper's
 * whole job is to be numerically identical to what sumMacros used to return.
 */
const bucketToTotals = (b: DayBucket): DayTotals => ({
  calories: b.calories,
  protein: b.protein,
  carbs: b.carbs,
  fat: b.fat,
  satFat: b.satFat ?? 0,
  salt: b.salt ?? 0,
  fibre: b.fibre ?? 0,
  sugar: b.sugar ?? 0,
});

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
  goalsState: "loading",
  whoopConnected: false,
  biometricRefreshToken: 0,
  loading: false,
  viewedDate: todayKey(),
  incomingRequestCount: 0,
  batchDraft: EMPTY_BATCH_DRAFT,
  compositionApplyDraft: null,
  manualEntryResult: null,

  setUserId: (id) => set({ userId: id }),
  setViewedDate: (date) => set({ viewedDate: date }),

  /** Wipe every trace of the signed-in user. Called on sign-out. */
  reset: () => {
    // Fire-and-forget: reset() is synchronous by contract (callers rely on
    // the state being gone on the next line), and a cache entry that
    // outlives a sign-out would hand the next account the wrong first
    // frame. The user-id check in readWhoopConnectionCache is the real
    // guard; this is the tidy-up.
    void clearWhoopConnectionCache();
    // Trends' remembered nutrients and range. Same reasoning: a preference
    // left behind greets the next account with the previous one's charts.
    void clearTrendsPrefs();
    set({
      userId: null,
      entries: [],
      workouts: [],
      compositions: [],
      savedIngredients: [],
      goals: DEFAULT_GOALS,
      goalsState: "loading",
      whoopConnected: false,
      biometricRefreshToken: 0,
      loading: false,
      viewedDate: todayKey(),
      incomingRequestCount: 0,
      batchDraft: EMPTY_BATCH_DRAFT,
      compositionApplyDraft: null,
      manualEntryResult: null,
    });
  },

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
  //
  // PL-050: "unbounded" means every row, so it is read in pages. One unpaged
  // select is silently cut at PostgREST's max_rows. `id` ends the ORDER BY so
  // rows sharing a logged_at (a bundle apply writes several) keep one position
  // across page requests. A failed page keeps the previous list rather than
  // installing the pages read so far, and is reported once, here.
  fetchEntries: async () => {
    const { userId } = get();
    if (!userId) return;
    set({ loading: true });
    try {
      const rows = await fetchAllPages<MealEntry>(
        (from, to) =>
          supabase
            .from("meal_entries")
            .select("*")
            .eq("user_id", userId)
            .order("logged_at", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to),
        ENTRIES_PAGE_SIZE,
      );
      set({ entries: rows });
    } catch (e) {
      reportError("fetchEntries", e);
    } finally {
      set({ loading: false });
    }
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
  //
  // PL-056: paged like fetchEntries (PL-050). The ORDER BY ends on the
  // view's composite identity, (origin_package, source_workout_id): two apps
  // can log a workout in the same second, and one app can log two, so
  // nothing shorter gives every row a fixed position across pages. A failed
  // page keeps the previous list and is reported once, here.
  fetchWorkouts: async () => {
    const { userId } = get();
    if (!userId) return;
    let data: Record<string, any>[];
    try {
      data = await fetchAllPages<Record<string, any>>(
        (from, to) =>
          supabase
            .from("biometric_workouts")
            .select("*")
            .eq("user_id", userId)
            .order("workout_start", { ascending: false })
            .order("origin_package", { ascending: true })
            .order("source_workout_id", { ascending: true })
            .range(from, to),
        WORKOUTS_PAGE_SIZE,
      );
    } catch (e) {
      reportError("fetchWorkouts", e);
      return;
    }

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
      originPackage: w.origin_package,
      ingestTransport: w.ingest_transport,
    }));
    set({ workouts });
  },

  /**
   * Two steps, and the order is the point.
   *
   * 1. Seed from the local cache, so Today's first frame already has the
   *    right layout for a returning WHOOP user. This resolves in about the
   *    time a file read takes, against tens of milliseconds for the round
   *    trip below — which itself cannot even start until the Supabase
   *    session has been restored.
   * 2. Reconcile against the real connection row, and correct the cache.
   *
   * A FAILED reconcile keeps the cached state. The panel stays, its values
   * render as "–", and nothing moves. The alternative — treating a failed
   * read as "not connected" — would collapse the column on every flaky
   * launch, which is the jump this whole mechanism exists to prevent.
   * Only a SUCCESSFUL read is allowed to change the layout.
   */
  bumpBiometricRefresh: () =>
    set((s) => ({ biometricRefreshToken: s.biometricRefreshToken + 1 })),

  loadWhoopConnection: async () => {
    const { userId } = get();
    if (!userId) return;

    const cached = await readWhoopConnectionCache(userId);
    if (cached !== null) set({ whoopConnected: cached });

    let connection: Awaited<ReturnType<typeof getWhoopConnection>>;
    try {
      connection = await getWhoopConnection();
    } catch (e) {
      // PL-014: one report, from the one place that owns this failure.
      reportError("loadWhoopConnection", e, {
        fingerprint: ["load-whoop-connection"],
      });
      return; // cached state stands
    }

    // `revoked` means the connection existed and died. For the panel that
    // is the same as absent — there is nothing to show — but Settings still
    // distinguishes them, which is why this reads `status` rather than
    // testing for null alone.
    const connected = connection != null && connection.status !== "revoked";

    // Re-read userId: a sign-out during the round trip must not write a
    // cache entry for a user who is no longer signed in.
    if (get().userId !== userId) return;

    set({ whoopConnected: connected });
    await writeWhoopConnectionCache(userId, connected);
  },

  /**
   * Settings' connect and disconnect. The store and the cache move in one
   * action so they cannot disagree — a disconnect that updated only the
   * store would come back connected on the next cold start.
   */
  setWhoopConnected: async (connected) => {
    const { userId } = get();
    set({ whoopConnected: connected });
    if (userId) await writeWhoopConnectionCache(userId, connected);
  },

  /**
   * PL-017 / PL-023. Two separate problems meet in this one read.
   *
   * PL-017: a user with no `goals` row is the NORMAL state of a new account,
   * not a failure. Nothing in sign-up writes one (P-TF01b), and this runs on
   * every auth event, so `.single()`'s PGRST116 filed a Sentry error on every
   * launch for those users and buried real failures in the signal.
   *
   * PL-023: `.maybeSingle()` alone is not enough, because an empty result is
   * only trustworthy if the read actually carried the user's session.
   * supabase-js resolves the access token PER REQUEST and falls back to the
   * ANON key when `getSession()` yields null (`SupabaseClient._getAccessToken`
   * → `fetchWithAuth`). Measured on production: `anon` holds SELECT on
   * `public.goals` and every SELECT policy is `(auth.uid() = user_id)` with
   * `polroles` null — i.e. PUBLIC — so an anon read returns ZERO ROWS with
   * HTTP 200. Indistinguishable from "no targets set", and the difference is
   * a user's real targets.
   *
   * Hence the session gate: no session means no query and state `error`,
   * never `absent`. With a session, an empty read is believed.
   *
   * The four states are what let the rest of the app tell "these are your
   * targets" from "these are placeholders": `absent` and `loaded` are known
   * good and may be written back; `loading` and `error` may not.
   */
  fetchGoals: async () => {
    const { userId, goalsState } = get();
    // No signed-in user: same convention as addEntry's `!user` exit — the
    // caller is told nothing and Sentry isn't told either, because this is
    // reached on ordinary sign-out races, not on failure.
    if (!userId) {
      set({ goalsState: "error" });
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) {
      // Not reported: a missing session is a lifecycle state, not a fault.
      // What matters is that no query goes out under the anon key.
      set({ goalsState: "error" });
      return;
    }

    const { data, error } = await supabase
      .from("goals")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      reportError("fetchGoals", error, { level: "error" });
      // A failed read must never downgrade a known-good state. If targets
      // were already loaded (or known absent), keep them and keep the state
      // — that is precisely the PL-023 data-loss path, since Settings seeds
      // its form from whatever is here.
      if (goalsState === "loaded" || goalsState === "absent") return;
      // Cold start: nothing known. Show the defaults, but say so, so no
      // write path will accept them.
      set({ goals: DEFAULT_GOALS, goalsState: "error" });
      return;
    }

    if (!data) {
      // PL-017: normal, not an error. A breadcrumb rather than an event, so a
      // LATER failure carries the fact that the store was on defaults.
      noteBreadcrumb("fetchGoals", "goals: no row for user");
      set({ goals: DEFAULT_GOALS, goalsState: "absent" });
      return;
    }

    set({
      goals: {
        calories: data.calories,
        protein: data.protein,
        carbs: data.carbs,
        fat: data.fat,
        satFat: data.sat_fat ?? DEFAULT_GOALS.satFat,
        salt: data.salt,
        fibre: data.fibre,
        sugar: data.sugar,
      },
      goalsState: "loaded",
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
    // Throws, never a silent return: ProductScreen used to close as if the
    // meal had been logged. Unreported, like applyEntries' `!user` — there is
    // no server error to send.
    if (!userId) throw new Error("Not authenticated");

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
      // Reported HERE, exactly once — same as applyEntries. The caller shows
      // the failure; it must not report it again.
      reportError("addEntry", error, { level: "error" });
      throw error;
    }
    // .single() turns anything other than exactly one RETURNING row into
    // `error` above, so `data` is the row.
    const inserted = data as MealEntry;
    set((s) => ({ entries: [inserted, ...s.entries] }));
    return inserted;
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

  /**
   * PL-023. The old implementation upserted all eight columns from whatever
   * the caller handed it, and SettingsScreen handed it a form seeded once at
   * mount. So a store sitting on DEFAULT_GOALS after a failed read, plus one
   * edit, rewrote seven values the user never saw — silently, with no undo
   * and no history on the table to recover from.
   *
   * Three rules now:
   *   1. Only `loaded` and `absent` may be written from. `loading` and
   *      `error` mean the store does not know the user's targets, so nothing
   *      it holds is safe to persist.
   *   2. `loaded` → UPDATE only the columns that actually changed. A field
   *      the user didn't touch is never written, so even a stale form cannot
   *      overwrite a value it never loaded.
   *   3. `absent` → INSERT the full row. Deliberately an insert and not an
   *      upsert: if a row does exist after all, the unique violation is the
   *      correct outcome, not an overwrite.
   */
  saveGoals: async (next) => {
    const { userId, goals, goalsState } = get();
    if (!userId) return { error: null };

    if (goalsState !== "loaded" && goalsState !== "absent") {
      return {
        error:
          "Your targets haven't loaded yet, so they can't be saved. Try again once they appear.",
      };
    }

    // camelCase → snake_case, mapped explicitly. Never spread the camelCase
    // object into a Supabase write (CLAUDE.md).
    const columns: Array<[keyof Goals, string]> = [
      ["calories", "calories"],
      ["protein", "protein"],
      ["carbs", "carbs"],
      ["fat", "fat"],
      ["satFat", "sat_fat"],
      ["salt", "salt"],
      ["fibre", "fibre"],
      ["sugar", "sugar"],
    ];

    if (goalsState === "absent") {
      const row: Record<string, unknown> = { user_id: userId };
      for (const [key, column] of columns) row[column] = next[key];
      row.updated_at = new Date().toISOString();

      const { error } = await supabase.from("goals").insert(row);
      if (error) {
        reportError("saveGoals", error, { level: "error" });
        return { error: "Couldn't save your goals. Check your connection." };
      }
      set({ goals: next, goalsState: "loaded" });
      return { error: null };
    }

    // loaded → changed columns only.
    const changes: Record<string, unknown> = {};
    for (const [key, column] of columns) {
      if (next[key] !== goals[key]) changes[column] = next[key];
    }

    // Nothing changed: pressing Save without editing anything must not write.
    if (Object.keys(changes).length === 0) return { error: null };

    changes.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("goals")
      .update(changes)
      .eq("user_id", userId)
      .select("user_id");

    if (error) {
      reportError("saveGoals", error, { level: "error" });
      return { error: "Couldn't save your goals. Check your connection." };
    }

    // An UPDATE filtered out by RLS returns NO error — the USING clause just
    // removes the row from the target set and the request "succeeds" with
    // zero rows. Same trap as saveCompositionApplyQuantities.
    if (!data || data.length === 0) {
      reportError(
        "saveGoals",
        { message: "goals update matched zero rows", code: "" },
        { level: "error" },
      );
      return { error: "Couldn't save your goals. Please try again." };
    }

    set({ goals: next });
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
        // Small four: the number when known, and when unknown the KEY IS
        // OMITTED — FoodProduct carries unknown as `undefined`, which
        // JSON.stringify drops from the request body, so Postgres stores NULL
        // (20260919120000 dropped the old DEFAULT 0). Deliberately not
        // `?? null`: against a column still NOT NULL (the migration not yet
        // applied), an explicit null fails the insert, and this action only
        // reports the error — the library row would silently never be
        // created. Omitting is safe in either order. And never `?? 0`: that
        // stored "zero sat fat" for foods we knew nothing about, and My
        // Library re-adds carried it into meal_entries (guard B+ in
        // nutrientCarriers.test.ts).
        sat_fat_per100: product.sat_fat_per100,
        salt_per100: product.salt_per100,
        fibre_per100: product.fibre_per100,
        sugar_per100: product.sugar_per100,
        barcode: product.barcode,
        off_id: product.off_id,
      })
      .select()
      .single();

    if (!error && data) {
      // Written straight to the base table, not the scored view, so the score
      // here is a placeholder: decay_score 0, never logged. ProductScreen now
      // calls this AFTER its meal_entries insert succeeds, so the server's
      // real score is already non-zero; the next fetchSavedIngredients()
      // (App.tsx, on auth events — i.e. usually next launch) replaces this
      // row with it.
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

  // Thin wrapper over getDaySummaryForDate — see the ⚠ DEAD comments on both
  // in AppState. bucketToTotals coalesces the nullable macros back to 0,
  // matching sumMacros' old behaviour exactly, so any straggling caller sees
  // bit-for-bit the same DayTotals shape it always did.
  getSplitTotalsForDate: (date) => {
    const summary = get().getDaySummaryForDate(date);
    const eaten = bucketToTotals(summary.eaten);
    const planned = bucketToTotals(summary.pending);
    return { eaten, planned, total: addTotals(eaten, planned) };
  },

  getDaySummaryForDate: (date) => getDaySummary(get().entries, date, new Date()),

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
