import { describe, it, expect } from "vitest";
import { bandForLocalHour, buildDayStream, Band } from "../dayStream";
import { MealEntry, Workout } from "../../types";

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
    eaten_at_estimated: false,
    ...overrides,
  };
}

function makeWorkout(overrides: Partial<Workout> = {}): Workout {
  return {
    id: "w1",
    ingestSource: "whoop",
    workoutStart: "2026-07-20T07:00:00.000Z",
    workoutEnd: "2026-07-20T07:45:00.000Z",
    timezoneOffset: null,
    localDate: "2026-07-20",
    sportName: "Running",
    strain: 12.4,
    averageHeartRate: 140,
    maxHeartRate: 170,
    energyKilojoule: 1200,
    distanceMeter: 5000,
    strainScoreState: "SCORED",
    ...overrides,
  };
}

// Local time helper — an entry/workout's local hour is what buildDayStream
// bands on, so tests build times via the local Date constructor, exactly
// like TodayScreen's own tests, rather than hand-writing a UTC offset that
// would drift with wherever CI happens to run.
const atLocal = (h: number, m = 0) =>
  new Date(2026, 6, 20, h, m).toISOString();

describe("bandForLocalHour", () => {
  it("covers the five bands at their boundaries", () => {
    expect(bandForLocalHour(0)).toBe("overnight");
    expect(bandForLocalHour(4)).toBe("overnight");
    expect(bandForLocalHour(5)).toBe("morning");
    expect(bandForLocalHour(10)).toBe("morning");
    expect(bandForLocalHour(11)).toBe("midday");
    expect(bandForLocalHour(16)).toBe("midday");
    expect(bandForLocalHour(17)).toBe("evening");
    expect(bandForLocalHour(21)).toBe("evening");
    expect(bandForLocalHour(22)).toBe("night");
    expect(bandForLocalHour(23)).toBe("night");
  });

  it("is monotonic — never decreases as the hour increases", () => {
    const order: Band[] = ["overnight", "morning", "midday", "evening", "night"];
    let lastIndex = -1;
    for (let h = 0; h <= 23; h++) {
      const idx = order.indexOf(bandForLocalHour(h));
      expect(idx).toBeGreaterThanOrEqual(lastIndex);
      lastIndex = idx;
    }
  });
});

describe("buildDayStream", () => {
  it("returns [] for an empty day", () => {
    expect(buildDayStream([], [])).toEqual([]);
  });

  it("emits exactly one band header for a single item", () => {
    const entry = makeEntry({ eaten_at: atLocal(8, 30) });
    const stream = buildDayStream([entry]);
    expect(stream).toEqual([
      { kind: "band", band: "morning", key: "band-morning" },
      { kind: "food", entry, key: `food-${entry.id}` },
    ]);
  });

  it("groups multiple items in the same band under one header", () => {
    const a = makeEntry({ id: "a", eaten_at: atLocal(6, 12) });
    const b = makeEntry({ id: "b", eaten_at: atLocal(8, 30) });
    const stream = buildDayStream([a, b]);
    expect(stream.filter((s) => s.kind === "band")).toHaveLength(1);
    expect(stream.map((s) => s.key)).toEqual([
      "band-morning",
      "food-a",
      "food-b",
    ]);
  });

  it("never repeats a band header across a day spanning 01:00→23:00", () => {
    const times = [1, 3, 6, 9, 12, 15, 18, 20, 22, 23];
    const entries = times.map((h, i) =>
      makeEntry({ id: `e${i}`, eaten_at: atLocal(h) }),
    );
    const stream = buildDayStream(entries);

    const bandKeys = stream
      .filter((s) => s.kind === "band")
      .map((s) => (s as { key: string }).key);
    expect(bandKeys).toEqual([
      "band-overnight",
      "band-morning",
      "band-midday",
      "band-evening",
      "band-night",
    ]);
    expect(new Set(bandKeys).size).toBe(bandKeys.length); // no repeats
  });

  it("a snack sorts inline under Midday with no off-rail card distinction", () => {
    const breakfast = makeEntry({
      id: "b",
      meal_type: "breakfast",
      eaten_at: atLocal(8, 0),
    });
    const snack = makeEntry({
      id: "s",
      meal_type: "snacks",
      eaten_at: atLocal(15, 40),
    });
    const stream = buildDayStream([breakfast, snack]);
    expect(stream.map((s) => s.key)).toEqual([
      "band-morning",
      "food-b",
      "band-midday",
      "food-s",
    ]);
  });

  it("sorts a workout into its true time position and band", () => {
    const early = makeEntry({ id: "early", eaten_at: atLocal(6, 12) });
    const workout = makeWorkout({ workoutStart: atLocal(7, 0) });
    const late = makeEntry({ id: "late", eaten_at: atLocal(8, 30) });

    const stream = buildDayStream([early, late], [workout]);

    expect(stream.map((s) => s.key)).toEqual([
      "band-morning",
      "food-early",
      "workout-w1",
      "food-late",
    ]);
  });

  it("defaults workouts to [] so commit-1 callers are unaffected", () => {
    const entry = makeEntry({ eaten_at: atLocal(8, 0) });
    expect(buildDayStream([entry])).toEqual(buildDayStream([entry], []));
  });
});
