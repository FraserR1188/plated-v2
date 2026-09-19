-- ============================================================================
-- 20260919120000_saved_ingredients_null_not_zero.sql
-- saved_ingredients NULL-not-zero — SCHEMA ONLY
--
-- The code half ships as its own commit: saveIngredient stops coercing an
-- unknown sat fat to 0, and the My Library read path stops coercing NULL to 0.
--
--     alter table public.saved_ingredients
--       alter column {sat_fat,salt,fibre,sugar}_per100 drop not null,
--       alter column {sat_fat,salt,fibre,sugar}_per100 drop default;
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- All four were NOT NULL DEFAULT 0 (measured 2026-09-19, Q1). The client
-- carries an unknown small macro as `undefined`; postgrest-js's
-- JSON.stringify drops that key from the insert body, so the column was
-- omitted and the DEFAULT turned "unknown" into a stored 0 for salt, fibre
-- and sugar. sat_fat was coerced client-side instead (`?? 0` — redundant, it
-- had the same default). My Library re-adds then carried those zeros into
-- meal_entries, the WHOOP correlation's source of truth. Q4 (2026-09-19)
-- measured 31 meal_entries rows across 2 users with the NULL-then-0
-- fingerprint (fibre 24, salt 7) — a floor, not a total. Same defect, same
-- fix as 20260814100000 (custom_foods) and 20260818140000 (meal_entries).
--
-- ── EFFECT ON THE CURRENT CLIENT (this can land before the code commit) ─────
--   salt/fibre/sugar  new library saves store NULL for unknown immediately —
--                     the key the client already omits now takes NULL.
--   sat_fat           still stored 0 for unknown until the code commit
--                     removes the client's `?? 0`.
--   reads             already NULL-safe: salt/fibre/sugar pass through to
--                     ProductScreen, which shows "—" and writes NULL to
--                     meal_entries; sat_fat still reads `?? 0` until the code
--                     commit. Nothing crashes on NULL (audited 2026-09-19).
--
-- ── NO BACKFILL ─────────────────────────────────────────────────────────────
-- Existing zeros stay zeros. A genuine zero and a fabricated one are
-- byte-identical and no provenance survives to tell them apart, so a
-- backfill would be deriving an unmeasured value. Baseline left in place
-- (S2, measured 2026-09-19 — 378 rows, 9 users with any zero):
--     sat_fat_per100 = 0    32 rows
--     salt_per100    = 0    48 rows
--     fibre_per100   = 0    63 rows
--     sugar_per100   = 0    32 rows
--     any of the four      120 rows
--     ALL FOUR = 0           8 rows
-- The 8 all-four-zero rows are the strongest evidence of the defect: a food
-- with genuinely zero sat fat AND salt AND fibre AND sugar is near-
-- nonexistent, so each is almost certainly four fabricated zeros. They are
-- left as they are — recorded here, not corrected.
--
-- ── NO TYPE CHANGE ──────────────────────────────────────────────────────────
-- sat_fat_per100 is unconstrained numeric; the other seven are numeric(8,2).
-- Normalising it would be lossless on today's data (S1: max scale 1, 0 rows
-- beyond 2dp, max value 30), but Postgres refuses it while
-- saved_ingredients_scored exists — that view selects si.*, so it depends on
-- the column ("cannot alter type of a column used by a view or rule",
-- measured on a fixture). Dropping and recreating that security_invoker view
-- risks it coming back without security_invoker = on, which fails open across
-- users. Not worth it for type tidiness — and meal_entries.sat_fat is
-- unconstrained numeric too. DROP NOT NULL / DROP DEFAULT are allowed with
-- the view in place (measured on the same fixture); the view is not touched.
--
-- ── THE CHECK, VERIFIED LIVE AT APPLY TIME ──────────────────────────────────
-- saved_ingredients_sat_fat_per100_check CHECK (sat_fat_per100 >= 0) exists
-- live but in no migration (S3); the other three columns have no CHECK. A
-- CHECK passes when its expression is TRUE or NULL, so NULL should be
-- accepted — but this is not assumed. The DO block below writes NULL to all
-- four columns of one REAL row after the ALTER and rolls that write back. If
-- the live CHECK — or anything else — rejects it, the whole migration aborts
-- and nothing changes. On an empty table (a fresh local DB) the probe is
-- vacuous. A pre-flight run of the same probe, which changes nothing, is
-- verify/20260919120000_verify.sql V0.
--
-- Explicit begin/commit so the ALTER and the probe succeed or fail together
-- however the CLI batches statements (precedent: 20260801100000).
--
-- S3 (measured): no triggers. RLS is the four legacy policies
-- "Users {read,insert,update,delete} own saved ingredients", all
-- auth.uid() = user_id, none referencing these columns — untouched.
-- ============================================================================

begin;

alter table public.saved_ingredients
  alter column sat_fat_per100 drop not null,
  alter column sat_fat_per100 drop default,
  alter column salt_per100    drop not null,
  alter column salt_per100    drop default,
  alter column fibre_per100   drop not null,
  alter column fibre_per100   drop default,
  alter column sugar_per100   drop not null,
  alter column sugar_per100   drop default;

-- Fail-closed probe. The inner block's EXCEPTION clause makes it a
-- subtransaction: raising 'PNULL' after a successful UPDATE rolls the UPDATE
-- back and is then swallowed. A rejection re-raises and aborts everything.
do $$
begin
  begin
    update public.saved_ingredients
       set sat_fat_per100 = null,
           salt_per100    = null,
           fibre_per100   = null,
           sugar_per100   = null
     where id = (select id from public.saved_ingredients order by id limit 1);
    raise exception 'probe accepted NULL' using errcode = 'PNULL';
  exception
    when sqlstate 'PNULL' then
      null;  -- NULL accepted on a real row; the probe UPDATE is rolled back.
    when check_violation or not_null_violation then
      raise exception
        'saved_ingredients rejected NULL in a small-macro column (%) — '
        'aborting: unknown-macro library saves would fail. Nothing changed.',
        sqlerrm;
  end;
end $$;

commit;
