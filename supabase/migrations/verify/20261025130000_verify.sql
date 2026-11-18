-- ============================================================================
-- Verification — 20261025130000_whoop_cycle_nutrition_incomplete_known.sql
-- (PL-059)
--
-- Order: 20261025120000 must already be applied (this view reads
-- meal_entries.incomplete_nutrients). Run V1 BEFORE applying this one. Apply
-- it. Run V2-V5 after. V6 (cleanup) is commented out.
--
-- Every "Expect" is PREDICTED unless marked MEASURED. "MEASURED in the rig"
-- lines come from 20261025130000_rig.sh (throwaway postgres:16-alpine, stub
-- tables, the real current whoop_cycle_nutrition and whoop_correlation
-- definitions built on top), not from the hosted database. "MEASURED
-- 2026-11-18 (hosted)" lines are the hosted run; each keeps its original
-- prediction beside it.
-- ============================================================================

-- ── V1. PRE-SNAPSHOT — run BEFORE applying this migration ─────────────────
-- effective_end OMITTED: it is now()-derived for an in-progress cycle and
-- would differ between snapshots on its own (see 20260831120000's V1).
create table public._diag_wcn_inc_pre as
select
  user_id, cycle_id, cycle_start, cycle_end,
  is_in_progress, score_state, strain, kilojoule, average_heart_rate, timezone_offset,
  meal_count, kcal, protein, carbs, fat, sat_fat, salt, fibre, sugar,
  has_estimated_times, first_meal_at, last_meal_at,
  sat_fat_known_meals, salt_known_meals, fibre_known_meals, sugar_known_meals
from public.whoop_cycle_nutrition;

select count(*) as pre_rows from public._diag_wcn_inc_pre;

-- How many flagged rows exist right now. The client that writes them hasn't
-- shipped, so this should be 0 — which is what makes V3's "nothing changed"
-- the right expectation.
select count(*) filter (where incomplete_nutrients is not null) as flagged_rows
from public.meal_entries;
-- Expect (PREDICTED): 0.  MEASURED 2026-11-18 (hosted): 0.


-- ── APPLY THE MIGRATION NOW ────────────────────────────────────────────────


-- ── V2. POST-SNAPSHOT — the same columns ───────────────────────────────────
create table public._diag_wcn_inc_post as
select
  user_id, cycle_id, cycle_start, cycle_end,
  is_in_progress, score_state, strain, kilojoule, average_heart_rate, timezone_offset,
  meal_count, kcal, protein, carbs, fat, sat_fat, salt, fibre, sugar,
  has_estimated_times, first_meal_at, last_meal_at,
  sat_fat_known_meals, salt_known_meals, fibre_known_meals, sugar_known_meals
from public.whoop_cycle_nutrition;


-- ── V3. NOTHING CHANGED — both directions ──────────────────────────────────
-- With no flagged row in meal_entries, every *_known_meals must equal what
-- count(m.x) returned, and nothing else in the view was touched.
select 'pre_only' as side, * from (
  select * from public._diag_wcn_inc_pre except select * from public._diag_wcn_inc_post) d
union all
select 'post_only', * from (
  select * from public._diag_wcn_inc_post except select * from public._diag_wcn_inc_pre) d;
-- Expect (PREDICTED): ZERO rows. An in-progress cycle that gained a meal
-- between V1 and V2 also shows up here as a pre/post pair — re-run V1/V2
-- back to back if so, that is the app, not this migration.
-- MEASURED in the rig (F7): with every flag cleared, the new view equals the
-- old view's snapshot row-for-row, both directions.
-- MEASURED 2026-11-18 (hosted): V3 NOT valid evidence — V1 of this file was
-- taken after the push, so pre and post are both the new view. Parity is
-- therefore NOT measured on hosted. Basis instead: flagged_rows = 0 (hosted,
-- MEASURED) makes every new FILTER clause pass every row, so each
-- *_known_meals = count(m.x); and rig F7 (MEASURED) shows row-for-row parity
-- on unflagged data. An alternative closed-cycle snapshot (774 rows, 6 users)
-- showed 0 diffs both ways, but whether the push fell between its two
-- snapshots was not recorded, so it is not counted.

select (select count(*) from public._diag_wcn_inc_pre)  as pre_rows,
       (select count(*) from public._diag_wcn_inc_post) as post_rows;
-- Expect (PREDICTED): equal.


-- ── V4. SHAPE ──────────────────────────────────────────────────────────────
-- security_invoker survived the replace.
select c.reloptions from pg_class c
where c.relname = 'whoop_cycle_nutrition' and c.relnamespace = 'public'::regnamespace;
-- Expect (PREDICTED): {security_invoker=on}.
-- MEASURED 2026-11-18 (hosted): {security_invoker=on}, checked before and
-- after the push.
-- MEASURED in the rig (F8 clean; no_invoker variant): {security_invoker=on}
-- with the option restated; EMPTY without it, so the restatement is required.

-- The definition now reads incomplete_nutrients in the known counts.
select position('incomplete_nutrients' in pg_get_viewdef('public.whoop_cycle_nutrition'::regclass)) > 0
  as reads_incomplete_nutrients;
-- Expect (PREDICTED): true.  MEASURED 2026-11-18 (hosted): true.

-- whoop_correlation still depends on this view, still valid, still passes the
-- counts through unchanged (no change of its own in this release).
select count(*) as wc_rows,
       count(*) filter (where n.fibre_known_meals is distinct from c.fibre_known_meals_same_cycle
                           or n.salt_known_meals  is distinct from c.salt_known_meals_same_cycle
                           or n.sugar_known_meals is distinct from c.sugar_known_meals_same_cycle
                           or n.sat_fat_known_meals is distinct from c.sat_fat_known_meals_same_cycle)
         as passthrough_mismatches
from public.whoop_correlation c
join public.whoop_cycle_nutrition n using (user_id, cycle_id);
-- Expect (PREDICTED): wc_rows = post_rows; passthrough_mismatches = 0.
-- MEASURED 2026-11-18 (hosted): wc_rows 783, passthrough_mismatches 0.
-- MEASURED in the rig (F6, F6b): whoop_correlation's same-cycle AND
-- prev-cycle known counts reflect the new rule with no change to its
-- definition.


-- ── V5. RLS — two accounts ────────────────────────────────────────────────
-- One DO block per user. Replace each UUID. set_config(..., true) and SET
-- LOCAL ROLE are transaction-local, and the final RAISE (the dashboard does
-- not show NOTICEs) rolls them back. wcn_own is non-vacuity: it proves the
-- role switch took and RLS is returning that user's own cycles.
do $$
declare
  v_me  uuid := '<USER A UUID>';
  n_wcn_own bigint; n_wcn_users bigint; n_wcn_foreign bigint; n_wc_foreign bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_me)::text, true);
  set local role authenticated;

  select count(*) into n_wcn_own from public.whoop_cycle_nutrition where user_id = v_me;
  select count(distinct user_id) into n_wcn_users from public.whoop_cycle_nutrition;
  select count(*) into n_wcn_foreign from public.whoop_cycle_nutrition where user_id <> v_me;
  select count(*) into n_wc_foreign from public.whoop_correlation where user_id <> v_me;

  raise exception 'V5 user A: wcn_own %, wcn_users % | wcn_foreign %, wc_foreign %',
    n_wcn_own, n_wcn_users, n_wcn_foreign, n_wc_foreign;
end $$;

do $$
declare
  v_me  uuid := '<USER B UUID>';
  n_wcn_own bigint; n_wcn_users bigint; n_wcn_foreign bigint; n_wc_foreign bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_me)::text, true);
  set local role authenticated;

  select count(*) into n_wcn_own from public.whoop_cycle_nutrition where user_id = v_me;
  select count(distinct user_id) into n_wcn_users from public.whoop_cycle_nutrition;
  select count(*) into n_wcn_foreign from public.whoop_cycle_nutrition where user_id <> v_me;
  select count(*) into n_wc_foreign from public.whoop_correlation where user_id <> v_me;

  raise exception 'V5 user B: wcn_own %, wcn_users % | wcn_foreign %, wc_foreign %',
    n_wcn_own, n_wcn_users, n_wcn_foreign, n_wc_foreign;
end $$;
-- Expect (PREDICTED) for each: wcn_users <= 1, wcn_foreign 0, wc_foreign 0.
-- MEASURED 2026-11-18 (hosted, the DO-block version above):
--   A: wcn_own 129, wcn_users 1, wcn_foreign 0, wc_foreign 0.
--   B: wcn_own 200, wcn_users 1, wcn_foreign 0, wc_foreign 0.
-- MEASURED in the rig (F9-F9c): 0 foreign rows through both views as A and
-- as B; with security_invoker removed (no_invoker), A saw 4 cycles (B's
-- included) and 1 foreign whoop_correlation row.


-- ── AFTER THE OTA: the rule on real data ───────────────────────────────────
-- Once a partial batch has been logged by the new client, this shows the
-- difference the migration makes: per cycle, how many meals the OLD rule
-- would have counted as known (count(m.fibre)) vs the new rule.
-- select n.user_id, n.cycle_id, n.meal_count,
--        n.fibre_known_meals as known_now,
--        (select count(m.fibre) from public.meal_entries m
--          where m.user_id = n.user_id and m.eaten_at >= n.cycle_start
--            and m.eaten_at < n.effective_end
--            and (m.planned = false or m.confirmed_at is not null)) as known_old_rule
-- from public.whoop_cycle_nutrition n
-- where n.effective_end is not null
-- order by n.cycle_start desc limit 20;
-- Expect: known_now = known_old_rule except on cycles containing a meal
-- with 'fibre' in incomplete_nutrients, where known_now is lower by the
-- number of such meals.


-- ── V6. CLEANUP — run yourself once satisfied ──────────────────────────────
-- drop table public._diag_wcn_inc_pre;
-- drop table public._diag_wcn_inc_post;
