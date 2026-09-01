-- ============================================================================
-- 20260901110000_whoop_correlation_sleep_join.sql
-- Commit three, part two-A — replace the chained sleep join
--
-- Replaces whoop_correlation's sleep join — previously chained through
-- whoop_recoveries.sleep_id (s.user_id = r.user_id and s.id = r.sleep_id) —
-- with a direct match on public.whoop_sleeps: sl.user_id = l.user_id and
-- sl.start = l.cycle_start. Deletes the recoveries CTE and the
-- whoop_recoveries join entirely — nothing else in this view reads
-- whoop_recoveries after part one repointed recovery_score/hrv/resting_heart_
-- rate/etc. onto biometric_periods_resolved. Renames the five WHOOP-only
-- sleep columns that have a Health Connect counterpart with a `_whoop`
-- suffix, so a future widening commit's `_hc` columns can sit beside them
-- without a name collision.
--
-- ── THE MEASURED POSITION: THIS COMMIT CHANGES NO PRODUCTION VALUES TODAY ──
-- Verified against production before writing this migration. The chained
-- join returns a NULL sleep block, today, on exactly three frames that have
-- no whoop_recoveries row: 1617103907 and 1685079064 (a8435663), and
-- 1737676452 (4dbf04ae). None of those three has a whoop_sleeps row at an
-- exact start match either — 4dbf04ae's WHOOP sleep history begins
-- 2026-08-23 and that frame starts 2026-08-22 (before it); the two a8435663
-- frames fall inside that account's sleep history range but have no sleep
-- row exactly at their start. So the new join finds nothing for any of the
-- three, same as the old one. Every other frame in production either has a
-- whoop_recoveries row (the old chained join already worked) or has no
-- whoop_sleeps row at all (both joins return NULL). Net effect on today's
-- 231 rows: zero.
--
-- This is a STRUCTURAL correction, not a data fix. It removes a dependency
-- on whoop_recoveries that has no reason to exist now that recovery itself
-- reads from biometric_periods_resolved, and it stops a cycle's sleep data
-- being gated on whether WHOOP happened to produce a recovery score for that
-- cycle — a gate that was never about sleep at all, only ever about how the
-- old join reached it. The payoff is real the first time a cycle exists
-- with a sleep but no recovery; there is no such cycle today. Part one's own
-- header wrongly claimed a single-cell payoff when the true number was 173
-- rows (corrected 2026-09-01, see that migration's own header and this one's
-- verify file for the correction). This header does not repeat that error
-- in the other direction: it makes no claim of payoff this commit does not
-- have.
--
-- ── THE MATCH: EXACT, NOT CONTAINMENT ──────────────────────────────────────
-- Licensed by the verified premise (biometric_synthetic_cycles.sql's own
-- header): WHOOP cycles are sleep-onset to sleep-onset, and
-- whoop_cycles.start equals whoop_sleeps.start of the sleep that produced
-- that cycle's recovery, exact to the microsecond, 53/53. That licenses an
-- equality join, not a range test. Deliberately not containment
-- (sl.start >= cycle_start and sl.start < effective_end): if the 53/53
-- premise ever drifts, an equality match fails LOUDLY — a NULL sleep block,
-- visible and diagnosable — whereas a containment window would keep
-- matching and hide the drift. Proven in a throwaway container, not
-- reasoned from schema alone (this migration's verify file, F3 vs. sabotage
-- 2): a nap sitting inside the frame window but NOT at cycle_start is
-- correctly ignored by the equality match and WOULD be wrongly picked up by
-- containment.
--
-- ── NO nap = false FILTER ───────────────────────────────────────────────────
-- Production has ZERO naps in whoop_sleeps today (count(*) where nap = true
-- is 0), so the filter would exclude nothing currently. More importantly: a
-- nap that ever DID start at exactly a cycle's sleep-onset instant would be
-- the 53/53 premise breaking in a different way, and silently filtering it
-- out would hide that break behind a clean-looking single-row result — the
-- same wrong-but-quiet failure mode that ruled out containment above. Left
-- unfiltered on purpose, so a collision surfaces as a fan-out (two output
-- rows for one frame) instead of a silently discarded row. Proven in a
-- throwaway container (F5 vs. sabotage 3): adding the filter makes a
-- deliberately-constructed nap-at-the-same-start collision resolve to one
-- row instead of two, which is exactly the silent discard this design
-- avoids.
--
-- ── THE FAN-OUT HAZARD IS REAL AND UNGUARDED BY ANY CONSTRAINT ─────────────
-- Nothing in the schema stops two whoop_sleeps rows from sharing
-- (user_id, start): the primary key is (user_id, id); the only other index,
-- whoop_sleeps_user_start_idx, is on (user_id, start) but is NOT unique.
-- Proven in a throwaway container, not merely asserted (F4): two sleeps for
-- one user sharing an identical start, different id, both nap = false,
-- produce TWO output rows for that frame under this join — every nutrition
-- figure on it duplicated. This is accepted, not fixed, in this commit: the
-- verify file's V5 is a standing production gate against it (see below), and
-- a violation is a whoop-sync data-quality question (e.g. a resynced sleep
-- landing under a new id at the same start), not something this view should
-- paper over with a guessed tiebreak.
--
-- ── THE recoveries CTE AND whoop_recoveries JOIN ARE DELETED ────────────────
-- Confirmed by grep (no remaining `rc.` reference anywhere in this file) AND
-- by execution: the throwaway-container verification schema was built with
-- NO whoop_recoveries table at all, and the CREATE VIEW below still applied
-- cleanly — the strongest possible proof that nothing in this view depends
-- on it any more. whoop_recoveries itself is untouched (still written by
-- whoop-sync, still read by biometric_periods' own recovery-score
-- resolution) — only this view's join to it is removed.
--
-- ── THE `_whoop` SUFFIX ─────────────────────────────────────────────────────
-- sleep_efficiency_percentage, total_in_bed_time_milli,
-- total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli, and
-- total_awake_time_milli are renamed with a `_whoop` suffix. Every one of
-- them has a same-or-adjacent-domain counterpart on
-- biometric_sleep_sessions (Health Connect), so a future widening commit
-- (part two-B, NOT this commit) can add matching `_hc` columns without ever
-- creating a same-named pair that invites pooling. sleep_efficiency_
-- percentage is the sharpest case: biometric_sleep_sessions has a column
-- with the IDENTICAL name, hardcoded to NULL by the Health Connect ingest
-- mapper today (mapping.ts:230-232, "Health Connect computes no equivalent
-- to WHOOP's sleep performance/efficiency score") — but a different
-- construct, not merely an unpopulated one, and the name collision is the
-- hazard regardless of today's null rate. Left UNSUFFIXED, deliberately:
-- respiratory_rate, disturbance_count, sleep_consistency_percentage,
-- sleep_id, sleep_was_nap — none has a Health Connect counterpart in
-- biometric_sleep_sessions, so there is nothing for the name to be confused
-- with.
--
-- ── DROP + CREATE, NOT CREATE OR REPLACE ────────────────────────────────────
-- The five renames are illegal under CREATE OR REPLACE VIEW (it may only
-- append trailing columns, never rename an existing one). V0 in this
-- migration's verify file re-runs the same pg_depend dependency check as
-- part one — RUN IT BEFORE APPLYING, STOP if it returns any row.
--
-- ── STRUCTURE: ONE CTE PER REAL-TABLE READ, NO BARE `*` ────────────────────
-- nutrition / resolved / sleeps are the three swappable real-table
-- dependencies now (recoveries is gone). Same fixture technique as every
-- prior commit in this series.
--
-- ── NOT IN THIS COMMIT ──────────────────────────────────────────────────────
-- biometric_periods_resolved, the Health Connect sleep widening, any `_hc`
-- column, and sleep_scored are untouched. sleep_scored still reads NULL on
-- every one of the 172 Health-Connect-won frames (it reads
-- resolved.sleep_score_state, which biometric_periods_resolved's synthetic
-- arm hardcodes null) — how to present that is part two-B's problem, an open
-- question, not solved here.
--
-- ── SECURITY_INVOKER: CHECKED ───────────────────────────────────────────────
-- Re-verified by reading the CREATE VIEW statement below immediately before
-- writing this line. Also proven, not just re-read: a from-scratch
-- auth.uid()/RLS reproduction in a throwaway container showed a second
-- account's data leaking into the first account's result the moment
-- security_invoker = on was dropped from this same join shape (this
-- migration's verify file, V8).
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
    sleep_performance, sleep_score_state
  from public.biometric_periods_resolved
),
sleeps as (
  -- start is read only to key the join below (l.cycle_start = sl.start); it
  -- is not itself an output column, same convention as every other
  -- join-only field in this file.
  select
    user_id, id, start,
    sleep_efficiency_percentage, sleep_consistency_percentage,
    respiratory_rate, total_in_bed_time_milli,
    total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli,
    total_awake_time_milli, disturbance_count, nap
  from public.whoop_sleeps
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
  -- Label only. Derived from timezone_offset for display. NEVER a join key.
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

  -- ── RECOVERY: resolved cross-provider (unchanged from part one) ──
  rv.recovery_score,
  rv.resting_heart_rate,
  rv.spo2_percentage,
  rv.skin_temp_celsius,
  rv.user_calibrating,

  rv.hrv,
  rv.hrv_method,
  rv.hrv_unit,

  -- ── SLEEP: performance resolved (unchanged); the rest now reached by a
  --    direct exact-start match on whoop_sleeps, not chained through
  --    whoop_recoveries.sleep_id — see header. `_whoop` suffix on every
  --    column that has a Health Connect counterpart. ──
  sl.id                                     as sleep_id,
  rv.sleep_performance                      as sleep_performance_percentage,
  sl.sleep_efficiency_percentage            as sleep_efficiency_percentage_whoop,
  sl.sleep_consistency_percentage,
  sl.respiratory_rate,
  sl.total_in_bed_time_milli                as total_in_bed_time_milli_whoop,
  sl.total_slow_wave_sleep_time_milli       as total_slow_wave_sleep_time_milli_whoop,
  sl.total_rem_sleep_time_milli             as total_rem_sleep_time_milli_whoop,
  sl.total_awake_time_milli                 as total_awake_time_milli_whoop,
  sl.disturbance_count,
  sl.nap                                    as sleep_was_nap,

  -- ── TRUST FLAGS. Filter on these before plotting anything. ──
  (l.score_state = 'SCORED')                          as cycle_scored,
  (rv.recovery_score_state = 'SCORED')                as recovery_scored,
  (rv.sleep_score_state = 'SCORED')                   as sleep_scored,
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
left join resolved rv on rv.user_id = l.user_id and rv.source_period_id = l.cycle_id
left join sleeps   sl on sl.user_id = l.user_id and sl.start = l.cycle_start;

comment on view public.whoop_correlation is
  'One row per cycle. *_prev_cycle nutrition pairs with recovery_*/hrv/sleep_* (what you ate BEFORE the night). *_same_cycle nutrition pairs with strain (what fuelled the day). Do not cross them. recovery_score/resting_heart_rate/hrv/spo2_percentage/skin_temp_celsius/user_calibrating/sleep_performance_percentage/recovery_scored/sleep_scored are resolved cross-provider via biometric_periods_resolved; hrv is NOT guaranteed RMSSD. sleep_id/sleep_efficiency_percentage_whoop/sleep_consistency_percentage/respiratory_rate/total_in_bed_time_milli_whoop/total_slow_wave_sleep_time_milli_whoop/total_rem_sleep_time_milli_whoop/total_awake_time_milli_whoop/disturbance_count/sleep_was_nap are WHOOP-only, reached by an EXACT match on whoop_sleeps.start = this cycle''s cycle_start (licensed by the verified premise that a WHOOP cycle opens at the sleep that produced its recovery, exact to the microsecond) — no longer chained through whoop_recoveries.sleep_id, so a cycle with no whoop_recoveries row no longer loses its sleep block (20260901110000). The five WHOOP-only columns with a Health Connect counterpart carry a `_whoop` suffix so a future widening commit''s `_hc` columns cannot collide with them under one name; sleep_id/sleep_was_nap/respiratory_rate/disturbance_count/sleep_consistency_percentage stay unsuffixed, nothing to confuse them with. The exact-start match can fan out into more than one row per cycle if two whoop_sleeps rows ever share (user_id, start) — nothing in the schema prevents that; see this migration''s verify file, V5, for the standing production check. is_stale (effective_end is null) is NOT the same as is_current. prev_cycle_contiguous is advisory (a fixed 2h threshold); prev_cycle_gap exposes the raw interval. *_known_meals columns (same-cycle and prev-cycle) are commit 2.5''s known-contributor counts, no completeness threshold imposed. Filter on cycle_scored / recovery_scored / sleep_scored / prev_nutrition_present / prev_cycle_contiguous (or prev_cycle_gap) before drawing any conclusion, and exclude is_in_progress = true (partial strain) and is_stale = true (abandoned cycle, not a quiet day). cycle_id / prev_cycle_id are text. The lag() window is partitioned by user_id alone.';

grant select on public.whoop_correlation to authenticated;
