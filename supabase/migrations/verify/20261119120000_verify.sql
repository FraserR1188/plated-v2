-- ============================================================================
-- Verification — 20261119120000_my_meal_entries_view.sql
--
-- Hosted only (dashboard SQL editor). No container rig: Docker was down when
-- this was written (2026-11-19). The view is one WHERE over one table, so the
-- hosted checks below exercise everything that could go wrong. A rig in the
-- 20261025130000_rig.sh pattern could add a no_invoker / no_where sabotage
-- pair if wanted.
--
-- Run V0 BEFORE the push. Push. Run V1–V7 after. Every "Expect" is PREDICTED
-- until a MEASURED line is added beside it; keep both.
--
--   A_USER      = a8435663-72e9-4d33-9c3f-803c4cbda393  (reader)
--   FRIEND_USER = 03f2f56a-d923-4acc-8a21-044deec280f7  (accepted friend of A,
--                 per 20260823150000_share_planned.sql's verification)
--
-- Impersonation block, used wherever a step says "as A" (swap the sub for
-- FRIEND_USER where a step says "as FRIEND"):
--
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393","role":"authenticated"}', true);
--   <query>
--   rollback;
-- ============================================================================


-- ── V0. BASELINE — BEFORE the push ─────────────────────────────────────────
-- (a) As postgres: each user's total rows. No eaten gate: the view has none.
select user_id, count(*)
from public.meal_entries
where user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
                  '03f2f56a-d923-4acc-8a21-044deec280f7')
group by 1;
-- Expect: two rows. Record both counts; V3 and V4 must equal them exactly.
-- MEASURED 2026-11-19 (hosted): A 1,486; FRIEND 42.

-- (b) As A, the BASE TABLE: the path the dashboard used to read.
--   select user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'::uuid as own, count(*)
--   from public.meal_entries group by 1;
-- Expect: own = true equal to V0(a)'s A count, AND an own = false row > 0
-- (friends' rows via meal_entries_select_follower). This proves the follower
-- path is live, so V3's "no own = false row" is a real test, not a vacuous one.
-- If there is no own = false row here, V3 proves nothing; find out why first.
-- MEASURED 2026-11-19 (hosted, before the push): own = true 1,486,
-- own = false 719. Follower path live, so V3 is a real test. V0(a)'s A count
-- should therefore read 1,486 (plus anything logged since).
--
-- Same check against whoop_correlation, MEASURED 2026-11-19: own = true only.
-- The correlation path doesn't need a view of its own.


-- ── V1. OPTIONS — after the push ───────────────────────────────────────────
select relname, reloptions
from pg_class
where relname = 'my_meal_entries' and relkind = 'v';
-- Expect: one row, reloptions = {security_invoker=on}.
-- MEASURED 2026-11-19 (hosted, after push): {security_invoker=on}. PASS.


-- ── V2. COLUMNS ────────────────────────────────────────────────────────────
select string_agg(column_name, ', ' order by ordinal_position)
from information_schema.columns
where table_schema = 'public' and table_name = 'my_meal_entries';
-- Expect exactly: id, user_id, name, brand, barcode, off_id, custom_food_id,
-- source, date, meal_type, calories, protein, carbs, fat, planned,
-- confirmed_at (16). No eaten_at, logged_at or eaten_at_estimated.
-- MEASURED 2026-11-19 (hosted): 16 columns exactly as listed, no clock-time
-- columns. PASS.


-- ── V3. SCOPING, as A ──────────────────────────────────────────────────────
--   select user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'::uuid as own, count(*)
--   from public.my_meal_entries group by 1;
-- Expect: ONE row, own = true, count = V0(a)'s A count exactly. Any
-- own = false row fails the migration. A count below V0(a) means the view
-- lost own rows (it must not: it adds a WHERE, it doesn't add a gate).
-- MEASURED 2026-11-19 (hosted): one row, own = true, 1,486 = V0(a). No
-- own = false row, where the base table in V0(b) gave 719 under the same
-- role and claims. PASS. This is the check that proves the fix.


-- ── V4. SCOPING, as FRIEND ─────────────────────────────────────────────────
-- Same query as V3, impersonating FRIEND_USER, comparing against FRIEND_USER's id.
-- Expect: one row, own = true, count = V0(a)'s FRIEND count. Proves the view
-- scopes to whoever is calling, not to a fixed user.
-- MEASURED 2026-11-19 (hosted): one row, own = true, 42 = V0(a). PASS.


-- ── V5. ANON ───────────────────────────────────────────────────────────────
--   begin; set local role anon;
--   select count(*) from public.my_meal_entries;
--   rollback;
-- Expect: ERROR 42501 permission denied for view my_meal_entries.
-- MEASURED 2026-11-19 (hosted): 42501. PASS.


-- ── V6. READ-ONLY, as A ────────────────────────────────────────────────────
-- Each in its own impersonation block. `where false` means nothing could
-- change even if a privilege check were missing; the privilege check fires
-- at plan time regardless.
--   insert into public.my_meal_entries (id) select id from public.my_meal_entries where false;
--   update public.my_meal_entries set name = name where false;
--   delete from public.my_meal_entries where false;
-- Expect: each ERROR 42501 permission denied for view my_meal_entries.
-- MEASURED 2026-11-19 (hosted): insert, update and delete all refused. PASS.

select grantee, string_agg(privilege_type, ', ' order by privilege_type)
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'my_meal_entries'
group by 1 order by 1;
-- Expect: authenticated = SELECT only; no anon row. postgres (owner) holds
-- all privileges; service_role may too via default privileges. That's
-- harmless: with no JWT sub, auth.uid() is null and the WHERE returns nothing.
-- MEASURED 2026-11-19 (hosted): authenticated = SELECT only; no anon row. PASS.


-- ── V7. DASHBOARD PARITY, as A ─────────────────────────────────────────────
-- The two numbers that exposed the problem, re-read through the view with
-- the dashboard's eaten gate and 90-day window.
--   select count(distinct date) as breakfast_days_90
--   from public.my_meal_entries
--   where (planned = false or confirmed_at is not null)
--     and meal_type = 'breakfast' and date::date >= current_date - 90;
-- Expect: equal to the same query run as postgres against meal_entries with
-- `user_id = A` on the same day (80 on 2026-11-19; it moves with the window).
-- MEASURED: not reported with the 2026-11-19 run. Re-run alongside the
-- dashboard checklist; the panel's breakfast n must equal it.
--
--   select count(*) as slot_days_over_2000 from (
--     select date, meal_type from public.my_meal_entries
--     where planned = false or confirmed_at is not null
--     group by 1, 2 having sum(calories) > 2000) s;
-- Expect: 0 (MEASURED 0 via user-scoped SQL as postgres, 2026-11-19).
-- MEASURED 2026-11-19 (hosted, through the view as A): 0. PASS.


-- ============================================================================
-- MANUAL TEST CHECKLIST — dashboard (app.platedapp.uk), after the push AND
-- the dashboard deploy that reads my_meal_entries
-- ============================================================================
-- [ ] Signed in as A, 90 days: "Meal size by slot" shows no dot above 2,000.
-- [ ] Breakfast n equals V7's breakfast_days_90.
-- [ ] Range All: habits strip reads 1,470 entries eaten and 124 days logged;
--     the most-logged footnote reads 192 of 1,470 (13%). (EXPECTED from
--     user-scoped SQL 2026-11-19; full table in plated/web
--     docs/dashboard-brief-phase2.md.)
-- [ ] Sign out, sign in as FRIEND_USER (or any account following A): only
--     that account's foods appear in "Most-logged foods"; none of A's.
-- [ ] After signing out of the dashboard, the phone app is still signed in
--     (dashboard sign-out is scope 'local').
