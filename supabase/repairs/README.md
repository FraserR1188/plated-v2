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

## A backup table in `public` is a published API endpoint

Supabase's default privileges grant `anon` and `authenticated` full DML on new
tables in `public`, and PostgREST exposes them. A backup table created without
thinking about this is world-readable and world-truncatable by anyone holding
the shipped anon key — including the rollback path for the repair itself.

**Enable RLS and revoke the app-role grants in the same script that creates
it**, or put it outside `public`. See `20260920_pl028_secure_backup.sql`,
which is the retrofit of exactly that mistake.

## Files

| File | What it did |
|---|---|
| `20260920_pl028_zeroed_nutrition.sql` | PL-028. Repaired 35 `meal_entries`, 3 `saved_ingredients` and 2 `meal_composition_items` whose nutrition had been stored as fabricated zeros. Backup: `public.pl028_repair_backup`, 41 rows |
| `20260920_pl028_secure_backup.sql` | Locked down that backup table after the readback found it exposed to `anon` and `authenticated` |

**`public.pl028_repair_backup` must not be dropped.** It is the only record of
the pre-repair values. See the PL-028 entry in `testing/2026-09-20-internal.md`.
