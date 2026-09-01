-- ============================================================================
-- 20260901120000_biometric_periods_resolved_sleep_pointer.sql
-- Commit three, part two-B (1 of 2) — sleep-domain winner pointer
--
-- Adds one trailing column, sleep_source_record_id, to
-- biometric_periods_resolved: the winning Health Connect sleep session's own
-- provider_record_id, carried alongside the existing sleep_ingest_transport/
-- sleep_origin_package provenance columns. NULL on the WHOOP arm and on any
-- frame with no sleep winner at all.
--
-- ── A POINTER, NOT A VALUE ──────────────────────────────────────────────────
-- This migration resolves WHICH biometric_sleep_sessions row won the sleep
-- domain for a frame; it does not resolve, pool, average, or otherwise touch
-- any sleep VALUE. sleep_candidates/sleep_ranked/sleep_winner already decide
-- the winner today (preference match > .direct > origin_package tiebreak) —
-- this migration only makes that decision legible to a downstream consumer
-- by exposing the winning row's own primary-key components
-- (origin_package was already exposed; provider_record_id is the piece that
-- was missing to actually join back to the row). The same idiom this schema
-- already uses for whoop_recoveries.sleep_id: a pointer bridge, not a
-- pooled value.
--
-- ── WHY A POINTER BRIDGE INSTEAD OF A SECOND CONTAINMENT JOIN ──────────────
-- The alternative — a consumer re-deriving "which HC session wins this
-- frame" itself via a fresh midpoint-containment join against
-- biometric_sleep_sessions — has two problems this avoids. First, it
-- duplicates the ranking logic that already lives here (preference/
-- .direct/origin_package), with its own chance to disagree about which
-- session won. Second, and more dangerous: a plain containment join has no
-- structural bound on how many sessions can fall inside one frame's window
-- — two qualifying sessions in one window fan out to two rows, silently
-- duplicating every downstream figure on that frame. A join on
-- sleep_source_record_id, by contrast, targets
-- biometric_sleep_sessions' actual primary key
-- (user_id, origin_package, provider_record_id) — it CANNOT return more
-- than one row, structurally, not by luck of today's data. Proven, not just
-- argued, in this migration's verify file (part two-B's F4/sabotage 1): a
-- constructed two-session-in-one-frame fixture fans out to 2 rows under a
-- naive containment join and stays at 1 under the pointer-bridge join.
--
-- Production has ZERO frames with more than one HC session inside one
-- window under midpoint containment today (measured before writing this
-- migration) — so the fan-out advantage is structural, not yet demonstrated
-- by any real frame. It is not hypothetical: it is proven in a throwaway
-- container against constructed data, and it is the reason this design was
-- chosen over the simpler-looking alternative.
--
-- ── TRAILING COLUMN, CREATE OR REPLACE STAYS LEGAL ─────────────────────────
-- Confirmed by execution, not assumed: this migration's CREATE OR REPLACE
-- VIEW statement was run in a throwaway container against the full real
-- dependency chain (biometric_periods, biometric_synthetic_cycles, and the
-- OLD biometric_periods_resolved applied first) and succeeded. No existing
-- column's name, position, or type changes — sleep_source_record_id is
-- appended strictly after the previous last column, source_updated_at.
-- whoop_cycle_nutrition (this view's other consumer) does not read this
-- column and is unaffected.
--
-- ── NO SLEEP VALUES ADDED HERE ──────────────────────────────────────────────
-- The Health Connect stage-level columns (deep/rem/awake/in-bed/total-sleep
-- minutes) are NOT added to this view. They belong to whoop_correlation
-- (part two-B, 2 of 2, the next migration), reached via this pointer, kept
-- with a `_hc` suffix, never sharing a column with their WHOOP counterparts.
-- This view resolves identity; it does not pool constructs.
-- ============================================================================

create or replace view public.biometric_periods_resolved
with (security_invoker = on) as
with

whoop_periods as (
  select
    p.user_id,
    p.source_period_id,
    p.period_start                as cycle_start,
    p.period_end                  as cycle_end,
    p.is_current,
    p.timezone_offset,
    p.ingest_transport,
    p.origin_package,
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
    p.source_updated_at,
    p.sleep_performance,
    p.sleep_score_state,
    p.hrv,
    p.hrv_method,
    p.hrv_unit,
    p.resting_heart_rate,
    s."end"            as wake_at,
    s.timezone_offset  as wake_timezone_offset
  from public.biometric_periods p
  left join public.whoop_recoveries r
    on r.user_id = p.user_id and r.cycle_id::text = p.source_period_id
  left join public.whoop_sleeps s
    on s.user_id = r.user_id and s.id = r.sleep_id
  where p.ingest_transport = 'whoop'
),

synthetic_periods as (
  select
    sc.user_id,
    sc.source_period_id,
    sc.cycle_start,
    sc.cycle_end,
    sc.is_current,
    sc.timezone_offset,
    sc.ingest_transport,
    sc.origin_package,
    null::numeric  as cycle_energy_kilojoule,
    null::integer  as cycle_average_heart_rate,
    null::integer  as cycle_max_heart_rate,
    null::numeric  as strain,
    null::text     as strain_score_state,
    null::numeric  as recovery_score,
    null::text     as recovery_score_state,
    null::numeric  as spo2_percentage,
    null::numeric  as skin_temp_celsius,
    null::boolean  as user_calibrating,
    null::timestamptz as source_updated_at,
    null::numeric  as sleep_performance,
    null::text     as sleep_score_state,
    null::numeric  as hrv,
    null::text     as hrv_method,
    null::text     as hrv_unit,
    null::numeric  as resting_heart_rate,
    sc.block_wake_at        as wake_at,
    sc.wake_timezone_offset as wake_timezone_offset
  from public.biometric_synthetic_cycles sc
),

all_periods as (
  select * from whoop_periods
  union all
  select * from synthetic_periods
),

bounded_periods as (
  select *,
    coalesce(cycle_end, case when cycle_start > now() - interval '36 hours' then now() end)
      as candidate_effective_end
  from all_periods
),

unreconciled_overlaps as (
  select distinct a.user_id, a.source_period_id, a.ingest_transport, a.origin_package
  from bounded_periods a
  join bounded_periods b
    on b.user_id = a.user_id
   and b.ingest_transport <> a.ingest_transport
   and b.cycle_start is distinct from a.cycle_start
   and a.cycle_start < b.candidate_effective_end
   and b.cycle_start < a.candidate_effective_end
),

clean_periods as (
  select bp.*
  from bounded_periods bp
  where not exists (
    select 1 from unreconciled_overlaps u
    where u.user_id = bp.user_id
      and u.source_period_id = bp.source_period_id
      and u.ingest_transport = bp.ingest_transport
      and u.origin_package = bp.origin_package
  )
),

ranked_periods as (
  select *,
    row_number() over (
      partition by user_id, cycle_start
      order by (ingest_transport = 'whoop') desc, origin_package asc
    ) as rn
  from clean_periods
),

frame_cycles as (
  select
    user_id,
    source_period_id,
    cycle_start,
    cycle_end,
    candidate_effective_end as effective_end,
    is_current,
    timezone_offset,
    ingest_transport   as frame_ingest_transport,
    origin_package     as frame_origin_package,
    cycle_energy_kilojoule,
    cycle_average_heart_rate,
    cycle_max_heart_rate,
    strain,
    strain_score_state,
    recovery_score,
    recovery_score_state,
    spo2_percentage,
    skin_temp_celsius,
    user_calibrating,
    source_updated_at,
    sleep_performance  as whoop_sleep_performance,
    sleep_score_state  as whoop_sleep_score_state,
    hrv                as whoop_hrv,
    hrv_method         as whoop_hrv_method,
    hrv_unit           as whoop_hrv_unit,
    resting_heart_rate as whoop_resting_heart_rate,
    ingest_transport   as whoop_or_hc,
    case
      when wake_timezone_offset ~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
        then ((wake_at at time zone 'UTC') + wake_timezone_offset::interval)::date
      else null::date
    end as local_date
  from ranked_periods
  where rn = 1
),

-- ── sleep domain ──────────────────────────────────────────────────────
-- ADDED (this migration): source_record_id. The HC arm carries the
-- session's own provider_record_id; the WHOOP arm carries null::text — the
-- WHOOP-side sleep pointer bridge is whoop_recoveries.sleep_id, already
-- resolved elsewhere, not this column's job.
sleep_candidates as (
  select
    user_id, source_period_id as frame_key,
    whoop_sleep_performance as sleep_performance,
    whoop_sleep_score_state as sleep_score_state,
    'whoop'::text as ingest_transport,
    'whoop.direct'::text as origin_package,
    null::text as source_record_id
  from frame_cycles
  where whoop_or_hc = 'whoop'
    and whoop_sleep_performance is not null
  union all
  select
    fc.user_id, fc.source_period_id as frame_key,
    null::numeric as sleep_performance,
    null::text    as sleep_score_state,
    'health_connect'::text as ingest_transport,
    s.origin_package,
    s.provider_record_id as source_record_id
  from public.biometric_sleep_sessions s
  join frame_cycles fc
    on fc.user_id = s.user_id
   and (s.period_start + (s.period_end - s.period_start) / 2) >= fc.cycle_start
   and fc.effective_end is not null
   and (s.period_start + (s.period_end - s.period_start) / 2) <  fc.effective_end
  where s.ingest_transport = 'health_connect'
),
sleep_ranked as (
  select sc.*,
    row_number() over (
      partition by sc.user_id, sc.frame_key
      order by
        (pref.ingest_transport is not null
           and pref.ingest_transport = sc.ingest_transport
           and pref.origin_package  = sc.origin_package)  desc,
        (sc.origin_package like '%.direct')                desc,
        sc.origin_package                                  asc
    ) as rn
  from sleep_candidates sc
  left join public.biometric_source_preferences pref
    on pref.user_id = sc.user_id and pref.domain = 'sleep'
),
sleep_winner as (select * from sleep_ranked where rn = 1),

hrv_candidates as (
  select
    user_id, source_period_id as frame_key,
    whoop_hrv as hrv, whoop_hrv_method as hrv_method, whoop_hrv_unit as hrv_unit,
    'whoop'::text as ingest_transport,
    'whoop.direct'::text as origin_package
  from frame_cycles
  where whoop_or_hc = 'whoop'
    and whoop_hrv is not null
  union all
  select
    fc.user_id, fc.source_period_id as frame_key,
    h.hrv_value as hrv, h.hrv_method, h.hrv_unit,
    'health_connect'::text as ingest_transport,
    h.origin_package
  from public.biometric_hrv_samples h
  join frame_cycles fc
    on fc.user_id = h.user_id
   and h.measured_at >= fc.cycle_start
   and fc.effective_end is not null
   and h.measured_at <  fc.effective_end
  where h.ingest_transport = 'health_connect'
),
hrv_ranked as (
  select hc.*,
    row_number() over (
      partition by hc.user_id, hc.frame_key
      order by
        (pref.ingest_transport is not null
           and pref.ingest_transport = hc.ingest_transport
           and pref.origin_package  = hc.origin_package)  desc,
        (hc.origin_package like '%.direct')                desc,
        hc.origin_package                                  asc
    ) as rn
  from hrv_candidates hc
  left join public.biometric_source_preferences pref
    on pref.user_id = hc.user_id and pref.domain = 'hrv'
),
hrv_winner as (select * from hrv_ranked where rn = 1),

resting_hr_candidates as (
  select
    user_id, source_period_id as frame_key,
    whoop_resting_heart_rate as resting_heart_rate,
    'whoop'::text as ingest_transport,
    'whoop.direct'::text as origin_package
  from frame_cycles
  where whoop_or_hc = 'whoop'
    and whoop_resting_heart_rate is not null
  union all
  select
    fc.user_id, fc.source_period_id as frame_key,
    r.resting_heart_rate,
    'health_connect'::text as ingest_transport,
    r.origin_package
  from public.biometric_resting_hr r
  join frame_cycles fc
    on fc.user_id = r.user_id
   and r.measured_at >= fc.cycle_start
   and fc.effective_end is not null
   and r.measured_at <  fc.effective_end
  where r.ingest_transport = 'health_connect'
),
resting_hr_ranked as (
  select rc.*,
    row_number() over (
      partition by rc.user_id, rc.frame_key
      order by
        (pref.ingest_transport is not null
           and pref.ingest_transport = rc.ingest_transport
           and pref.origin_package  = rc.origin_package)  desc,
        (rc.origin_package like '%.direct')                desc,
        rc.origin_package                                  asc
    ) as rn
  from resting_hr_candidates rc
  left join public.biometric_source_preferences pref
    on pref.user_id = rc.user_id and pref.domain = 'resting_hr'
),
resting_hr_winner as (select * from resting_hr_ranked where rn = 1)

select
  fc.user_id,
  fc.source_period_id,
  fc.cycle_start   as period_start,
  fc.cycle_end     as period_end,
  fc.is_current,
  fc.timezone_offset,
  fc.local_date,
  fc.frame_ingest_transport as period_ingest_transport,
  fc.frame_origin_package   as period_origin_package,

  fc.cycle_energy_kilojoule,
  fc.cycle_average_heart_rate,
  fc.cycle_max_heart_rate,

  fc.recovery_score,
  fc.recovery_score_state,
  fc.spo2_percentage,
  fc.skin_temp_celsius,
  fc.user_calibrating,

  fc.strain,
  fc.strain_score_state,

  sw.sleep_performance,
  sw.sleep_score_state,
  sw.ingest_transport as sleep_ingest_transport,
  sw.origin_package   as sleep_origin_package,

  hw.hrv,
  hw.hrv_method,
  hw.hrv_unit,
  hw.ingest_transport as hrv_ingest_transport,
  hw.origin_package   as hrv_origin_package,

  rw.resting_heart_rate,
  rw.ingest_transport as resting_hr_ingest_transport,
  rw.origin_package   as resting_hr_origin_package,

  fc.source_updated_at,

  -- TRAILING (this migration). See header.
  sw.source_record_id as sleep_source_record_id

from frame_cycles fc
left join sleep_winner      sw on sw.user_id = fc.user_id and sw.frame_key = fc.source_period_id
left join hrv_winner        hw on hw.user_id = fc.user_id and hw.frame_key = fc.source_period_id
left join resting_hr_winner rw on rw.user_id = fc.user_id and rw.frame_key = fc.source_period_id;

comment on view public.biometric_periods_resolved is
  'Per-domain (sleep/hrv/resting_hr) resolution across BOTH the WHOOP and Health Connect arms, keyed on frame cycles. Unreconciled cross-arm overlaps are suppressed entirely, not guessed. local_date is wake-anchored uniformly. sleep_source_record_id (20260901120000) is the winning Health Connect sleep session''s own provider_record_id — a POINTER, not a value, NULL on the WHOOP arm and on any frame with no sleep winner. Join it against biometric_sleep_sessions on (user_id, sleep_origin_package, sleep_source_record_id) — that is the table''s actual primary key, so the join cannot fan out. Do not resolve or pool any Health Connect sleep VALUE into this view; that belongs downstream (whoop_correlation), reached through this pointer, never sharing a column with its WHOOP counterpart. Period-identity columns are byte-identical in name and WHOOP-arm value to the prior version.';

grant select on public.biometric_periods_resolved to authenticated;
