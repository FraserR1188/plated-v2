-- ============================================================================
-- Verification — 20260901100000_whoop_correlation_repoint.sql
--
-- Run V0 BEFORE applying (a real dependency here means STOP, do not apply).
-- Run V1 BEFORE applying — it cannot be recreated after. Apply the
-- migration. Run V2-V7 after. V8 (cleanup) is commented out.
-- ============================================================================

-- ── V0. PRE-FLIGHT — nothing depends on whoop_correlation ─────────────────
-- This migration does an unconditional DROP, not DROP IF EXISTS CASCADE.
-- Confirmed via grep across every migration and every src/ + supabase/
-- functions/ file that nothing reads whoop_correlation — this checks the
-- one thing grep cannot see: an ad-hoc object created directly on the
-- remote (dashboard SQL editor, a manual view, anything outside the tracked
-- migration history).
select distinct dependent_ns.nspname as dependent_schema,
                dependent_view.relname as dependent_object
from pg_depend
join pg_rewrite on pg_depend.objid = pg_rewrite.oid
join pg_class as dependent_view on pg_rewrite.ev_class = dependent_view.oid
join pg_class as source_table on pg_depend.refobjid = source_table.oid
join pg_namespace dependent_ns on dependent_ns.oid = dependent_view.relnamespace
join pg_namespace source_ns on source_ns.oid = source_table.relnamespace
where source_ns.nspname = 'public'
  and source_table.relname = 'whoop_correlation'
  and dependent_view.relname != 'whoop_correlation';
-- Expect ZERO rows. If this returns anything, STOP — do not apply this
-- migration until you know what that object is and whether it survives the
-- DROP. (Query mechanics sanity-checked in a throwaway container against a
-- known dependent before shipping this file — it does detect one.)


-- ── V1. PRE-SNAPSHOT — run BEFORE the push ─────────────────────────────────
-- OLD column list, explicit, old names. hrv_rmssd_milli is selected under
-- its old name here (it doesn't change value or meaning pre-migration).
create table public._diag_wc_pre as
select
  user_id, cycle_id, cycle_start, cycle_end, is_in_progress, timezone_offset,
  cycle_local_date, strain, kilojoule, average_heart_rate,
  meal_count_same_cycle, kcal_same_cycle, protein_same_cycle, carbs_same_cycle,
  fat_same_cycle, sat_fat_same_cycle, salt_same_cycle, fibre_same_cycle, sugar_same_cycle,
  prev_cycle_id, meal_count_prev_cycle, kcal_prev_cycle, protein_prev_cycle,
  carbs_prev_cycle, fat_prev_cycle, sat_fat_prev_cycle, salt_prev_cycle,
  fibre_prev_cycle, sugar_prev_cycle, last_meal_before_sleep_at,
  recovery_score, hrv_rmssd_milli, resting_heart_rate, spo2_percentage,
  skin_temp_celsius, user_calibrating,
  sleep_id, sleep_performance_percentage, sleep_efficiency_percentage,
  sleep_consistency_percentage, respiratory_rate, total_in_bed_time_milli,
  total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli,
  total_awake_time_milli, disturbance_count, sleep_was_nap,
  cycle_scored, recovery_scored, sleep_scored, nutrition_present,
  prev_nutrition_present, prev_cycle_contiguous,
  timing_estimated_same_cycle, timing_estimated_prev_cycle
from public.whoop_correlation;

select count(*) as pre_row_count from public._diag_wc_pre;


-- ── APPLY THE MIGRATION NOW ────────────────────────────────────────────────


-- ── V2. POST-SNAPSHOT — same old column list ───────────────────────────────
-- hrv_rmssd_milli no longer exists as a column name (renamed to hrv per
-- this migration) — aliased back to the old name here purely so V3's diff
-- compares like values under like names. Production is 100% 'rmssd' today,
-- so this alias changes nothing about what's actually being compared.
create table public._diag_wc_post as
select
  user_id, cycle_id, cycle_start, cycle_end, is_in_progress, timezone_offset,
  cycle_local_date, strain, kilojoule, average_heart_rate,
  meal_count_same_cycle, kcal_same_cycle, protein_same_cycle, carbs_same_cycle,
  fat_same_cycle, sat_fat_same_cycle, salt_same_cycle, fibre_same_cycle, sugar_same_cycle,
  prev_cycle_id, meal_count_prev_cycle, kcal_prev_cycle, protein_prev_cycle,
  carbs_prev_cycle, fat_prev_cycle, sat_fat_prev_cycle, salt_prev_cycle,
  fibre_prev_cycle, sugar_prev_cycle, last_meal_before_sleep_at,
  recovery_score, hrv as hrv_rmssd_milli, resting_heart_rate, spo2_percentage,
  skin_temp_celsius, user_calibrating,
  sleep_id, sleep_performance_percentage, sleep_efficiency_percentage,
  sleep_consistency_percentage, respiratory_rate, total_in_bed_time_milli,
  total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli,
  total_awake_time_milli, disturbance_count, sleep_was_nap,
  cycle_scored, recovery_scored, sleep_scored, nutrition_present,
  prev_nutrition_present, prev_cycle_contiguous,
  timing_estimated_same_cycle, timing_estimated_prev_cycle
from public.whoop_correlation;

select count(*) as post_row_count from public._diag_wc_post;


-- ── V3. TARGETED DIFF ───────────────────────────────────────────────────────
-- Split into SAME-CYCLE/identity/recovery columns (V3(1)) and PREV-CYCLE
-- columns (V3(2)) deliberately: the partition widening (V5) means exactly
-- ONE row's entire prev_* column set legitimately changes together, not
-- just resting_heart_rate. Folding both concerns into one query would force
-- hardcoding that row's identity here before V5 has even found it — instead
-- V3(2) excludes whatever V5 discovers, dynamically.

-- V3(1). Same-cycle / identity / resolved-recovery columns — identical for
-- every row except the ONE named resting_heart_rate exception.
select pre.user_id, pre.cycle_id, 'V3(1) MISMATCH' as check_name
from public._diag_wc_pre pre
join public._diag_wc_post post using (user_id, cycle_id)
where not (pre.user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9' and pre.cycle_id = '1737676452')
  and (
       pre.cycle_start                    is distinct from post.cycle_start
    or pre.cycle_end                      is distinct from post.cycle_end
    or pre.is_in_progress                 is distinct from post.is_in_progress
    or pre.timezone_offset                is distinct from post.timezone_offset
    or pre.cycle_local_date               is distinct from post.cycle_local_date
    or pre.strain                         is distinct from post.strain
    or pre.kilojoule                      is distinct from post.kilojoule
    or pre.average_heart_rate             is distinct from post.average_heart_rate
    or pre.meal_count_same_cycle          is distinct from post.meal_count_same_cycle
    or pre.kcal_same_cycle                is distinct from post.kcal_same_cycle
    or pre.protein_same_cycle             is distinct from post.protein_same_cycle
    or pre.carbs_same_cycle               is distinct from post.carbs_same_cycle
    or pre.fat_same_cycle                 is distinct from post.fat_same_cycle
    or pre.sat_fat_same_cycle             is distinct from post.sat_fat_same_cycle
    or pre.salt_same_cycle                is distinct from post.salt_same_cycle
    or pre.fibre_same_cycle               is distinct from post.fibre_same_cycle
    or pre.sugar_same_cycle               is distinct from post.sugar_same_cycle
    or pre.recovery_score                 is distinct from post.recovery_score
    or pre.hrv_rmssd_milli                is distinct from post.hrv_rmssd_milli
    -- resting_heart_rate deliberately excluded — checked in V3(3) below
    or pre.spo2_percentage                is distinct from post.spo2_percentage
    or pre.skin_temp_celsius              is distinct from post.skin_temp_celsius
    or pre.user_calibrating               is distinct from post.user_calibrating
    or pre.sleep_id                       is distinct from post.sleep_id
    or pre.sleep_performance_percentage   is distinct from post.sleep_performance_percentage
    or pre.sleep_efficiency_percentage    is distinct from post.sleep_efficiency_percentage
    or pre.sleep_consistency_percentage   is distinct from post.sleep_consistency_percentage
    or pre.respiratory_rate               is distinct from post.respiratory_rate
    or pre.total_in_bed_time_milli        is distinct from post.total_in_bed_time_milli
    or pre.total_slow_wave_sleep_time_milli is distinct from post.total_slow_wave_sleep_time_milli
    or pre.total_rem_sleep_time_milli     is distinct from post.total_rem_sleep_time_milli
    or pre.total_awake_time_milli         is distinct from post.total_awake_time_milli
    or pre.disturbance_count              is distinct from post.disturbance_count
    or pre.sleep_was_nap                  is distinct from post.sleep_was_nap
    or pre.cycle_scored                   is distinct from post.cycle_scored
    or pre.recovery_scored                is distinct from post.recovery_scored
    or pre.sleep_scored                   is distinct from post.sleep_scored
    or pre.nutrition_present              is distinct from post.nutrition_present
    or pre.timing_estimated_same_cycle    is distinct from post.timing_estimated_same_cycle
  );
-- Expect ZERO rows.

-- V3(2). Prev-cycle columns — identical for every row EXCEPT whichever one
-- row V5 finds legitimately changed prev_cycle_id (found dynamically, not
-- hardcoded — this migration's author does not know which cycle_id that is
-- ahead of running it against real data).
with changed_prev as (
  select pre.user_id, pre.cycle_id
  from public._diag_wc_pre pre
  join public._diag_wc_post post using (user_id, cycle_id)
  where pre.prev_cycle_id is distinct from post.prev_cycle_id
)
select pre.user_id, pre.cycle_id, 'V3(2) MISMATCH' as check_name
from public._diag_wc_pre pre
join public._diag_wc_post post using (user_id, cycle_id)
where (pre.user_id, pre.cycle_id) not in (select user_id, cycle_id from changed_prev)
  and (
       pre.prev_cycle_id                  is distinct from post.prev_cycle_id
    or pre.meal_count_prev_cycle          is distinct from post.meal_count_prev_cycle
    or pre.kcal_prev_cycle                is distinct from post.kcal_prev_cycle
    or pre.protein_prev_cycle             is distinct from post.protein_prev_cycle
    or pre.carbs_prev_cycle               is distinct from post.carbs_prev_cycle
    or pre.fat_prev_cycle                 is distinct from post.fat_prev_cycle
    or pre.sat_fat_prev_cycle             is distinct from post.sat_fat_prev_cycle
    or pre.salt_prev_cycle                is distinct from post.salt_prev_cycle
    or pre.fibre_prev_cycle               is distinct from post.fibre_prev_cycle
    or pre.sugar_prev_cycle               is distinct from post.sugar_prev_cycle
    or pre.last_meal_before_sleep_at      is distinct from post.last_meal_before_sleep_at
    or pre.prev_nutrition_present         is distinct from post.prev_nutrition_present
    or pre.prev_cycle_contiguous          is distinct from post.prev_cycle_contiguous
    or pre.timing_estimated_prev_cycle    is distinct from post.timing_estimated_prev_cycle
  );
-- Expect ZERO rows.

-- V3(3). THE ONE NAMED EXCEPTION — resting_heart_rate on
-- (4dbf04ae-7b46-4511-8122-f17284c622d9, 1737676452), NULL -> 45, exactly.
select pre.resting_heart_rate as pre_rhr, post.resting_heart_rate as post_rhr
from public._diag_wc_pre pre
join public._diag_wc_post post using (user_id, cycle_id)
where pre.user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
  and pre.cycle_id = '1737676452';
-- Expect EXACTLY ONE row: pre_rhr IS NULL, post_rhr = 45.

-- V3(4). The two all-NULL frames (a8435663, no whoop_recoveries row, no
-- Health Connect data for that user) are COMPLETELY unchanged, including
-- resting_heart_rate — they must NOT pick up a stray value from anywhere.
select pre.user_id, pre.cycle_id, pre.resting_heart_rate as pre_rhr, post.resting_heart_rate as post_rhr
from public._diag_wc_pre pre
join public._diag_wc_post post using (user_id, cycle_id)
where pre.cycle_id in ('1617103907', '1685079064');
-- Expect 2 rows, pre_rhr and post_rhr both NULL on each. (Every other
-- column for these two rows is already covered by V3(1) since they are not
-- excluded from it.)


-- ── V4. NON-VACUITY ─────────────────────────────────────────────────────────
select
  (select count(*) from public._diag_wc_pre)  as pre_count,
  (select count(*) from public._diag_wc_post) as post_count;
-- Expect 231 / 231.

select 'pre_only' as side, pre.user_id, pre.cycle_id
from public._diag_wc_pre pre
left join public._diag_wc_post post using (user_id, cycle_id)
where post.user_id is null
union all
select 'post_only', post.user_id, post.cycle_id
from public._diag_wc_post post
left join public._diag_wc_pre pre using (user_id, cycle_id)
where pre.user_id is null;
-- Expect ZERO rows.


-- ── V5. THE PARTITION-WIDENING BOUNDARY FRAME ──────────────────────────────
-- Found dynamically (not hardcoded — nobody has confirmed which cycle_id
-- this is against real data yet). This is the same `changed_prev` set V3(2)
-- excludes; asserted here to be EXACTLY ONE row, not merely "some rows".
select pre.user_id, pre.cycle_id,
       pre.prev_cycle_id  as pre_prev_cycle_id,
       post.prev_cycle_id as post_prev_cycle_id
from public._diag_wc_pre pre
join public._diag_wc_post post using (user_id, cycle_id)
where pre.prev_cycle_id is distinct from post.prev_cycle_id;
-- Expect EXACTLY ONE row: pre_prev_cycle_id NULL (no predecessor under the
-- old 3-column partition — a different provenance than whatever preceded
-- it), post_prev_cycle_id NOT NULL (a real predecessor once partitioned by
-- user_id alone).


-- ── V6. NEW COLUMNS — live view, not a diff ────────────────────────────────

-- V6(a). is_stale is true for exactly the one known stale cycle.
select user_id, cycle_id, is_stale
from public.whoop_correlation
where is_stale = true;
-- Expect EXACTLY ONE row: cycle_id = '1663052944',
-- user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'.

select
  count(*) filter (where is_stale = true)  as stale_count,
  count(*) filter (where is_stale = false) as not_stale_count,
  count(*)                                 as total
from public.whoop_correlation;
-- Expect stale_count = 1, not_stale_count = total - 1 (i.e. is_stale is
-- never itself NULL — effective_end is null is well-defined for every row).

-- V6(b). Known-meal counts reachable and non-null on every *_same_cycle
-- column (count() never nulls, by construction).
select
  count(*) as total,
  count(sat_fat_known_meals_same_cycle) as sat_fat_known_present,
  count(salt_known_meals_same_cycle)    as salt_known_present,
  count(fibre_known_meals_same_cycle)   as fibre_known_present,
  count(sugar_known_meals_same_cycle)   as sugar_known_present
from public.whoop_correlation;
-- Expect all four *_known_present columns to equal total.

-- V6(c). hrv_method is 'rmssd' wherever hrv is non-null (production is
-- 100% rmssd today on both arms — this is a live tripwire for the day
-- that stops being true, not an expectation this migration invented).
select count(*) as hrv_present_but_not_rmssd
from public.whoop_correlation
where hrv is not null and hrv_method is distinct from 'rmssd';
-- Expect 0.


-- ── V7. RLS ──────────────────────────────────────────────────────────────
-- security_invoker survived the DROP + CREATE:
select relname, c.reloptions
from pg_class c
where c.relname = 'whoop_correlation' and c.relnamespace = 'public'::regnamespace;
-- Expect reloptions to include security_invoker=true (or cross-check via
-- `select definition from pg_views where viewname = 'whoop_correlation'`
-- and confirm `with (security_invoker = on)` appears in it, per the same
-- caveat noted in 20260831120000's verify file).

-- Second-account check, begin/rollback so nothing is left behind. a8435663
-- has exactly 50 rows in whoop_cycle_nutrition (confirmed,
-- 20260831120000's verify file, T8) and whoop_correlation is a 1:1 LEFT-
-- JOIN wrapper over it, so the same 50 is expected here.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.whoop_correlation;
-- Expect row_count = 50, distinct_users = 1.
rollback;


-- ── V8. CLEANUP — run yourself once satisfied ──────────────────────────────
-- drop table public._diag_wc_pre;
-- drop table public._diag_wc_post;
