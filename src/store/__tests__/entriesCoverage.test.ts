// ============================================================
// Part 4 — Trends needs 14 local days of entries in the store.
//
// Today's `fetchEntries` is UNBOUNDED: it selects every row the user has
// ever logged, with no date filter, so 14 days is covered many times over.
// This test exists because that is DUE TO CHANGE — the comment directly
// above fetchEntries describes a planned bounded query, "last N days +
// everything future + everything pending".
//
// If that lands with N < 14, Trends does not break loudly. It renders the
// unfetched days as GAPS, which is the chart's notation for "you logged
// nothing" — so the app would quietly tell the user they had not eaten.
// This asserts the coverage so the bounded query fails here first.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const source = fs
  .readFileSync(
    path.resolve(process.cwd(), "src/store/useStore.ts"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

/** The body of `fetchEntries`, up to the next action. */
function fetchEntriesBody(): string {
  const start = source.indexOf("  fetchEntries: async () => {");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  fetchCompositions:", start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Trends' window, stated once so the assertions and the feature agree. */
const TRENDS_WINDOW_DAYS = 14;

describe("the entries the store holds cover Trends' window", () => {
  it("fetchEntries applies no date filter at all today", () => {
    // The current guarantee, pinned. `.eq("user_id", …)` and an order are
    // the only constraints; any `.gte`/`.lte`/`.filter` on a date column
    // would mean a window exists and needs checking against 14 days.
    const body = fetchEntriesBody();
    expect(body).toContain('.from("meal_entries")');
    expect(body).not.toMatch(/\.(gte|lte|gt|lt)\(\s*["']date["']/);
    expect(body).not.toMatch(/\.(gte|lte|gt|lt)\(\s*["']eaten_at["']/);
    expect(body).not.toMatch(/\.(gte|lte|gt|lt)\(\s*["']logged_at["']/);
    expect(body).not.toContain(".limit(");
  });

  it("if a bounded window is introduced, it must cover at least 14 local days", () => {
    // Deliberately a FAILING GUIDE rather than a silent pass. When the
    // bounded query lands, the first assertion above goes red; whoever is
    // doing that work reads this and either widens the window or gives
    // Trends its own fetch. Both are fine. Doing neither is not.
    const body = fetchEntriesBody();
    const bounded = /\.(gte|lte|gt|lt)\(/.test(body) || body.includes(".limit(");

    if (!bounded) {
      expect(TRENDS_WINDOW_DAYS).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
      return;
    }

    // A window exists. It must name a day count, and that count must be >= 14.
    const days = [...body.matchAll(/(\d+)\s*(?:\*\s*)?(?:days?|DAYS?)/g)].map(
      (m) => Number(m[1]),
    );
    expect(
      days.length,
      "fetchEntries is now bounded but names no day count — Trends' 14-day " +
        "window cannot be verified against it. Give Trends its own fetch, or " +
        "make the window explicit.",
    ).toBeGreaterThan(0);
    expect(Math.max(...days)).toBeGreaterThanOrEqual(TRENDS_WINDOW_DAYS);
  });
});
