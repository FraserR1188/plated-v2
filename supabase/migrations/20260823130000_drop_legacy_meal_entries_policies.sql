-- ============================================================
-- Drops the six legacy-named meal_entries own-row policies captured (not
-- created) by 20260823120000_capture_meal_entries_rls.sql:
--
--   "Users can delete own entries" / "Users can insert own entries" /
--   "Users can read own entries"                          (oldest generation)
--
--   "Users delete own entries" / "Users insert own entries" /
--   "Users read own entries"                              (middle generation)
--
-- Kept: meal_entries_delete_own, meal_entries_insert_own,
-- meal_entries_select_own, meal_entries_update_own,
-- meal_entries_select_follower — the current generation plus the
-- cross-user gate. Five policies, one per operation plus the follower
-- read path.
--
-- ─── WHY THIS IS SAFE TODAY AND NOT SAFE TO LEAVE INDEFINITELY ───
--
-- Every dropped policy has the identical predicate (auth.uid() = user_id,
-- or the same thing as with_check for INSERT) as its current-generation
-- replacement. Permissive policies OR together — Postgres grants access if
-- ANY applicable policy's condition holds — so three copies of the same
-- condition grant exactly what one copy grants. Removing five of the six
-- redundant copies (this migration keeps one from the current generation)
-- changes nothing about who can read, insert, or delete a row, today.
--
-- It stops being a no-op the moment anyone tightens meal_entries_select_own
-- — narrows it to exclude some row it currently includes, say. That edit
-- would silently do nothing: "Users can read own entries" and "Users read
-- own entries" would still be sitting there with the OLD, untightened
-- (auth.uid() = user_id) condition, and the OR means the loosest policy
-- wins. A reviewer reading only the diff on meal_entries_select_own would
-- see a correct-looking tightened predicate and have no way to know, from
-- that file alone, that it was defeated the moment it landed. This
-- migration exists so that failure mode is unreachable, not just unlikely.
--
-- Idempotent: DROP POLICY IF EXISTS. Safe to re-run.
-- ============================================================

drop policy if exists "Users can delete own entries" on public.meal_entries;
drop policy if exists "Users can insert own entries" on public.meal_entries;
drop policy if exists "Users can read own entries"   on public.meal_entries;

drop policy if exists "Users delete own entries" on public.meal_entries;
drop policy if exists "Users insert own entries" on public.meal_entries;
drop policy if exists "Users read own entries"   on public.meal_entries;

-- ============================================================================
-- VERIFICATION
--
-- Run the pg_policies / row-count / relrowsecurity checks as ANY role (they
-- don't depend on who's asking). Run the second-account checks as
-- `authenticated`, impersonating the given user — NOT as `postgres`, which
-- bypasses RLS entirely and would report success regardless of whether the
-- policies are correct. In the Supabase Studio SQL editor, use the role/JWT
-- switcher; via psql or the CLI, precede each block with:
--
--   set local role authenticated;
--   set local request.jwt.claims to '{"sub":"<USER_ID>","role":"authenticated"}';
--
-- substituting the user being impersonated for <USER_ID>.
-- ============================================================================

-- V0. BASELINE ROW COUNT — run BEFORE applying this migration. Record it;
--     it's compared against V4 below, not just against itself.
--
-- select count(*) from public.meal_entries;

-- V1. Exactly five policies remain, all under current-generation names.
--
-- select policyname, cmd, permissive, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'meal_entries'
-- order by policyname;
--
-- Expect EXACTLY these 5 rows (alphabetical by policyname):
--   meal_entries_delete_own
--   meal_entries_insert_own
--   meal_entries_select_follower
--   meal_entries_select_own
--   meal_entries_update_own

-- V2. relrowsecurity / relforcerowsecurity unchanged by this migration —
--     it only drops policies, never touches the table's RLS flags.
--
-- select relrowsecurity, relforcerowsecurity
-- from pg_class
-- where oid = 'public.meal_entries'::regclass;
-- Expect: t, f — same as before this migration.

-- V3. Row count unchanged — dropping policies touches no data.
--
-- select count(*) from public.meal_entries;
-- Expect: identical to V0.

-- V4. SECOND-ACCOUNT CHECKS — as `authenticated`, impersonating each user
--     in turn (see the role/JWT note above). Substitute three real,
--     DISTINCT accounts:
--       <A_USER_ID>      — the account doing the reading
--       <B_USER_ID>      — any account A is NOT friends with
--       <FRIEND_USER_ID> — an account with an ACCEPTED friendship with A,
--                          who has at least one logged or confirmed entry
--
-- 4a. A reads A's own entries — expect the SAME count as V0/A's own
--     baseline (capture this once, before the migration, as A):
--
-- select count(*) from public.meal_entries where user_id = '<A_USER_ID>';

-- 4b. A reads B's entries, no friendship between them — expect 0:
--
-- select count(*) from public.meal_entries where user_id = '<B_USER_ID>';

-- 4c. A reads FRIEND's logged/confirmed entries via the follower policy —
--     expect the SAME count as the equivalent query run before this
--     migration (capture that baseline first, then re-run after):
--
-- select count(*) from public.meal_entries where user_id = '<FRIEND_USER_ID>';
--
-- All three (4a/4b/4c) must match their pre-migration values exactly —
-- dropping the legacy policies must be invisible to every one of them.
