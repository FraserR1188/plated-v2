-- ============================================================================
-- Verification — 20260901120000_biometric_periods_resolved_sleep_pointer.sql
--                 20260901130000_whoop_correlation_hc_sleep_widening.sql
-- Commit three, part two-B
--
-- Run V0 BEFORE applying (a real dependency here means STOP, do not apply).
-- Run V1 BEFORE applying — it cannot be recreated after. Apply BOTH
-- migrations. Run V2-V9 after. V10 (cleanup) is commented out.
--
-- There is no value diff for the new _hc columns — they don't exist before
-- this commit. V3 asserts every PRE-EXISTING column is unchanged; V5-V8
-- characterize the new columns against the live view directly.
-- ============================================================================

-- ── V0. PRE-FLIGHT — nothing depends on whoop_correlation ─────────────────
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
-- Expect ZERO rows. If this returns anything, STOP.


-- ── V1. PRE-SNAPSHOT — run BEFORE the push ─────────────────────────────────
-- Every pre-existing column, current names.
create table public._diag_wc3_pre as
select
  user_id, cycle_id, cycle_start, cycle_end, is_in_progress, timezone_offset,
  cycle_local_date, is_stale, strain, kilojoule, average_heart_rate,
  meal_count_same_cycle, kcal_same_cycle, protein_same_cycle, carbs_same_cycle,
  fat_same_cycle, sat_fat_same_cycle, salt_same_cycle, fibre_same_cycle, sugar_same_cycle,
  sat_fat_known_meals_same_cycle, salt_known_meals_same_cycle,
  fibre_known_meals_same_cycle, sugar_known_meals_same_cycle,
  prev_cycle_id, meal_count_prev_cycle, kcal_prev_cycle, protein_prev_cycle,
  carbs_prev_cycle, fat_prev_cycle, sat_fat_prev_cycle, salt_prev_cycle,
  fibre_prev_cycle, sugar_prev_cycle,
  sat_fat_known_meals_prev_cycle, salt_known_meals_prev_cycle,
  fibre_known_meals_prev_cycle, sugar_known_meals_prev_cycle,
  last_meal_before_sleep_at,
  recovery_score, resting_heart_rate, spo2_percentage, skin_temp_celsius,
  user_calibrating, hrv, hrv_method, hrv_unit,
  sleep_id, sleep_performance_percentage, sleep_efficiency_percentage_whoop,
  sleep_consistency_percentage, respiratory_rate,
  total_in_bed_time_milli_whoop, total_slow_wave_sleep_time_milli_whoop,
  total_rem_sleep_time_milli_whoop, total_awake_time_milli_whoop,
  disturbance_count, sleep_was_nap,
  cycle_scored, recovery_scored, sleep_scored, nutrition_present,
  prev_nutrition_present, prev_cycle_contiguous, prev_cycle_gap,
  timing_estimated_same_cycle, timing_estimated_prev_cycle
from public.whoop_correlation;

select count(*) as pre_row_count from public._diag_wc3_pre;


-- ── APPLY BOTH MIGRATIONS NOW ───────────────────────────────────────────────


-- ── V2. POST-SNAPSHOT — same pre-existing column list, sleep_scored_whoop
--       aliased back to sleep_scored so V3 compares like names. ───────────
create table public._diag_wc3_post as
select
  user_id, cycle_id, cycle_start, cycle_end, is_in_progress, timezone_offset,
  cycle_local_date, is_stale, strain, kilojoule, average_heart_rate,
  meal_count_same_cycle, kcal_same_cycle, protein_same_cycle, carbs_same_cycle,
  fat_same_cycle, sat_fat_same_cycle, salt_same_cycle, fibre_same_cycle, sugar_same_cycle,
  sat_fat_known_meals_same_cycle, salt_known_meals_same_cycle,
  fibre_known_meals_same_cycle, sugar_known_meals_same_cycle,
  prev_cycle_id, meal_count_prev_cycle, kcal_prev_cycle, protein_prev_cycle,
  carbs_prev_cycle, fat_prev_cycle, sat_fat_prev_cycle, salt_prev_cycle,
  fibre_prev_cycle, sugar_prev_cycle,
  sat_fat_known_meals_prev_cycle, salt_known_meals_prev_cycle,
  fibre_known_meals_prev_cycle, sugar_known_meals_prev_cycle,
  last_meal_before_sleep_at,
  recovery_score, resting_heart_rate, spo2_percentage, skin_temp_celsius,
  user_calibrating, hrv, hrv_method, hrv_unit,
  sleep_id, sleep_performance_percentage, sleep_efficiency_percentage_whoop,
  sleep_consistency_percentage, respiratory_rate,
  total_in_bed_time_milli_whoop, total_slow_wave_sleep_time_milli_whoop,
  total_rem_sleep_time_milli_whoop, total_awake_time_milli_whoop,
  disturbance_count, sleep_was_nap,
  cycle_scored, recovery_scored,
  sleep_scored_whoop as sleep_scored,
  nutrition_present, prev_nutrition_present, prev_cycle_contiguous, prev_cycle_gap,
  timing_estimated_same_cycle, timing_estimated_prev_cycle
from public.whoop_correlation;

select count(*) as post_row_count from public._diag_wc3_post;


-- ── V3. FULL-ROW DIFF ON EVERY PRE-EXISTING COLUMN, NO EXCEPTIONS ─────────
-- This commit only adds columns and renames one (aliased back above). It
-- must change nothing that already existed.
select pre.user_id, pre.cycle_id, 'V3 MISMATCH' as check_name
from public._diag_wc3_pre pre
join public._diag_wc3_post post using (user_id, cycle_id)
where (
     pre.cycle_start                    is distinct from post.cycle_start
  or pre.cycle_end                      is distinct from post.cycle_end
  or pre.is_in_progress                 is distinct from post.is_in_progress
  or pre.timezone_offset                is distinct from post.timezone_offset
  or pre.cycle_local_date               is distinct from post.cycle_local_date
  or pre.is_stale                       is distinct from post.is_stale
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
  or pre.sat_fat_known_meals_same_cycle is distinct from post.sat_fat_known_meals_same_cycle
  or pre.salt_known_meals_same_cycle    is distinct from post.salt_known_meals_same_cycle
  or pre.fibre_known_meals_same_cycle   is distinct from post.fibre_known_meals_same_cycle
  or pre.sugar_known_meals_same_cycle   is distinct from post.sugar_known_meals_same_cycle
  or pre.prev_cycle_id                  is distinct from post.prev_cycle_id
  or pre.meal_count_prev_cycle          is distinct from post.meal_count_prev_cycle
  or pre.kcal_prev_cycle                is distinct from post.kcal_prev_cycle
  or pre.protein_prev_cycle             is distinct from post.protein_prev_cycle
  or pre.carbs_prev_cycle               is distinct from post.carbs_prev_cycle
  or pre.fat_prev_cycle                 is distinct from post.fat_prev_cycle
  or pre.sat_fat_prev_cycle             is distinct from post.sat_fat_prev_cycle
  or pre.salt_prev_cycle                is distinct from post.salt_prev_cycle
  or pre.fibre_prev_cycle               is distinct from post.fibre_prev_cycle
  or pre.sugar_prev_cycle               is distinct from post.sugar_prev_cycle
  or pre.sat_fat_known_meals_prev_cycle is distinct from post.sat_fat_known_meals_prev_cycle
  or pre.salt_known_meals_prev_cycle    is distinct from post.salt_known_meals_prev_cycle
  or pre.fibre_known_meals_prev_cycle   is distinct from post.fibre_known_meals_prev_cycle
  or pre.sugar_known_meals_prev_cycle   is distinct from post.sugar_known_meals_prev_cycle
  or pre.last_meal_before_sleep_at      is distinct from post.last_meal_before_sleep_at
  or pre.recovery_score                 is distinct from post.recovery_score
  or pre.resting_heart_rate             is distinct from post.resting_heart_rate
  or pre.spo2_percentage                is distinct from post.spo2_percentage
  or pre.skin_temp_celsius              is distinct from post.skin_temp_celsius
  or pre.user_calibrating               is distinct from post.user_calibrating
  or pre.hrv                            is distinct from post.hrv
  or pre.hrv_method                     is distinct from post.hrv_method
  or pre.hrv_unit                       is distinct from post.hrv_unit
  or pre.sleep_id                       is distinct from post.sleep_id
  or pre.sleep_performance_percentage   is distinct from post.sleep_performance_percentage
  or pre.sleep_efficiency_percentage_whoop is distinct from post.sleep_efficiency_percentage_whoop
  or pre.sleep_consistency_percentage   is distinct from post.sleep_consistency_percentage
  or pre.respiratory_rate               is distinct from post.respiratory_rate
  or pre.total_in_bed_time_milli_whoop  is distinct from post.total_in_bed_time_milli_whoop
  or pre.total_slow_wave_sleep_time_milli_whoop is distinct from post.total_slow_wave_sleep_time_milli_whoop
  or pre.total_rem_sleep_time_milli_whoop is distinct from post.total_rem_sleep_time_milli_whoop
  or pre.total_awake_time_milli_whoop   is distinct from post.total_awake_time_milli_whoop
  or pre.disturbance_count              is distinct from post.disturbance_count
  or pre.sleep_was_nap                  is distinct from post.sleep_was_nap
  or pre.cycle_scored                   is distinct from post.cycle_scored
  or pre.recovery_scored                is distinct from post.recovery_scored
  or pre.sleep_scored                   is distinct from post.sleep_scored
  or pre.nutrition_present              is distinct from post.nutrition_present
  or pre.prev_nutrition_present         is distinct from post.prev_nutrition_present
  or pre.prev_cycle_contiguous          is distinct from post.prev_cycle_contiguous
  or pre.prev_cycle_gap                 is distinct from post.prev_cycle_gap
  or pre.timing_estimated_same_cycle    is distinct from post.timing_estimated_same_cycle
  or pre.timing_estimated_prev_cycle    is distinct from post.timing_estimated_prev_cycle
  );
-- Expect ZERO rows.


-- ── V4. NON-VACUITY ─────────────────────────────────────────────────────────
select
  (select count(*) from public._diag_wc3_pre)  as pre_count,
  (select count(*) from public._diag_wc3_post) as post_count;
-- Expect pre_count = post_count. A fan-out from the new hc_sleeps join
-- would appear here as post_count > pre_count. Load-bearing, not a
-- formality.

select 'pre_only' as side, pre.user_id, pre.cycle_id
from public._diag_wc3_pre pre
left join public._diag_wc3_post post using (user_id, cycle_id)
where post.user_id is null
union all
select 'post_only', post.user_id, post.cycle_id
from public._diag_wc3_post post
left join public._diag_wc3_pre pre using (user_id, cycle_id)
where pre.user_id is null;
-- Expect ZERO rows.


-- ── V5. _hc POPULATION ──────────────────────────────────────────────────────
select
  count(*) as total,
  count(*) filter (where sleep_data_source = 'health_connect') as hc_frames,
  count(total_deep_ms_hc)   as deep_hc_populated,
  count(total_rem_ms_hc)    as rem_hc_populated,
  count(total_sleep_ms_hc)  as sleep_hc_populated,
  count(total_in_bed_ms_hc) as in_bed_hc_populated
from public.whoop_correlation;
-- Expect deep_hc_populated = rem_hc_populated = sleep_hc_populated =
-- in_bed_hc_populated = hc_frames: every _hc column should populate on
-- exactly the frames where Health Connect won the sleep domain AND a
-- matching session exists (expected to be all of them, per the migration
-- header's reasoning -- but that reasoning is not a substitute for this
-- number). If deep_hc_populated is 0 while hc_frames is non-zero, the
-- pointer join is not matching and this commit does nothing -- the primary
-- failure mode to watch for.
-- MEASURED on the actual push: hc_frames = 173 of 232 total frames.
-- Per-column populated counts (deep/rem/sleep/in_bed) not yet
-- recorded -- fill from a V5 run.


-- ── V6. NEVER-POOLED TRIPWIRE ────────────────────────────────────────────
-- total_deep_ms_hc and total_slow_wave_sleep_time_milli_whoop must never be
-- equal when both are non-null -- equality would be a coincidence today and
-- a copy-paste bug tomorrow (proven to fire against exactly that bug in a
-- throwaway container, this commit's own F3-derived sabotage).
select user_id, cycle_id, total_deep_ms_hc, total_slow_wave_sleep_time_milli_whoop
from public.whoop_correlation
where total_deep_ms_hc is not null
  and total_slow_wave_sleep_time_milli_whoop is not null
  and total_deep_ms_hc = total_slow_wave_sleep_time_milli_whoop;
-- Expect ZERO rows.


-- ── V7. FAN-OUT GATE ON THE JOIN KEY ─────────────────────────────────────
select user_id, origin_package, provider_record_id, count(*)
from public.biometric_sleep_sessions
group by user_id, origin_package, provider_record_id
having count(*) > 1;
-- Expect ZERO -- this is the primary key. A non-zero result means the key
-- this commit assumed is not actually unique, and the pointer-bridge join's
-- fan-out immunity no longer holds.


-- ── V8. sleep_scored_whoop SOLVES WHAT IT WAS RENAMED FOR ──────────────────
select count(*) as violations
from public.whoop_correlation
where sleep_data_source = 'health_connect'
  and sleep_scored_whoop is not null;
-- Expect 0 -- sleep_scored_whoop must be NULL on every Health-Connect-won
-- frame (it reads resolved.sleep_score_state, which
-- biometric_periods_resolved's synthetic arm hardcodes null; this simply
-- confirms the rename didn't change that).

select count(*) as whoop_scored_present
from public.whoop_correlation
where sleep_data_source = 'whoop' and sleep_scored_whoop is not null;
-- Expect > 0 on any account with scored WHOOP sleep data -- confirms the
-- column still does its job on WHOOP-won frames, not just NULL everywhere.


-- ── V9. RLS — BOTH VIEWS, PROVEN FOR TWO DIFFERENT REASONS ─────────────────
-- security_invoker survived on both:
select relname, c.reloptions
from pg_class c
where c.relname in ('whoop_correlation', 'biometric_periods_resolved')
  and c.relnamespace = 'public'::regnamespace
order by relname;
-- Expect reloptions to include security_invoker=true on BOTH rows.

-- Second-account check via whoop_correlation (proves the RLS chain end to
-- end, not just the reloptions flag):
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.whoop_correlation;
-- Expect row_count = 50, distinct_users = 1.
rollback;

-- Second-account check via biometric_periods_resolved directly -- proven in
-- a throwaway container that dropping ITS security_invoker does NOT leak
-- through whoop_correlation's own join (the join is driven by an already
-- RLS-filtered row and equality-matches on user_id, which re-narrows the
-- result regardless), but biometric_periods_resolved carries its own grant
-- select to authenticated and IS directly queryable -- so its own RLS
-- posture needs its own direct check, not an inference from
-- whoop_correlation's behaviour:
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.biometric_periods_resolved;
-- Expect distinct_users = 1 (only a8435663's own rows).
rollback;


-- ── V10. CLEANUP — run yourself once satisfied ─────────────────────────────
-- drop table public._diag_wc3_pre;
-- drop table public._diag_wc3_post;
