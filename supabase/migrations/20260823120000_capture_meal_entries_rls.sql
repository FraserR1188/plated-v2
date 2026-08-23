-- ============================================================
-- Captures meal_entries' RLS policy set, which — unlike profiles/follows
-- (see 20260819100000_capture_social_schema.sql) — has never existed in
-- migration history. This file is a faithful transcription of the live
-- shape, as read via:
--
--   select policyname, cmd, permissive, roles, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename = 'meal_entries'
--   order by policyname;
--
-- run against the remote on 2026-08-23 — not a redesign, and NOT an
-- opportunity to tidy up. Eleven policies came back, not the five you'd
-- expect from reading 20260712190000/20260819110000 alone: three naming
-- generations of the same own-row rules, coexisting.
--
--   "Users can delete own entries" / "Users can insert own entries" /
--   "Users can read own entries"                          (oldest generation)
--
--   "Users delete own entries" / "Users insert own entries" /
--   "Users read own entries"                              (middle generation)
--
--   meal_entries_delete_own / meal_entries_insert_own /
--   meal_entries_select_own / meal_entries_update_own     (current generation)
--
--   meal_entries_select_follower                          (cross-user gate)
--
-- All eleven are PERMISSIVE, all roles {public}. Permissive policies OR
-- together, so all three SELECT-shaped generations are simultaneously
-- live and simultaneously sufficient — none of them is dead weight the way
-- an unused policy would be. This migration changes NONE of that: every
-- predicate below is transcribed verbatim, duplicates included. Dropping
-- the six redundant legacy-named policies is COMMIT A2's job, once this
-- capture makes that safe to reason about; this migration is a pure
-- restatement of the live grant, drop-then-recreate under the SAME names,
-- so a from-scratch `db push` reproduces production exactly.
--
-- ⚠ SUPERSEDED, IN PART, BY 20260823130000_drop_legacy_meal_entries_policies.sql.
-- That migration drops the six legacy-named policies below (both the
-- "Users can ... own entries" and "Users ... own entries" generations),
-- keeping only meal_entries_delete_own / _insert_own / _select_own /
-- _update_own / _select_follower. If you are reading this file to figure
-- out what the live policy set IS, read 20260823130000 too — this file
-- alone describes a state that no longer holds once that one has run.
-- Do NOT recreate the six legacy policies by hand on the strength of this
-- file; a from-scratch `db push` applies both migrations in order and
-- ends at 20260823130000's five-policy state, not this one's eleven.
--
-- meal_entries_update_own's existence answers the open question from the
-- read-only pass: useStore's four .update() call sites (updateEntry,
-- confirmEntries, skipEntries, retimeEntries) are authorised by this
-- policy. qual (auth.uid() = user_id), with_check NULL — Postgres
-- backfills an omitted UPDATE with_check from qual, so user_id cannot be
-- retargeted to someone else's row by an update.
--
-- meal_entries_select_follower's qual was confirmed byte-identical (modulo
-- whitespace/Postgres's own re-parenthesisation) to the text created in
-- 20260819110000_friendship_accept_gate.sql — transcribed from that
-- migration's known-good text, not re-derived here.
--
-- Idempotent by construction, same convention as 20260819100000: DROP POLICY
-- IF EXISTS + CREATE POLICY under the live names, safe to re-run.
-- ============================================================

alter table public.meal_entries enable row level security;

comment on table public.meal_entries is
  'RLS: row security ENABLED, NOT FORCED (relforcerowsecurity = false), deliberately. Force-RLS only constrains the table OWNER/postgres role bypassing their own policies — an owner-console-access concern, not a client one — and service_role bypasses RLS unconditionally regardless of the force flag either way. See this migration for the full own-row + follower policy set.';

-- ─── Drop every policy this migration is authoritative for ───────────────

drop policy if exists "Users can delete own entries" on public.meal_entries;
drop policy if exists "Users can insert own entries" on public.meal_entries;
drop policy if exists "Users can read own entries"   on public.meal_entries;

drop policy if exists "Users delete own entries" on public.meal_entries;
drop policy if exists "Users insert own entries" on public.meal_entries;
drop policy if exists "Users read own entries"   on public.meal_entries;

drop policy if exists meal_entries_delete_own on public.meal_entries;
drop policy if exists meal_entries_insert_own on public.meal_entries;
drop policy if exists meal_entries_select_own on public.meal_entries;
drop policy if exists meal_entries_update_own on public.meal_entries;

drop policy if exists meal_entries_select_follower on public.meal_entries;

-- ─── Oldest generation — "Users can ... own entries" ─────────────────────

create policy "Users can delete own entries" on public.meal_entries
  for delete using (auth.uid() = user_id);

create policy "Users can insert own entries" on public.meal_entries
  for insert with check (auth.uid() = user_id);

create policy "Users can read own entries" on public.meal_entries
  for select using (auth.uid() = user_id);

-- ─── Middle generation — "Users ... own entries" ─────────────────────────

create policy "Users delete own entries" on public.meal_entries
  for delete using (auth.uid() = user_id);

create policy "Users insert own entries" on public.meal_entries
  for insert with check (auth.uid() = user_id);

create policy "Users read own entries" on public.meal_entries
  for select using (auth.uid() = user_id);

-- ─── Current generation — meal_entries_*_own ─────────────────────────────

create policy meal_entries_delete_own on public.meal_entries
  for delete using (auth.uid() = user_id);

create policy meal_entries_insert_own on public.meal_entries
  for insert with check (auth.uid() = user_id);

create policy meal_entries_select_own on public.meal_entries
  for select using (auth.uid() = user_id);

create policy meal_entries_update_own on public.meal_entries
  for update using (auth.uid() = user_id);

-- ─── Cross-user gate — transcribed verbatim from 20260819110000 ─────────

create policy meal_entries_select_follower on public.meal_entries
  for select
  using (
        (planned = false or confirmed_at is not null)
    and skipped_at is null
    and exists (
          select 1
            from public.follows f
           where f.status = 'accepted'
             and (
                   (f.follower_id  = auth.uid() and f.following_id = meal_entries.user_id)
                or (f.following_id = auth.uid() and f.follower_id  = meal_entries.user_id)
                 )
        )
  );

-- ============================================================================
-- VERIFICATION — this migration must be a pure no-op on the live grant.
-- Run both V0 and V1 as the SAME role. Running either as `postgres`
-- bypasses RLS and answers a different question.
-- ============================================================================

-- V0. BASELINE — run BEFORE applying this migration. Keep the output.
--
-- select policyname, cmd, permissive, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'meal_entries'
-- order by policyname;
-- Expect: the same 11 rows this migration's header describes.

-- V1. AFTER APPLYING — re-run the identical query.
--
-- select policyname, cmd, permissive, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'meal_entries'
-- order by policyname;
-- Expect: byte-identical to V0 — same 11 policyname/cmd/permissive/roles
-- pairs, same qual/with_check text (modulo Postgres's own
-- re-parenthesisation, which round-trips identically either side of a
-- drop+recreate). Any row added, removed, or changed means this migration
-- did not transcribe faithfully — stop and diff against V0 before
-- proceeding to A2.

-- V2. Row count untouched — a policy change touches no data, but this is
--     the same paranoia every migration in this repo applies to itself.
--
-- select count(*) from public.meal_entries;
-- Expect: identical before and after.

-- V3. relrowsecurity / relforcerowsecurity unchanged.
--
-- select relrowsecurity, relforcerowsecurity
-- from pg_class
-- where oid = 'public.meal_entries'::regclass;
-- Expect: t, f — both before and after.
