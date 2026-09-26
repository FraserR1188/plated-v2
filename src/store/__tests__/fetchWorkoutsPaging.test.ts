// ============================================================
// PL-056 — fetchWorkouts must read EVERY row, not an arbitrary max_rows.
//
// Same cap as PL-050, worse shape: fetchWorkouts had no ORDER BY at all, so
// past max_rows the rows it lost were not "the oldest" but whichever the
// planner happened to put last. The fake (helpers/fakePostgrest.ts) caps
// at 1000 and reorders tied rows on every request.
//
// A workout's identity in biometric_workouts is (origin_package,
// source_workout_id) — the view's own composite key. Two Health Connect
// apps can log workouts that start in the same second, and one app can log
// two; the fixture has both, so the ORDER BY must end on the full key.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/react-native";
import { useStore, WORKOUTS_PAGE_SIZE } from "../useStore";
import { supabase } from "../../lib/supabase";
import { fakeCappedTable, FakeRow } from "./helpers/fakePostgrest";

const CAP = 1000;
const USER = "test-user-id";
const PACKAGES = ["com.google.android.apps.fitness", "com.strava", "whoop.direct"];

const identity = (r: FakeRow) => `${r.origin_package}|${r.source_workout_id}`;

/**
 * `count` workouts for USER. Every block of 4 shares one workout_start, and
 * within a block two rows also share origin_package — so a tiebreak on
 * origin_package alone is still not total. Some foreign rows are mixed in.
 */
function fixture(count: number): FakeRow[] {
  const rows: FakeRow[] = [];
  const t0 = Date.UTC(2026, 8, 26, 7, 0, 0);
  for (let i = 0; i < count; i++) {
    const block = Math.floor(i / 4);
    const pkg = PACKAGES[i % 4 === 3 ? 0 : i % 3];
    rows.push({
      user_id: USER,
      origin_package: pkg,
      ingest_source: pkg === "whoop.direct" ? "whoop" : pkg,
      source_workout_id: `w-${String(i).padStart(6, "0")}`,
      workout_start: new Date(t0 - block * 3_600_000).toISOString(),
      workout_end: new Date(t0 - block * 3_600_000 + 1_800_000).toISOString(),
    });
  }
  for (let i = 0; i < 30; i++) {
    rows.push({
      user_id: "someone-else",
      origin_package: "com.strava",
      ingest_source: "com.strava",
      source_workout_id: `x-${i}`,
      workout_start: new Date(t0 - i * 5_400_000).toISOString(),
      workout_end: null,
    });
  }
  return rows;
}

/** workout_start desc, then origin_package, then source_workout_id. */
function expectedKeys(rows: FakeRow[]): string[] {
  return rows
    .filter((r) => r.user_id === USER)
    .sort((a, z) => {
      const [as, zs] = [String(a.workout_start), String(z.workout_start)];
      if (as !== zs) return as < zs ? 1 : -1;
      return identity(a) < identity(z) ? -1 : identity(a) > identity(z) ? 1 : 0;
    })
    .map(identity);
}

function heldKeys(): string[] {
  return useStore
    .getState()
    .workouts.map((w) => `${w.originPackage}|${w.id}`);
}

function fake(rows: FakeRow[], failOnRequest?: number) {
  return fakeCappedTable("biometric_workouts", rows, { cap: CAP, identity, failOnRequest });
}

beforeEach(() => {
  useStore.getState().reset();
  useStore.getState().setUserId(USER);
  vi.mocked(supabase.from).mockReset();
  vi.mocked(Sentry.captureException).mockClear();
});

describe("fetchWorkouts pages past the response cap (PL-056)", () => {
  it("returns all 2,350 workouts — none missing, none duplicated", async () => {
    const rows = fixture(2350);
    fake(rows);

    await useStore.getState().fetchWorkouts();

    const held = heldKeys();
    expect(held).toHaveLength(2350);
    expect(new Set(held).size).toBe(2350);
    expect(held).toEqual(expectedKeys(rows));
  });

  it("workouts sharing a start (and a package) are neither read twice nor skipped at a page boundary", async () => {
    const rows = fixture(1203);
    fake(rows);

    await useStore.getState().fetchWorkouts();

    const held = heldKeys();
    const duplicates = held.length - new Set(held).size;
    const missing = expectedKeys(rows).filter((k) => !held.includes(k)).length;
    expect({ duplicates, missing }).toEqual({ duplicates: 0, missing: 0 });
    expect(held).toEqual(expectedKeys(rows));
  });

  it("stops cleanly when the total is an exact multiple of the page size", async () => {
    expect(WORKOUTS_PAGE_SIZE).toBeGreaterThan(0);
    const rows = fixture(3 * WORKOUTS_PAGE_SIZE);
    const f = fake(rows);

    await useStore.getState().fetchWorkouts();

    expect(heldKeys()).toEqual(expectedKeys(rows));
    expect(f.requestCount()).toBe(4);
  });

  it("a failed page installs nothing partial, keeps the previous workouts, and reports once", async () => {
    const previous = [{ id: "kept", originPackage: "com.strava" } as never];
    useStore.setState({ workouts: previous });
    fake(fixture(2350), 2);

    await expect(useStore.getState().fetchWorkouts()).resolves.toBeUndefined();

    expect(heldKeys()).toEqual(["com.strava|kept"]);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { tags: Record<string, string> },
    ];
    expect(ctx.tags.operation).toBe("fetchWorkouts");
  });
});

describe("WORKOUTS_PAGE_SIZE stays below the response cap", () => {
  it("is below max_rows in supabase/config.toml and below 1000", () => {
    const toml = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/config.toml"),
      "utf8",
    );
    const match = toml.match(/^max_rows\s*=\s*(\d+)/m);
    expect(match).not.toBeNull();
    expect(WORKOUTS_PAGE_SIZE).toBeLessThan(Number(match![1]));
    expect(WORKOUTS_PAGE_SIZE).toBeLessThan(CAP);
  });
});
