import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  draftsFromFeedEntry,
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
