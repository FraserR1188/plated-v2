-- ============================================================================
-- 20260801100000_rename_meal_bundles_to_compositions.sql
-- Migration 1 of 2 for the Batches feature — RENAME ONLY.
--
--   meal_bundles                 → meal_compositions
--   meal_bundle_items            → meal_composition_items
--   meal_bundle_items.bundle_id  → composition_id
--   bump_bundle_use(uuid)        → bump_composition_use(uuid)
--
-- NO new columns, NO kind discriminator, NO trigger changes. App behaviour
-- must be byte-for-byte identical after this migration lands (paired with the
-- matching TS rename) — it exists purely so migration 2 (batch capability:
-- kind, yield_g, portion_g, portion_label, the item-nullability trigger)
-- lands on a table already named for what it's about to become, instead of
-- bundling a rename and a behavioural change into one apply.
--
-- WHY A SEPARATE MIGRATION
--   Renaming and adding capability in one migration makes a failed apply
--   ambiguous — did the rename fail, or the new constraint? Splitting means
--   this one is trivially low-risk: RENAME does not move or rewrite a single
--   row, and holds only a brief ACCESS EXCLUSIVE catalog lock. Migration 2
--   can then be reasoned about, applied, and if need be rolled back entirely
--   independently of this ever having happened.
--
-- WHAT DOES NOT NEED TOUCHING BY HAND
--   RLS policy USING/CHECK clauses: stored as parsed expression trees keyed
--   on column ATTNUM, not text — ALTER TABLE/COLUMN RENAME updates them for
--   free. Same reason the CHECK constraint on `name` needs no edit.
--   GRANTs: tied to the table OID, survive a rename untouched.
--   Foreign keys (composition_id → meal_compositions.id, both user_id →
--   auth.users): OID-based, survive both the table and column rename intact.
--   Indexes: functionally fine unrenamed; renamed below anyway, purely for
--   readability — nothing depends on their names.
--
-- WHAT DOES NEED TOUCHING BY HAND
--   bump_bundle_use(uuid): a LANGUAGE SQL function whose $$...$$ body is
--   opaque text (this project targets the pre-PG14 body syntax), re-resolved
--   BY NAME at every CALL — not parsed into a dependency-tracked node at
--   CREATE time the way a view or policy is. Renaming the table underneath it
--   would leave the old body text pointing at a relation name that no longer
--   exists. It has to be dropped and recreated against the new name, which
--   is also the only way to rename the parameter (p_bundle_id → p_composition_id).
--
-- SEQUENCING — READ BEFORE APPLYING
--   This migration and the matching TS rename (bundles.ts → compositions
--   naming throughout, MealBundle* types, useStore actions, TodayScreen's
--   bundle sheets) must land together. The app has no compatibility shim for
--   the old table names — the moment this commits, any not-yet-updated
--   client code querying `meal_bundles` / `meal_bundle_items` / `bundle_id`
--   will error. Apply this, then immediately do the TS rename, before
--   reloading the dev client.
-- ============================================================================

begin;

-- ─── 1. Tables ──────────────────────────────────────────────────────────────

alter table public.meal_bundles      rename to meal_compositions;
alter table public.meal_bundle_items rename to meal_composition_items;

alter table public.meal_composition_items
  rename column bundle_id to composition_id;

-- ─── 2. Constraint / index names (cosmetic — behaviour unaffected either way) ─

alter table public.meal_compositions
  rename constraint meal_bundles_name_not_blank to meal_compositions_name_not_blank;

alter index public.meal_bundles_user_idx
  rename to meal_compositions_user_idx;

alter index public.meal_bundle_items_bundle_idx
  rename to meal_composition_items_composition_idx;

alter index public.meal_bundle_items_user_idx
  rename to meal_composition_items_user_idx;

-- ─── 3. RLS policy names (cosmetic — USING/CHECK already followed the rename) ─

alter policy meal_bundles_select_own on public.meal_compositions
  rename to meal_compositions_select_own;
alter policy meal_bundles_insert_own on public.meal_compositions
  rename to meal_compositions_insert_own;
alter policy meal_bundles_update_own on public.meal_compositions
  rename to meal_compositions_update_own;
alter policy meal_bundles_delete_own on public.meal_compositions
  rename to meal_compositions_delete_own;

alter policy meal_bundle_items_select_own on public.meal_composition_items
  rename to meal_composition_items_select_own;
alter policy meal_bundle_items_insert_own on public.meal_composition_items
  rename to meal_composition_items_insert_own;
alter policy meal_bundle_items_update_own on public.meal_composition_items
  rename to meal_composition_items_update_own;
alter policy meal_bundle_items_delete_own on public.meal_composition_items
  rename to meal_composition_items_delete_own;

-- ─── 4. bump_bundle_use → bump_composition_use ───────────────────────────────
--
-- Drop + recreate, not ALTER FUNCTION ... RENAME TO: a bare rename leaves the
-- body text saying `meal_bundles` / `p_bundle_id`, and RENAME does not touch
-- a function's source. Recreating is also the only way the parameter name
-- follows.

drop function if exists public.bump_bundle_use(uuid);

create or replace function public.bump_composition_use(p_composition_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.meal_compositions
     set use_count    = use_count + 1,
         last_used_at = now()
   where id = p_composition_id
     and user_id = auth.uid();
$$;

comment on function public.bump_composition_use(uuid) is
  'Atomically record a composition (bundle today; bundle or batch from '
  'migration 2) application. Call AFTER applyEntries succeeds — a composition '
  'you failed to apply is not one you used.';

grant execute on function public.bump_composition_use(uuid) to authenticated;

-- ─── 5. Table/column comments — the old ones name a table that no longer exists ─

comment on table public.meal_compositions is
  'A named, reusable set of foods. Applied to a (day) — each item carries its '
  'own meal_type and time. Snapshot semantics: items do not reference foods. '
  '(Migration 1 of 2 for the Batches feature: rename only — no kind column yet.)';

comment on column public.meal_composition_items.eaten_time is
  'LOCAL wall clock (07:30), not an instant. Rebuilt on the target day by the '
  'client so DST changes cannot shift a bundle.';

commit;


-- ============================================================================
-- VERIFICATION — run as `authenticated`, NOT in the SQL editor as postgres.
-- The postgres role bypasses RLS and will cheerfully tell you everything is
-- fine even if a policy silently failed to carry over.
--
-- Before applying, snapshot current row counts so V6 has something to compare
-- against:
--   select count(*) from public.meal_bundles;
--   select count(*) from public.meal_bundle_items;
-- ============================================================================

-- V1. Old names are gone, new names exist. Expect exactly 2 rows:
--     meal_compositions, meal_composition_items.
--
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('meal_bundles', 'meal_bundle_items',
--                        'meal_compositions', 'meal_composition_items');

-- V2. Column rename landed. Expect exactly 1 row: composition_id.
--
-- select column_name from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'meal_composition_items'
--    and column_name in ('bundle_id', 'composition_id');

-- V3. RLS still ON, all 8 policies present under their new names.
--
-- select tablename, policyname, cmd from pg_policies
--  where tablename in ('meal_compositions', 'meal_composition_items')
--  order by tablename, cmd;

-- V4. FKs survived the rename with the right on-delete rules. Expect
--     composition_id → meal_compositions CASCADE, both user_id → CASCADE.
--
-- select conrelid::regclass as child, pg_get_constraintdef(oid) as def
--   from pg_constraint
--  where contype = 'f'
--    and conrelid::regclass::text in ('meal_compositions', 'meal_composition_items');

-- V5. Old function gone, new one present, still scoped to the caller.
--
-- select proname from pg_proc where proname in ('bump_bundle_use', 'bump_composition_use');
--     Expect: only bump_composition_use.
--
-- select public.bump_composition_use('<someone else''s composition id>');
--     Expect: no error, 0 rows updated — their use_count does not move.

-- V6. No data moved or was dropped by the rename. Compare against the
--     pre-migration snapshot above — both counts must be identical.
--
-- select count(*) from public.meal_compositions;
-- select count(*) from public.meal_composition_items;

-- V7. A composition you own still round-trips: bump your own use_count.
--
-- select public.bump_composition_use('<a composition id you own>');
-- select use_count, last_used_at from public.meal_compositions where id = '<same id>';
--     Expect: use_count incremented by 1, last_used_at updated to ~now().


-- ============================================================================
-- ON-DEVICE TEST CHECKLIST (after the matching TS rename lands, same commit)
-- ============================================================================
--   □ npx vitest run — full suite green, including mealEntriesInsertSites
--     (unaffected by this migration — it only inspects meal_entries insert
--     sites, and this migration touches neither meal_entries nor its two
--     insert sites' shape) and any bundle-specific unit tests.
--   □ App builds/reloads on the dev client with no red-screen from a stale
--     `meal_bundles` / `bundle_id` reference anywhere in the client.
--   □ TodayScreen "Bundles" sheet still lists existing bundles (proves
--     getBundles()/fetchBundles() reads meal_compositions correctly).
--   □ Apply an existing bundle to today → meal_entries rows appear exactly as
--     before (proves applyBundle()/bump_composition_use round-trip).
--   □ Save a new bundle from selected entries → 1 meal_compositions row + N
--     meal_composition_items rows, positions 0..N-1 (proves the insert path's
--     composition_id / user_id columns are named right).
--   □ Add an item to an existing bundle, rename a bundle, delete a bundle
--     item, delete a whole bundle → each still works (proves update/delete
--     RLS policies carried over under their new names).


-- ============================================================================
-- ROLLBACK — reverse of every statement above, in reverse order. Run this
-- manually; it is NOT meant to be committed as a new forward migration file.
--
-- ⚠ SEQUENCING: if the matching TS rename has already been deployed, roll
-- THAT back first (git revert the client commit) before running this SQL —
-- the moment this commits, any client code still saying `meal_compositions` /
-- `composition_id` / `bump_composition_use` will start erroring, exactly
-- mirroring the forward-direction sequencing note above.
--
-- Only safe to run before migration 2 (or any code depending on `kind`,
-- `yield_g`, etc.) has landed — this rollback assumes those don't exist yet.
-- ============================================================================

-- begin;
--
-- comment on table public.meal_bundles is
--   'A named, reusable set of foods. Applied to a (day) — each item carries its '
--   'own meal_type and time. Snapshot semantics: items do not reference foods.';
--
-- comment on column public.meal_bundle_items.eaten_time is
--   'LOCAL wall clock (07:30), not an instant. Rebuilt on the target day by the '
--   'client so DST changes cannot shift a bundle.';
--
-- drop function if exists public.bump_composition_use(uuid);
--
-- create or replace function public.bump_bundle_use(p_bundle_id uuid)
-- returns void
-- language sql
-- security invoker
-- set search_path = public
-- as $$
--   update public.meal_bundles
--      set use_count    = use_count + 1,
--          last_used_at = now()
--    where id = p_bundle_id
--      and user_id = auth.uid();
-- $$;
--
-- comment on function public.bump_bundle_use(uuid) is
--   'Atomically record a bundle application. Call AFTER applyEntries succeeds — '
--   'a bundle you failed to apply is not a bundle you used.';
--
-- grant execute on function public.bump_bundle_use(uuid) to authenticated;
--
-- alter policy meal_compositions_select_own on public.meal_compositions
--   rename to meal_bundles_select_own;
-- alter policy meal_compositions_insert_own on public.meal_compositions
--   rename to meal_bundles_insert_own;
-- alter policy meal_compositions_update_own on public.meal_compositions
--   rename to meal_bundles_update_own;
-- alter policy meal_compositions_delete_own on public.meal_compositions
--   rename to meal_bundles_delete_own;
--
-- alter policy meal_composition_items_select_own on public.meal_composition_items
--   rename to meal_bundle_items_select_own;
-- alter policy meal_composition_items_insert_own on public.meal_composition_items
--   rename to meal_bundle_items_insert_own;
-- alter policy meal_composition_items_update_own on public.meal_composition_items
--   rename to meal_bundle_items_update_own;
-- alter policy meal_composition_items_delete_own on public.meal_composition_items
--   rename to meal_bundle_items_delete_own;
--
-- alter index public.meal_compositions_user_idx
--   rename to meal_bundles_user_idx;
-- alter index public.meal_composition_items_composition_idx
--   rename to meal_bundle_items_bundle_idx;
-- alter index public.meal_composition_items_user_idx
--   rename to meal_bundle_items_user_idx;
--
-- alter table public.meal_compositions
--   rename constraint meal_compositions_name_not_blank to meal_bundles_name_not_blank;
--
-- alter table public.meal_composition_items
--   rename column composition_id to bundle_id;
--
-- alter table public.meal_composition_items rename to meal_bundle_items;
-- alter table public.meal_compositions      rename to meal_bundles;
--
-- commit;
