// ============================================================
// PL-050 — fetchEntries must read EVERY row, not the first max_rows.
//
// PostgREST silently caps every response at the project's max_rows. There
// is no error and no flag: a user past the cap just gets fewer rows, and
// the ones missing are whichever the ORDER BY put last. An unbounded
// select is therefore a truncated select the moment an account grows past
// the cap. Measured 2026-09-26: user A at 787 rows, 8.4/day.
//
// The fake below is the part that makes these tests mean something:
//
//   - it CAPS every response at 1000 rows, whatever range was asked for;
//   - it honours eq/order/range the way PostgREST does;
//   - rows tied on every ORDER BY key come back in a DIFFERENT order on
//     every request. Postgres promises nothing about tied rows, and with
//     LIMIT/OFFSET paging that is exactly how a row gets read twice or
//     never. A bundle apply inserts several rows in one statement, so
//     identical logged_at values are ordinary data here, not an edge case.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/react-native";
import { useStore, ENTRIES_PAGE_SIZE } from "../useStore";
import { supabase } from "../../lib/supabase";

const CAP = 1000;
const USER = "test-user-id";
const OTHER = "someone-else";

type Row = { id: string; user_id: string; logged_at: string; name: string };

/** FNV-1a over `${seed}:${id}` — a tie order that changes per request. */
function tieRank(id: string, seed: number): number {
  let h = 0x811c9dc5;
  for (const ch of `${seed}:${id}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function fakeMealEntries(
  rows: Row[],
  opts: { failOnRequest?: number } = {},
) {
  let requests = 0;

  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    expect(table).toBe("meal_entries");
    const filters: [keyof Row, unknown][] = [];
    const orders: { col: keyof Row; asc: boolean }[] = [];
    let range: [number, number] | null = null;

    const run = () => {
      const n = requests++;
      if (opts.failOnRequest === n) {
        return {
          data: null,
          error: { code: "57014", message: "canceling statement due to statement timeout" },
        };
      }
      const matched = rows
        .filter((r) => filters.every(([c, v]) => r[c] === v))
        .sort((a, z) => {
          for (const { col, asc } of orders) {
            if (a[col] < z[col]) return asc ? -1 : 1;
            if (a[col] > z[col]) return asc ? 1 : -1;
          }
          return tieRank(a.id, n) - tieRank(z.id, n);
        });
      const [lo, hi] = range ?? [0, matched.length - 1];
      return { data: matched.slice(lo, hi + 1).slice(0, CAP), error: null };
    };

    const builder = {
      select: () => builder,
      eq: (col: keyof Row, value: unknown) => {
        filters.push([col, value]);
        return builder;
      },
      order: (col: keyof Row, o?: { ascending?: boolean }) => {
        orders.push({ col, asc: o?.ascending ?? true });
        return builder;
      },
      range: (from: number, to: number) => {
        range = [from, to];
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }) as never);

  return { requestCount: () => requests };
}

/**
 * `count` rows for USER, newest first by construction. Every `groupSize`
 * consecutive rows share one logged_at — the shape a bundle apply leaves.
 * A few rows for another user are mixed in and must never come back.
 */
function fixture(count: number, groupSize: number): Row[] {
  const rows: Row[] = [];
  const t0 = Date.UTC(2026, 8, 26, 12, 0, 0);
  for (let i = 0; i < count; i++) {
    const group = Math.floor(i / groupSize);
    rows.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      user_id: USER,
      logged_at: new Date(t0 - group * 60_000).toISOString(),
      name: `row ${i}`,
    });
  }
  for (let i = 0; i < 40; i++) {
    rows.push({
      id: `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`,
      user_id: OTHER,
      logged_at: new Date(t0 - i * 90_000).toISOString(),
      name: `foreign ${i}`,
    });
  }
  return rows;
}

/** The order the store should hold: logged_at desc, then id desc. */
function expectedIds(rows: Row[]): string[] {
  return rows
    .filter((r) => r.user_id === USER)
    .sort((a, z) =>
      a.logged_at !== z.logged_at
        ? a.logged_at < z.logged_at ? 1 : -1
        : a.id < z.id ? 1 : -1,
    )
    .map((r) => r.id);
}

function heldIds(): string[] {
  return useStore.getState().entries.map((e) => e.id);
}

beforeEach(() => {
  useStore.getState().reset();
  useStore.getState().setUserId(USER);
  vi.mocked(supabase.from).mockReset();
  vi.mocked(Sentry.captureException).mockClear();
});

describe("fetchEntries pages past the response cap (PL-050)", () => {
  it("returns all 2,350 rows — none missing, none duplicated, rows sharing a timestamp included", async () => {
    const rows = fixture(2350, 7);
    fakeMealEntries(rows);

    await useStore.getState().fetchEntries();

    const held = heldIds();
    expect(held).toHaveLength(2350);
    expect(new Set(held).size).toBe(2350);
    expect(held).toEqual(expectedIds(rows));
  });

  it("rows that share logged_at are neither read twice nor skipped at a page boundary", async () => {
    // Groups of 7 never divide the page size evenly, so tied groups
    // straddle every boundary. Without a unique tiebreaker, each page's
    // query is free to order a straddling group differently.
    const rows = fixture(1200, 7);
    fakeMealEntries(rows);

    await useStore.getState().fetchEntries();

    const held = heldIds();
    const duplicates = held.length - new Set(held).size;
    const missing = expectedIds(rows).filter((id) => !held.includes(id));
    expect({ duplicates, missing: missing.length }).toEqual({
      duplicates: 0,
      missing: 0,
    });
    expect(held).toEqual(expectedIds(rows));
  });

  it("stops cleanly when the total is an exact multiple of the page size", async () => {
    expect(ENTRIES_PAGE_SIZE).toBeGreaterThan(0);
    const rows = fixture(3 * ENTRIES_PAGE_SIZE, 7);
    const fake = fakeMealEntries(rows);

    await useStore.getState().fetchEntries();

    expect(heldIds()).toEqual(expectedIds(rows));
    // Three full pages, then one empty page that ends the loop. Fewer
    // would have stopped on a full page; more would mean it never stops.
    expect(fake.requestCount()).toBe(4);
  });

  it("a failed page installs nothing partial, keeps the previous list, and reports once", async () => {
    const previous = [{ id: "kept", user_id: USER } as never];
    useStore.setState({ entries: previous });
    fakeMealEntries(fixture(2350, 7), { failOnRequest: 2 });

    await expect(useStore.getState().fetchEntries()).resolves.toBeUndefined();

    expect(heldIds()).toEqual(["kept"]);
    expect(useStore.getState().loading).toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { tags: Record<string, string> },
    ];
    expect(ctx.tags.operation).toBe("fetchEntries");
  });
});

describe("ENTRIES_PAGE_SIZE stays below the response cap", () => {
  // A page larger than max_rows comes back short, and a short page is the
  // loop's signal to stop — so it would silently end after page one, the
  // exact truncation this change removes.
  it("is below max_rows in supabase/config.toml", () => {
    const toml = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/config.toml"),
      "utf8",
    );
    const match = toml.match(/^max_rows\s*=\s*(\d+)/m);
    expect(match).not.toBeNull();
    expect(ENTRIES_PAGE_SIZE).toBeLessThan(Number(match![1]));
  });

  it("is below the 1000-row cap the hosted project ran with until 2026-09-26", () => {
    // Hosted max_rows was raised to 2000 on 2026-09-26 as a stopgap. If it
    // is ever lowered back, a page size between 1000 and 2000 would start
    // truncating again with no error.
    expect(ENTRIES_PAGE_SIZE).toBeLessThan(CAP);
  });
});
