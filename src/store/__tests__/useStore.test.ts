import { describe, it, expect, vi, beforeEach } from "vitest";
import { useStore } from "../useStore";
import { supabase } from "../../lib/supabase";
import { MealEntry } from "../../types";

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
