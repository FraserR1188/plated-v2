-- ============================================================================
-- Verification — 20260901110000_whoop_correlation_sleep_join.sql
--
-- Run V0 BEFORE applying (a real dependency here means STOP, do not apply).
-- Run V1 BEFORE applying — it cannot be recreated after. Apply the
-- migration. Run V2-V8 after. V9 (cleanup) is commented out.
--
-- Unlike part one, this migration asserts TOTAL invariance — every column,
-- every row, byte-identical — because the measured position is that it
-- changes no production value today (see the migration's own header). V3
-- here is a single full-row diff with no exceptions, which is a stronger
-- and simpler claim than part one's split V3(1)/V3(2)/V3(5).
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
-- Exact current column names — this is what's live right now.
create table public._diag_wc2_pre as
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
  sleep_id, sleep_performance_percentage, sleep_efficiency_percentage,
  sleep_consistency_percentage, respiratory_rate, total_in_bed_time_milli,
  total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli,
  total_awake_time_milli, disturbance_count, sleep_was_nap,
  cycle_scored, recovery_scored, sleep_scored, nutrition_present,
  prev_nutrition_present, prev_cycle_contiguous, prev_cycle_gap,
  timing_estimated_same_cycle, timing_estimated_prev_cycle
from public.whoop_correlation;

select count(*) as pre_row_count from public._diag_wc2_pre;
-- Expect 231 (or whatever the live count is at the time you run this —
-- record it, V4 compares against it).


-- ── APPLY THE MIGRATION NOW ────────────────────────────────────────────────


-- ── V2. POST-SNAPSHOT — same column list, five renamed columns aliased
--       back to their old names purely so V3 compares like values under
--       like names. This is the only difference from V1's query. ──────────
create table public._diag_wc2_post as
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
  sleep_id, sleep_performance_percentage,
  sleep_efficiency_percentage_whoop      as sleep_efficiency_percentage,
  sleep_consistency_percentage, respiratory_rate,
  total_in_bed_time_milli_whoop          as total_in_bed_time_milli,
  total_slow_wave_sleep_time_milli_whoop as total_slow_wave_sleep_time_milli,
  total_rem_sleep_time_milli_whoop       as total_rem_sleep_time_milli,
  total_awake_time_milli_whoop           as total_awake_time_milli,
  disturbance_count, sleep_was_nap,
  cycle_scored, recovery_scored, sleep_scored, nutrition_present,
  prev_nutrition_present, prev_cycle_contiguous, prev_cycle_gap,
  timing_estimated_same_cycle, timing_estimated_prev_cycle
from public.whoop_correlation;

select count(*) as post_row_count from public._diag_wc2_post;


-- ── V3. FULL-ROW DIFF, EVERY COLUMN, NO EXCEPTIONS ─────────────────────────
-- The measured position is that this commit changes nothing today. Unlike
-- part one, there is no known legitimate change to carve out — this is a
-- single equality check across every non-key column.
select pre.user_id, pre.cycle_id, 'V3 MISMATCH' as check_name
from public._diag_wc2_pre pre
join public._diag_wc2_post post using (user_id, cycle_id)
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
  or pre.prev_nutrition_present         is distinct from post.prev_nutrition_present
  or pre.prev_cycle_contiguous          is distinct from post.prev_cycle_contiguous
  or pre.prev_cycle_gap                 is distinct from post.prev_cycle_gap
  or pre.timing_estimated_same_cycle    is distinct from post.timing_estimated_same_cycle
  or pre.timing_estimated_prev_cycle    is distinct from post.timing_estimated_prev_cycle
  );
-- Expect ZERO rows. Any row here means this commit moved a value it claims
-- not to — treat that as a stop-and-investigate result, not something to
-- explain away in a follow-up comment the way part one's header had to.


-- ── V4. NON-VACUITY ─────────────────────────────────────────────────────────
select
  (select count(*) from public._diag_wc2_pre)  as pre_count,
  (select count(*) from public._diag_wc2_post) as post_count;
-- Expect pre_count = post_count. A fan-out (V5's hazard reaching production)
-- would show here as post_count > pre_count — this is load-bearing, not a
-- formality.

select 'pre_only' as side, pre.user_id, pre.cycle_id
from public._diag_wc2_pre pre
left join public._diag_wc2_post post using (user_id, cycle_id)
where post.user_id is null
union all
select 'post_only', post.user_id, post.cycle_id
from public._diag_wc2_post post
left join public._diag_wc2_pre pre using (user_id, cycle_id)
where pre.user_id is null;
-- Expect ZERO rows.


-- ── V5. THE FAN-OUT HARD GATE — run against the live table, not a diff ────
-- Nothing in the schema stops two whoop_sleeps rows from sharing
-- (user_id, start): the primary key is (user_id, id), and the only other
-- index on whoop_sleeps is (user_id, start), not unique. Proven capable of
-- fanning out this view's join in a throwaway container (this migration's
-- own fixture F4) — this is the production check for whether it has.
select user_id, start, count(*) as n, array_agg(id) as sleep_ids
from public.whoop_sleeps
group by user_id, start
having count(*) > 1;
-- Expect ZERO rows. A non-zero result means WHOOP reissued a sleep under a
-- new id at the same start (or some other data-quality event produced a
-- duplicate) — that is a whoop-sync investigation, not something this view
-- should silently paper over with a guessed tiebreak.


-- ── V6. THE NAP GATE — run against the live table ──────────────────────────
select count(*) as nap_count from public.whoop_sleeps where nap = true;
-- Expect 0, matching the measured position this migration's header records.
-- A non-zero result does not by itself break anything — it only matters if
-- one of those naps' start also matches a cycle_start (a coincidental
-- collision), which is a separate, narrower check:
select s.user_id, s.id as sleep_id, s.start, c.id as cycle_id
from public.whoop_sleeps s
join public.whoop_cycles c on c.user_id = s.user_id and c.start = s.start
where s.nap = true;
-- Expect ZERO rows regardless of whether nap_count above is 0.


-- ── V7. THE THREE NAMED ZERO-PAYOFF FRAMES ─────────────────────────────────
select user_id, cycle_id, sleep_id, total_slow_wave_sleep_time_milli_whoop
from public.whoop_correlation
where (user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393' and cycle_id in ('1617103907', '1685079064'))
   or (user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9' and cycle_id = '1737676452');
-- Expect 3 rows, sleep_id and total_slow_wave_sleep_time_milli_whoop NULL
-- on all three — matching this migration's own header: the new join finds
-- nothing new for any of them either.

-- NOTE ON A DISCREPANCY IN THIS MIGRATION'S OWN IMPLEMENTATION BRIEF, found
-- while writing this file, not resolved: the brief's own V7 spec named
-- cycle 1737676452 UNDER a8435663 as an example of a frame that reads a
-- POPULATED sleep block (sleep_id = 9bb38891-282d-4c02-885f-33367606897f,
-- total_slow_wave_sleep_time_milli_whoop = 6821370), offered as "the pair
-- that proves the new join reaches the same rows the old one did." That
-- directly contradicts the SAME brief's own "THE MEASURED POSITION"
-- section, which states cycle 1737676452 belongs to user 4dbf04ae and has
-- NO whoop_sleeps row at an exact start match under either join. Both
-- cannot be true of one cycle_id. Not silently resolved either way here —
-- this file has no production access to check which claim is right, and
-- hardcoding a specific sleep_id/value that might be the wrong one would
-- repeat exactly the mistake part one's own header already had to correct
-- once. Flagged in the handback instead. The query below finds a genuine,
-- already-working example for manual spot-checking — no hardcoded expected
-- values, since none can be verified from here:
select user_id, cycle_id, sleep_id, total_slow_wave_sleep_time_milli_whoop
from public.whoop_correlation
where sleep_id is not null
order by cycle_start desc
limit 5;
-- Eyeball this against the same (user_id, cycle_id) pair's row in
-- _diag_wc2_pre — sleep_id and every _whoop column should match exactly
-- (V3 already proves this for every row; this is a human-readable sample).


-- ── V8. RLS ──────────────────────────────────────────────────────────────
select relname, c.reloptions
from pg_class c
where c.relname = 'whoop_correlation' and c.relnamespace = 'public'::regnamespace;
-- Expect reloptions to include security_invoker=true (or cross-check via
-- `select definition from pg_views where viewname = 'whoop_correlation'`
-- and confirm `with (security_invoker = on)` appears in it).

begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.whoop_correlation;
-- Expect row_count = 50, distinct_users = 1 (same as part one's V7 — this
-- migration doesn't change row count or ownership).
rollback;


-- ── V9. CLEANUP — run yourself once satisfied ──────────────────────────────
-- drop table public._diag_wc2_pre;
-- drop table public._diag_wc2_post;
