// ============================================================
// Trends' remembered selection and range.
//
// Same shape, and the same safety property, as whoopConnectionCache: the
// stored value carries the user id it belongs to, and a mismatch is treated
// exactly like no cache at all. Two accounts on one device is how this app
// is tested and how a shared phone works.
//
// Everything here is a PREFERENCE, not data. A read that fails, returns junk
// or belongs to someone else falls back to the defaults — it never throws
// and never blocks a render.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  TRENDS_PREFS_KEY,
  clearTrendsPrefs,
  readTrendsPrefs,
  writeTrendsPrefs,
} from "../trendsPrefs";
import { DEFAULT_NUTRIENTS } from "../trends";

// The in-memory AsyncStorage mock from vitest.setup.ts exposes its map.
const store = (AsyncStorage as unknown as { __store: Map<string, string> })
  .__store;

beforeEach(() => {
  store.clear();
});

const DEFAULTS = { nutrients: DEFAULT_NUTRIENTS, range: 7 as const };

describe("readTrendsPrefs", () => {
  it("returns null when nothing has been stored", async () => {
    expect(await readTrendsPrefs("u1")).toBeNull();
  });

  it("round-trips a selection and range", async () => {
    await writeTrendsPrefs("u1", { nutrients: ["fibre", "salt"], range: 14 });
    expect(await readTrendsPrefs("u1")).toEqual({
      nutrients: ["fibre", "salt"],
      range: 14,
    });
  });

  // The whole point of storing the user id. Without this, account A's
  // chosen nutrients decide what account B opens on.
  it("refuses a value stored by a different user", async () => {
    await writeTrendsPrefs("u1", { nutrients: ["sugar"], range: 14 });
    expect(await readTrendsPrefs("u2")).toBeNull();
  });

  it("returns null for junk rather than throwing", async () => {
    store.set(TRENDS_PREFS_KEY, "not json at all");
    expect(await readTrendsPrefs("u1")).toBeNull();
  });

  it("rejects a stored nutrient that is not one of the eight", async () => {
    // A renamed or removed nutrient must not come back as a chart key that
    // no longer exists — buildTrendSeries would not find its metadata.
    store.set(
      TRENDS_PREFS_KEY,
      JSON.stringify({ userId: "u1", nutrients: ["calories", "vitaminC"], range: 7 }),
    );
    expect(await readTrendsPrefs("u1")).toBeNull();
  });

  it("rejects a stored range that is not offered", async () => {
    store.set(
      TRENDS_PREFS_KEY,
      JSON.stringify({ userId: "u1", nutrients: ["calories"], range: 30 }),
    );
    expect(await readTrendsPrefs("u1")).toBeNull();
  });

  it("rejects an empty selection", async () => {
    store.set(
      TRENDS_PREFS_KEY,
      JSON.stringify({ userId: "u1", nutrients: [], range: 7 }),
    );
    expect(await readTrendsPrefs("u1")).toBeNull();
  });

  it("rejects a selection longer than the cap", async () => {
    store.set(
      TRENDS_PREFS_KEY,
      JSON.stringify({
        userId: "u1",
        nutrients: ["calories", "protein", "carbs", "fat"],
        range: 7,
      }),
    );
    expect(await readTrendsPrefs("u1")).toBeNull();
  });
});

describe("writeTrendsPrefs", () => {
  it("stores the user id alongside the preference", async () => {
    await writeTrendsPrefs("u7", DEFAULTS);
    const raw = JSON.parse(store.get(TRENDS_PREFS_KEY)!);
    expect(raw.userId).toBe("u7");
  });

  it("overwrites rather than accumulating", async () => {
    await writeTrendsPrefs("u1", { nutrients: ["calories"], range: 7 });
    await writeTrendsPrefs("u1", { nutrients: ["salt"], range: 14 });
    expect(store.size).toBe(1);
    expect(await readTrendsPrefs("u1")).toEqual({
      nutrients: ["salt"],
      range: 14,
    });
  });

  it("stores no entry data — only the selection, the range and the id", async () => {
    // A preferences blob is not a place for anything about what was eaten.
    await writeTrendsPrefs("u1", { nutrients: ["calories"], range: 7 });
    const raw = JSON.parse(store.get(TRENDS_PREFS_KEY)!);
    expect(Object.keys(raw).sort()).toEqual(["nutrients", "range", "userId"]);
  });
});

describe("clearTrendsPrefs", () => {
  it("removes the stored preference", async () => {
    await writeTrendsPrefs("u1", DEFAULTS);
    await clearTrendsPrefs();
    expect(await readTrendsPrefs("u1")).toBeNull();
  });
});

describe("the store clears it on sign-out", () => {
  it("reset() calls clearTrendsPrefs", async () => {
    // Source-text assertion: reset() is where every per-user cache is
    // dropped, and a preference left behind would greet the next account
    // with the previous one's charts.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs
      .readFileSync(path.resolve(process.cwd(), "src/store/useStore.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    // Anchored on the IMPLEMENTATION, not the interface. `  reset: ` also
    // matches the `reset: () => void;` type member declared hundreds of
    // lines earlier, and slicing from there asserts nothing about the code
    // that runs -- the same file-wide-name trap as PL-025.
    const start = src.indexOf("  reset: () => {");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  fetchEntries:", start);
    const body = src.slice(start, end === -1 ? start + 2000 : end);
    expect(body).toContain("clearTrendsPrefs");
  });
});
