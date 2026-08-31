-- ============================================================================
-- 20260901100000_whoop_correlation_repoint.sql
-- Commit three, part one — whoop_correlation onto resolved columns
--
-- Repoints recovery_score/spo2_percentage/skin_temp_celsius/user_calibrating/
-- recovery_scored, resting_heart_rate, hrv (renamed from hrv_rmssd_milli),
-- and sleep_performance_percentage/sleep_scored off DIRECT whoop_recoveries/
-- whoop_sleeps joins onto public.biometric_periods_resolved's already-
-- resolved, cross-provider-aware columns. Simplifies the lag() window from
-- (user_id, period_ingest_transport, period_origin_package) to user_id
-- alone. Exposes commit 2.5's four known-meal counts (previously invisible
-- to this view — see below). Adds is_stale and prev_cycle_gap.
--
-- ── THE MEASURED PAYOFF, STATED PLAINLY ────────────────────────────────
-- CORRECTED 2026-09-01 — the original text here claimed exactly one cell
-- changed in production. That was false; measured wrong before the
-- pre/post snapshots were dropped. The real numbers, verified against this
-- migration's own verify file (V3(5)):
--
-- resting_heart_rate went from 56 non-null rows to 229 non-null (of 231
-- total). 173 rows gained a value; zero lost one; zero changed value on a
-- row that already had one. Of the 173: 172 are Health-Connect-won frames,
-- and the remaining one is cycle 1737676452. The cause: a synthetic
-- frame's source_period_id is shaped like whoop://sleep/<uuid> — it can
-- never match a numeric whoop_recoveries.cycle_id, so the OLD direct join
-- silently returned NULL for every single HC frame, not because no
-- resting-HR reading existed but because the join key structurally could
-- not match. 1737676452 is different in kind: a genuine WHOOP cycle whose
-- own whoop_recoveries row simply never arrived, filled by Health
-- Connect's resolved candidate instead. This is the commit's actual,
-- measured payoff on today's data — not a one-cell curiosity, a real fix
-- reaching three-quarters of the dataset, working exactly as designed.
--
-- sleep_performance_percentage resolves to Health Connect on all 172
-- HC-won frames and is NULL on every one of them (HC candidates
-- structurally cannot populate a WHOOP-style performance score — see
-- biometric_periods_resolved's own sleep_candidates CTE) — the SAME output
-- those frames already had via the old direct join, since none of them ever
-- had a whoop_recoveries/whoop_sleeps row to leak a value from in the first
-- place. recovery_score/hrv/spo2_percentage/skin_temp_celsius/
-- user_calibrating are structurally WHOOP-only on both sides of this change
-- (biometric_periods_resolved's synthetic arm hardcodes them null) — moving
-- their source changes nothing about when they're populated.
--
-- ── THE `select n.*` FREEZE, AND WHY THIS COMMIT FIXES IT FOR GOOD ─────
-- whoop_correlation's `lagged` CTE previously did `select n.*, lag(...)
-- from public.whoop_cycle_nutrition n`. A `SELECT *` inside a view is
-- expanded to an explicit column list and FROZEN into pg_rewrite at the
-- view's own CREATE/CREATE OR REPLACE time — it does not re-expand on every
-- query. Commit 2.5 added sat_fat_known_meals/salt_known_meals/
-- fibre_known_meals/sugar_known_meals as trailing columns on
-- whoop_cycle_nutrition; whoop_correlation's frozen n.* never picked them
-- up (reproduced and confirmed in an isolated throwaway-container test: a
-- dependent view's frozen `t.*` stayed at 3 columns after the base view
-- gained a 4th, and only refreshed once the dependent view was itself
-- re-created — even with byte-identical text). Every real-table/upstream-
-- view read below is an EXPLICIT column list, not a bare `*`, specifically
-- so this can't happen again silently: adding a column to
-- whoop_cycle_nutrition or biometric_periods_resolved in the future will
-- require a conscious edit here to surface it, not a silent freeze.
--
-- ── STRUCTURE: ONE CTE PER REAL-TABLE READ, NO BARE `*` ────────────────
-- nutrition / resolved / recoveries / sleeps below are the four swappable
-- real-table dependencies — a fixture substitutes a VALUES block for
-- whichever one it needs to control, copying every downstream CTE and the
-- final select character-for-character, the same technique as commits one
-- through 2.5. A CTE cannot shadow a schema-qualified reference, so the
-- view must read the CTE name; the fixture replaces the CTE.
--
-- ── DROP + CREATE, NOT CREATE OR REPLACE ────────────────────────────────
-- CREATE OR REPLACE VIEW may only APPEND trailing columns and may never
-- rename an existing one. This commit does both: hrv_rmssd_milli is renamed
-- to hrv (see below), and new columns (is_stale, hrv_method, hrv_unit, the
-- eight known-meal counts, prev_cycle_gap) are inserted in the MIDDLE of
-- the column list, not appended at the end. CREATE OR REPLACE would refuse
-- this outright. Confirmed via pg_depend, not assumed (this migration's
-- verify file, V0): nothing in the database depends on whoop_correlation —
-- zero SQL consumers (only whoop_correlation itself reads
-- whoop_cycle_nutrition; nothing reads whoop_correlation), zero runtime
-- consumers (re-verified by grep across src/ and supabase/functions/: the
-- only hit for "whoop_correlation" or "WhoopCorrelationRow" anywhere in
-- application code is the dead type declaration itself,
-- src/types/index.ts). So the DROP needs no CASCADE and takes nothing down
-- with it. RUN V0 BEFORE APPLYING THIS MIGRATION — if it returns any row,
-- STOP; something depends on this view that this migration's author did
-- not find.
--
-- ── THE HRV RENAME ──────────────────────────────────────────────────────
-- The old column name, hrv_rmssd_milli, asserts RMSSD in its own name. The
-- resolved column, biometric_periods_resolved.hrv, does not — it is
-- whichever method won the domain, WHOOP or Health Connect, and
-- biometric_hrv_samples.hrv_method's own CHECK constraint permits 'sdnn' as
-- well as 'rmssd'. Production is 100% 'rmssd'/'ms' on both arms TODAY,
-- verified in code, not inferred: WHOOP's arm hardcodes the literals
-- (biometric_periods, unchanged by this commit); Health Connect's own
-- ingest mapper (supabase/functions/health-connect-ingest/mapping.ts,
-- mapHrv) also hardcodes 'rmssd'/'ms', because Android's
-- HeartRateVariabilityRmssdRecord structurally cannot report anything else
-- — and the same file documents, confirmed on-device, that WHOOP writes
-- ZERO HRV records to Health Connect at all. So today this rename changes
-- no value and no behavior. It exists so that the day a real SDNN-reporting
-- provider is added, a consumer reading a column literally named
-- hrv_rmssd_milli cannot silently average an SDNN value into an RMSSD
-- series and call it a continuous line — hrv_method/hrv_unit now travel
-- WITH hrv, not as a fact a consumer has to already know. A chart must
-- break the line, not smooth over it, the moment hrv_method changes
-- between two adjacent points.
--
-- ── THE KNOWN DEFECT THIS COMMIT DOES NOT FIX ───────────────────────────
-- The sleep block (sleep_id, sleep_efficiency_percentage,
-- sleep_consistency_percentage, respiratory_rate, total_in_bed_time_milli,
-- total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli,
-- total_awake_time_milli, disturbance_count, sleep_was_nap) STAYS on the
-- direct whoop_sleeps join, chained through whoop_recoveries.sleep_id
-- (s.user_id = r.user_id and s.id = r.sleep_id) — UNCHANGED, deliberately.
-- biometric_periods_resolved does not resolve any of these columns; only
-- sleep_performance/sleep_score_state are resolved, and those two ARE
-- repointed in this commit (see below). The chained join means: when a
-- cycle has NO whoop_recoveries row at all, r.user_id is NULL, so
-- `s.user_id = r.user_id` can never match anything, so the ENTIRE sleep
-- block reads NULL — even on a WHOOP cycle whose whoop_sleeps row genuinely
-- exists (WHOOP's own recovery pipeline just never produced a recovery for
-- that cycle). THREE production frames hit this today: 1617103907 and
-- 1685079064 (a8435663, no whoop_recoveries row, no Health Connect data for
-- that user either, so genuinely all-NULL) and 1737676452 (4dbf04ae, no
-- whoop_recoveries row, but Health Connect DID win sleep and resting-HR for
-- that frame — resting_heart_rate now reaches the output via the repoint
-- above, but sleep_efficiency_percentage/respiratory_rate/etc. still read
-- NULL because nothing in this commit touches the chained join that gates
-- them). Fixing this means reaching whoop_sleeps through containment
-- against the frame's own [cycle_start, effective_end) window, the same
-- pattern biometric_periods_resolved already uses for Health Connect
-- candidates, rather than through whoop_recoveries.sleep_id — that is part
-- two's problem, not this commit's. Untouched here on purpose.
--
-- ── THE PARTITION SIMPLIFICATION ────────────────────────────────────────
-- lag() now partitions by user_id alone, dropping
-- period_ingest_transport/period_origin_package entirely — the lagged CTE
-- no longer needs to join biometric_periods_resolved at all to compute its
-- window. Licensed by 20260830180000's own non-overlap proof
-- (verify/20260830180000_verify.sql, V2(2b)), re-run against current
-- production data as this migration's own V-check before relying on it
-- again — see verify file. One frame in the current 231-row dataset sits
-- at a WHOOP<->Health-Connect provenance boundary and gains a prev_cycle_id
-- it did not have under the old three-column partition; identified and
-- asserted specifically in the verify file, not merely counted.
--
-- ── CONTINUITY: EXPOSED, NOT GATED — A DELIBERATE REVERSAL ─────────────
-- prev_cycle_contiguous stays exactly as it was (advisory output, computed
-- from a fixed 2-hour threshold, nothing upstream reads it back). A NEW
-- column, prev_cycle_gap, exposes the RAW interval (cycle_start -
-- prev_cycle_end) alongside it: a 3-hour gap and a 5-week gap both
-- currently read identically as prev_cycle_contiguous = false, which is
-- not enough information for a consumer to decide whether "meaningless" or
-- "just barely outside the strap-off window" is the right read. lag() is
-- NOT gated on continuity — nulling prev_* on a discontinuity would destroy
-- data a consumer might legitimately want (e.g. plotting the gap itself);
-- exposing the raw gap lets the CONSUMER refuse the pairing, rather than
-- the view refusing it for them. Same "expose the signal, do not bake in a
-- threshold" principle as the known-meal counts below and as
-- cycle_scored/recovery_scored/sleep_scored already established in this
-- view — not a new precedent, a continuation of the existing one.
--
-- ── KNOWN-MEAL COUNTS ────────────────────────────────────────────────────
-- sat_fat_known_meals/salt_known_meals/fibre_known_meals/sugar_known_meals
-- (commit 2.5) are now readable (see freeze note above) and exposed both
-- same-cycle and lag()ed prev-cycle, matching every other nutrition column
-- in this view. No completeness threshold is imposed here either — same
-- reasoning as prev_cycle_gap above.
--
-- ── SECURITY_INVOKER: CHECKED ──────────────────────────────────────────
-- Re-verified by reading the CREATE VIEW statement below immediately
-- before writing this line.
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
recoveries as (
  -- Only the sleep_id pointer bridge survives here — recovery_score and its
  -- supporting fields all come from `resolved` now. See the header note on
  -- the chained sleep join this migration deliberately leaves in place.
  select user_id, cycle_id, sleep_id
  from public.whoop_recoveries
),
sleeps as (
  select
    user_id, id,
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
  -- Partitioned by user_id ALONE now — see header note. No join needed here
  -- to compute the window; biometric_periods_resolved is only joined below,
  -- for its resolved recovery/hrv/sleep columns, not to key this lag().
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

  -- effective_end is null: a stale, permanently-open cycle (production:
  -- 1663052944, a8435663, open since 2026-07-23) OR a genuinely brand-new
  -- one older than 36h with no close yet — either way, is_current alone
  -- reports true for both and cannot tell them apart. is_stale can.
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

  -- ── RECOVERY: repointed onto resolution ───────────────────
  rv.recovery_score,
  rv.resting_heart_rate,
  rv.spo2_percentage,
  rv.skin_temp_celsius,
  rv.user_calibrating,

  -- ── HRV: repointed AND renamed — see header note ──────────
  rv.hrv,
  rv.hrv_method,
  rv.hrv_unit,

  -- ── SLEEP: performance repointed; the rest stays on the direct,
  --    chained whoop_sleeps join — see header note on the known defect ──
  sl.id                               as sleep_id,
  rv.sleep_performance                as sleep_performance_percentage,
  sl.sleep_efficiency_percentage,
  sl.sleep_consistency_percentage,
  sl.respiratory_rate,
  sl.total_in_bed_time_milli,
  sl.total_slow_wave_sleep_time_milli,
  sl.total_rem_sleep_time_milli,
  sl.total_awake_time_milli,
  sl.disturbance_count,
  sl.nap                              as sleep_was_nap,

  -- ── TRUST FLAGS. Filter on these before plotting anything. ──
  (l.score_state = 'SCORED')                          as cycle_scored,
  (rv.recovery_score_state = 'SCORED')                as recovery_scored,
  (rv.sleep_score_state = 'SCORED')                   as sleep_scored,
  (l.meal_count > 0)                                  as nutrition_present,
  (l.prev_cycle_id is not null
     and coalesce(l.prev_meal_count, 0) > 0)          as prev_nutrition_present,
  -- Is cycle N-1 actually the cycle before this one, or is there a strap-off
  -- gap between them? If they are not contiguous, the lag is meaningless.
  (l.prev_cycle_end is not null
     and l.cycle_start - l.prev_cycle_end < interval '2 hours')
                                                      as prev_cycle_contiguous,
  -- The raw gap, for a consumer that wants more than a boolean. NULL when
  -- there is no predecessor (partition start) or the predecessor is still
  -- open (prev_cycle_end null). See header note — deliberately not gated.
  (l.cycle_start - l.prev_cycle_end)                  as prev_cycle_gap,
  l.has_estimated_times                               as timing_estimated_same_cycle,
  coalesce(l.prev_has_estimated_times, false)         as timing_estimated_prev_cycle

from lagged l
left join resolved   rv on rv.user_id = l.user_id and rv.source_period_id = l.cycle_id
left join recoveries rc on rc.user_id = l.user_id and rc.cycle_id::text = l.cycle_id
left join sleeps      sl on sl.user_id = rc.user_id and sl.id = rc.sleep_id;

comment on view public.whoop_correlation is
  'One row per cycle. *_prev_cycle nutrition pairs with recovery_*/hrv/sleep_* (what you ate BEFORE the night). *_same_cycle nutrition pairs with strain (what fuelled the day). Do not cross them. recovery_score/resting_heart_rate/hrv/spo2_percentage/skin_temp_celsius/user_calibrating/sleep_performance_percentage/recovery_scored/sleep_scored are resolved cross-provider via biometric_periods_resolved; hrv is NOT guaranteed RMSSD — always read hrv_method/hrv_unit alongside it. sleep_id/sleep_efficiency_percentage/sleep_consistency_percentage/respiratory_rate/total_in_bed_time_milli/total_slow_wave_sleep_time_milli/total_rem_sleep_time_milli/total_awake_time_milli/disturbance_count/sleep_was_nap remain WHOOP-only, reached through whoop_recoveries.sleep_id — a cycle with no whoop_recoveries row reads this whole block NULL even if a whoop_sleeps row exists (known, unfixed defect, see 20260901100000''s header). is_stale (effective_end is null) is NOT the same as is_current: a permanently-abandoned open cycle reads is_current = true and is_stale = true forever. prev_cycle_contiguous is advisory (a fixed 2h threshold); prev_cycle_gap exposes the raw interval so a consumer can apply its own. *_known_meals columns (same-cycle and prev-cycle) are commit 2.5''s known-contributor counts, no completeness threshold imposed. Filter on cycle_scored / recovery_scored / sleep_scored / prev_nutrition_present / prev_cycle_contiguous (or prev_cycle_gap) before drawing any conclusion, and exclude is_in_progress = true (partial strain) and is_stale = true (abandoned cycle, not a quiet day). cycle_id / prev_cycle_id are text. The lag() window is partitioned by user_id alone (widened from (user_id, period_ingest_transport, period_origin_package) — licensed by biometric_periods_resolved''s per-user non-overlap proof, re-verified in this migration''s verify file).';

grant select on public.whoop_correlation to authenticated;
