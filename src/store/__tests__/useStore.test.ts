import { describe, it, expect, vi, beforeEach } from "vitest";
import { useStore } from "../useStore";
import { supabase } from "../../lib/supabase";
import { MealEntry, FoodProduct, SavedIngredient } from "../../types";

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

beforeEach(() => {
  useStore.getState().reset();
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: { id: "test-user-id" } },
  } as never);
});

describe("useStore.addEntry", () => {
  it("does nothing when there is no signed-in user", async () => {
    useStore.getState().setUserId(null);
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
    expect(supabase.from).not.toHaveBeenCalled();
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

  it("appends the RETURNING row (with the trigger's decision) to local state", async () => {
    useStore.getState().setUserId("test-user-id");
    const returned = makeEntry({ id: "server-generated-id", planned: true });
    mockInsertSingle(returned);

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
  overrides: Partial<SavedIngredient> = {},
): SavedIngredient {
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
    ...overrides,
  };
}

const pgError = { message: "constraint violated", code: "23505" };

describe("useStore.saveGoals", () => {
  it("on success, updates local goals and returns a null error", async () => {
    useStore.getState().setUserId("test-user-id");
    const upsert = vi.fn(async () => ({ error: null }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ upsert });

    const newGoals = { ...useStore.getState().goals, calories: 2500 };
    const result = await useStore.getState().saveGoals(newGoals);

    expect(result.error).toBeNull();
    expect(useStore.getState().goals).toEqual(newGoals);
  });

  it("on failure, leaves local goals UNCHANGED and returns a non-null error", async () => {
    useStore.getState().setUserId("test-user-id");
    const before = useStore.getState().goals;
    const upsert = vi.fn(async () => ({ error: pgError }));
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ upsert });

    const result = await useStore
      .getState()
      .saveGoals({ ...before, calories: 2500 });

    expect(result.error).toEqual(expect.any(String));
    expect(useStore.getState().goals).toEqual(before);
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
    });

    expect(result).toBeNull();
    expect(useStore.getState().savedIngredients).toEqual([existing]);
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
