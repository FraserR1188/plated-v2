# supabase/repairs

One-off **data** repairs run against production. **Not part of the migration
chain** — nothing here is replayed by `supabase db push`, and nothing here
changes schema. Each file is the SQL that actually ran, kept so a repair can
be reviewed after the fact and, if it comes to it, reversed.

## Rules

Every repair in here was, and every future one must be:

1. **Dry-run first** inside `begin … rollback`, with per-account counts and a
   per-row diff, and approved by Robbie before the real run.
2. **Backed up first.** A backup table holding every row the repair could
   match, with its pre-repair values, written *before* any `UPDATE` runs so a
   half-applied state still has the originals.
3. **Guarded per product.** No blanket "all four are zero, so repair it"
   sweep: a stored `0` cannot be told from a real zero, so every repair names
   its evidence per product. Table salt really is 0 kcal.
4. **Attributed by `user_id` before it runs.** Confirm which accounts the
   matched rows belong to. Grouping rows by a value is a join on that value
   and needs `user_id` for the same reason.
5. **Followed by an independent post-commit readback**, run outside the repair
   transaction.

## Repair artefacts never go in `public`

**Not "in `public` with RLS". Not in `public` at all.**

On a Supabase project, `public` is a published API surface:

- **PostgREST serves it**, so a table there is addressable at
  `/rest/v1/<table>` as soon as it exists.
- **Default privileges grant `anon` and `authenticated` full DML** on new
  tables in it — `SELECT, INSERT, UPDATE, DELETE, TRUNCATE`.
- **`create table` does not enable RLS.**

So a backup table created in `public` is world-readable and
world-**truncatable** by anyone holding the shipped anon key, from the moment
the `create table` returns. The rollback path for a data repair is deletable
by an anonymous client while the repair is still being verified. There is no
safe window to lock it down in afterwards, because the exposure starts first.

**Put them in `maintenance`**, which is not in this project's exposed schema
list, with RLS on and no app-role grants. PostgREST then returns `PGRST106
Invalid schema` for the whole schema, so a later grant mistake on the table
cannot re-expose it — the table is not merely denied, it is not addressable.

This is written from having got it wrong: see **PL-031** in
`testing/2026-09-20-internal.md`, and the two scripts below that are the
retrofit.

## Files

| File | What it did |
|---|---|
| `20260920_pl028_zeroed_nutrition.sql` | PL-028. Repaired 35 `meal_entries`, 3 `saved_ingredients` and 2 `meal_composition_items` whose nutrition had been stored as fabricated zeros. Backup: `public.pl028_repair_backup`, 41 rows |
| `20260920_pl028_secure_backup.sql` | PL-031, step 1. Locked down that backup table after the readback found it exposed to `anon` and `authenticated` |
| `20260920_pl028_backup_out_of_public.sql` | PL-031, step 2. Deleted a third user's row, then moved the table to `maintenance` so PostgREST cannot serve it at all. 40 rows |

**`maintenance.pl028_repair_backup` must not be dropped.** It is the only
record of the pre-repair values — 40 rows, taken 2026-09-20 16:04 UTC. See the
PL-028 entry in `testing/2026-09-20-internal.md`.
