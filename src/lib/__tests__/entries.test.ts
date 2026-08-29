import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyEntries,
  draftsFromDay,
  draftsForTarget,
  sharedMealType,
  getDaySummary,
} from "../entries";
import { supabase } from "../supabase";
import { dateKey, localHM, willBePlanned } from "../time";
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

// ─── D6: merge-to-one-slot — multi-select "Same meal & time for all" ────
//
// sharedMealType is the pure predicate the sheet's smart default reads: do
// all selected rows already agree on a section? If so, default to merging
// them into one slot and preselect that section. If not, default to keeping
// each item's own slot. Empty selection can't happen from the UI (the sheet
// only opens with a non-empty selectedEntries), but is covered here as the
// honest base case of "all() over zero items".
describe("sharedMealType", () => {
  it("returns the common meal_type when every entry shares one", () => {
    const entries = [
      makeEntry({ id: "a", meal_type: "breakfast" }),
      makeEntry({ id: "b", meal_type: "breakfast" }),
      makeEntry({ id: "c", meal_type: "breakfast" }),
    ];
    expect(sharedMealType(entries)).toBe("breakfast");
  });

  it("returns null when entries span more than one meal_type", () => {
    const entries = [
      makeEntry({ id: "a", meal_type: "breakfast" }),
      makeEntry({ id: "b", meal_type: "lunch" }),
    ];
    expect(sharedMealType(entries)).toBeNull();
  });

  it("returns that entry's own meal_type for a single entry", () => {
    const entries = [makeEntry({ id: "a", meal_type: "dinner" })];
    expect(sharedMealType(entries)).toBe("dinner");
  });

  it("returns null for an empty selection", () => {
    expect(sharedMealType([])).toBeNull();
  });
});

describe("multi-entry merge to one slot (draftsForTarget + copyEntriesTo seam)", () => {
  it("produces N drafts for N selected rows, all sharing the target meal_type and wall-clock time", () => {
    const sources = [
      makeEntry({ id: "a", meal_type: "breakfast", eaten_at: "2026-07-20T07:00:00.000Z" }),
      makeEntry({ id: "b", meal_type: "breakfast", eaten_at: "2026-07-20T07:15:00.000Z" }),
      makeEntry({ id: "c", meal_type: "breakfast", eaten_at: "2026-07-20T07:30:00.000Z" }),
    ];

    const drafts = draftsForTarget(sources, {
      dayKey: "2026-07-21",
      meal_type: "lunch",
      time: { hours: 12, minutes: 15 },
    });

    expect(drafts).toHaveLength(sources.length);
    for (const draft of drafts) {
      expect(draft.meal_type).toBe("lunch");
      const d = new Date(draft.eaten_at);
      expect(d.getHours()).toBe(12);
      expect(d.getMinutes()).toBe(15);
      expect(dateKey(d)).toBe("2026-07-21");
    }
  });

  it("leaves the sources untouched — copyEntriesTo's insert is additive, count grows by exactly N", async () => {
    const sources = [
      makeEntry({ id: "a", meal_type: "breakfast" }),
      makeEntry({ id: "b", meal_type: "lunch" }),
    ];
    const capture = mockInsert(sources.map((s, i) => ({ id: `new-${i}` })));

    const drafts = draftsForTarget(sources, {
      dayKey: "2026-07-22",
      meal_type: "dinner",
      time: { hours: 19, minutes: 0 },
    });
    const inserted = await applyEntries(drafts);

    expect(inserted).toHaveLength(sources.length);
    const rows = capture.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(sources.length);
    // Nothing here mutates or deletes `sources` — draftsForTarget only reads them.
    expect(sources[0].meal_type).toBe("breakfast");
    expect(sources[1].meal_type).toBe("lunch");
  });
});

// The each-mode pill in CopyToSheet previews planned/logged with
// draftsFromDay(entries, dayKey).map(d => willBePlanned(d.eaten_at)) — the
// SAME builder applyEntries actually inserts through. If that prediction used
// a different time calculation than the real insert, a DST-switch day is
// exactly where they'd silently disagree: a naive +24h/ms shift moves the
// wall-clock time by an hour across the fold, which can flip which side of
// "now" a copy lands on and make the pill lie about what's about to happen.
describe("each-mode pill survives a DST-switch day (draftsFromDay → willBePlanned)", () => {
  const originalTZ = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Europe/London";
  });
  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it("splits planned vs logged using the same resolved wall-clock instant the insert will use", () => {
    const sources = [
      makeEntry({ id: "a", meal_type: "breakfast", eaten_at: "2026-10-18T07:00:00.000Z" }), // 08:00 BST
      makeEntry({ id: "b", meal_type: "dinner", eaten_at: "2026-10-18T19:00:00.000Z" }), // 20:00 BST
    ];

    // 2026-10-25: UK clocks fall back from BST to GMT.
    const targetDayKey = "2026-10-25";
    const drafts = draftsFromDay(sources, targetDayKey);

    // The wall clock itself must survive the fold — 08:00 stays 08:00 local,
    // not shifted to 07:00 or 09:00 by naive instant arithmetic.
    expect(localHM(drafts[0].eaten_at)).toEqual({ hours: 8, minutes: 0 });
    expect(localHM(drafts[1].eaten_at)).toEqual({ hours: 20, minutes: 0 });

    // "now" is 11:00 local on the target day, itself past the fold (GMT).
    const now = new Date("2026-10-25T11:00:00.000Z");
    const plannedFlags = drafts.map((d) => willBePlanned(d.eaten_at, now));

    // 08:00 has already passed by 11:00 → logged. 20:00 is still ahead → planned.
    expect(plannedFlags).toEqual([false, true]);

    const plannedCount = plannedFlags.filter(Boolean).length;
    expect(plannedCount).toBe(1); // "1 logged · 1 planned"
    expect(drafts.length - plannedCount).toBe(1);
  });
});

// ─── D7: getDaySummary — the shared day-total selector ──────────────────
//
// History's average card, Today's ring/macro panel and the past-day view
// each grew their own answer to "what happened on this day" and disagreed
// (History counted skipped and pending rows the ring didn't). This is the
// one fixture exercising all four rows getDaySummary has to tell apart:
// a plain eaten row, a confirmed plan (also "eaten"), a still-pending plan,
// and a skipped plan (must vanish from every bucket).
describe("getDaySummary", () => {
  const DATE = "2026-07-20";
  // Local-component constructors, not ISO strings with a Z — dateKey() reads
  // local Y/M/D, and an ISO UTC string can land on a different local day
  // depending on the test runner's timezone. See lib/time.ts's dateKey comment.
  const LIVE_NOW = new Date(2026, 6, 20, 12, 0, 0); // same local day as DATE
  const SETTLED_NOW = new Date(2026, 6, 21, 9, 0, 0); // the day after

  const plainEaten = makeEntry({
    id: "eaten-1",
    date: DATE,
    planned: false,
    confirmed_at: null,
    skipped_at: null,
    calories: 400,
    protein: 20,
    carbs: 40,
    fat: 10,
    sat_fat: 3,
    salt: 1,
    fibre: 5,
    sugar: 8,
  });

  const confirmedPlan = makeEntry({
    id: "eaten-2-confirmed",
    date: DATE,
    planned: true,
    confirmed_at: "2026-07-20T09:00:00.000Z",
    skipped_at: null,
    calories: 300,
    protein: 15,
    carbs: 30,
    fat: 8,
    sat_fat: 2,
    salt: 0.5,
    fibre: 4,
    sugar: 6,
  });

  const pendingPlan = makeEntry({
    id: "pending-1",
    date: DATE,
    planned: true,
    confirmed_at: null,
    skipped_at: null,
    calories: 500,
    protein: 25,
    carbs: 50,
    fat: 12,
    sat_fat: 4,
    salt: 2,
    fibre: 6,
    sugar: 10,
  });

  const skippedPlan = makeEntry({
    id: "skipped-1",
    date: DATE,
    planned: true,
    confirmed_at: null,
    skipped_at: "2026-07-19T20:00:00.000Z",
    // Deliberately absurd values — if this row leaks into any bucket, the
    // totals below are wrong by a mile, not by a rounding error.
    calories: 999,
    protein: 99,
    carbs: 99,
    fat: 99,
    sat_fat: 99,
    salt: 99,
    fibre: 99,
    sugar: 99,
  });

  const fixture = [plainEaten, confirmedPlan, pendingPlan, skippedPlan];

  const expectedEaten = {
    calories: 700,
    protein: 35,
    carbs: 70,
    fat: 18,
    satFat: 5,
    salt: 1.5,
    fibre: 9,
    sugar: 14,
    count: 2,
  };

  const expectedPending = {
    calories: 500,
    protein: 25,
    carbs: 50,
    fat: 12,
    satFat: 4,
    salt: 2,
    fibre: 6,
    sugar: 10,
    count: 1,
  };

  describe("live day (now is the same calendar day as date)", () => {
    it("splits eaten (plain + confirmed) from pending, dropping the skipped row from both", () => {
      const summary = getDaySummary(fixture, DATE, LIVE_NOW);
      expect(summary.eaten).toEqual(expectedEaten);
      expect(summary.pending).toEqual(expectedPending);
    });

    it("is not settled", () => {
      expect(getDaySummary(fixture, DATE, LIVE_NOW).isSettled).toBe(false);
    });

    it("towardGoal counts eaten + pending", () => {
      const summary = getDaySummary(fixture, DATE, LIVE_NOW);
      expect(summary.towardGoal).toEqual({
        calories: 1200,
        protein: 60,
        carbs: 120,
        fat: 30,
        satFat: 9,
        salt: 3.5,
        fibre: 15,
        sugar: 24,
        count: 3,
      });
    });
  });

  describe("settled day (now is the day after date)", () => {
    it("splits the same eaten/pending buckets as the live day", () => {
      const summary = getDaySummary(fixture, DATE, SETTLED_NOW);
      expect(summary.eaten).toEqual(expectedEaten);
      expect(summary.pending).toEqual(expectedPending);
    });

    it("is settled", () => {
      expect(getDaySummary(fixture, DATE, SETTLED_NOW).isSettled).toBe(true);
    });

    it("towardGoal equals eaten exactly — an unconfirmed plan on an ended day never happened", () => {
      const summary = getDaySummary(fixture, DATE, SETTLED_NOW);
      expect(summary.towardGoal).toEqual(summary.eaten);
    });
  });

  it("pending's count and macros are identical whether the day is live or settled", () => {
    const live = getDaySummary(fixture, DATE, LIVE_NOW);
    const settled = getDaySummary(fixture, DATE, SETTLED_NOW);
    expect(settled.pending).toEqual(live.pending);
  });

  it("a date whose only rows are pending returns eaten.count === 0", () => {
    const onlyPending = makeEntry({
      id: "pending-only",
      date: "2026-07-25",
      planned: true,
      confirmed_at: null,
      skipped_at: null,
    });
    const summary = getDaySummary([onlyPending], "2026-07-25", LIVE_NOW);
    expect(summary.eaten.count).toBe(0);
    // Zero rows contributed to any nullable macro — null, not a false "0".
    expect(summary.eaten.satFat).toBeNull();
    expect(summary.eaten.salt).toBeNull();
    expect(summary.eaten.fibre).toBeNull();
    expect(summary.eaten.sugar).toBeNull();
  });

  // The rule stated alongside DayBucket: a null macro contributes nothing to
  // a sum, but a bucket where EVERY contributing row is null for a macro must
  // itself report null, not 0 — 0 would assert "we know it's zero" when the
  // truth is "we don't know". Covered separately from the main fixture above
  // since every row there has real macro values.
  describe("null-vs-zero macro aggregation", () => {
    it("stays null when every row in the bucket has a null value for that macro", () => {
      const a = makeEntry({ id: "a", date: DATE, sat_fat: null, salt: null, fibre: null, sugar: null });
      const b = makeEntry({ id: "b", date: DATE, sat_fat: null, salt: null, fibre: null, sugar: null });
      const summary = getDaySummary([a, b], DATE, LIVE_NOW);
      expect(summary.eaten.satFat).toBeNull();
      expect(summary.eaten.salt).toBeNull();
      expect(summary.eaten.fibre).toBeNull();
      expect(summary.eaten.sugar).toBeNull();
      // calories/protein/carbs/fat are NOT NULL on MealEntry — always summed.
      expect(summary.eaten.calories).toBe(a.calories + b.calories);
    });

    it("a null row contributes nothing — does not zero out a bucket with a real value", () => {
      const known = makeEntry({ id: "known", date: DATE, salt: 2.5 });
      const unknown = makeEntry({ id: "unknown", date: DATE, salt: null });
      const summary = getDaySummary([known, unknown], DATE, LIVE_NOW);
      expect(summary.eaten.salt).toBe(2.5);
    });
  });
});
