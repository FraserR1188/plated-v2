// ============================================================
// src/lib/paging.ts — read every row of a query, one range at a time.
//
// PL-050. PostgREST caps every response at the project's max_rows and says
// nothing when it does: an unpaged select past the cap is a truncated
// select, not an error. This walks ranges until a page comes back short.
//
// Two things the CALLER must get right, because this can't check them:
//
//   1. The query's ORDER BY must be TOTAL — end it on a unique column (id).
//      Rows tied on every sort key have no fixed position, so across two
//      range requests the same row can land on both pages or on neither.
//   2. pageSize must be below max_rows. A page the server cut short looks
//      exactly like the last page, and the loop stops there.
//
// A failed page THROWS. The pages already read are discarded rather than
// returned, because a partial list handed back as if complete is the
// silent-loss failure this exists to remove (the PL-003 rule).
// ============================================================

export type PageResult<T> = {
  data: T[] | null;
  error: unknown;
};

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`fetchAllPages: page size must be a positive integer, got ${pageSize}`);
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw error;
    // No error and no data is not "the end": stopping here would return
    // what was read so far as if it were everything.
    if (!data) throw new Error("fetchAllPages: page returned no data and no error");
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}
