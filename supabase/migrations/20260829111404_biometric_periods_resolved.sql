-- ============================================================
-- Resolved biometric layer — commit 2 of N
--
-- Four pieces, in dependency order:
--   1. biometric_source_preferences  — user-owned, per-domain provider pick
--   2. biometric_periods             — rewritten as a union-shaped view with
--                                       its single existing (WHOOP) arm
--   3. biometric_periods_resolved    — resolves sleep/hrv/resting_hr
--                                       INDEPENDENTLY per domain, not as
--                                       one whole-row pick (see part 3)
--   4. whoop_cycle_nutrition / whoop_correlation — repointed onto (3),
--      with the one-cycle-lag window repartitioned by PERIOD provider
--      identity, and cycle_id widened bigint -> text (see below)
--
-- Two deliberate, explicit deviations from a byte-for-byte refactor —
-- both scoped to whoop_cycle_nutrition / whoop_correlation, both argued
-- for below, neither silent:
--
-- (1) cycle_id / prev_cycle_id CHANGE TYPE, bigint -> text. The prior
--     draft of this migration kept cycle_id bigint via an explicit cast
--     back from source_period_id (text), reasoning that a type change
--     would break the acceptance diff. That reasoning stood only as long
--     as the cast was harmless — it stops being harmless the day arm
--     two's period ids are not bigint-parseable, at which point the cast
--     throws and the view is simply broken, not merely narrow. Neither
--     view has a client consumer today (WhoopCorrelationRow is confirmed
--     dead code — nothing in src/ reads whoop_correlation or
--     whoop_cycle_nutrition), so the cost of widening the type NOW is one
--     cast in a diff query; the cost of widening it LATER, with consumers
--     attached, is a breaking change. Fixed now, cheaply, on purpose.
--     The acceptance diff below casts the *_pre snapshot's cycle_id /
--     prev_cycle_id to text to compare like with like.
--
-- (2) biometric_periods_resolved resolves sleep / hrv / resting_hr
--     INDEPENDENTLY, each against its own preference row, rather than
--     picking one whole source row for the whole period. The previous
--     draft pinned the preference lookup to domain = 'sleep' as a single
--     anchor for the entire bundled row — flagged in that draft's own
--     follow-ups as silently deciding hrv/resting_hr's precedence by
--     proxy. That is now fixed: see part 3 for the shape this takes and
--     why "Garmin for workouts, WHOOP for recovery" is the real case this
--     has to serve.
--
-- Everything else remains a strict refactor. whoop_correlation and
-- whoop_cycle_nutrition's output columns keep their existing name and
-- order (type, for cycle_id / prev_cycle_id only, changes per (1) above).
-- Verify with the acceptance diff shipped alongside this migration
-- (EXCEPT in both directions against the snapshot_*_pre tables, with the
-- cycle_id cast) — if that diff is non-empty anywhere else, this
-- migration is wrong and must be fixed, not worked around by loosening
-- the comparison further.
--
-- SECURITY_INVOKER CHECKED: every view in this file — biometric_periods,
-- biometric_periods_resolved, whoop_cycle_nutrition, whoop_correlation —
-- carries `with (security_invoker = on)`. Re-verified by reading each
-- CREATE VIEW statement below immediately before writing this line, after
-- the part 3 rewrite.
--
-- NULL-not-zero: no new coalesce-to-0 is introduced by this migration.
-- whoop_cycle_nutrition's existing coalesce(sum(m.calories), 0)-style
-- lines are UNTOUCHED and are not a NULL-not-zero violation in the first
-- place — they aggregate the user's OWN meal log, where zero meals
-- logged really is zero calories, not an absent measurement.
--
-- Deliberate simplification retained from the previous draft:
-- biometric_periods_resolved's per-domain rankings still group candidates
-- by (user_id, source_period_id) — a placeholder, since source_period_id
-- is provider-specific and two providers essentially never emit the same
-- one. With one arm this is a no-op by construction. Reconciling "the
-- same real-world period" across providers on TIME-RANGE OVERLAP rather
-- than id equality is commit three's "synthetic cycle reconstruction,"
-- not solved here.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. biometric_source_preferences
--
-- DIFFERENT posture from every other table in the biometric layer: the
-- user owns this row (it is a setting, not a measurement), so unlike
-- whoop_tokens/whoop_cycles/biometric_* the client gets full CRUD on its
-- own rows and the default anon/authenticated DML grants are NOT revoked.
-- Table stays empty — this migration inserts no rows.
-- ════════════════════════════════════════════════════════════

create table if not exists public.biometric_source_preferences (
  user_id            uuid not null references auth.users (id) on delete cascade,
  domain             text not null check (domain in ('sleep', 'hrv', 'resting_hr', 'workouts')),

  -- Same vocabulary, same shape checks, as
  -- 20260829072742_biometric_provider_neutral_tables.sql — copied
  -- verbatim so the two tables' notion of "a provider" cannot drift.
  ingest_transport   text not null check (ingest_transport in ('whoop', 'health_connect')),
  origin_package     text not null check (origin_package <> '' and origin_package ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),

  updated_at         timestamptz not null default now(),

  constraint biometric_source_preferences_transport_origin_check check (
    (ingest_transport = 'whoop'          and origin_package like '%.direct')
    or
    (ingest_transport = 'health_connect' and origin_package not like '%.direct')
  ),

  primary key (user_id, domain)
);

comment on table public.biometric_source_preferences is
  'User-chosen provider per biometric domain. Empty by default: absence of a row means "use the default precedence," not "no preference recorded as null."';

-- default now() only fires on INSERT, not UPDATE (same footgun documented
-- on whoop_tokens.updated_at, 20260712120000_whoop_data.sql:72-76). Reuse
-- the existing shared trigger function rather than letting this column
-- silently freeze at first-write.
drop trigger if exists biometric_source_preferences_set_updated_at on public.biometric_source_preferences;
create trigger biometric_source_preferences_set_updated_at
  before update on public.biometric_source_preferences
  for each row execute function public.set_updated_at();

alter table public.biometric_source_preferences enable row level security;

create policy biometric_source_preferences_select_own on public.biometric_source_preferences
  for select to authenticated using (auth.uid() = user_id);
create policy biometric_source_preferences_insert_own on public.biometric_source_preferences
  for insert to authenticated with check (auth.uid() = user_id);
create policy biometric_source_preferences_update_own on public.biometric_source_preferences
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy biometric_source_preferences_delete_own on public.biometric_source_preferences
  for delete to authenticated using (auth.uid() = user_id);

-- No revoke here, deliberately: the user is meant to write their own rows.


-- ════════════════════════════════════════════════════════════
-- 2. biometric_periods — rewritten, single arm, union-shaped
--
-- ingest_source (one column, one hardcoded literal) becomes two columns:
-- ingest_transport ('whoop') and origin_package ('whoop.direct'), matching
-- 20260829072742_biometric_provider_neutral_tables.sql's vocabulary. Every
-- OTHER output column keeps its existing name and type exactly — this
-- view is not covered by the whoop_correlation/whoop_cycle_nutrition
-- column-stability rule, but there is no reason to gratuitously rename
-- anything else here either.
--
-- Written as the first arm of what will become a UNION ALL. Postgres has
-- no syntax for a one-armed union, so today this is a single SELECT with
-- a marked splice point — arm two (Health Connect) is added by literally
-- appending `union all select ...` at the point marked below, once its
-- synthetic cycle reconstruction exists (commit three). Nothing here
-- should need to change to accommodate that append.
-- ════════════════════════════════════════════════════════════

-- DROP + CREATE, not CREATE OR REPLACE: Postgres only allows CREATE OR
-- REPLACE VIEW to APPEND trailing columns to an existing view's list — it
-- refuses to rename an existing column (ingest_source -> ingest_transport
-- here) or insert one in the middle (origin_package at position 3, which
-- shifts every column after it). Both happen below, so CREATE OR REPLACE
-- would fail outright. Nothing else in the schema depends on
-- biometric_periods as of this migration (biometric_periods_resolved,
-- defined further down THIS file, depends on the NEW definition created
-- here, not the old one) — confirmed by grep across every migration for
-- "biometric_periods" before writing this. DROP therefore needs no
-- CASCADE. The grant this view already had is gone the instant it's
-- dropped, so it is re-issued explicitly below — do not remove that line.
drop view if exists public.biometric_periods;

create view public.biometric_periods
with (security_invoker = on) as
-- ── ARM ONE: WHOOP ──────────────────────────────────────────
select
  c.user_id,
  'whoop'::text                          as ingest_transport,
  'whoop.direct'::text                   as origin_package,
  c.id::text                             as source_period_id,

  c.start                                as period_start,
  c."end"                                as period_end,
  (c."end" is null)                      as is_current,
  c.timezone_offset                      as timezone_offset,
  ((c.start at time zone 'UTC') + (c.timezone_offset)::interval)::date
                                         as local_date,

  c.kilojoule                            as cycle_energy_kilojoule,
  c.average_heart_rate                   as cycle_average_heart_rate,
  c.max_heart_rate                       as cycle_max_heart_rate,

  r.recovery_score                       as recovery_score,
  r.score_state                          as recovery_score_state,
  r.hrv_rmssd_milli                      as hrv,
  -- Still hardcoded: WHOOP only ever reports RMSSD. Becomes ROW-SOURCED
  -- (read from the arm's own data, not a literal) the moment arm two adds
  -- a provider whose HRV method can vary per record.
  'rmssd'::text                          as hrv_method,
  'ms'::text                             as hrv_unit,
  r.resting_heart_rate                   as resting_heart_rate,
  r.spo2_percentage                      as spo2_percentage,
  r.skin_temp_celsius                    as skin_temp_celsius,
  r.user_calibrating                     as user_calibrating,

  c.strain                               as strain,
  c.score_state                          as strain_score_state,

  s.sleep_performance_percentage         as sleep_performance,
  s.score_state                          as sleep_score_state,

  greatest(c.whoop_updated_at, r.whoop_updated_at, s.whoop_updated_at)
                                         as source_updated_at
from public.whoop_cycles c
left join public.whoop_recoveries r
  on r.user_id = c.user_id and r.cycle_id = c.id
left join public.whoop_sleeps s
  on s.user_id = r.user_id and s.id = r.sleep_id

-- ── ARM TWO (Health Connect) GOES HERE ───────────────────────
-- union all
-- select ... from <synthetic Health Connect cycle reconstruction>
-- Deliberately absent. Commit three's problem.
;

-- Re-issued because DROP VIEW above wiped it: without this line,
-- authenticated loses SELECT on biometric_periods entirely.
grant select on public.biometric_periods to authenticated;


-- ════════════════════════════════════════════════════════════
-- 3. biometric_periods_resolved — PER-DOMAIN resolution
--
-- The previous draft picked one WHOLE source row per period, with the
-- preference lookup pinned to domain = 'sleep' as a stand-in for the
-- whole bundle. That is wrong on its own terms: biometric_periods bundles
-- sleep + hrv + resting-HR + strain into one row, but
-- biometric_source_preferences is deliberately domain-grained precisely
-- because a user's real preference can be "Garmin for workouts, WHOOP for
-- recovery" — i.e. genuinely split by domain. A single anchor domain
-- silently decides every OTHER domain's precedence by proxy, which is the
-- exact failure mode a domain-grained preference table exists to prevent.
--
-- So: sleep, hrv, and resting_hr are resolved INDEPENDENTLY below, each
-- against its own preference row, and the output row is ASSEMBLED from
-- three (potentially different) winners rather than copied from one.
-- Every domain-resolved column is paired with its own provenance columns
-- (sleep_ingest_transport/sleep_origin_package, and the hrv_ / resting_hr_
-- equivalents) — a single row-level ingest_transport is not meaningful
-- once domains can disagree, and is not emitted.
--
-- 'workouts' IS a domain in biometric_source_preferences, but
-- biometric_periods is PERIOD-grain, not workout-grain: a workout does
-- not belong to exactly one cycle the way sleep/HRV/resting-HR do (WHOOP
-- itself models workouts as their own entity, joined by interval, not by
-- cycle_id). Workout source resolution belongs in biometric_workouts, a
-- separate view, not here. This view never looks up a 'workouts'
-- preference row — that is not the same as silently accepting and
-- discarding one; it is structurally out of scope for a period-grained
-- result, and biometric_workouts is where that preference must eventually
-- be honoured instead.
--
-- strain, cycle_energy_kilojoule, cycle_average_heart_rate,
-- cycle_max_heart_rate, recovery_score (+ its supporting fields
-- spo2_percentage/skin_temp_celsius/user_calibrating), and the period's
-- own identity (source_period_id/period_start/period_end/is_current/
-- timezone_offset/local_date) are WHOOP-ONLY, same as strain: none of
-- them is one of the four domains in biometric_source_preferences, and
-- none has a cross-provider equivalent to resolve TOWARD — a WHOOP
-- "cycle" and a WHOOP "recovery score" are WHOOP-proprietary constructs,
-- structurally identical in that sense to strain. There is nothing to
-- rank here: always the WHOOP row for this period, when one exists. This
-- bucket's own provenance is period_ingest_transport/period_origin_package
-- — attributing WHICH ARM DEFINED THIS PERIOD ITSELF, which is also what
-- whoop_correlation's lag() window repartitions on (part 4b): the lag
-- exists to protect PERIOD boundaries from cross-provider interleaving,
-- not any one domain's data.
--
-- With only one arm existing today, every ranking below has exactly one
-- candidate per (user_id, source_period_id), so every domain resolves to
-- the same WHOOP row every time — a no-op on output, which is what makes
-- now the right time to build the machinery rather than later.
-- ════════════════════════════════════════════════════════════

create or replace view public.biometric_periods_resolved
with (security_invoker = on) as
with
  -- Period identity + WHOOP-only metrics. No domain, no ranking — always
  -- the WHOOP row for this period.
  period_base as (
    select
      p.user_id,
      p.source_period_id,
      p.period_start,
      p.period_end,
      p.is_current,
      p.timezone_offset,
      p.local_date,
      p.ingest_transport as period_ingest_transport,
      p.origin_package   as period_origin_package,
      p.cycle_energy_kilojoule,
      p.cycle_average_heart_rate,
      p.cycle_max_heart_rate,
      p.strain,
      p.strain_score_state,
      p.recovery_score,
      p.recovery_score_state,
      p.spo2_percentage,
      p.skin_temp_celsius,
      p.user_calibrating,
      p.source_updated_at
    from public.biometric_periods p
    where p.ingest_transport = 'whoop'
  ),

  -- ── sleep, resolved independently ────────────────────────────
  sleep_ranked as (
    select
      p.user_id, p.source_period_id,
      p.sleep_performance, p.sleep_score_state,
      p.ingest_transport as sleep_ingest_transport,
      p.origin_package   as sleep_origin_package,
      row_number() over (
        partition by p.user_id, p.source_period_id
        order by
          -- 1. This domain's own preference wins, if one is set.
          (pref.ingest_transport is not null
             and pref.ingest_transport = p.ingest_transport
             and pref.origin_package  = p.origin_package)  desc,
          -- 2. No preference: direct integration outranks Health Connect.
          --    Read off the origin_package SHAPE (the reserved
          --    '<vendor>.direct' namespace from commit one), never off a
          --    specific provider's name.
          (p.origin_package like '%.direct')                desc,
          -- 3. Deterministic, clock-independent tiebreak.
          p.origin_package                                  asc
      ) as rn
    from public.biometric_periods p
    left join public.biometric_source_preferences pref
      on pref.user_id = p.user_id and pref.domain = 'sleep'
  ),
  sleep_winner as (select * from sleep_ranked where rn = 1),

  -- ── hrv, resolved independently ──────────────────────────────
  -- hrv_method / hrv_unit travel WITH the hrv winner, not with the row —
  -- this is the entire reason those two columns exist.
  hrv_ranked as (
    select
      p.user_id, p.source_period_id,
      p.hrv, p.hrv_method, p.hrv_unit,
      p.ingest_transport as hrv_ingest_transport,
      p.origin_package   as hrv_origin_package,
      row_number() over (
        partition by p.user_id, p.source_period_id
        order by
          (pref.ingest_transport is not null
             and pref.ingest_transport = p.ingest_transport
             and pref.origin_package  = p.origin_package)  desc,
          (p.origin_package like '%.direct')                desc,
          p.origin_package                                  asc
      ) as rn
    from public.biometric_periods p
    left join public.biometric_source_preferences pref
      on pref.user_id = p.user_id and pref.domain = 'hrv'
  ),
  hrv_winner as (select * from hrv_ranked where rn = 1),

  -- ── resting_hr, resolved independently ───────────────────────
  resting_hr_ranked as (
    select
      p.user_id, p.source_period_id,
      p.resting_heart_rate,
      p.ingest_transport as resting_hr_ingest_transport,
      p.origin_package   as resting_hr_origin_package,
      row_number() over (
        partition by p.user_id, p.source_period_id
        order by
          (pref.ingest_transport is not null
             and pref.ingest_transport = p.ingest_transport
             and pref.origin_package  = p.origin_package)  desc,
          (p.origin_package like '%.direct')                desc,
          p.origin_package                                  asc
      ) as rn
    from public.biometric_periods p
    left join public.biometric_source_preferences pref
      on pref.user_id = p.user_id and pref.domain = 'resting_hr'
  ),
  resting_hr_winner as (select * from resting_hr_ranked where rn = 1)

select
  pb.user_id,
  pb.source_period_id,
  pb.period_start,
  pb.period_end,
  pb.is_current,
  pb.timezone_offset,
  pb.local_date,
  pb.period_ingest_transport,
  pb.period_origin_package,

  pb.cycle_energy_kilojoule,
  pb.cycle_average_heart_rate,
  pb.cycle_max_heart_rate,

  pb.recovery_score,
  pb.recovery_score_state,
  pb.spo2_percentage,
  pb.skin_temp_celsius,
  pb.user_calibrating,

  pb.strain,
  pb.strain_score_state,

  sw.sleep_performance,
  sw.sleep_score_state,
  sw.sleep_ingest_transport,
  sw.sleep_origin_package,

  hw.hrv,
  hw.hrv_method,
  hw.hrv_unit,
  hw.hrv_ingest_transport,
  hw.hrv_origin_package,

  rw.resting_heart_rate,
  rw.resting_hr_ingest_transport,
  rw.resting_hr_origin_package,

  pb.source_updated_at

from period_base pb
left join sleep_winner      sw on sw.user_id = pb.user_id and sw.source_period_id = pb.source_period_id
left join hrv_winner        hw on hw.user_id = pb.user_id and hw.source_period_id = pb.source_period_id
left join resting_hr_winner rw on rw.user_id = pb.user_id and rw.source_period_id = pb.source_period_id;

comment on view public.biometric_periods_resolved is
  'Sleep, hrv, and resting_hr are resolved INDEPENDENTLY per (user_id, source_period_id), each against its own biometric_source_preferences row: preference match > direct integration > origin_package tiebreak. Period identity, strain, and recovery_score have no domain and are always the WHOOP row. A no-op on output today: one arm means every ranking has one candidate. workouts is not resolved here — see biometric_workouts.';

grant select on public.biometric_periods_resolved to authenticated;


-- ════════════════════════════════════════════════════════════
-- 4a. whoop_cycle_nutrition — repointed onto biometric_periods_resolved,
--     cycle_id widened to text
--
-- DROP + CREATE, not CREATE OR REPLACE, and in a specific order:
--   (a) cycle_id's type changes bigint -> text (see migration header),
--       which CREATE OR REPLACE VIEW never permits for an existing
--       column, full stop.
--   (b) whoop_correlation depends on this view, so IT must be dropped
--       FIRST — dependents before dependencies — or this DROP fails with
--       "cannot drop view ... other objects depend on it".
-- Both views' grants are wiped by DROP and re-issued explicitly below.
--
-- Only the CYCLE-LEVEL data source and cycle_id's type change. The
-- meal-to-cycle interval join, the confirmation gate, the grouping, and
-- the nutrition aggregation below are BYTE-IDENTICAL to
-- 20260712180000_meal_planning.sql:199-261 — including its existing
-- coalesce(sum(...), 0) lines, left untouched (see migration header).
--
-- ON, not WHERE — quoted forward from 20260712180000_meal_planning.sql:
-- 184-187: "It sits in the ON clause, not a WHERE. In the WHERE it would
-- silently convert the LEFT JOIN into an inner one and delete every
-- zero-meal cycle from the view — which is a real cycle with nothing
-- logged, not a missing cycle, and the difference is the whole point of
-- the LEFT JOIN." Unchanged below.
-- ════════════════════════════════════════════════════════════

drop view if exists public.whoop_correlation;
drop view if exists public.whoop_cycle_nutrition;

create view public.whoop_cycle_nutrition
with (security_invoker = on) as
with bounded as (
  select
    p.user_id,
    p.source_period_id           as cycle_id,   -- text now; was bigint via ::bigint cast, see header
    p.period_start                as cycle_start,
    p.period_end                  as cycle_end,
    (p.period_end is null)        as is_in_progress,
    p.strain_score_state          as score_state,
    p.strain                      as strain,
    p.cycle_energy_kilojoule      as kilojoule,
    p.cycle_average_heart_rate    as average_heart_rate,
    p.timezone_offset             as timezone_offset,
    coalesce(
      p.period_end,
      case when p.period_start > now() - interval '36 hours' then now() end
    ) as effective_end
  from public.biometric_periods_resolved p
)
select
  b.user_id,
  b.cycle_id,
  b.cycle_start,
  b.cycle_end,
  b.effective_end,
  b.is_in_progress,
  b.score_state,
  b.strain,
  b.kilojoule,
  b.average_heart_rate,
  b.timezone_offset,

  count(m.id)                         as meal_count,
  coalesce(sum(m.calories), 0)        as kcal,
  coalesce(sum(m.protein),  0)        as protein,
  coalesce(sum(m.carbs),    0)        as carbs,
  coalesce(sum(m.fat),      0)        as fat,
  coalesce(sum(m.sat_fat),  0)        as sat_fat,
  coalesce(sum(m.salt),     0)        as salt,
  coalesce(sum(m.fibre),    0)        as fibre,
  coalesce(sum(m.sugar),    0)        as sugar,

  coalesce(bool_or(m.eaten_at_estimated), false) as has_estimated_times,
  min(m.eaten_at)                     as first_meal_at,
  max(m.eaten_at)                     as last_meal_at

from bounded b
left join public.meal_entries m
       on m.user_id  = b.user_id
      and b.effective_end is not null
      and m.eaten_at >= b.cycle_start
      and m.eaten_at <  b.effective_end
      -- ── THE GATE ──────────────────────────────────────────
      -- A plan is not evidence. Only meals that actually happened.
      and (m.planned = false or m.confirmed_at is not null)
group by
  b.user_id, b.cycle_id, b.cycle_start, b.cycle_end, b.effective_end,
  b.is_in_progress, b.score_state, b.strain, b.kilojoule,
  b.average_heart_rate, b.timezone_offset;

comment on view public.whoop_cycle_nutrition is
  'Meals aggregated per cycle by UTC INTERVAL containment of eaten_at. EXCLUDES unconfirmed planned meals: a plan is not evidence. LEFT JOIN: meal_count = 0 is a real cycle with nothing logged, not a missing cycle. Cycle boundaries come from biometric_periods_resolved; cycle_id is text (was bigint) so it can carry a non-WHOOP period id once arm two exists.';

grant select on public.whoop_cycle_nutrition to authenticated;


-- ════════════════════════════════════════════════════════════
-- 4b. whoop_correlation — repointed lag() partition, cycle_id widened
--
-- The recovery (r) / sleep (s) joins below are UNCHANGED and still read
-- whoop_recoveries / whoop_sleeps directly, NOT biometric_periods_
-- resolved: that spine does not carry sleep_id, the stage-milli fields,
-- sleep_efficiency/consistency, respiratory_rate, disturbance_count, or
-- nap, all of which this view outputs. Only the CYCLE-LEVEL lag() window
-- and the recovery join's cycle_id comparison change.
--
-- r.cycle_id (whoop_recoveries, still bigint — that table is untouched)
-- is cast to text for the join against l.cycle_id (now text): bigint and
-- text have no default equality operator, so `r.cycle_id = l.cycle_id`
-- would error outright once l.cycle_id stops being bigint. The cast goes
-- on r (the WHOOP-native, permanently-bigint side), not on l, since l may
-- carry a non-numeric id once arm two exists and a bigint cast on l would
-- throw for those rows instead of simply not matching.
--
-- CRITICAL: the lag() window is repartitioned from (user_id) to
-- (user_id, period_ingest_transport, period_origin_package) — the
-- PERIOD's own provider identity (part 3), not any one domain's. Without
-- this, if two providers' periods ever interleave in one user's
-- timeline, lag() pairs cycle N's recovery with the OTHER PROVIDER'S
-- cycle N-1 nutrition — silently, and the numbers still look like
-- numbers. period_ingest_transport / period_origin_package are pulled in
-- via a join to biometric_periods_resolved purely to key the window; they
-- are not selected in the final output, so whoop_correlation's column
-- list is unchanged (cycle_id / prev_cycle_id's TYPE excepted, per (1) in
-- the migration header).
-- ════════════════════════════════════════════════════════════

create view public.whoop_correlation
with (security_invoker = on) as
with lagged as (
  select
    n.*,
    lag(n.cycle_id)            over w as prev_cycle_id,
    lag(n.cycle_start)         over w as prev_cycle_start,
    lag(n.cycle_end)           over w as prev_cycle_end,
    lag(n.meal_count)          over w as prev_meal_count,
    lag(n.kcal)                over w as prev_kcal,
    lag(n.protein)             over w as prev_protein,
    lag(n.carbs)               over w as prev_carbs,
    lag(n.fat)                 over w as prev_fat,
    lag(n.sat_fat)             over w as prev_sat_fat,
    lag(n.salt)                over w as prev_salt,
    lag(n.fibre)               over w as prev_fibre,
    lag(n.sugar)               over w as prev_sugar,
    lag(n.last_meal_at)        over w as prev_last_meal_at,
    lag(n.has_estimated_times) over w as prev_has_estimated_times
  from public.whoop_cycle_nutrition n
  left join public.biometric_periods_resolved p
         on p.user_id          = n.user_id
        and p.source_period_id = n.cycle_id
  window w as (
    partition by n.user_id, p.period_ingest_transport, p.period_origin_package
    order by n.cycle_start
  )
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
  l.prev_last_meal_at as last_meal_before_sleep_at,

  r.recovery_score,
  r.hrv_rmssd_milli,
  r.resting_heart_rate,
  r.spo2_percentage,
  r.skin_temp_celsius,
  r.user_calibrating,

  -- sleep(N) := the sleep recovery(N) POINTS AT. Not an interval join.
  s.id                               as sleep_id,
  s.sleep_performance_percentage,
  s.sleep_efficiency_percentage,
  s.sleep_consistency_percentage,
  s.respiratory_rate,
  s.total_in_bed_time_milli,
  s.total_slow_wave_sleep_time_milli,
  s.total_rem_sleep_time_milli,
  s.total_awake_time_milli,
  s.disturbance_count,
  s.nap                              as sleep_was_nap,

  -- ── TRUST FLAGS. Filter on these before plotting anything. ──
  (l.score_state = 'SCORED')                          as cycle_scored,
  (r.score_state = 'SCORED')                          as recovery_scored,
  (s.score_state = 'SCORED')                          as sleep_scored,
  (l.meal_count > 0)                                  as nutrition_present,
  (l.prev_cycle_id is not null
     and coalesce(l.prev_meal_count, 0) > 0)          as prev_nutrition_present,
  -- Is cycle N-1 actually the cycle before this one, or is there a strap-off
  -- gap between them? If they are not contiguous, the lag is meaningless.
  (l.prev_cycle_end is not null
     and l.cycle_start - l.prev_cycle_end < interval '2 hours')
                                                      as prev_cycle_contiguous,
  l.has_estimated_times                               as timing_estimated_same_cycle,
  coalesce(l.prev_has_estimated_times, false)         as timing_estimated_prev_cycle

from lagged l
left join public.whoop_recoveries r
       on r.user_id = l.user_id
      and r.cycle_id::text = l.cycle_id
left join public.whoop_sleeps s
       on s.user_id = r.user_id
      and s.id      = r.sleep_id;

comment on view public.whoop_correlation is
  'One row per cycle. *_prev_cycle nutrition pairs with recovery_* and sleep_* (what you ate BEFORE the night). *_same_cycle nutrition pairs with strain (what fuelled the day). Do not cross them. Filter on cycle_scored / recovery_scored / prev_nutrition_present / prev_cycle_contiguous before drawing any conclusion, and exclude is_in_progress = true — its strain is partial. cycle_id / prev_cycle_id are text (were bigint). The one-cycle lag window is partitioned by (user_id, period_ingest_transport, period_origin_package), not just user_id, so two providers'' periods can never contaminate each other''s lag pairing.';

grant select on public.whoop_correlation to authenticated;
