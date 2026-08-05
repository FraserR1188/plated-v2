import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyEntries, draftsFromDay, draftsForTarget } from "../entries";
import { supabase } from "../supabase";
import { dateKey } from "../time";
import { EntryDraft, MealEntry } from "../../types";

function makeDraft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    name: "Porridge",
    brand: null,
    serving_g: 250,
    calories: 437,
    protein: 12.5,
    carbs: 60,
    fat: 8,
    sat_fat: 2,
    salt: 1.25,
    fibre: 6,
    sugar: 4,
    meal_type: "breakfast",
    eaten_at: "2026-07-27T08:00:00.000Z",
    eaten_at_estimated: false,
    source: "search",
    barcode: null,
    off_id: null,
    image_url: null,
    image_path: null,
    custom_food_id: null,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<MealEntry> = {}): MealEntry {
  return {
    id: "e1",
    user_id: "u1",
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
    meal_type: "breakfast",
    brand: null,
    salt: 1.25,
    fibre: 6,
    sugar: 4,
    sat_fat: 2,
    eaten_at: "2026-07-20T08:00:00.000Z",
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

/** Wire supabase.from("meal_entries").insert(rows).select() to capture the
 *  rows it was called with and hand back a canned RETURNING result. */
function mockInsert(returning: unknown[]) {
  const insertedRowsCapture: { rows?: unknown } = {};
  const select = vi.fn(async () => ({ data: returning, error: null }));
  const insert = vi.fn((rows: unknown) => {
    insertedRowsCapture.rows = rows;
    return { select };
  });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });
  return insertedRowsCapture;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: { id: "test-user-id" } },
  } as never);
});

describe("applyEntries", () => {
  it("derives `date` from eaten_at via local dateKey — never trusts a caller-supplied one", async () => {
    const capture = mockInsert([]);
    const draft = makeDraft({ eaten_at: "2026-07-27T23:45:00.000Z" });

    await applyEntries([draft]);

    const rows = capture.rows as { date: string; eaten_at: string }[];
    expect(rows[0].date).toBe(dateKey(new Date(draft.eaten_at)));
  });

  it("never sends planned / confirmed_at / skipped_at — the DB trigger owns them", async () => {
    const capture = mockInsert([]);
    await applyEntries([makeDraft()]);

    const row = (capture.rows as Record<string, unknown>[])[0];
    expect(row).not.toHaveProperty("planned");
    expect(row).not.toHaveProperty("confirmed_at");
    expect(row).not.toHaveProperty("skipped_at");
  });

  it("returns the RETURNING rows from .select(), not a locally-guessed value", async () => {
    const returned = [{ id: "new-1", planned: true }];
    mockInsert(returned);

    const result = await applyEntries([makeDraft()]);
    expect(result).toBe(returned);
  });

  it("preserves NULL vs 0 on the way in — does not coalesce nullable macros", async () => {
    const capture = mockInsert([]);
    await applyEntries([
      makeDraft({ sat_fat: null, salt: null, fibre: null, sugar: null }),
    ]);

    const row = (capture.rows as Record<string, unknown>[])[0];
    expect(row.sat_fat).toBeNull();
    expect(row.salt).toBeNull();
    expect(row.fibre).toBeNull();
    expect(row.sugar).toBeNull();
  });

  it("short-circuits on an empty draft list without calling supabase", async () => {
    const result = await applyEntries([]);
    expect(result).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("each row's date is independently derived from ITS OWN eaten_at — a mixed-day batch doesn't collapse to one date", async () => {
    const capture = mockInsert([]);
    const drafts = [
      makeDraft({ eaten_at: "2026-07-20T08:00:00.000Z" }),
      makeDraft({ eaten_at: "2026-07-27T08:00:00.000Z" }),
    ];
    await applyEntries(drafts);

    const rows = capture.rows as { date: string }[];
    expect(rows[0].date).toBe(dateKey(new Date(drafts[0].eaten_at)));
    expect(rows[1].date).toBe(dateKey(new Date(drafts[1].eaten_at)));
    expect(rows[0].date).not.toBe(rows[1].date);
  });
});

describe("draftsFromDay (copy-a-day)", () => {
  it("moves the entry onto the target day while keeping its OWN meal_type — there is no targetMeal override", () => {
    const source = makeEntry({ meal_type: "dinner", date: "2026-07-20" });
    const [draft] = draftsFromDay([source], "2026-07-27");

    expect(draft.meal_type).toBe("dinner");
    expect(dateKey(new Date(draft.eaten_at))).toBe("2026-07-27");
  });

  it("produces a draft with no `date` field for applyEntries to accidentally trust", () => {
    const source = makeEntry();
    const [draft] = draftsFromDay([source], "2026-07-27");
    expect(draft).not.toHaveProperty("date");
  });

  it("marks the copy as an estimate, regardless of the source's certainty", () => {
    const source = makeEntry({ eaten_at_estimated: false });
    const [draft] = draftsFromDay([source], "2026-07-27");
    expect(draft.eaten_at_estimated).toBe(true);
  });

  it("preserves the wall-clock time across the day change", () => {
    const source = makeEntry({ eaten_at: "2026-07-20T12:30:00.000Z" });
    const [draft] = draftsFromDay([source], "2026-07-27");
    const d = new Date(draft.eaten_at);
    const sourceD = new Date(source.eaten_at);
    expect(d.getHours()).toBe(sourceD.getHours());
    expect(d.getMinutes()).toBe(sourceD.getMinutes());
  });
});

// ─── D5: copy-to-any-slot — the new contract ─────────────────────────────
//
// draftsFromDay hard-inherits meal_type and wall-clock time from the source
// row (see the two tests above: "keeping its OWN meal_type", "preserves the
// wall-clock time"). That is the bug: "Copy to…" can only ever land a copy
// in the same section at the same time, on a different day.
//
// draftsForTarget replaces it with a signature that REQUIRES the explicit
// target — day, meal_type AND time — so source-inheritance is structurally
// impossible, the same intent as EntryDraft omitting `date`/`planned`.
describe("draftsForTarget (copy to an explicit day/meal/time)", () => {
  it("lands the copy in the CHOSEN meal_type and at the CHOSEN time, not the source's", () => {
    const source = makeEntry({
      meal_type: "breakfast",
      eaten_at: "2026-07-20T08:00:00.000Z", // 08:00 breakfast
    });

    const [draft] = draftsForTarget([source], {
      dayKey: "2026-07-20",
      meal_type: "lunch",
      time: { hours: 13, minutes: 30 },
    });

    expect(draft.meal_type).toBe("lunch");
    const d = new Date(draft.eaten_at);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(30);
    expect(dateKey(d)).toBe("2026-07-20");
  });

  it("produces exactly one draft per source entry — count grows by exactly one at the apply seam", () => {
    const source = makeEntry({ id: "source-1" });
    const drafts = draftsForTarget([source], {
      dayKey: "2026-07-27",
      meal_type: "dinner",
      time: { hours: 19, minutes: 0 },
    });
    expect(drafts).toHaveLength(1);
  });

  it("derives the day from the chosen dayKey via local dateKey — never the source's day", () => {
    const source = makeEntry({ eaten_at: "2026-07-20T08:00:00.000Z" });
    const [draft] = draftsForTarget([source], {
      dayKey: "2026-08-15",
      meal_type: "breakfast",
      time: { hours: 8, minutes: 0 },
    });
    expect(dateKey(new Date(draft.eaten_at))).toBe("2026-08-15");
  });

  it("never produces a draft with a `date` or `planned` field — both stay unrepresentable in EntryDraft", () => {
    const source = makeEntry();
    const [draft] = draftsForTarget([source], {
      dayKey: "2026-07-27",
      meal_type: "snacks",
      time: { hours: 15, minutes: 0 },
    });
    expect(draft).not.toHaveProperty("date");
    expect(draft).not.toHaveProperty("planned");
    expect(draft).not.toHaveProperty("confirmed_at");
    expect(draft).not.toHaveProperty("skipped_at");
  });

  it("marks the copy as an estimate, regardless of the source's certainty", () => {
    const source = makeEntry({ eaten_at_estimated: false });
    const [draft] = draftsForTarget([source], {
      dayKey: "2026-07-27",
      meal_type: "breakfast",
      time: { hours: 8, minutes: 0 },
    });
    expect(draft.eaten_at_estimated).toBe(true);
  });

  it("builds eaten_at from dayKey + time via the local Date constructor — no +24h arithmetic across DST", () => {
    // BST → GMT fold, 2026-10-25. A +24h/ms-arithmetic implementation would
    // shift the wall-clock time by an hour; going through parts must not.
    const source = makeEntry({ eaten_at: "2026-10-20T07:30:00.000Z" });
    const [draft] = draftsForTarget([source], {
      dayKey: "2026-10-26",
      meal_type: "breakfast",
      time: { hours: 7, minutes: 30 },
    });
    const d = new Date(draft.eaten_at);
    expect(d.getHours()).toBe(7);
    expect(d.getMinutes()).toBe(30);
    expect(dateKey(d)).toBe("2026-10-26");
  });
});
