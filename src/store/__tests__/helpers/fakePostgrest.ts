// ============================================================
// A capped PostgREST fake for list reads (PL-050, PL-056).
//
// Wires supabase.from(<table>) to a builder that honours eq/order/range
// the way PostgREST does, and:
//
//   - CAPS every response at `cap` rows, whatever range was asked for,
//     silently — the way max_rows does;
//   - breaks rows tied on every ORDER BY key in a DIFFERENT order on every
//     request, because Postgres promises nothing about tied rows. With
//     LIMIT/OFFSET paging that is exactly how a row gets read twice or
//     never, so a missing tiebreaker shows up as real duplicates/drops.
//
// fetchEntriesPaging.test.ts carries its own inline copy (it predates this
// helper and is left as pinned).
// ============================================================

import { vi, expect } from "vitest";
import { supabase } from "../../../lib/supabase";

export type FakeRow = Record<string, string | number | null>;

/** FNV-1a over `${seed}:${key}` — a tie order that changes per request. */
function tieRank(key: string, seed: number): number {
  let h = 0x811c9dc5;
  for (const ch of `${seed}:${key}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function fakeCappedTable(
  table: string,
  rows: FakeRow[],
  opts: { cap: number; identity: (r: FakeRow) => string; failOnRequest?: number },
) {
  let requests = 0;

  vi.mocked(supabase.from).mockImplementation(((name: string) => {
    expect(name).toBe(table);
    const filters: [string, unknown][] = [];
    const orders: { col: string; asc: boolean }[] = [];
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
            const x = a[col] ?? "";
            const y = z[col] ?? "";
            if (x < y) return asc ? -1 : 1;
            if (x > y) return asc ? 1 : -1;
          }
          return tieRank(opts.identity(a), n) - tieRank(opts.identity(z), n);
        });
      const [lo, hi] = range ?? [0, matched.length - 1];
      return { data: matched.slice(lo, hi + 1).slice(0, opts.cap), error: null };
    };

    const builder = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        filters.push([col, value]);
        return builder;
      },
      order: (col: string, o?: { ascending?: boolean }) => {
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
