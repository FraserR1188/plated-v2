import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  draftsFromFeedEntry,
  draftsForCopy,
  initialCopyMealType,
  copyEntriesToMyLog,
  getEntriesForUserRange,
} from "../social";
import { supabase } from "../supabase";
import { dateKey, localHM, sameTimeOnDay } from "../time";
import { CopyPayload, MealEntry } from "../../types";

function makeEntry(overrides: Partial<MealEntry> = {}): MealEntry {
  return {
    id: "e1",
    user_id: "friend-1",
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

function makePayload(overrides: Partial<CopyPayload> = {}): CopyPayload {
  return {
    scope: "meal_section",
    entries: [makeEntry()],
    sourceName: "Alex's Breakfast",
    ...overrides,
  };
}

/** Wire supabase.from("meal_entries").insert(rows).select() to capture the
 *  rows it was called with and hand back a canned RETURNING result. Same
 *  harness as entries.test.ts — kept local rather than shared, since it's a
 *  handful of lines and importing test infra across test files is its own
 *  kind of coupling. */
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

/** A "shared"-mode target (ingredient / meal_section): one chosen slot. */
const SHARED_TARGET = {
  dayKey: "2026-09-05",
  time: { hours: 12, minutes: 30 },
  meal_type: "lunch" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: { id: "test-user-id" } },
  } as never);
});

describe("draftsFromFeedEntry", () => {
  it("resolves eaten_at via sameTimeOnDay(target.time, target.dayKey) — never now()", () => {
    const payload = makePayload();
    const target = {
      dayKey: "2026-09-05",
      time: { hours: 14, minutes: 30 },
      meal_type: null,
    };

    const [draft] = draftsFromFeedEntry(payload, target);

    expect(draft.eaten_at).toBe(sameTimeOnDay(target.time, target.dayKey));
  });

  it("lets a future target day through untouched — no clamping, no special-casing planned", () => {
    const payload = makePayload();
    const farFuture = {
      dayKey: "2030-01-01",
      time: { hours: 9, minutes: 0 },
      meal_type: null,
    };

    const [draft] = draftsFromFeedEntry(payload, farFuture);

    expect(draft.eaten_at).toBe(sameTimeOnDay(farFuture.time, farFuture.dayKey));
  });

  it("target.meal_type overrides every entry's own section when provided (meal_section copy)", () => {
    const payload = makePayload({
      entries: [
        makeEntry({ id: "e1", meal_type: "breakfast" }),
        makeEntry({ id: "e2", meal_type: "breakfast" }),
      ],
    });
    const target = {
      dayKey: "2026-09-05",
      time: { hours: 8, minutes: 0 },
      meal_type: "dinner" as const,
    };

    const drafts = draftsFromFeedEntry(payload, target);

    expect(drafts.every((d) => d.meal_type === "dinner")).toBe(true);
  });

  it("preserves each entry's own meal_type when target.meal_type is null (full_day copy)", () => {
    const payload = makePayload({
      scope: "full_day",
      entries: [
        makeEntry({ id: "e1", meal_type: "breakfast" }),
        makeEntry({ id: "e2", meal_type: "lunch" }),
      ],
    });
    const target = {
      dayKey: "2026-09-05",
      time: { hours: 8, minutes: 0 },
      meal_type: null,
    };

    const drafts = draftsFromFeedEntry(payload, target);

    expect(drafts.map((d) => d.meal_type)).toEqual(["breakfast", "lunch"]);
  });

  it("preserves each entry's OWN wall-clock time (and their relative order) when target.time is null (full_day copy) — this is the test that stops a future 'simplify to one timestamp'", () => {
    const payload = makePayload({
      scope: "full_day",
      entries: [
        makeEntry({ id: "e1", eaten_at: "2026-07-20T08:15:00.000Z" }), // 08:15
        makeEntry({ id: "e2", eaten_at: "2026-07-20T13:40:00.000Z" }), // 13:40
      ],
    });
    const target = { dayKey: "2026-09-05", time: null, meal_type: null };

    const drafts = draftsFromFeedEntry(payload, target);

    const expectedFirst = sameTimeOnDay(
      localHM("2026-07-20T08:15:00.000Z"),
      target.dayKey,
    );
    const expectedSecond = sameTimeOnDay(
      localHM("2026-07-20T13:40:00.000Z"),
      target.dayKey,
    );

    // Each entry's own clock time survives the day move...
    expect(drafts[0].eaten_at).toBe(expectedFirst);
    expect(drafts[1].eaten_at).toBe(expectedSecond);

    // ...they're genuinely distinct, not both collapsed onto one instant...
    expect(drafts[0].eaten_at).not.toBe(drafts[1].eaten_at);

    // ...and their relative order (08:15 before 13:40) is preserved.
    expect(new Date(drafts[0].eaten_at).getTime()).toBeLessThan(
      new Date(drafts[1].eaten_at).getTime(),
    );
  });

  it("marks the copy as an estimate regardless of the chosen day/time — matches draftsForTarget/draftsFromDay", () => {
    const payload = makePayload({ entries: [makeEntry({ eaten_at_estimated: false })] });
    const target = {
      dayKey: "2026-09-05",
      time: { hours: 8, minutes: 0 },
      meal_type: null,
    };

    const [draft] = draftsFromFeedEntry(payload, target);

    expect(draft.eaten_at_estimated).toBe(true);
  });

  it("never coalesces a null macro to 0", () => {
    const payload = makePayload({
      entries: [
        makeEntry({ sat_fat: null, salt: null, fibre: null, sugar: null }),
      ],
    });
    const target = {
      dayKey: "2026-09-05",
      time: { hours: 8, minutes: 0 },
      meal_type: null,
    };

    const [draft] = draftsFromFeedEntry(payload, target);

    expect(draft.sat_fat).toBeNull();
    expect(draft.salt).toBeNull();
    expect(draft.fibre).toBeNull();
    expect(draft.sugar).toBeNull();
  });

  it("drops image_path and custom_food_id — a friend's private storage path can't be signed by the viewer", () => {
    const payload = makePayload({
      entries: [
        makeEntry({
          image_path: "friend-id/food-id/front.jpg",
          custom_food_id: "cf-1",
        }),
      ],
    });

    const [draft] = draftsFromFeedEntry(payload, {
      dayKey: "2026-09-05",
      time: { hours: 8, minutes: 0 },
      meal_type: null,
    });

    expect(draft.image_path).toBeNull();
    expect(draft.custom_food_id).toBeNull();
  });

  it("the returned draft carries neither `date` nor `planned` — EntryDraft protects the table, this protects the builder", () => {
    const payload = makePayload();
    const [draft] = draftsFromFeedEntry(payload, {
      dayKey: "2026-09-05",
      time: { hours: 8, minutes: 0 },
      meal_type: null,
    });

    expect(draft).not.toHaveProperty("date");
    expect(draft).not.toHaveProperty("planned");
  });
});

describe("copyEntriesToMyLog", () => {
  it("threads the target all the way to the insert: a future day derives the matching `date`, planned is never sent, and null macros survive", async () => {
    const capture = mockInsert([]);
    const payload = makePayload({
      entries: [
        makeEntry({ sat_fat: null, salt: null, fibre: null, sugar: null }),
      ],
    });
    const target = {
      dayKey: "2030-01-01",
      time: { hours: 19, minutes: 0 },
      meal_type: null,
    };

    await copyEntriesToMyLog(payload, target);

    const row = (capture.rows as Record<string, unknown>[])[0];
    const expectedEatenAt = sameTimeOnDay(target.time, target.dayKey);

    // `date` IS present on the actual insert row (applyEntries derives it),
    // and it must reflect the FUTURE target day, not today.
    expect(row.date).toBe(dateKey(new Date(expectedEatenAt)));
    expect(row.eaten_at).toBe(expectedEatenAt);

    // `planned` is never sent — the DB trigger owns it.
    expect(row).not.toHaveProperty("planned");

    // Null macros reach the insert as null, not a coalesced 0.
    expect(row.sat_fat).toBeNull();
    expect(row.salt).toBeNull();
    expect(row.fibre).toBeNull();
    expect(row.sugar).toBeNull();
  });

  it("a single-ingredient copy at a new weight reaches the insert ratio-scaled, with the friend's sat fat and 'copied' provenance", async () => {
    const capture = mockInsert([]);
    const payload = makePayload({ scope: "ingredient" }); // 250g, 437 kcal, sat_fat 2

    await copyEntriesToMyLog(payload, SHARED_TARGET, 375);

    const row = (capture.rows as Record<string, unknown>[])[0];
    expect(row.serving_g).toBe(375);
    expect(row.calories as number).toBeCloseTo(437 * 1.5, 9);
    expect(row.sat_fat as number).toBeCloseTo(3, 9);
    expect(row.source).toBe("copied");
  });

  it("a weightless single-ingredient copy reaches the insert with serving_g NULL — never a substituted 100g", async () => {
    const capture = mockInsert([]);
    const payload = makePayload({
      scope: "ingredient",
      entries: [makeEntry({ serving_g: null })],
    });

    await copyEntriesToMyLog(payload, SHARED_TARGET, null);

    const row = (capture.rows as Record<string, unknown>[])[0];
    expect(row.serving_g).toBeNull();
    expect(row.calories).toBe(437);
  });
});

describe("draftsForCopy — the single-ingredient friend copy", () => {
  it("with no target weight, returns exactly what draftsFromFeedEntry returns", () => {
    const payload = makePayload({ scope: "ingredient" });
    expect(draftsForCopy(payload, SHARED_TARGET, null)).toEqual(
      draftsFromFeedEntry(payload, SHARED_TARGET),
    );
  });

  it("rescales every nutrient and serving_g by ratio off the friend's own serving_g — no per-100g rebuild, no rounding", () => {
    // 250g → 375g is ×1.5. The old entryToProduct route rounded 437/250 to
    // 175 kcal/100g first, giving 656.25 here instead of 655.5.
    const [d] = draftsForCopy(makePayload({ scope: "ingredient" }), SHARED_TARGET, 375);

    expect(d.serving_g).toBe(375);
    expect(d.calories).toBeCloseTo(655.5, 9);
    expect(d.protein).toBeCloseTo(12.5 * 1.5, 9);
    expect(d.carbs).toBeCloseTo(60 * 1.5, 9);
    expect(d.fat).toBeCloseTo(8 * 1.5, 9);
    expect(d.sat_fat as number).toBeCloseTo(2 * 1.5, 9);
    expect(d.salt as number).toBeCloseTo(1.25 * 1.5, 9);
    expect(d.fibre as number).toBeCloseTo(6 * 1.5, 9);
    expect(d.sugar as number).toBeCloseTo(4 * 1.5, 9);
  });

  it("carries the friend's KNOWN sat fat — the field the old entryToProduct route dropped to NULL", () => {
    const [same] = draftsForCopy(makePayload({ scope: "ingredient" }), SHARED_TARGET, null);
    expect(same.sat_fat).toBe(2);
  });

  it("keeps NULL small macros NULL through a rescale", () => {
    const payload = makePayload({
      scope: "ingredient",
      entries: [makeEntry({ sat_fat: null, salt: null, fibre: null, sugar: null })],
    });
    const [d] = draftsForCopy(payload, SHARED_TARGET, 100);
    expect(d.sat_fat).toBeNull();
    expect(d.salt).toBeNull();
    expect(d.fibre).toBeNull();
    expect(d.sugar).toBeNull();
  });

  it("a friend's entry with no weight copies unchanged with serving_g NULL — no weight is ever invented", () => {
    const payload = makePayload({
      scope: "ingredient",
      entries: [makeEntry({ serving_g: null })],
    });
    for (const grams of [null, 150]) {
      const [d] = draftsForCopy(payload, SHARED_TARGET, grams);
      expect(d.serving_g).toBeNull();
      expect(d.calories).toBe(437);
      expect(d.sat_fat).toBe(2);
    }
  });

  it("stamps the copy 'copied', keeps the OFF identity, and drops the friend's private image path", () => {
    const payload = makePayload({
      scope: "ingredient",
      entries: [
        makeEntry({
          barcode: "5000112",
          off_id: "off-1",
          image_url: "https://images.openfoodfacts.org/x.jpg",
          image_path: "friend-1/cf-1/front.jpg",
          custom_food_id: "cf-1",
        }),
      ],
    });
    const [d] = draftsForCopy(payload, SHARED_TARGET, 300);
    expect(d.source).toBe("copied");
    expect(d.barcode).toBe("5000112");
    expect(d.off_id).toBe("off-1");
    expect(d.image_url).toBe("https://images.openfoodfacts.org/x.jpg");
    expect(d.image_path).toBeNull();
    expect(d.custom_food_id).toBeNull();
  });

  it("refuses a target weight on a multi-entry scope", () => {
    const payload = makePayload({ scope: "meal_section", entries: [makeEntry(), makeEntry({ id: "e2" })] });
    expect(() => draftsForCopy(payload, SHARED_TARGET, 200)).toThrow(/single-ingredient/);
  });

  it("refuses a non-positive or non-finite target weight — it would fabricate zeros", () => {
    const payload = makePayload({ scope: "ingredient" });
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => draftsForCopy(payload, SHARED_TARGET, bad)).toThrow(/must be > 0/);
    }
  });
});

describe("initialCopyMealType", () => {
  // Local wall-clock 19:30 → dinner by sectionForTime.
  const evening = new Date(2026, 8, 5, 19, 30);

  it("ingredient scope seeds from THIS copy's time, never the friend's section", () => {
    const payload = makePayload({
      scope: "ingredient",
      entries: [makeEntry({ meal_type: "breakfast" })],
    });
    expect(initialCopyMealType(payload, evening)).toBe("dinner");
  });

  it("meal_section keeps seeding from the section its entries share (unchanged here — a separate decision)", () => {
    const payload = makePayload({
      scope: "meal_section",
      entries: [makeEntry({ meal_type: "breakfast" }), makeEntry({ id: "e2", meal_type: "breakfast" })],
    });
    expect(initialCopyMealType(payload, evening)).toBe("breakfast");
  });
});

/** Wire supabase.from("meal_entries").<chain>.<chain>... to a chainable mock
 *  that records every method call (name + args) in order, and resolves —
 *  since the real query builder is itself a thenable — via a `.then`.
 *  Purpose-built for asserting filter CONSTRUCTION (which methods, which
 *  args, which order), which mockInsert above doesn't cover. */
function mockRangeQuery(data: unknown[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  const chain =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  builder.select = chain("select");
  builder.eq = chain("eq");
  builder.gte = chain("gte");
  builder.lte = chain("lte");
  builder.or = chain("or");
  builder.is = chain("is");
  builder.order = chain("order");
  builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
    resolve({ data, error: null });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue(builder);
  return calls;
}

describe("getEntriesForUserRange", () => {
  it("uses .gte/.lte for the date range, keeps the skipped_at gate, and does NOT reinstate a client-side planned/confirmed filter — RLS (meal_entries_select_follower) is the only gate on that now", async () => {
    const calls = mockRangeQuery([]);

    await getEntriesForUserRange("friend-1", "2026-08-01", "2026-08-14");

    // Exact method sequence: no "or" in the chain. If someone reinstates a
    // client-side planned/confirmed filter, this fails immediately, before
    // even checking its args.
    expect(calls.map((c) => c.method)).toEqual([
      "select",
      "eq",
      "gte",
      "lte",
      "is",
      "order",
    ]);
    expect(calls.some((c) => c.method === "or")).toBe(false);
    expect(calls.find((c) => c.method === "eq")?.args).toEqual([
      "user_id",
      "friend-1",
    ]);
    expect(calls.find((c) => c.method === "gte")?.args).toEqual([
      "date",
      "2026-08-01",
    ]);
    expect(calls.find((c) => c.method === "lte")?.args).toEqual([
      "date",
      "2026-08-14",
    ]);
    expect(calls.find((c) => c.method === "is")?.args).toEqual([
      "skipped_at",
      null,
    ]);
    expect(calls.find((c) => c.method === "order")?.args).toEqual([
      "eaten_at",
      { ascending: true },
    ]);
  });
});
