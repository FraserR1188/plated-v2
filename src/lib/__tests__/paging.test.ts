// PL-050 — the pager on its own. The store test proves fetchEntries uses it
// correctly against a capped fake; this pins the loop's own contract.

import { describe, it, expect, vi } from "vitest";
import { fetchAllPages } from "../paging";

/** A page source over `total` integers that records each range asked for. */
function source(total: number, opts: { failAt?: number } = {}) {
  const asked: [number, number][] = [];
  const fetchPage = vi.fn(async (from: number, to: number) => {
    asked.push([from, to]);
    if (opts.failAt === asked.length - 1) {
      return { data: null, error: { code: "57014" } };
    }
    const data = Array.from({ length: total }, (_, i) => i).slice(from, to + 1);
    return { data, error: null };
  });
  return { fetchPage, asked };
}

describe("fetchAllPages", () => {
  it("asks for consecutive, non-overlapping ranges and stops on a short page", async () => {
    const { fetchPage, asked } = source(25);
    const rows = await fetchAllPages(fetchPage, 10);
    expect(rows).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(asked).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
    ]);
  });

  it("an empty table is one request and an empty list", async () => {
    const { fetchPage } = source(0);
    await expect(fetchAllPages(fetchPage, 10)).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("throws the page's own error, never a partial list", async () => {
    const { fetchPage } = source(25, { failAt: 1 });
    await expect(fetchAllPages(fetchPage, 10)).rejects.toEqual({ code: "57014" });
  });

  it("treats data: null with no error as a failure, not as the end", async () => {
    // Stopping there would return the pages read so far as if complete.
    const fetchPage = vi.fn(async () => ({ data: null, error: null }));
    await expect(fetchAllPages(fetchPage, 10)).rejects.toThrow(/no data/i);
  });

  it("refuses a page size below 1", async () => {
    const { fetchPage } = source(5);
    await expect(fetchAllPages(fetchPage, 0)).rejects.toThrow(/page size/i);
  });
});
