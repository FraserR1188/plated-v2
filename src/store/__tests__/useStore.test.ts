import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/react-native";
import { useStore } from "../useStore";
import { supabase } from "../../lib/supabase";
import {
  MealEntry,
  FoodProduct,
  SavedIngredientScored,
  MealCompositionItem,
  MealCompositionWithItems,
  EntryDraft,
} from "../../types";

function makeEntry(overrides: Partial<MealEntry> = {}): MealEntry {
  return {
    id: "e1",
    user_id: "test-user-id",
    date: "2026-07-20",
    logged_at: "2026-07-20T12:00:00.000Z",
    name: "Porridge",
    calories: 437,
    protein: 12.5,
    carbs: 60,
    fat: 8,
    source: "search",
    barcode: null,
    off_id: null,
    serving_g: 250,
    meal_type: "dinner",
    brand: null,
    salt: 1.25,
    fibre: 6,
    sugar: 4,
    sat_fat: 2,
    eaten_at: "2026-07-20T19:00:00.000Z",
    planned: false,
    confirmed_at: null,
    skipped_at: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    eaten_at_estimated: false,
    ...overrides,
  };
}

/** Wire supabase.from("meal_entries").insert(row).select().single() to
 *  capture the row it was called with and hand back a canned RETURNING row. */
function mockInsertSingle(returning: unknown) {
  const capture: { row?: unknown } = {};
  const single = vi.fn(async () => ({ data: returning, error: null }));
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn((row: unknown) => {
    capture.row = row;
    return { select };
  });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });
  return capture;
}

/** Same chain as mockInsertSingle, but the insert fails. */
function mockInsertSingleError(error: unknown) {
  const single = vi.fn(async () => ({ data: null, error }));
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });
}

type AddEntryInput = Parameters<
  ReturnType<typeof useStore.getState>["addEntry"]
>[0];

function sandwich(): AddEntryInput {
  return {
    date: "2026-07-27",
    meal_type: "lunch",
    name: "Sandwich",
    brand: null,
    source: "search",
    serving_g: 100,
    calories: 300,
    protein: 10,
    carbs: 30,
    fat: 10,
    sat_fat: null,
    salt: null,
    fibre: null,
    sugar: null,
    barcode: null,
    off_id: null,
    eaten_at: "2026-07-27T12:00:00.000Z",
    eaten_at_estimated: false,
    image_url: null,
    image_path: null,
    custom_food_id: null,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: { id: "test-user-id" } },
  } as never);
});

describe("useStore.addEntry", () => {
  it("rejects without touching the network when there is no signed-in user", async () => {
    useStore.getState().setUserId(null);
    vi.mocked(supabase.from).mockClear();
    vi.mocked(Sentry.captureException).mockClear();

    await expect(useStore.getState().addEntry(sandwich())).rejects.toThrow(
      /not authenticated/i,
    );

    expect(supabase.from).not.toHaveBeenCalled();
    // Same as applyEntries' `!user` branch: the caller is told, Sentry isn't.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("rejects with the insert error, reports it exactly once, and adds nothing to local state", async () => {
    useStore.getState().setUserId("test-user-id");
    const alreadyLogged = makeEntry({ id: "already-logged" });
    useStore.setState({ entries: [alreadyLogged] });
    const pgError = {
      message: "TypeError: Network request failed",
      code: "",
      details: "",
      hint: "",
    };
    mockInsertSingleError(pgError);
    vi.mocked(Sentry.captureException).mockClear();

    await expect(useStore.getState().addEntry(sandwich())).rejects.toBe(pgError);

    expect(useStore.getState().entries).toEqual([alreadyLogged]);
    // Reported inside addEntry, like applyEntries — which is why ProductScreen
    // must not report it again.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { tags: { operation: string } },
    ];
    expect(ctx.tags.operation).toBe("addEntry");
  });

  it("writes the EXPLICIT date/meal_type the caller passed — it does not derive or infer them", async () => {
    useStore.getState().setUserId("test-user-id");
    const capture = mockInsertSingle(makeEntry());

    await useStore.getState().addEntry({
      date: "2026-07-27",
      meal_type: "lunch",
      name: "Sandwich",
      brand: null,
      source: "search",
      serving_g: 100,
      calories: 300,
      protein: 10,
      carbs: 30,
      fat: 10,
      sat_fat: null,
      salt: null,
      fibre: null,
      sugar: null,
      barcode: null,
      off_id: null,
      eaten_at: "2026-07-27T12:00:00.000Z",
      eaten_at_estimated: false,
      image_url: null,
      image_path: null,
      custom_food_id: null,
    });

    const row = capture.row as { date: string; meal_type: string };
    expect(row.date).toBe("2026-07-27");
    expect(row.meal_type).toBe("lunch");
  });

  it("never sends planned/confirmed_at/skipped_at — the BEFORE INSERT trigger owns them", async () => {
    useStore.getState().setUserId("test-user-id");
    const capture = mockInsertSingle(makeEntry());

    await useStore.getState().addEntry({
      date: "2026-07-27",
      meal_type: "lunch",
      name: "Sandwich",
      brand: null,
      source: "search",
      serving_g: 100,
      calories: 300,
      protein: 10,
      carbs: 30,
      fat: 10,
      sat_fat: null,
      salt: null,
      fibre: null,
      sugar: null,
      barcode: null,
      off_id: null,
      eaten_at: "2026-07-27T12:00:00.000Z",
      eaten_at_estimated: false,
      image_url: null,
      image_path: null,
      custom_food_id: null,
    });

    const row = capture.row as Record<string, unknown>;
    expect(row).not.toHaveProperty("planned");
    expect(row).not.toHaveProperty("confirmed_at");
    expect(row).not.toHaveProperty("skipped_at");
  });

  it("appends the RETURNING row (with the trigger's decision) to local state and returns it", async () => {
    useStore.getState().setUserId("test-user-id");
    const returned = makeEntry({ id: "server-generated-id", planned: true });
    mockInsertSingle(returned);

    const result = await useStore.getState().addEntry(sandwich());

    expect(result).toEqual(returned);
    expect(useStore.getState().entries).toEqual([returned]);
  });
});

describe("useStore.copyEntriesToDay", () => {
  it("inserts new rows for the target day and leaves the source entry (and day) untouched", async () => {
    const source = makeEntry({
      id: "source-1",
      date: "2026-07-20",
      meal_type: "dinner",
      eaten_at: "2026-07-20T19:00:00.000Z",
    });
    useStore.setState({ entries: [source] });
    useStore.getState().setUserId("test-user-id");

    const insertedCopy = makeEntry({
      id: "copy-1",
      date: "2026-07-27",
      meal_type: "dinner",
      eaten_at: "2026-07-27T19:00:00.000Z",
    });

    const select = vi.fn(async () => ({ data: [insertedCopy], error: null }));
    const insert = vi.fn(() => ({ select }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });

    const { error } = await useStore
      .getState()
      .copyEntriesToDay([source], "2026-07-27");

    expect(error).toBeNull();

    const entries = useStore.getState().entries;
    // The source entry is untouched — same id, same date, still present.
    const stillSource = entries.find((e) => e.id === "source-1");
    expect(stillSource).toBeDefined();
    expect(stillSource!.date).toBe("2026-07-20");

    // Exactly one new entry landed on the target day — not zero, not two.
    const onTargetDay = entries.filter((e) => e.date === "2026-07-27");
    expect(onTargetDay).toHaveLength(1);
    expect(onTargetDay[0].id).toBe("copy-1");

    // Total entry count grew by exactly one copy.
    expect(entries).toHaveLength(2);
  });
});

// ─── D5: copy-to-any-slot — the new contract ─────────────────────────────
//
// copyEntriesToDay (above) can only ever land a copy in the source's own
// meal_type at the source's own wall-clock time — it just moves the day.
// copyEntriesTo takes an explicit { dayKey, meal_type, time } target, so a
// copy can land in ANY section at ANY time on ANY day. It must route through
// the same applyEntries() seam (no third meal_entries insert site) and must
// append whatever `planned` the trigger's RETURNING row actually says —
// never guess.
describe("useStore.copyEntriesTo", () => {
  it("inserts exactly one new row at the CHOSEN day/meal/time, appends the trigger's own `planned`, and leaves the source untouched", async () => {
    const source = makeEntry({
      id: "source-1",
      date: "2026-07-20",
      meal_type: "breakfast",
      eaten_at: "2026-07-20T08:00:00.000Z",
      planned: false,
    });
    useStore.setState({ entries: [source] });
    useStore.getState().setUserId("test-user-id");

    // A future slot: the trigger would derive planned = true. The store must
    // append THAT, not assume false because the source was logged.
    const insertedCopy = makeEntry({
      id: "copy-1",
      date: "2026-07-27",
      meal_type: "dinner",
      eaten_at: "2026-07-27T19:00:00.000Z",
      planned: true,
    });

    const select = vi.fn(async () => ({ data: [insertedCopy], error: null }));
    const insert = vi.fn(() => ({ select }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });

    const { error } = await useStore.getState().copyEntriesTo([source], {
      dayKey: "2026-07-27",
      meal_type: "dinner",
      time: { hours: 19, minutes: 0 },
    });

    expect(error).toBeNull();

    const entries = useStore.getState().entries;

    // Source untouched: same id, same day, same section.
    const stillSource = entries.find((e) => e.id === "source-1");
    expect(stillSource).toBeDefined();
    expect(stillSource!.date).toBe("2026-07-20");
    expect(stillSource!.meal_type).toBe("breakfast");

    // Exactly one new row, in the chosen section, carrying the trigger's planned.
    const copy = entries.find((e) => e.id === "copy-1");
    expect(copy).toBeDefined();
    expect(copy!.date).toBe("2026-07-27");
    expect(copy!.meal_type).toBe("dinner");
    expect(copy!.planned).toBe(true);

    // Total entry count grew by exactly one.
    expect(entries).toHaveLength(2);
  });
});

// ─── Unchecked-write correctness fix ──────────────────────────
//
// saveGoals, saveIngredient (existing-item branch), and deleteIngredient used
// to run their optimistic set() unconditionally, even when the underlying
// Supabase write failed — painting the UI as saved/updated/removed when
// nothing actually persisted. The failure case in each block below is the
// regression test for that: it asserts local state is untouched when the
// write fails, not just that the write was attempted.

function makeSavedIngredient(
  overrides: Partial<SavedIngredientScored> = {},
): SavedIngredientScored {
  return {
    id: "si-1",
    user_id: "test-user-id",
    name: "Porridge",
    brand: null,
    cal_per100: 175,
    protein_per100: 5,
    carbs_per100: 24,
    fat_per100: 3.2,
    sat_fat_per100: 0.8,
    salt_per100: 0.1,
    fibre_per100: 2.4,
    sugar_per100: 1.6,
    barcode: null,
    off_id: null,
    use_count: 1,
    created_at: "2026-07-20T12:00:00.000Z",
    decay_score: 1,
    last_used_at: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

const pgError = { message: "constraint violated", code: "23505" };

// ─── Apply-time quantity adjustment (Phase 1 apply-draft plumbing, Phase 2
// save-back-to-definition) ───────────────────────────────────────────────

function makeCompositionItem(
  overrides: Partial<MealCompositionItem> & { id: string },
): MealCompositionItem {
  return {
    composition_id: "comp-1",
    user_id: "test-user-id",
    position: 0,
    name: "Test food",
    brand: null,
    serving_g: 100,
    calories: 200,
    protein: 10,
    carbs: 20,
    fat: 5,
    sat_fat: 1,
    salt: 0.5,
    fibre: 2,
    sugar: 3,
    meal_type: "breakfast",
    eaten_time: "08:00",
    barcode: null,
    off_id: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    ...overrides,
  };
}

function makeMealComposition(
  items: MealCompositionItem[],
  overrides: Partial<MealCompositionWithItems> = {},
): MealCompositionWithItems {
  return {
    id: "comp-1",
    user_id: "test-user-id",
    name: "Test bundle",
    use_count: 0,
    last_used_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    kind: "bundle",
    yield_g: null,
    portion_g: null,
    portion_label: null,
    ...overrides,
    items,
  };
}

function makeEntryDraft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    name: "Test food",
    brand: null,
    serving_g: 100,
    calories: 200,
    protein: 10,
    carbs: 20,
    fat: 5,
    sat_fat: 1,
    salt: 0.5,
    fibre: 2,
    sugar: 3,
    meal_type: "breakfast",
    eaten_at: "2026-07-27T08:00:00.000Z",
    eaten_at_estimated: true,
    source: "bundle",
    barcode: null,
    off_id: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    ...overrides,
  };
}

/** Wire supabase.from("meal_composition_items").update(row).eq("id", id)
 *  .select("id") to a single shared mock, so every call in a
 *  saveCompositionApplyQuantities run (one per changed row, sequential)
 *  lands in update.mock.calls / eq.mock.calls for inspection.
 *
 * `returning` defaults to one row — a real UPDATE that actually matched
 * something — since most tests care about the payload/call shape, not the
 * row-count check. Pass `[]` to simulate the zero-row RLS-filtered case
 * (see updateCompositionItemQuantities's own comment on why that must not
 * read as success). */
function mockCompositionItemsUpdate(returning: { id: string }[] = [{ id: "row" }]) {
  const select = vi.fn(async () => ({ data: returning, error: null }));
  const eq = vi.fn(() => ({ select }));
  const update = vi.fn((row: unknown) => {
    void row;
    return { eq };
  });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ update });
  return { update, eq, select };
}

describe("useStore.saveCompositionApplyQuantities", () => {
  it("writes only the row(s) whose grams actually changed — an untouched item is left alone", async () => {
    const unchanged = makeCompositionItem({ id: "unchanged", serving_g: 100 });
    const changed = makeCompositionItem({
      id: "changed",
      serving_g: 25,
      calories: 100,
      protein: 8,
      carbs: 4,
      fat: 6,
      sat_fat: 2,
      salt: 0.1,
      fibre: 1,
      sugar: 0.5,
    });
    const composition = makeMealComposition([unchanged, changed]);
    // Seeded exactly as the real app would have it: fetchCompositions()
    // populates `compositions` well before ApplyBundleSheet ever opens.
    // saveCompositionApplyQuantities's cache update maps over THIS array.
    useStore.setState({ compositions: [composition] });

    useStore.getState().startCompositionApplyDraft(composition, "2026-07-27");
    useStore.getState().setCompositionApplyItemGrams("changed", 10); // 25g → 10g

    const { update, eq } = mockCompositionItemsUpdate();

    const result = await useStore.getState().saveCompositionApplyQuantities();

    expect(result.error).toBeNull();
    // NOTE: supabase.from is a single mock shared across this whole test
    // file (never cleared between `it`s — see vitest.setup.ts), so its call
    // COUNT accumulates across every earlier test. `update`/`eq` are fresh
    // per test (created by mockCompositionItemsUpdate above) — those are
    // what call-count assertions must use.
    expect(update).toHaveBeenCalledTimes(1); // exactly one row written
    expect(supabase.from).toHaveBeenCalledWith("meal_composition_items");
    expect(eq).toHaveBeenCalledWith("id", "changed"); // never "unchanged"

    const payload = update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.serving_g).toBe(10);
    expect(payload.calories).toBeCloseTo(40); // 100 * (10/25)
    expect(payload.protein).toBeCloseTo(3.2); // 8 * (10/25)

    // The cache reflects the write immediately — no refetch needed for the
    // bundle sheet's "N items · Xkcal" subtitle (summed fresh from
    // bundle.items at render) to show the new total.
    const cached = useStore
      .getState()
      .compositions.find((c) => c.id === "comp-1")!
      .items.find((i) => i.id === "changed")!;
    expect(cached.serving_g).toBe(10);
    expect(cached.calories).toBeCloseTo(40);
  });

  it("keeps a NULL nutrient NULL in the update payload — never coalesced to 0", async () => {
    const item = makeCompositionItem({ id: "1", serving_g: 25, fibre: null });
    const composition = makeMealComposition([item]);

    useStore.getState().startCompositionApplyDraft(composition, "2026-07-27");
    useStore.getState().setCompositionApplyItemGrams("1", 10);

    const { update } = mockCompositionItemsUpdate();

    await useStore.getState().saveCompositionApplyQuantities();

    const payload = update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.fibre).toBeNull();
  });

  it("never includes a non-rescalable item (NULL serving_g), even if a grams change is forced onto it", async () => {
    const rescalable = makeCompositionItem({ id: "a", serving_g: 25 });
    const nonRescalable = makeCompositionItem({ id: "b", serving_g: null });
    const composition = makeMealComposition([rescalable, nonRescalable]);

    useStore.getState().startCompositionApplyDraft(composition, "2026-07-27");
    useStore.getState().setCompositionApplyItemGrams("a", 10); // real change
    // "b" has no denominator to scale from — setting it is a no-op the store
    // must still refuse at save-back time, even though the UI never offers
    // this control for a non-rescalable item in the first place.
    useStore.getState().setCompositionApplyItemGrams("b", 50);

    const { update, eq } = mockCompositionItemsUpdate();

    await useStore.getState().saveCompositionApplyQuantities();

    expect(update).toHaveBeenCalledTimes(1); // only "a"
    expect(eq).toHaveBeenCalledWith("id", "a");
    expect(eq).not.toHaveBeenCalledWith("id", "b");
  });

  it("is a no-op (not an error) when nothing changed", async () => {
    const item = makeCompositionItem({ id: "1", serving_g: 25 });
    const composition = makeMealComposition([item]);

    useStore.getState().startCompositionApplyDraft(composition, "2026-07-27");
    // No setCompositionApplyItemGrams call — nothing changed.

    const { update } = mockCompositionItemsUpdate();

    const result = await useStore.getState().saveCompositionApplyQuantities();

    expect(result.error).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses for a batch composition without touching the database at all", async () => {
    // Constructed directly rather than via startCompositionApplyDraft:
    // draftsFromComposition assumes bundle-shaped items (non-null
    // eaten_time) and would throw on a real batch ingredient — this test is
    // specifically about saveCompositionApplyQuantities's OWN kind guard,
    // isolated from that unrelated precondition.
    useStore.setState({
      compositionApplyDraft: {
        compositionId: "comp-batch",
        compositionName: "Test batch",
        compositionKind: "batch",
        dayKey: "2026-07-27",
        items: [
          {
            itemId: "1",
            originalDraft: makeEntryDraft({ serving_g: 25 }),
            currentGramsG: 25,
          },
        ],
      },
    });
    useStore.getState().setCompositionApplyItemGrams("1", 10);

    const { update } = mockCompositionItemsUpdate();

    const result = await useStore.getState().saveCompositionApplyQuantities();

    expect(result.error).not.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("treats a zero-row UPDATE result as a failure, not silent success", async () => {
    // Reproduces exactly what manual RLS testing found: a foreign auth.uid()
    // updating this table gets NO Postgrest error — the USING clause just
    // filters the row out of the update's target set, so the request
    // "succeeds" with zero rows affected. Simulated here by returning an
    // empty array from .select("id") rather than by mocking an error.
    const item = makeCompositionItem({ id: "1", serving_g: 25 });
    const composition = makeMealComposition([item]);
    useStore.setState({ compositions: [composition] });

    useStore.getState().startCompositionApplyDraft(composition, "2026-07-27");
    useStore.getState().setCompositionApplyItemGrams("1", 10);

    mockCompositionItemsUpdate([]); // zero rows returned

    const result = await useStore.getState().saveCompositionApplyQuantities();

    expect(result.error).not.toBeNull();
    // The cache must NOT show the edit as saved when nothing actually was.
    const cachedItem = useStore.getState().compositions[0].items[0];
    expect(cachedItem.serving_g).toBe(25);
  });
});

/** Wire supabase.from("goals").select("*").eq(...).maybeSingle().
 *  Deliberately does NOT expose .single() — if fetchGoals regresses to
 *  .single() this throws "single is not a function" rather than quietly
 *  passing, so the no-row test can't go vacuous. */
function mockGoalsSelect(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select });
  return { maybeSingle, eq, select };
}

/** PL-023: goals UPDATE — .update(patch).eq(...).select("user_id").
 *  Returns rows so a zero-row (RLS-filtered) update can be simulated. */
function mockGoalsUpdate(rows: unknown[], error: unknown = null) {
  const capture: { patch?: Record<string, unknown> } = {};
  const select = vi.fn(async () => ({ data: rows, error }));
  const eq = vi.fn(() => ({ select }));
  const update = vi.fn((patch: Record<string, unknown>) => {
    capture.patch = patch;
    return { eq };
  });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ update });
  return capture;
}

/** PL-023: goals INSERT — .insert(row). */
function mockGoalsInsert(error: unknown = null) {
  const capture: { row?: Record<string, unknown> } = {};
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    capture.row = row;
    return { error };
  });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });
  return capture;
}

function withSession() {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: { access_token: "t", user: { id: "test-user-id" } } },
    error: null,
  } as never);
}

function withoutSession() {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: null },
    error: null,
  } as never);
}

const goalsRow = {
  user_id: "test-user-id",
  calories: 2400,
  protein: 180,
  carbs: 240,
  fat: 70,
  sat_fat: 24,
  salt: 5,
  fibre: 35,
  sugar: 40,
};

const realGoals = {
  calories: 2400,
  protein: 180,
  carbs: 240,
  fat: 70,
  satFat: 24,
  salt: 5,
  fibre: 35,
  sugar: 40,
};

const DEFAULTS = {
  calories: 2000,
  protein: 150,
  carbs: 200,
  fat: 65,
  satFat: 20,
  salt: 6,
  fibre: 30,
  sugar: 30,
};

describe("useStore.fetchGoals", () => {
  it("PL-023: NO session means no query at all, and state 'error'", async () => {
    // supabase-js resolves the access token per request and falls back to the
    // ANON key when getSession() yields null (SupabaseClient._getAccessToken).
    // An anon read of `goals` returns ZERO ROWS with HTTP 200 — measured: anon
    // holds SELECT on public.goals and the policy (auth.uid() = user_id)
    // applies to PUBLIC. So an ungated read is indistinguishable from "this
    // user has no targets", which is what PL-023 turns into data loss.
    useStore.getState().setUserId("test-user-id");
    withoutSession();
    vi.mocked(supabase.from).mockClear();

    await useStore.getState().fetchGoals();

    expect(supabase.from).not.toHaveBeenCalled();
    expect(useStore.getState().goalsState).toBe("error");
  });

  it("PL-023: with a session, an empty read is trustworthy — 'absent', not 'error'", async () => {
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({ data: null, error: null });

    await useStore.getState().fetchGoals();

    expect(useStore.getState().goalsState).toBe("absent");
    expect(useStore.getState().goals).toEqual(DEFAULTS);
  });

  it("PL-017: 'absent' is not an error — nothing is reported, a breadcrumb is left", async () => {
    // The normal state of every account between sign-up and the first visit
    // to Settings (P-TF01b). fetchGoals runs on every auth event, so
    // reporting it filed a Sentry error on every launch for those users.
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({ data: null, error: null });
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.addBreadcrumb).mockClear();

    await useStore.getState().fetchGoals();

    expect(Sentry.captureException).not.toHaveBeenCalled();
    // Not an event, but a later error should carry "goals: no row" context.
    expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
    const crumb = vi.mocked(Sentry.addBreadcrumb).mock.calls[0][0] as {
      message?: string;
      level?: string;
    };
    expect(crumb.message).toMatch(/no row/i);
    expect(crumb.level).not.toBe("error");
  });

  it("PL-023: a failure AFTER a good load keeps the loaded goals and their state", async () => {
    // The data-loss path. If a later failed read dropped the store back to
    // DEFAULT_GOALS, Settings would seed 2000 kcal over real targets and the
    // next Save would persist them.
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({ data: goalsRow, error: null });
    await useStore.getState().fetchGoals();
    expect(useStore.getState().goalsState).toBe("loaded");

    mockGoalsSelect({
      data: null,
      error: { message: "TypeError: Network request failed", code: "" },
    });
    await useStore.getState().fetchGoals();

    expect(useStore.getState().goals).toEqual(realGoals);
    expect(useStore.getState().goalsState).toBe("loaded");
  });

  it("PL-023: a failure after 'absent' keeps 'absent' — it does not degrade to 'error'", async () => {
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({ data: null, error: null });
    await useStore.getState().fetchGoals();
    expect(useStore.getState().goalsState).toBe("absent");

    mockGoalsSelect({ data: null, error: { message: "boom", code: "" } });
    await useStore.getState().fetchGoals();

    expect(useStore.getState().goalsState).toBe("absent");
  });

  it("a failure on COLD START gives 'error', with the defaults for display only", async () => {
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({
      data: null,
      error: { message: "TypeError: Network request failed", code: "" },
    });
    vi.mocked(Sentry.captureException).mockClear();

    await useStore.getState().fetchGoals();

    expect(useStore.getState().goalsState).toBe("error");
    expect(useStore.getState().goals).toEqual(DEFAULTS);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { tags: { operation: string } },
    ];
    expect(ctx.tags.operation).toBe("fetchGoals");
  });

  it("maps a real row snake_case → camelCase and sets 'loaded'", async () => {
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({ data: goalsRow, error: null });
    // Cleared deliberately: without it this assertion is only true because
    // the tests ABOVE happen not to report, which a sabotage run caught.
    vi.mocked(Sentry.captureException).mockClear();

    await useStore.getState().fetchGoals();

    expect(useStore.getState().goals).toEqual(realGoals);
    expect(useStore.getState().goalsState).toBe("loaded");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("a NULL sat_fat on a real row falls back to the default, not to 0", async () => {
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({ data: { ...goalsRow, sat_fat: null }, error: null });

    await useStore.getState().fetchGoals();

    expect(useStore.getState().goals.satFat).toBe(20);
    expect(useStore.getState().goals.calories).toBe(2400);
  });

  it("does not touch the network when there is no signed-in user", async () => {
    useStore.getState().setUserId(null);
    vi.mocked(supabase.from).mockClear();
    vi.mocked(Sentry.captureException).mockClear();

    await useStore.getState().fetchGoals();

    expect(supabase.from).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("reset() clears the state back to 'loading'", async () => {
    useStore.getState().setUserId("test-user-id");
    withSession();
    mockGoalsSelect({ data: goalsRow, error: null });
    await useStore.getState().fetchGoals();
    expect(useStore.getState().goalsState).toBe("loaded");

    useStore.getState().reset();

    expect(useStore.getState().goalsState).toBe("loading");
    expect(useStore.getState().goals).toEqual(DEFAULTS);
  });
});

describe("useStore.saveGoals", () => {
  it("PL-023: in 'loaded', writes ONLY the changed columns", async () => {
    // The heart of PL-023. The old code upserted all eight columns from a
    // form seeded once at mount, so one edit rewrote seven other values that
    // may never have been loaded.
    useStore.getState().setUserId("test-user-id");
    useStore.setState({ goals: realGoals, goalsState: "loaded" });
    const capture = mockGoalsUpdate([{ user_id: "test-user-id" }]);

    const result = await useStore
      .getState()
      .saveGoals({ ...realGoals, calories: 2500 });

    expect(result.error).toBeNull();
    const patch = capture.patch as Record<string, unknown>;
    expect(patch.calories).toBe(2500);
    // Every other macro column must be ABSENT, not merely equal.
    for (const col of [
      "protein",
      "carbs",
      "fat",
      "sat_fat",
      "salt",
      "fibre",
      "sugar",
    ]) {
      expect(patch).not.toHaveProperty(col);
    }
    expect(useStore.getState().goals.calories).toBe(2500);
  });

  it("PL-023: a no-op save writes nothing at all", async () => {
    useStore.getState().setUserId("test-user-id");
    useStore.setState({ goals: realGoals, goalsState: "loaded" });
    vi.mocked(supabase.from).mockClear();

    const result = await useStore.getState().saveGoals({ ...realGoals });

    expect(result.error).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("PL-023: in 'absent', INSERTs the full row and becomes 'loaded'", async () => {
    useStore.getState().setUserId("test-user-id");
    useStore.setState({ goals: DEFAULTS, goalsState: "absent" });
    const capture = mockGoalsInsert();

    const result = await useStore
      .getState()
      .saveGoals({ ...DEFAULTS, calories: 2200 });

    expect(result.error).toBeNull();
    const row = capture.row as Record<string, unknown>;
    expect(row.user_id).toBe("test-user-id");
    expect(row.calories).toBe(2200);
    // snake_case, mapped explicitly — never a spread of the camelCase object.
    expect(row.sat_fat).toBe(20);
    expect(row).not.toHaveProperty("satFat");
    expect(useStore.getState().goalsState).toBe("loaded");
  });

  it("PL-023: refuses to write in 'loading' — no query, non-null error", async () => {
    useStore.getState().setUserId("test-user-id");
    useStore.setState({ goals: DEFAULTS, goalsState: "loading" });
    vi.mocked(supabase.from).mockClear();

    const result = await useStore
      .getState()
      .saveGoals({ ...DEFAULTS, calories: 2500 });

    expect(result.error).toEqual(expect.any(String));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("PL-023: refuses to write in 'error' — no query, non-null error", async () => {
    // The exact data-loss sequence: a failed read leaves the defaults on
    // screen, the user "corrects" one field, and the old code wrote all
    // eight over their real row.
    useStore.getState().setUserId("test-user-id");
    useStore.setState({ goals: DEFAULTS, goalsState: "error" });
    vi.mocked(supabase.from).mockClear();

    const result = await useStore
      .getState()
      .saveGoals({ ...DEFAULTS, calories: 2500 });

    expect(result.error).toEqual(expect.any(String));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("PL-023: a zero-row UPDATE is a failure, not silent success", async () => {
    // Same lesson as saveCompositionApplyQuantities: an RLS-filtered UPDATE
    // returns no Postgrest error, just an empty row set.
    useStore.getState().setUserId("test-user-id");
    useStore.setState({ goals: realGoals, goalsState: "loaded" });
    mockGoalsUpdate([]);

    const result = await useStore
      .getState()
      .saveGoals({ ...realGoals, calories: 2500 });

    expect(result.error).toEqual(expect.any(String));
    // The cache must not show the edit as saved when nothing was.
    expect(useStore.getState().goals.calories).toBe(2400);
  });

  it("on failure, leaves local goals UNCHANGED and returns a non-null error", async () => {
    useStore.getState().setUserId("test-user-id");
    useStore.setState({ goals: realGoals, goalsState: "loaded" });
    const before = useStore.getState().goals;
    mockGoalsUpdate([], pgError);

    const result = await useStore
      .getState()
      .saveGoals({ ...before, calories: 2500 });

    expect(result.error).toEqual(expect.any(String));
    expect(useStore.getState().goals).toEqual(before);
  });
});

describe("useStore.fetchSavedIngredients", () => {
  it("queries saved_ingredients_scored ordered by decay_score desc, and stores results in the order returned", async () => {
    // decay_score, not use_count, is the sort key. use_count 11 sorting
    // BEHIND use_count 1 here is the point: the client trusts whatever order
    // the view/DB hands back rather than re-sorting client-side, so a
    // zero-decay item lands wherever the query put it — last, if the query
    // is correct.
    const frequent = makeSavedIngredient({
      id: "frequent-but-stale",
      use_count: 11,
      decay_score: 0.4,
    });
    const recent = makeSavedIngredient({
      id: "recent",
      use_count: 1,
      decay_score: 3.2,
    });
    const neverLogged = makeSavedIngredient({
      id: "never-logged",
      use_count: 2,
      decay_score: 0,
      last_used_at: null,
    });
    // Pre-sorted, as the real `.order("decay_score", { ascending: false })`
    // query would return it.
    const dbOrder = [recent, frequent, neverLogged];

    const order = vi.fn(async () => ({ data: dbOrder, error: null }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select });

    useStore.getState().setUserId("test-user-id");
    await useStore.getState().fetchSavedIngredients();

    expect(supabase.from).toHaveBeenCalledWith("saved_ingredients_scored");
    expect(select).toHaveBeenCalledWith("*");
    expect(eq).toHaveBeenCalledWith("user_id", "test-user-id");
    expect(order).toHaveBeenCalledWith("decay_score", { ascending: false });
    expect(useStore.getState().savedIngredients.map((i) => i.id)).toEqual([
      "recent",
      "frequent-but-stale",
      "never-logged",
    ]);
  });
});

describe("useStore.saveIngredient (existing-item bump branch)", () => {
  it("on success, bumps use_count locally and returns the updated ingredient", async () => {
    const existing = makeSavedIngredient({ use_count: 3 });
    useStore.setState({ savedIngredients: [existing] });
    useStore.getState().setUserId("test-user-id");

    const eq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ update });

    const result = await useStore.getState().saveIngredient({
      name: existing.name,
      brand: existing.brand ?? "",
      cal_per100: existing.cal_per100,
      protein_per100: existing.protein_per100,
      carbs_per100: existing.carbs_per100,
      fat_per100: existing.fat_per100,
      sat_fat_per100: undefined,
      salt_per100: undefined,
      fibre_per100: undefined,
      sugar_per100: undefined,
    });

    expect(result?.use_count).toBe(4);
    expect(useStore.getState().savedIngredients[0].use_count).toBe(4);
  });

  it("on failure, leaves savedIngredients UNCHANGED and returns null", async () => {
    const existing = makeSavedIngredient({ use_count: 3 });
    useStore.setState({ savedIngredients: [existing] });
    useStore.getState().setUserId("test-user-id");

    const eq = vi.fn(async () => ({ error: pgError }));
    const update = vi.fn(() => ({ eq }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ update });

    const result = await useStore.getState().saveIngredient({
      name: existing.name,
      brand: existing.brand ?? "",
      cal_per100: existing.cal_per100,
      protein_per100: existing.protein_per100,
      carbs_per100: existing.carbs_per100,
      fat_per100: existing.fat_per100,
      sat_fat_per100: undefined,
      salt_per100: undefined,
      fibre_per100: undefined,
      sugar_per100: undefined,
    });

    expect(result).toBeNull();
    expect(useStore.getState().savedIngredients).toEqual([existing]);
  });
});

describe("useStore.saveIngredient (new-item insert branch)", () => {
  // What matters is the WIRE body: postgrest-js sends JSON.stringify(row), so
  // an `undefined` value means the key is absent and Postgres stores NULL
  // (no default since 20260919120000). An explicit null would fail against a
  // still-NOT NULL column; a 0 would be the original bug.
  const wire = (row: unknown) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

  const baseProduct: FoodProduct = {
    name: "Mystery granola",
    brand: "",
    cal_per100: 450,
    protein_per100: 10,
    carbs_per100: 60,
    fat_per100: 15,
    sat_fat_per100: undefined,
    salt_per100: undefined,
    fibre_per100: undefined,
    sugar_per100: undefined,
  };

  beforeEach(() => {
    useStore.getState().setUserId("test-user-id");
  });

  it("leaves an unknown small macro OUT of the request body — stored NULL; never 0, never an explicit null", async () => {
    const capture = mockInsertSingle(makeSavedIngredient());
    await useStore.getState().saveIngredient(baseProduct);

    const body = wire(capture.row);
    for (const key of ["sat_fat_per100", "salt_per100", "fibre_per100", "sugar_per100"]) {
      expect(body, key).not.toHaveProperty(key);
    }
    expect(body.cal_per100).toBe(450);
  });

  it("sends known small macros, including a genuine 0", async () => {
    const capture = mockInsertSingle(makeSavedIngredient());
    await useStore.getState().saveIngredient({
      ...baseProduct,
      sat_fat_per100: 0,
      salt_per100: 1.2,
      fibre_per100: 3,
      sugar_per100: 0,
    });

    const body = wire(capture.row);
    expect(body.sat_fat_per100).toBe(0);
    expect(body.salt_per100).toBe(1.2);
    expect(body.fibre_per100).toBe(3);
    expect(body.sugar_per100).toBe(0);
  });
});

describe("useStore.deleteIngredient", () => {
  it("on success, removes the ingredient locally", async () => {
    const existing = makeSavedIngredient();
    useStore.setState({ savedIngredients: [existing] });

    const eq = vi.fn(async () => ({ error: null }));
    const del = vi.fn(() => ({ eq }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({
      delete: del,
    });

    await useStore.getState().deleteIngredient(existing.id);

    expect(useStore.getState().savedIngredients).toEqual([]);
  });

  it("on failure, the ingredient is still present — no delete-ghost", async () => {
    const existing = makeSavedIngredient();
    useStore.setState({ savedIngredients: [existing] });

    const eq = vi.fn(async () => ({ error: pgError }));
    const del = vi.fn(() => ({ eq }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({
      delete: del,
    });

    await useStore.getState().deleteIngredient(existing.id);

    expect(useStore.getState().savedIngredients).toEqual([existing]);
  });
});

// ─── Batch draft ─────────────────────────────────────────────
//
// Pure client-side state — no Supabase mocking needed. These exist because
// the picker->caller flow that used to be an onPick callback in navigation
// params (which React Navigation warned about — non-serialisable state) is
// now entirely this slice: BatchIngredientPickerScreen calls these actions
// directly and BatchEditorScreen renders off the same state.

function makeProduct(overrides: Partial<FoodProduct> = {}): FoodProduct {
  return {
    name: "Plain flour",
    brand: "",
    cal_per100: 341,
    protein_per100: 9.4,
    carbs_per100: 77.7,
    fat_per100: 1.3,
    sat_fat_per100: undefined,
    salt_per100: undefined,
    fibre_per100: undefined,
    sugar_per100: undefined,
    ...overrides,
  };
}

describe("useStore batch draft", () => {
  it("starts empty", () => {
    expect(useStore.getState().batchDraft).toEqual({
      name: "",
      ingredients: [],
      totalYieldG: "",
      portionSizeG: "",
      portionLabel: "",
    });
  });

  it("addBatchIngredient appends one ingredient and clears yield/portion", () => {
    useStore.getState().setBatchDraftTotalYieldG("900");
    useStore.getState().setBatchDraftPortionSizeG("150");

    useStore.getState().addBatchIngredient(makeProduct(), 200);

    const draft = useStore.getState().batchDraft;
    expect(draft.ingredients).toHaveLength(1);
    expect(draft.ingredients[0].product.name).toBe("Plain flour");
    expect(draft.ingredients[0].quantityG).toBe(200);
    expect(draft.ingredients[0].key).toBeTruthy();
    // YIELD-ON-EDIT: the ingredient set just changed.
    expect(draft.totalYieldG).toBe("");
    expect(draft.portionSizeG).toBe("");
  });

  it("addBatchIngredient does not clobber name/portionLabel — only yield/portion", () => {
    useStore.getState().setBatchDraftName("Sunday chilli");
    useStore.getState().setBatchDraftPortionLabel("1 bowl");

    useStore.getState().addBatchIngredient(makeProduct(), 200);

    const draft = useStore.getState().batchDraft;
    expect(draft.name).toBe("Sunday chilli");
    expect(draft.portionLabel).toBe("1 bowl");
  });

  it("repeated adds accumulate, each with a distinct key", () => {
    useStore.getState().addBatchIngredient(makeProduct({ name: "Egg" }), 58);
    useStore.getState().addBatchIngredient(makeProduct({ name: "Milk" }), 100);

    const { ingredients } = useStore.getState().batchDraft;
    expect(ingredients.map((i) => i.product.name)).toEqual(["Egg", "Milk"]);
    expect(ingredients[0].key).not.toBe(ingredients[1].key);
  });

  it("addBatchIngredients adds several at once, each with a distinct key — the recipe-scan confirm shape", () => {
    useStore.getState().addBatchIngredients([
      { product: makeProduct({ name: "Onion" }), quantityG: 130 },
      { product: makeProduct({ name: "Garlic" }), quantityG: 4 },
      { product: makeProduct({ name: "Olive oil" }), quantityG: 14 },
    ]);

    const { ingredients } = useStore.getState().batchDraft;
    expect(ingredients).toHaveLength(3);
    expect(new Set(ingredients.map((i) => i.key)).size).toBe(3);
    expect(ingredients.map((i) => i.product.name)).toEqual(["Onion", "Garlic", "Olive oil"]);
  });

  it("removeBatchIngredient removes by key and leaves the rest, clearing yield/portion", () => {
    useStore.getState().addBatchIngredient(makeProduct({ name: "Egg" }), 58);
    useStore.getState().addBatchIngredient(makeProduct({ name: "Milk" }), 100);
    const [first, second] = useStore.getState().batchDraft.ingredients;
    useStore.getState().setBatchDraftTotalYieldG("500");

    useStore.getState().removeBatchIngredient(first.key);

    const draft = useStore.getState().batchDraft;
    expect(draft.ingredients).toEqual([second]);
    expect(draft.totalYieldG).toBe("");
  });

  it("updateBatchIngredientQuantity updates only the matching row, clearing yield/portion", () => {
    useStore.getState().addBatchIngredient(makeProduct({ name: "Egg" }), 58);
    useStore.getState().addBatchIngredient(makeProduct({ name: "Milk" }), 100);
    const [egg, milk] = useStore.getState().batchDraft.ingredients;
    useStore.getState().setBatchDraftPortionSizeG("150");

    useStore.getState().updateBatchIngredientQuantity(egg.key, 116);

    const draft = useStore.getState().batchDraft;
    expect(draft.ingredients.find((i) => i.key === egg.key)?.quantityG).toBe(116);
    expect(draft.ingredients.find((i) => i.key === milk.key)?.quantityG).toBe(100);
    expect(draft.portionSizeG).toBe("");
  });

  it("setBatchDraftIngredients wholesale-replaces — the edit-mode hydration path", () => {
    useStore.getState().addBatchIngredient(makeProduct({ name: "Stale" }), 1);

    const hydrated = [{ key: "item-1", product: makeProduct({ name: "Chicken" }), quantityG: 300 }];
    useStore.getState().setBatchDraftIngredients(hydrated);

    expect(useStore.getState().batchDraft.ingredients).toEqual(hydrated);
  });

  it("setters touch only their own field", () => {
    useStore.getState().setBatchDraftName("A");
    useStore.getState().setBatchDraftPortionLabel("B");
    useStore.getState().setBatchDraftTotalYieldG("900");
    useStore.getState().setBatchDraftPortionSizeG("150");

    expect(useStore.getState().batchDraft).toEqual({
      name: "A",
      portionLabel: "B",
      totalYieldG: "900",
      portionSizeG: "150",
      ingredients: [],
    });
  });

  it("resetBatchDraft clears everything back to the initial empty draft", () => {
    useStore.getState().setBatchDraftName("Sunday chilli");
    useStore.getState().addBatchIngredient(makeProduct(), 200);
    useStore.getState().setBatchDraftTotalYieldG("900");

    useStore.getState().resetBatchDraft();

    expect(useStore.getState().batchDraft).toEqual({
      name: "",
      ingredients: [],
      totalYieldG: "",
      portionSizeG: "",
      portionLabel: "",
    });
  });

  it("reset() (sign-out) also clears the batch draft", () => {
    useStore.getState().setBatchDraftName("Sunday chilli");
    useStore.getState().addBatchIngredient(makeProduct(), 200);

    useStore.getState().reset();

    expect(useStore.getState().batchDraft.name).toBe("");
    expect(useStore.getState().batchDraft.ingredients).toEqual([]);
  });
});

describe("useStore.manualEntryResult (Phase 3 cross-screen handoff — write-once/read-once/clear-on-read)", () => {
  it("starts empty", () => {
    expect(useStore.getState().manualEntryResult).toBeNull();
  });

  it("consumeManualEntryResult returns null when nothing is pending", () => {
    expect(useStore.getState().consumeManualEntryResult()).toBeNull();
  });

  it("setManualEntryResult makes the value readable via getState directly", () => {
    const product = makeProduct({ name: "Water" });
    useStore.getState().setManualEntryResult(product);
    expect(useStore.getState().manualEntryResult).toEqual(product);
  });

  it("consumeManualEntryResult returns the pending value AND clears it in the same call", () => {
    const product = makeProduct({ name: "Water" });
    useStore.getState().setManualEntryResult(product);

    const consumed = useStore.getState().consumeManualEntryResult();

    expect(consumed).toEqual(product);
    expect(useStore.getState().manualEntryResult).toBeNull();
  });

  it("a second consume after the first returns null — read-once, not re-readable", () => {
    useStore.getState().setManualEntryResult(makeProduct());
    useStore.getState().consumeManualEntryResult();

    expect(useStore.getState().consumeManualEntryResult()).toBeNull();
  });

  it("reset() (sign-out) also clears a pending manual-entry result", () => {
    useStore.getState().setManualEntryResult(makeProduct());
    useStore.getState().reset();
    expect(useStore.getState().manualEntryResult).toBeNull();
  });
});
