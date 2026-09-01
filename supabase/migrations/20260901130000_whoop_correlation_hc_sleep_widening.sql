-- ============================================================================
-- 20260901130000_whoop_correlation_hc_sleep_widening.sql
-- Commit three, part two-B (2 of 2) — Health Connect sleep widening
--
-- Joins biometric_sleep_sessions onto whoop_correlation via the previous
-- migration's sleep_source_record_id pointer, on the table's actual primary
-- key (user_id, origin_package, provider_record_id) — a join that cannot
-- fan out structurally, not merely by luck of today's data (see part two-B
-- (1 of 2)'s header for the full reasoning and the throwaway-container
-- proof). Adds six `_hc` stage-duration columns, renames sleep_scored to
-- sleep_scored_whoop, and adds sleep_data_source / sleep_origin_package
-- passthroughs.
--
-- ── THE MEASURED PAYOFF ──────────────────────────────────────────────────
-- Production facts measured before writing this migration: 181 Health
-- Connect sleep sessions (all origin_package = 'com.whoop.android'), every
-- stage column fully populated (181/181 on total_in_bed_ms/total_awake_ms/
-- total_light_ms/total_deep_ms/total_rem_ms/total_sleep_ms), sleep_
-- efficiency_percentage null on all 181 (the ingest mapper hardcodes it),
-- is_nap false on all 181 (the mapper omits the field; the column default
-- applies — "unknown," not "confirmed not a nap"). HC wins the sleep domain
-- on 172 of today's 231 frames. Zero frames contain more than one qualifying
-- HC session under midpoint containment.
--
-- Reasoned from those facts, not re-measured here: the pointer-bridge join
-- should populate the six `_hc` columns on exactly those 172 frames and
-- leave them NULL on the other 59 (the winning candidate a frame's
-- sleep_winner already selected is, by construction, a real
-- biometric_sleep_sessions row, so the pointer join is expected to match
-- every time a winner exists). This is a PREDICTION from given facts, not a
-- number this migration measured directly — this migration's own verify
-- file, V5, is the check that confirms the actual count against real data
-- after the push. Record the actual result there. Do not treat 172 as
-- confirmed until V5 says so — this project has gotten a number wrong from
-- reasoning-without-running three times already in this series.
--
-- ── WHY THE POINTER BRIDGE, NOT A DIRECT CONTAINMENT JOIN ──────────────────
-- See part two-B (1 of 2)'s header in full. Summary: a fresh containment
-- join in this view would re-derive ranking logic that already lives in
-- biometric_periods_resolved, with its own chance to disagree, and has no
-- structural bound on how many sessions can fall inside one frame — it can
-- fan out. A join on the pointer targets biometric_sleep_sessions' actual
-- primary key and cannot return more than one row. Proven in this
-- migration's verify file (F4: a constructed two-session-in-one-frame
-- fixture stays at exactly one output row under this join; sabotage 1
-- swaps in a naive containment join against the same fixture and confirms
-- it fans out to two).
--
-- ── NEVER POOL ───────────────────────────────────────────────────────────
-- total_deep_ms_hc and total_slow_wave_sleep_time_milli_whoop are related,
-- not identical constructs — documented three separate times already
-- (biometric_sleep_sessions' own table comment, its column comment, and the
-- Health Connect ingest mapper's comment). They must never share a column,
-- be averaged, or be coalesced into one another. This migration's verify
-- file, V6, is a standing tripwire against exactly that mistake — proven to
-- fire against a deliberately sabotaged view that sources
-- total_slow_wave_sleep_time_milli_whoop from hs.total_deep_ms instead of
-- sl.total_slow_wave_sleep_time_milli.
--
-- total_sleep_ms_hc has no WHOOP counterpart and is NOT derived as
-- light + slow-wave + REM from whoop_sleeps — WHOOP never reports that sum
-- itself, and computing it here would be inventing a number and presenting
-- it as if WHOOP had reported it. Left HC-only, deliberately, same
-- reasoning as biometric_workout_sessions declining to synthesize a
-- strain-equivalent from heart-rate data.
--
-- ── NOT SURFACED, DELIBERATELY ──────────────────────────────────────────
-- sleep_efficiency_percentage_hc: null on all 181 rows in production; the
-- Health Connect ingest mapper (supabase/functions/health-connect-ingest/
-- mapping.ts:230-232) writes null unconditionally — "Health Connect
-- computes no equivalent to WHOOP's sleep performance/efficiency score."
-- Nothing to expose. Add it the day that mapper actually populates it, not
-- before.
--
-- is_nap_hc / any Health Connect nap column: every biometric_sleep_sessions
-- row from Health Connect stores is_nap = false, but only because the
-- ingest mapper OMITS the field entirely and the column's own
-- `not null default false` supplies the value — confirmed still true.
-- "false" here means "Health Connect carries no nap signal," not
-- "confirmed not a nap." Surfacing it in this view would assert a fact
-- Health Connect never reported. This is a NULL-not-zero defect in
-- biometric_sleep_sessions itself (the same class of bug this schema has
-- fixed elsewhere with a bare, undefaulted column) — logged as a follow-up
-- to fix AT THE SOURCE TABLE, not solved or worked around here.
--
-- ── cycle_id IS NOT UNIQUE ACROSS USERS ─────────────────────────────────
-- One physical device syncing into two accounts (a shared strap, a test
-- account and a real one) produces the SAME cycle_id under both, with
-- different data. (user_id, cycle_id) is the key, never cycle_id alone.
-- This has caused confusion twice already in this series (a8435663 and
-- 4dbf04ae both surface in verify files and fixtures throughout this
-- schema) — restated here explicitly rather than left to be rediscovered a
-- third time.
--
-- ── SECURITY_INVOKER ON BOTH VIEWS — NOT REDUNDANT, DIFFERENT REASONS ────
-- Proven, not assumed, in a throwaway container (this migration's verify
-- file, V9): dropping security_invoker on biometric_periods_resolved alone
-- does NOT leak through whoop_correlation's own join — whoop_correlation's
-- join is driven by an already-RLS-filtered row from whoop_cycle_nutrition
-- and equality-joins on user_id, which re-narrows the result regardless of
-- the upstream view's own RLS posture. But biometric_periods_resolved
-- carries its OWN grant select to authenticated and IS directly queryable
-- by a client — dropping its security_invoker leaks there directly, proven
-- the same way. So: both views need security_invoker = on, for two
-- different reasons, not one redundant one. Re-verified by reading the
-- CREATE VIEW statement below immediately before writing this line.
--
-- ── DROP + CREATE, NOT CREATE OR REPLACE ────────────────────────────────
-- The `_hc` columns are inserted immediately after their `_whoop`
-- counterparts, in the middle of the existing column list, so the pairing
-- is visible in a `select *` — not appended at the end. CREATE OR REPLACE
-- VIEW would refuse this. V0 below re-runs the pg_depend dependency check;
-- STOP if it returns any row.
--
-- ── STRUCTURE: ONE CTE PER REAL-TABLE READ ──────────────────────────────
-- nutrition / resolved / sleeps / hc_sleeps. hc_sleeps is the new one, for
-- biometric_sleep_sessions.
-- ============================================================================

drop view public.whoop_correlation;

create view public.whoop_correlation
with (security_invoker = on) as
with nutrition as (
  select
    user_id, cycle_id, cycle_start, cycle_end, effective_end, is_in_progress,
    score_state, strain, kilojoule, average_heart_rate, timezone_offset,
    meal_count, kcal, protein, carbs, fat, sat_fat, salt, fibre, sugar,
    has_estimated_times, last_meal_at,
    sat_fat_known_meals, salt_known_meals, fibre_known_meals, sugar_known_meals
  from public.whoop_cycle_nutrition
),
resolved as (
  select
    user_id, source_period_id,
    recovery_score, recovery_score_state,
    spo2_percentage, skin_temp_celsius, user_calibrating,
    resting_heart_rate,
    hrv, hrv_method, hrv_unit,
    sleep_performance, sleep_score_state,
    sleep_ingest_transport, sleep_origin_package, sleep_source_record_id
  from public.biometric_periods_resolved
),
sleeps as (
  select
    user_id, id, start,
    sleep_efficiency_percentage, sleep_consistency_percentage,
    respiratory_rate, total_in_bed_time_milli,
    total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli,
    total_awake_time_milli, disturbance_count, nap
  from public.whoop_sleeps
),
hc_sleeps as (
  -- sleep_efficiency_percentage and is_nap are deliberately NOT read here —
  -- see header, NOT SURFACED.
  select
    user_id, origin_package, provider_record_id,
    total_in_bed_ms, total_awake_ms, total_light_ms,
    total_deep_ms, total_rem_ms, total_sleep_ms
  from public.biometric_sleep_sessions
),
lagged as (
  select
    n.*,
    lag(n.cycle_id)              over w as prev_cycle_id,
    lag(n.cycle_start)           over w as prev_cycle_start,
    lag(n.cycle_end)             over w as prev_cycle_end,
    lag(n.meal_count)            over w as prev_meal_count,
    lag(n.kcal)                  over w as prev_kcal,
    lag(n.protein)               over w as prev_protein,
    lag(n.carbs)                 over w as prev_carbs,
    lag(n.fat)                   over w as prev_fat,
    lag(n.sat_fat)               over w as prev_sat_fat,
    lag(n.salt)                  over w as prev_salt,
    lag(n.fibre)                 over w as prev_fibre,
    lag(n.sugar)                 over w as prev_sugar,
    lag(n.last_meal_at)          over w as prev_last_meal_at,
    lag(n.has_estimated_times)   over w as prev_has_estimated_times,
    lag(n.sat_fat_known_meals)   over w as prev_sat_fat_known_meals,
    lag(n.salt_known_meals)      over w as prev_salt_known_meals,
    lag(n.fibre_known_meals)     over w as prev_fibre_known_meals,
    lag(n.sugar_known_meals)     over w as prev_sugar_known_meals
  from nutrition n
  window w as (partition by n.user_id order by n.cycle_start)
)
select
  l.user_id,
  l.cycle_id,
  l.cycle_start,
  l.cycle_end,
  l.is_in_progress,
  l.timezone_offset,
  (l.cycle_start + coalesce(l.timezone_offset, '+00:00')::interval)::date
    as cycle_local_date,

  (l.effective_end is null) as is_stale,

  -- ── SAME CYCLE: nutrition(N) fuels strain(N) ──────────────
  l.strain,
  l.kilojoule,
  l.average_heart_rate,
  l.meal_count      as meal_count_same_cycle,
  l.kcal            as kcal_same_cycle,
  l.protein         as protein_same_cycle,
  l.carbs           as carbs_same_cycle,
  l.fat             as fat_same_cycle,
  l.sat_fat         as sat_fat_same_cycle,
  l.salt            as salt_same_cycle,
  l.fibre           as fibre_same_cycle,
  l.sugar           as sugar_same_cycle,
  l.sat_fat_known_meals as sat_fat_known_meals_same_cycle,
  l.salt_known_meals    as salt_known_meals_same_cycle,
  l.fibre_known_meals   as fibre_known_meals_same_cycle,
  l.sugar_known_meals   as sugar_known_meals_same_cycle,

  -- ── LAGGED: nutrition(N-1) -> recovery(N), sleep(N) ───────
  l.prev_cycle_id,
  l.prev_meal_count as meal_count_prev_cycle,
  l.prev_kcal       as kcal_prev_cycle,
  l.prev_protein    as protein_prev_cycle,
  l.prev_carbs      as carbs_prev_cycle,
  l.prev_fat        as fat_prev_cycle,
  l.prev_sat_fat    as sat_fat_prev_cycle,
  l.prev_salt       as salt_prev_cycle,
  l.prev_fibre      as fibre_prev_cycle,
  l.prev_sugar      as sugar_prev_cycle,
  l.prev_sat_fat_known_meals as sat_fat_known_meals_prev_cycle,
  l.prev_salt_known_meals    as salt_known_meals_prev_cycle,
  l.prev_fibre_known_meals   as fibre_known_meals_prev_cycle,
  l.prev_sugar_known_meals   as sugar_known_meals_prev_cycle,
  l.prev_last_meal_at as last_meal_before_sleep_at,

  -- ── RECOVERY: resolved cross-provider (unchanged) ──
  rv.recovery_score,
  rv.resting_heart_rate,
  rv.spo2_percentage,
  rv.skin_temp_celsius,
  rv.user_calibrating,

  rv.hrv,
  rv.hrv_method,
  rv.hrv_unit,

  -- ── SLEEP: _whoop and _hc columns paired immediately, never pooled.
  --    sleep_id stays WHOOP-only (unaffected by which arm won the domain —
  --    see this migration's verify file, F3, for the proof that these two
  --    blocks are independently sourced and never cross-contaminate). ──
  sl.id                                     as sleep_id,
  rv.sleep_ingest_transport                 as sleep_data_source,
  rv.sleep_origin_package                   as sleep_origin_package,
  rv.sleep_performance                      as sleep_performance_percentage,
  sl.sleep_efficiency_percentage            as sleep_efficiency_percentage_whoop,
  -- sleep_efficiency_percentage_hc: not surfaced, see header.
  sl.sleep_consistency_percentage,
  sl.respiratory_rate,
  sl.total_in_bed_time_milli                as total_in_bed_time_milli_whoop,
  hs.total_in_bed_ms                        as total_in_bed_ms_hc,
  sl.total_slow_wave_sleep_time_milli       as total_slow_wave_sleep_time_milli_whoop,
  hs.total_deep_ms                          as total_deep_ms_hc,
  hs.total_light_ms                         as total_light_ms_hc,
  sl.total_rem_sleep_time_milli             as total_rem_sleep_time_milli_whoop,
  hs.total_rem_ms                           as total_rem_ms_hc,
  sl.total_awake_time_milli                 as total_awake_time_milli_whoop,
  hs.total_awake_ms                         as total_awake_ms_hc,
  hs.total_sleep_ms                         as total_sleep_ms_hc,
  sl.disturbance_count,
  sl.nap                                    as sleep_was_nap,
  -- is_nap_hc: not surfaced, see header.

  -- ── TRUST FLAGS. Filter on these before plotting anything. ──
  (l.score_state = 'SCORED')                          as cycle_scored,
  (rv.recovery_score_state = 'SCORED')                as recovery_scored,
  (rv.sleep_score_state = 'SCORED')                   as sleep_scored_whoop,
  (l.meal_count > 0)                                  as nutrition_present,
  (l.prev_cycle_id is not null
     and coalesce(l.prev_meal_count, 0) > 0)          as prev_nutrition_present,
  (l.prev_cycle_end is not null
     and l.cycle_start - l.prev_cycle_end < interval '2 hours')
                                                      as prev_cycle_contiguous,
  (l.cycle_start - l.prev_cycle_end)                  as prev_cycle_gap,
  l.has_estimated_times                               as timing_estimated_same_cycle,
  coalesce(l.prev_has_estimated_times, false)         as timing_estimated_prev_cycle

from lagged l
left join resolved  rv on rv.user_id = l.user_id and rv.source_period_id = l.cycle_id
left join sleeps    sl on sl.user_id = l.user_id and sl.start = l.cycle_start
left join hc_sleeps hs on hs.user_id            = rv.user_id
                       and hs.origin_package     = rv.sleep_origin_package
                       and hs.provider_record_id = rv.sleep_source_record_id;

comment on view public.whoop_correlation is
  'One row per cycle, keyed (user_id, cycle_id) -- cycle_id is NOT unique across users (one device syncing into two accounts produces the same id under both). *_prev_cycle nutrition pairs with recovery_*/hrv/sleep_* (what you ate BEFORE the night). *_same_cycle nutrition pairs with strain (what fuelled the day). Do not cross them. recovery_score/resting_heart_rate/hrv/spo2_percentage/skin_temp_celsius/user_calibrating/sleep_performance_percentage/recovery_scored are resolved cross-provider via biometric_periods_resolved. sleep_data_source (WHOOP-arm resolution: rv.sleep_ingest_transport) and sleep_origin_package tell you which provider won the sleep domain for this frame. sleep_id/sleep_was_nap/respiratory_rate/disturbance_count/sleep_consistency_percentage and every `_whoop`-suffixed column are reached by an EXACT match on whoop_sleeps.start = cycle_start, independent of which arm won the sleep domain -- see F3 in this migration''s verify file for proof these never cross-contaminate with the `_hc` columns. Every `_hc`-suffixed column is reached via biometric_periods_resolved.sleep_source_record_id, a pointer join onto biometric_sleep_sessions'' own primary key (user_id, origin_package, provider_record_id) that cannot fan out. total_deep_ms_hc and total_slow_wave_sleep_time_milli_whoop are related, NOT identical constructs -- never pool, average, or coalesce them (see 20260901130000''s header). total_sleep_ms_hc has no WHOOP counterpart and is not derived. sleep_efficiency_percentage_hc and any Health Connect nap signal are deliberately not surfaced -- see 20260901130000''s header. sleep_scored_whoop (renamed from sleep_scored) is structurally WHOOP-only and reads NULL on every Health-Connect-won frame -- read sleep_data_source alongside it, an unqualified NULL there means "WHOOP has no opinion," not "unscored." hrv is NOT guaranteed RMSSD. is_stale (effective_end is null) is NOT the same as is_current. prev_cycle_contiguous is advisory; prev_cycle_gap exposes the raw interval. *_known_meals columns are commit 2.5''s known-contributor counts, no completeness threshold imposed. Filter on cycle_scored / recovery_scored / sleep_scored_whoop / prev_nutrition_present / prev_cycle_contiguous (or prev_cycle_gap) before drawing any conclusion, and exclude is_in_progress = true and is_stale = true. cycle_id / prev_cycle_id are text. The lag() window is partitioned by user_id alone.';

grant select on public.whoop_correlation to authenticated;
