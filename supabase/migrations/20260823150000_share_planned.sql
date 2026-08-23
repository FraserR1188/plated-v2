-- ============================================================
-- Opt-in sharing of a user's own PLANNED (not-yet-eaten, unconfirmed)
-- meal_entries rows with accepted friends. SCHEMA ONLY — no client change
-- accompanies this migration, and none is required for it to be safe to
-- ship: getEntriesForUserRange's .or("planned.eq.false,confirmed_at.not.is.null")
-- filter (src/lib/social.ts) is unchanged, so even once a user flips
-- share_planned = true, the app's own friend-log query still asks Postgres
-- for "not planned, or confirmed" and never sees the newly-visible rows.
-- The column and the RLS disjunct below are real and enforced at the DB
-- layer the moment this lands; only the UI path to use them is absent.
-- That is the point — this ships inert, and can be verified against the
-- real schema before any screen depends on it.
--
-- default false is load-bearing: every existing user starts opted OUT.
-- NO BACKFILL of true for any existing row, under any circumstance.
--
-- ─── What changes on meal_entries_select_follower ───────────────────────
--
-- Before (captured verbatim in 20260823120000, unchanged since
-- 20260819110000):
--
--   (planned = false or confirmed_at is not null)
--   and skipped_at is null
--   and exists ( ...accepted-friendship check... )
--
-- After: the planned clause gains a third disjunct — sharer opted in —
-- while skipped_at stays OUTSIDE the disjunction (a skipped row is never
-- visible to a friend, opted in or not) and the friendship check is
-- copied byte-for-byte from the captured text, not retyped:
--
--   (
--     planned = false
--     or confirmed_at is not null
--     or exists (
--          select 1 from public.profiles p
--           where p.user_id = meal_entries.user_id
--             and p.share_planned
--        )
--   )
--   and skipped_at is null
--   and exists ( ...same accepted-friendship check, unchanged... )
--
-- Idempotent: add column if not exists, drop policy if exists + create.
-- ============================================================

alter table public.profiles
  add column if not exists share_planned boolean not null default false;

comment on column public.profiles.share_planned is
  'Opt-in: when true, this user''s own PLANNED (unconfirmed, not-yet-eaten) meal_entries rows become visible to accepted friends via meal_entries_select_follower, subject to the same skipped_at and friendship gates as logged/confirmed rows. Default false. Never backfilled to true for existing users.';

drop policy if exists meal_entries_select_follower on public.meal_entries;

create policy meal_entries_select_follower on public.meal_entries
  for select
  using (
        (
          planned = false
          or confirmed_at is not null
          or exists (
               select 1
                 from public.profiles p
                where p.user_id = meal_entries.user_id
                  and p.share_planned
             )
        )
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
-- VERIFICATION
--
-- Parameterised for two real accounts:
--   A_USER      = a8435663-72e9-4d33-9c3f-803c4cbda393  (the reader, throughout)
--   FRIEND_USER = 03f2f56a-d923-4acc-8a21-044deec280f7  (accepted friend of A,
--                 currently shows 14 of 29 rows to A — the pre-migration
--                 baseline this script's counts are measured against)
--   PENDING_USER = c7c5338a-... (friendship status = pending with A — used
--                 only in scenario (d), to prove the accept-gate still holds)
--
-- Run every SELECT below as `authenticated`, impersonating A unless a step
-- says otherwise:
--   set local role authenticated;
--   set local request.jwt.claims to '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393","role":"authenticated"}';
--
-- To flip FRIEND_USER's own share_planned (run as FRIEND_USER, or as
-- postgres/service_role directly against the table — either is fine, this
-- isn't testing the UPDATE policy, just setting up state for the SELECT
-- checks below):
--
--   update public.profiles set share_planned = true  where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
--   update public.profiles set share_planned = false where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
-- ============================================================================

-- V0. BASELINE — run BEFORE applying this migration, as A.
-- select count(*) from public.meal_entries where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
-- Expect: 14 (the known pre-migration baseline).

-- (a) FRIEND_USER.share_planned = false (the default — no action needed,
--     this is the state V0 was already measured in). Re-run as A:
--
-- select count(*) from public.meal_entries where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
-- Expect: 14. Unchanged — this migration adds a disjunct that's false for
-- everyone until share_planned is explicitly flipped.

-- (b) Flip FRIEND_USER to share_planned = true (see UPDATE above). As A:
--
-- select count(*) from public.meal_entries where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
-- Expect: EXACTLY 29 — 14 already-visible (logged/confirmed) plus 15
-- unconfirmed-planned-and-not-skipped, per the known breakdown of this
-- account's 29 total rows (14 / 15 / 0 / 0 across
-- logged-or-confirmed / unconfirmed-planned / confirmed-planned /
-- skipped). A hardcoded 29, not "more than 14" — a subquery matching only
-- SOME of the planned rows is the realistic failure mode, and it must
-- fail this check immediately rather than pass pending the cross-check
-- below. Stop here if it isn't exactly 29.
--
-- Cross-check (confirmation, not the pass/fail gate — that's above):
--
-- select count(*) from public.meal_entries
--  where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7'
--    and planned = true
--    and confirmed_at is null
--    and skipped_at is null;
-- Expect: exactly 15, matching 29 - 14.

-- (b→WHOOP) Commit B's own test — the only point in this sequence where it
--     stops being theoretical. As A, immediately after (b):
--
-- select count(*) from public.whoop_unassigned_meals;
-- Expect: 118, unchanged. Before Commit B, whoop_unassigned_meals' single-user
-- guarantee was incidental (an inner join that happened to narrow to
-- auth.uid()); now that FRIEND_USER's planned rows genuinely satisfy
-- meal_entries_select_follower for the first time in this whole sequence,
-- this is the one moment that distinguishes "the explicit where m.user_id =
-- auth.uid() in `placed` holds it shut" from "nothing was ever actually
-- tested." A count other than 118 means a friend's planned meal reached A's
-- own unassigned-meals view — stop immediately, do not proceed to (c).

-- (c) With FRIEND_USER still share_planned = true, mark one of their
--     currently-visible planned rows skipped (run as FRIEND_USER or as
--     postgres against a specific row's id). Postgres has no UPDATE ...
--     LIMIT — use a subquery, and RETURNING id so (f) can reset this exact
--     row rather than every skipped row on the account:
--
-- update public.meal_entries set skipped_at = now()
--  where id = (
--    select id from public.meal_entries
--     where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7'
--       and planned = true and confirmed_at is null and skipped_at is null
--     limit 1
--  )
-- returning id;
-- -- Record the returned id — needed by (f).
--
-- Then, as A:
-- select count(*) from public.meal_entries where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
-- Expect: EXACTLY 28. The skipped row must drop back out — skipped_at is
-- outside the disjunction and gates everything, share_planned included.

-- (d) FRIEND_USER share_planned = true, but the OTHER account
--     (PENDING_USER, friendship status = 'pending' with A, not accepted) —
--     the accept-gate must not weaken. As A:
--
-- select count(*) from public.meal_entries where user_id = '<PENDING_USER_ID>';
-- Expect: 0. share_planned is irrelevant here — the exists(...) friendship
-- check never matches a pending row, same as before this migration.

-- (e) A's own planned entries, unaffected throughout every step above. As A,
--     re-run after EACH of (a)/(b)/(c)/(d):
--
-- select count(*) from public.meal_entries where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393';
-- Expect: 463, every time — this policy only ever governs rows where
-- meal_entries.user_id is someone else; A's own-row policies
-- (meal_entries_select_own, etc.) are untouched by this migration and don't
-- reference share_planned at all.

-- (f) Reset. Undo the skip from (c) — using the id (c) returned, NOT a
--     blanket "every skipped row on this account" clear. Ground truth has
--     zero pre-existing skipped rows on FRIEND_USER today, so a blanket
--     clear happens to be harmless right now, but it would silently
--     un-skip a genuinely skipped meal if this account ever has one —
--     reset the specific row instead:
--
-- update public.meal_entries set skipped_at = null where id = '<ID_RETURNED_BY_C>';
-- update public.profiles set share_planned = false where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
--
-- Then, as A:
-- select count(*) from public.meal_entries where user_id = '03f2f56a-d923-4acc-8a21-044deec280f7';
-- Expect: 14 — back to the exact pre-migration baseline.
-- select count(*) from public.whoop_unassigned_meals;
-- Expect: 118 — back to baseline, confirming (b→WHOOP)'s reset is clean too.
