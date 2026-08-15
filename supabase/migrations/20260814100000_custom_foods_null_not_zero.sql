-- ============================================================================
-- 20260814100000_custom_foods_null_not_zero.sql
-- custom_foods — drop NOT NULL / DEFAULT 0 on the four small-macro columns
--
-- THE VIOLATION
--   sat_fat_per100, salt_per100, fibre_per100, sugar_per100 are currently
--   NOT NULL DEFAULT 0. This is the third NULL-not-zero violation site found
--   for this product (after the OFF adapter's `?? 0` coercion, fixed at the
--   app layer, and CreateFoodScreen's num() helper, fixed alongside this
--   migration) — and the only one of the three that can't be fixed in app
--   code alone: DEFAULT 0 fires on column OMISSION, so even a corrected
--   client that stops sending 0 for a blank field would still get a stored
--   0 back from Postgres, silently, every time. The client-side fix and this
--   migration ship together for that reason.
--
--   Same rule as meal_entries, core_ingredients (see that migration's
--   header): NULL = we don't know. 0 = we know, it's zero. A blank field in
--   the upcoming manual-entry flow (Phase 3) must be able to record "unknown"
--   without asserting a fake zero into the day's totals and the WHOOP
--   correlation.
--
-- WHAT'S DELIBERATELY NOT TOUCHED
--   cal_per100, protein_per100, carbs_per100, fat_per100 stay NOT NULL
--   DEFAULT 0. Ratified: the big four are permanently non-nullable —
--   hasUsableNutrition()/canSubmitProduct() (src/lib/macros.ts) are the
--   guarantee for those, not a stored NULL. Their own DEFAULT 0 is a latent
--   coercion-on-omission footgun of the same shape as this migration fixes,
--   but is explicitly out of scope here — flagged, not changed.
--
-- NO BACKFILL
--   Existing rows with a stored 0 on any of the four columns are
--   unrecoverably ambiguous: a genuine zero (e.g. a salt-free item) and a
--   blank-field-coerced-to-zero are, after the fact, the exact same value.
--   `update ... set salt_per100 = null where salt_per100 = 0` would destroy
--   real zeros as readily as it would fix fabricated ones. This migration is
--   forward-only: it changes what a future write CAN store, and leaves every
--   existing row exactly as it is.
--
-- WHY THIS IS THE FIRST TRACKED MIGRATION TO TOUCH custom_foods
--   The table predates the migrations directory (created directly on the
--   remote at some point before this project tracked schema changes) — see
--   CLAUDE.md's note on schema.legacy-v2.LEGACY-DO-NOT-USE..sql, which
--   itself doesn't define custom_foods either. `db push` alters the live
--   table regardless of its own creation being untracked.
-- ============================================================================

-- ── Pre-flight (run manually before the ALTER below, not part of this
--    migration's apply) — confirm there's no CHECK constraint on these four
--    columns that DROP NOT NULL wouldn't also neutralise. A plain numeric
--    CHECK (e.g. `salt_per100 >= 0`) passes on NULL by default in Postgres,
--    so this isn't expected to find anything blocking — verifying, not
--    guessing:
--
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.custom_foods'::regclass
--    and contype = 'c';

alter table public.custom_foods
  alter column sat_fat_per100 drop not null,
  alter column sat_fat_per100 drop default,
  alter column salt_per100 drop not null,
  alter column salt_per100 drop default,
  alter column fibre_per100 drop not null,
  alter column fibre_per100 drop default,
  alter column sugar_per100 drop not null,
  alter column sugar_per100 drop default;

comment on column public.custom_foods.sat_fat_per100 is
  'Per-100g, grams. NULL = unknown (left blank at manual entry) — never '
  'coalesced to 0. See 20260814100000_custom_foods_null_not_zero.sql.';

comment on column public.custom_foods.salt_per100 is
  'Per-100g, grams (UK label convention). NULL = unknown — never coalesced '
  'to 0. No sodium column anywhere in this app; salt-in-grams is the only '
  'persisted unit. See 20260814100000_custom_foods_null_not_zero.sql.';

comment on column public.custom_foods.fibre_per100 is
  'Per-100g, grams. NULL = unknown — never coalesced to 0. See '
  '20260814100000_custom_foods_null_not_zero.sql.';

comment on column public.custom_foods.sugar_per100 is
  'Per-100g, grams. NULL = unknown — never coalesced to 0. See '
  '20260814100000_custom_foods_null_not_zero.sql.';


-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- V1. Post-conditions on the four altered columns. Expected: all four rows
--     show is_nullable = 'YES' and column_default IS NULL.
--
-- select column_name, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'custom_foods'
--    and column_name in ('sat_fat_per100','salt_per100','fibre_per100','sugar_per100')
--  order by column_name;

-- V2. The big four are UNCHANGED. Expected: all four rows show
--     is_nullable = 'NO' and column_default = '0'.
--
-- select column_name, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'custom_foods'
--    and column_name in ('cal_per100','protein_per100','carbs_per100','fat_per100')
--  order by column_name;

-- V3. Omitting a small-macro column on INSERT now stores NULL, not 0.
--     Run as `authenticated` (RLS applies to custom_foods; postgres/service
--     role bypasses it and won't catch a policy problem). Clean up the test
--     row afterwards — it's a real row under your own user_id otherwise.
--
-- insert into public.custom_foods (user_id, name, cal_per100, protein_per100, carbs_per100, fat_per100)
--   values (auth.uid(), 'NULL-not-zero test', 100, 5, 10, 2)
--   returning id, sat_fat_per100, salt_per100, fibre_per100, sugar_per100;
--     Expect: all four NULL, not 0.
--
-- delete from public.custom_foods where name = 'NULL-not-zero test';

-- V4. No backfill happened — an existing row's stored 0 (if you have one
--     from before this migration) is still exactly 0, not NULL.
--
-- select id, name, sat_fat_per100, salt_per100, fibre_per100, sugar_per100
--   from public.custom_foods
--  where created_at < '2026-08-14'
--    and (sat_fat_per100 = 0 or salt_per100 = 0 or fibre_per100 = 0 or sugar_per100 = 0)
--  limit 5;
--     Expect: any rows returned still show 0, unchanged from before.


-- ============================================================================
-- MANUAL TEST CHECKLIST
-- ============================================================================
-- [ ] Run V1 — all four small-macro columns nullable, no default.
-- [ ] Run V2 — big-four columns unchanged (NOT NULL, default 0).
-- [ ] Run V3 as `authenticated` — omitted small-macro columns land as NULL
--     on insert. Delete the test row after.
-- [ ] Run V4 (only if a pre-migration row with a stored 0 exists) — confirm
--     it's untouched.
-- [ ] After Commit B (app layer) lands: CreateFoodScreen -> leave Sat Fat
--     blank -> Save -> confirm the row's sat_fat_per100 is NULL in the DB,
--     not 0, and that ProductScreen renders "-" for it, not "0 g".
