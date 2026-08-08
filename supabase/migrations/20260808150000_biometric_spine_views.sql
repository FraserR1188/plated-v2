-- ============================================================
-- biometric spine views — additive, faithful, provider-agnostic
--
-- Two provider-agnostic "faithful spine" views over the existing WHOOP
-- tables. Does NOT alter any base table and does NOT touch
-- whoop_correlation. No pairing / lag / contiguity logic lives here — that
-- is a later layer (see bottom of this file).
--
-- Grain: biometric_periods = one row per cycle (daily recovery/sleep/strain
-- spine). biometric_workouts = one row per workout. Different grains,
-- sibling views.
--
-- RLS: both views are security_invoker = on, so they respect the
-- underlying tables' existing per-user RLS as the querying user. No new
-- policies. If that flag is missing the view runs as owner and bypasses
-- RLS — it fails open, leaking every user's biometrics.
-- ============================================================

-- ---------- biometric_periods : cycle-grain daily spine ----------
create or replace view public.biometric_periods
with (security_invoker = on) as
select
  c.user_id,
  'whoop'::text                          as ingest_source,
  c.id::text                             as source_period_id,   -- text: Garmin/Apple ids won't be bigint

  c.start                                as period_start,
  c."end"                                as period_end,          -- NULL == open/current cycle, kept honest
  (c."end" is null)                      as is_current,
  c.timezone_offset                      as timezone_offset,
  -- local_date is for DISPLAY / NL queries only — NOT a join key.
  -- Shift the UTC wall-clock by the cycle's fixed offset, then cast to date.
  -- NOT `AT TIME ZONE <offset>` (sign-inversion footgun on POSIX-style zone
  -- names). timezone_offset is stored verbatim from WHOOP as an ISO-8601
  -- offset string (e.g. '+01:00'), confirmed in supabase/functions/whoop-sync,
  -- so a direct interval add after normalizing to a UTC wall-clock timestamp
  -- is safe and does not depend on session timezone for the final cast.
  ((c.start at time zone 'UTC') + (c.timezone_offset)::interval)::date
                                         as local_date,

  -- cycle-level energy/HR — carried on whoop_cycles itself, already
  -- promoted in whoop_cycle_nutrition. Shares the cycle's own
  -- strain_score_state; not a separately-scored quantity. `cycle_` prefix
  -- avoids colliding with recovery's resting_heart_rate and the workout
  -- view's average/max_heart_rate (different grains). kJ unit named
  -- explicitly, symmetric with biometric_workouts.energy_kilojoule, for the
  -- future kcal-converting Garmin/Apple arm.
  c.kilojoule                            as cycle_energy_kilojoule,
  c.average_heart_rate                   as cycle_average_heart_rate,
  c.max_heart_rate                       as cycle_max_heart_rate,

  -- recovery metrics (LEFT join: a scored cycle with no recovery yet still appears, NULLs intact)
  r.recovery_score                       as recovery_score,
  r.score_state                          as recovery_score_state,   -- recovery's own state, kept separate
  r.hrv_rmssd_milli                      as hrv,
  'rmssd'::text                          as hrv_method,             -- load-bearing: never pool with SDNN
  'ms'::text                             as hrv_unit,
  r.resting_heart_rate                   as resting_heart_rate,
  r.spo2_percentage                      as spo2_percentage,
  r.skin_temp_celsius                    as skin_temp_celsius,
  r.user_calibrating                     as user_calibrating,       -- quality gate: recovery unreliable while true

  -- strain lives on the cycle
  c.strain                               as strain,
  c.score_state                          as strain_score_state,     -- cycle's own state, kept separate

  -- sleep (LEAN: performance only). Joined via recovery.sleep_id, NEVER by interval —
  -- the night sits at the tail of cycle N-1 but produces recovery for cycle N.
  s.sleep_performance_percentage         as sleep_performance,
  s.score_state                          as sleep_score_state,      -- sleep's own state, kept separate

  -- freshness signal across all three joined sources, not a fake now().
  -- greatest() ignores NULLs and only returns NULL if all three are NULL.
  greatest(c.whoop_updated_at, r.whoop_updated_at, s.whoop_updated_at)
                                         as source_updated_at
from public.whoop_cycles c
left join public.whoop_recoveries r
  on r.user_id = c.user_id and r.cycle_id = c.id
left join public.whoop_sleeps s
  on s.user_id = r.user_id and s.id = r.sleep_id;

grant select on public.biometric_periods to authenticated;


-- ---------- biometric_workouts : workout-grain spine ----------
create or replace view public.biometric_workouts
with (security_invoker = on) as
select
  w.user_id,
  'whoop'::text                          as ingest_source,
  w.id::text                             as source_workout_id,

  w.start                                as workout_start,
  w."end"                                as workout_end,            -- both needed: pre-window anchors start, post-window anchors end
  w.timezone_offset                      as timezone_offset,
  ((w.start at time zone 'UTC') + (w.timezone_offset)::interval)::date
                                         as local_date,

  w.sport_name                           as sport_name,             -- provider-specific naming, do not pool across sources
  w.strain                               as strain,
  w.score_state                          as strain_score_state,
  w.average_heart_rate                   as average_heart_rate,
  w.max_heart_rate                       as max_heart_rate,
  w.kilojoule                            as energy_kilojoule,       -- kJ, NOT kcal. Never expose a unit-free `energy` (4.184x trap)
  w.distance_meter                       as distance_meter,
  w.altitude_gain_meter                  as altitude_gain_meter,
  w.altitude_change_meter                as altitude_change_meter,

  w.whoop_updated_at                     as source_updated_at
from public.whoop_workouts w;

grant select on public.biometric_workouts to authenticated;

-- ============================================================================
-- VERIFICATION
--
-- The before AND after snapshots (V0, V2) must be run as the SAME role.
-- Running either one in the SQL editor as `postgres` bypasses RLS — that
-- role sees every user's rows, so a postgres "after" compared against an
-- authenticated "before" (or vice versa) is not apples-to-apples and can
-- hide a real regression. Run both as `authenticated`, or both as the same
-- test user via the app / a JWT-bearing client.
-- ============================================================================

-- V0. BASELINE — run BEFORE applying this migration.
--
-- select count(*) as n, md5(string_agg(t::text, ',' order by t::text)) as sig
-- from whoop_correlation t;

-- V1. RLS fails closed (the security_invoker check). Sign in as a SECOND
--     account and confirm both come back empty:
--
-- select count(*) from public.biometric_periods;   -- expect 0
-- select count(*) from public.biometric_workouts;  -- expect 0
-- Non-zero here means security_invoker didn't take — stop and fix before
-- anything else.

-- V2. whoop_correlation is byte-identical — re-run V0 and diff both n and
--     sig against the pre-migration values. Any drift means this migration
--     touched something it shouldn't have (it should touch nothing; these
--     are new views only).

-- V3. NULL-faithfulness. Find (or make) a cycle whose recovery is unscored:
--
-- select recovery_score, recovery_score_state, hrv, hrv_method,
--        cycle_energy_kilojoule, cycle_average_heart_rate
-- from public.biometric_periods
-- where recovery_score_state = 'PENDING_SCORE'
-- limit 5;
-- Expect recovery_score IS NULL (never 0), hrv IS NULL, hrv_method still
-- 'rmssd'. cycle_energy_kilojoule / cycle_average_heart_rate depend on the
-- CYCLE's own score_state, not recovery's — they can be populated even
-- when recovery is still pending.

-- V4. Three score_states are independent. Confirm a scored strain never
--     masks an unscored recovery:
--
-- select strain, strain_score_state, recovery_score, recovery_score_state
-- from public.biometric_periods
-- where strain_score_state = 'SCORED' and recovery_score_state <> 'SCORED'
-- limit 5;
-- If any rows exist: strain present, recovery_score NULL, states differ.
-- Good — no collapse.

-- V5. local_date timezone sanity. Pick a cycle you can eyeball against the
--     WHOOP app:
--
-- select source_period_id, period_start, timezone_offset, local_date
-- from public.biometric_periods
-- order by period_start desc
-- limit 5;
-- local_date must match the calendar day WHOOP shows for that cycle, under
-- BST too. If it's off by a day, the offset format/sign is wrong.

-- V6. Workouts land, with units intact.
--
-- select count(*) from public.biometric_workouts;   -- ~31 on your account
-- select sport_name, distance_meter, energy_kilojoule, strain
-- from public.biometric_workouts
-- where distance_meter between 4800 and 5200
-- order by (workout_end - workout_start)
-- limit 5;
-- A real 5k: distance ~5000, energy_kilojoule populated (kJ), sensible
-- strain.

-- V7. CROSS-VIEW CONSISTENCY — biometric_periods.cycle_energy_kilojoule
--     must read the SAME underlying value as whoop_cycle_nutrition's
--     kilojoule, for the same (user_id, cycle). Both ultimately read
--     whoop_cycles.kilojoule, but they're two independent view definitions
--     — this catches the day one they diverge (e.g. one gets rounded, one
--     doesn't, or a future edit changes one column mapping and not the
--     other):
--
-- select
--   p.source_period_id,
--   p.cycle_energy_kilojoule as periods_kj,
--   n.kilojoule              as nutrition_kj
-- from public.biometric_periods p
-- join public.whoop_cycle_nutrition n
--   on n.cycle_id = p.source_period_id::bigint and n.user_id = p.user_id
-- where p.cycle_energy_kilojoule is distinct from n.kilojoule
-- limit 5;
-- Expect ZERO rows. Any row here means the two views disagree on the same
-- underlying cycle's energy figure.

-- ============================================================
-- NOT in this migration (deliberately deferred)
--
-- The pairing layer. Nutrition<->biometric pairing — the one-cycle
-- recovery lag, the prev_cycle_contiguous guard, same-cycle strain, and the
-- bidirectional workout before/after windows — is a separate layer built on
-- top of these views, gated with the LLM query feature (Play Billing). It
-- is where the load-bearing invariants live so the LLM never re-derives
-- them. The pairing layer must also filter planned = false (plans aren't
-- facts) and owns the derived workout->cycle interval match (kept out of
-- the spine on purpose).
--
-- whoop_correlation refactor to read through biometric_periods.
-- Behaviour-changing; its own future commit, with the lag hand-verified
-- again.
--
-- HealthKit / Garmin branches. Each becomes a union all arm per view,
-- carrying its own ingest_source, hrv_method, and energy unit. No
-- normalisation across sources in these views.
-- ============================================================
