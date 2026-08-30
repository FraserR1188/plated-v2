-- ============================================================
-- biometric_periods_resolved — cross-provider frame cycles (commit two)
--
-- THE DEFECT: sleep_ranked / hrv_ranked / resting_hr_ranked partitioned by
-- (user_id, source_period_id) — provider-scoped by construction, since
-- source_period_id is whoop_cycles.id for the WHOOP arm and a Health
-- Connect provider_record_id for the synthetic arm. A WHOOP candidate and
-- a Health Connect candidate for the same real night land in DIFFERENT
-- partitions, each wins its own rn = 1, and the final join (filtered to
-- ingest_transport = 'whoop') only ever attaches the WHOOP winner.
-- biometric_source_preferences and the .direct precedence never
-- adjudicate anything — they never see two candidates at once.
--
-- THE FIX: a FRAME CYCLE is the provider-neutral key. biometric_periods
-- (WHOOP) and biometric_synthetic_cycles (Health Connect) both emit
-- onset-to-onset cycles in the same vocabulary; frame_cycles below unions
-- them, reconciles a same-night pair down to one frame, and every
-- per-domain candidate — drawn from the event-grain tables directly, not
-- from either period-grain view — is assigned to a frame by containment,
-- then ranked within (user_id, frame's own source_period_id).
--
-- ── ONLY TWO REAL CONSUMERS EXIST, CONFIRMED BY GREP ─────────────────
-- whoop_cycle_nutrition reads source_period_id, period_start, period_end,
-- strain_score_state, strain, cycle_energy_kilojoule,
-- cycle_average_heart_rate, timezone_offset. whoop_correlation reads only
-- period_ingest_transport, period_origin_package (to key its lag window).
-- NEITHER reads any sleep_*/hrv_*/resting_heart_rate*/resting_hr_* column,
-- and nothing in src/ or supabase/functions/ reads this view at all. So:
-- the WHOOP-only period-identity bucket (source_period_id, period_start,
-- period_end, is_current, timezone_offset, period_ingest_transport,
-- period_origin_package, cycle_energy_kilojoule, cycle_average_heart_rate,
-- cycle_max_heart_rate, strain, strain_score_state, recovery_score,
-- recovery_score_state, spo2_percentage, skin_temp_celsius,
-- user_calibrating, source_updated_at) keeps its EXACT existing names —
-- verified with the byte-identical acceptance diff in this migration's
-- verify file — so CREATE OR REPLACE VIEW stays valid and neither
-- consumer needs touching. Only the per-domain shape (sleep/hrv/
-- resting_hr) and what feeds it changes.
--
-- ── FRAME RECONCILIATION: EXACT cycle_start MATCH, WHOOP WINS ────────
-- commit one's own acceptance test proved WHOOP and synthetic cycle_start
-- agree to the microsecond for the shared-device test accounts, so
-- reconciliation keys on exact equality, not a time-overlap window —
-- unlike biometric_workouts' dedup, which needed overlap matching because
-- WHOOP's workout id and a Health Connect provider_record_id share no
-- key. Where both arms produce a row for the same instant, WHOOP wins:
-- not a preference (biometric_source_preferences has no domain for "which
-- provider defines the grid," and none is added here — this isn't taste,
-- WHOOP's row is strictly richer, carrying strain and recovery that
-- Health Connect structurally cannot produce).
--
-- CAVEAT, not fixed here: exact equality was proven only for one physical
-- device writing both paths. Two genuinely independent devices disagreeing
-- by even a minute would fail the exact match and produce two
-- OVERLAPPING frames for one real night — see the hard gate below, which
-- exists specifically because that case cannot be silently tolerated.
--
-- ── THE HARD GATE ─────────────────────────────────────────────────────
-- unreconciled_overlaps finds cross-arm candidate pairs, for the same
-- user, whose cycle_start values are NOT identical (the handled case,
-- above) but whose [cycle_start, effective_end) spans overlap anyway —
-- exactly the two-independent-devices scenario. Both candidates in such a
-- pair are excluded from frame_cycles entirely: no frame is emitted for
-- either. This is the same "an untrustworthy boundary gets no row, not a
-- guessed one" principle as biometric_synthetic_cycles' >36h ceiling
-- suppression, applied to a new hazard. It does not fabricate a preferred
-- winner between the two, because there is no principled basis to pick
-- one — a >90s disagreement means the arms cannot even agree on which
-- night they are describing.
--
-- Scoped to CROSS-ARM overlaps only. Two Health-Connect-sourced frames
-- from DIFFERENT origin_packages (e.g. Garmin and Fitbit both
-- contributing) overlapping each other is a different, deeper problem —
-- effectively "which device wins" — not solved here; logged as a
-- follow-up at the end of this file.
--
-- ── effective_end IS PROVIDER-BLIND, APPLIED BEFORE RECONCILIATION ───
-- Two of a8435663's own WHOOP cycles are confirmed permanently NULL-end
-- (whoop-sync follow-up, logged against 20260830170000's verify file) —
-- a demonstrated hazard, not a hypothetical one, and it applies to the
-- WHOOP arm exactly as much as a stale synthetic one. whoop_cycle_nutrition
-- already survives this today only because its own effective_end gate is
-- provider-blind — it reads period_start/period_end generically, it does
-- not know or care which arm produced them. This migration computes the
-- identical formula, coalesce(cycle_end, case when cycle_start >
-- now() - interval '36 hours' then now() end), on EVERY candidate before
-- reconciliation and before any per-domain containment test — a stale
-- is_current row from either arm gets a NULL effective_end and can never
-- greedily claim an event that belongs to a later, correctly-bounded
-- frame.
--
-- ── local_date: ONE ANCHOR FOR THE WHOLE VIEW, WAKE-ANCHORED ─────────
-- biometric_periods (WHOOP arm) computes local_date from cycle START;
-- biometric_synthetic_cycles computes it from the WAKE instant — proven
-- correct in that commit (onset-keying produced phantom missing nights).
-- Passing either arm's own local_date through unchanged would mean this
-- one output column carries two different anchors depending on which arm
-- won a given frame, silently. This view emits WAKE-anchored local_date
-- uniformly, for every frame regardless of source arm. For a synthetic
-- frame that is direct — block_wake_at/wake_timezone_offset are exactly
-- what commit one added for this. For a WHOOP frame there is no such
-- column on biometric_periods today, so whoop_periods below re-derives
-- the wake instant directly from whoop_sleeps."end" via the same
-- recovery.sleep_id pointer biometric_periods already uses internally —
-- re-derived rather than by adding a column to that view, since this
-- commit does not touch biometric_periods.
--
-- ── PER-DOMAIN CANDIDATES: RAW EVENT-GRAIN TABLES, NOT PERIOD VIEWS ──
-- Per the brief: candidates are drawn from biometric_sleep_sessions /
-- biometric_hrv_samples / biometric_resting_hr directly, assigned to a
-- frame by containment — never from biometric_synthetic_cycles (that
-- view is already merged/filtered for CYCLE BOUNDARY purposes: the nap
-- exclusion and duration floor answer "is this a legitimate onset," a
-- different question from "is this a legitimate sleep-quality reading to
-- report for an already-established frame"). This means a nap or a
-- sub-floor session CAN contribute sleep-domain data if its midpoint
-- happens to fall inside a frame — a deliberate, lower-stakes choice
-- (unlike a wrong cycle boundary, a wrong sleep_efficiency_percentage
-- input is not load-bearing for anything else in this schema today) and
-- not a silent one.
--
-- Assignment instants, verified against production, not re-derived here:
-- resting-HR and HRV candidates use plain measured_at containment
-- (resting-HR: wake-instant-restamped, 4.9-10.8h inside its cycle under
-- onset anchoring; HRV: no onset/wake ambiguity, a single point in time).
-- Health Connect SLEEP candidates use the session's MIDPOINT, not onset:
-- onset sits exactly on a frame boundary by construction, so a second
-- device's independent ~20-minute onset-detection disagreement could push
-- it across into the wrong frame; the midpoint sits hours interior and
-- cannot be dislodged by that kind of drift. WHOOP's own sleep/hrv/
-- resting-hr candidates need no containment test at all — they are linked
-- to their cycle by recovery.cycle_id / recovery.sleep_id, an authoritative
-- pointer already resolved inside biometric_periods, not inferred by time.
--
-- sleep_performance stays WHOOP's own metric, populated only when a WHOOP
-- candidate wins the sleep domain. Health Connect's sleep_efficiency_
-- percentage is a DIFFERENT, non-identical metric (currently always NULL
-- — the ingest mapper never populates it, Health Connect computes no
-- WHOOP-style score) and is not poured into the same column under a
-- shared name; a Health-Connect-won sleep domain reports
-- sleep_performance = NULL with correct sleep_ingest_transport/
-- sleep_origin_package provenance. Surfacing sleep_efficiency_percentage
-- as its own column is a real future improvement, out of scope here
-- (nothing populates it today) — logged, not built.
--
-- Every WHOOP-only metric (cycle_energy_kilojoule, strain,
-- strain_score_state, recovery_score, recovery_score_state, etc.) is an
-- explicit NULL literal on the synthetic arm — never a fabricated state
-- string like 'UNSCORED': absent means absent, and a consumer branching
-- on a state string must never read a fabricated one as real.
--
-- ── ORDER BY IS UNCHANGED ─────────────────────────────────────────────
-- Preference match > .direct outranks Health Connect > origin_package
-- tiebreak — byte-identical to the shipped ranking logic. Only the
-- PARTITION key moves, from source_period_id to the frame's own
-- source_period_id (now potentially shared across two arms' candidates).
--
-- ── NON-OVERLAP / CONTIGUITY: THE INVARIANT A LATER COMMIT NEEDS ─────
-- frame_cycles is proven non-overlapping and contiguous PER USER (not per
-- (user_id, origin_package) the way biometric_synthetic_cycles proves it
-- internally) in the verify file. This is what would let a future
-- whoop_correlation repointing simplify its lag() window back to a plain
-- partition by user_id — not done in this commit, whoop_correlation is
-- untouched, this only establishes the invariant that repointing would
-- rely on.
--
-- ── security_invoker = on: CHECKED ────────────────────────────────────
-- Re-verified by reading the CREATE VIEW statement below immediately
-- before writing this line.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- The resolved view itself.
--
-- whoop_periods and synthetic_periods are the two swappable real-table
-- dependencies (the same fixture technique as commit one: isolate every
-- real-table read into its own top-level CTE, copy everything downstream
-- verbatim, substitute a VALUES block for whichever CTE a fixture needs
-- to control). An earlier draft of this migration made whoop_periods a
-- separate persistent VIEW instead of a CTE — wrong, and not just for
-- style: a security_invoker view calling another security_invoker view
-- requires the INVOKING role to hold SELECT on the inner view too, and
-- revoking that (to keep it out of the public API) would have made every
-- authenticated call to biometric_periods_resolved fail outright. A CTE
-- has no privilege boundary of its own to get wrong.
--
-- CREATE OR REPLACE, not DROP + CREATE: whoop_cycle_nutrition reads this
-- view and whoop_correlation reads both this view and
-- whoop_cycle_nutrition, so a bare DROP fails outright on the dependency
-- (and CASCADE would take both consumers down with it). It is also
-- unnecessary — the final column list below is byte-identical in name,
-- order, and type to the version it replaces (verified by comparison,
-- and again by the V1 snapshot diff in the verify file), which is exactly
-- what CREATE OR REPLACE VIEW requires. If this statement ever errors on
-- push, that error IS the signal that a column moved — fix the column
-- list, do not reach for DROP as a workaround.
-- ════════════════════════════════════════════════════════════
create or replace view public.biometric_periods_resolved
with (security_invoker = on) as
with

-- WHOOP arm: biometric_periods plus the one field it does not expose (the
-- wake instant), re-derived via the same recovery.sleep_id pointer
-- biometric_periods already resolves internally — not by adding a column
-- to that view, which this commit does not touch.
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

-- THE HARD GATE. See migration header. Both members of an unreconciled
-- cross-arm overlapping pair land here and are excluded below.
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
    ingest_transport   as whoop_or_hc, -- which arm actually won this frame
    case
      when wake_timezone_offset ~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
        then ((wake_at at time zone 'UTC') + wake_timezone_offset::interval)::date
      else null::date
    end as local_date
  from ranked_periods
  where rn = 1
),

-- ── sleep domain ──────────────────────────────────────────────────────
-- The WHOOP arm nominates a candidate ONLY when it actually has a value.
-- A NULL-valued nomination would still out-rank a real Health Connect
-- reading via the .direct tiebreak below, purely because a row exists —
-- which is the absent-vs-present distinction NULL-not-zero exists to
-- protect, inverted: provenance would say WHOOP supplied this, when WHOOP
-- supplied nothing.
sleep_candidates as (
  select
    user_id, source_period_id as frame_key,
    whoop_sleep_performance as sleep_performance,
    whoop_sleep_score_state as sleep_score_state,
    'whoop'::text as ingest_transport,
    'whoop.direct'::text as origin_package
  from frame_cycles
  where whoop_or_hc = 'whoop'
    and whoop_sleep_performance is not null
  union all
  select
    fc.user_id, fc.source_period_id as frame_key,
    null::numeric as sleep_performance,
    null::text    as sleep_score_state,
    'health_connect'::text as ingest_transport,
    s.origin_package
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

-- ── hrv domain — empty on the Health Connect side today; must not error,
--    must not fabricate, must not drop the frame (LEFT JOIN below) ─────
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

-- ── resting_hr domain ─────────────────────────────────────────────────
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

  fc.source_updated_at

from frame_cycles fc
left join sleep_winner      sw on sw.user_id = fc.user_id and sw.frame_key = fc.source_period_id
left join hrv_winner        hw on hw.user_id = fc.user_id and hw.frame_key = fc.source_period_id
left join resting_hr_winner rw on rw.user_id = fc.user_id and rw.frame_key = fc.source_period_id;

comment on view public.biometric_periods_resolved is
  'Per-domain (sleep/hrv/resting_hr) resolution across BOTH the WHOOP and Health Connect arms, keyed on frame cycles (union of biometric_periods'' WHOOP arm and biometric_synthetic_cycles, reconciled by exact cycle_start match, WHOOP wins on merit). Unreconciled cross-arm overlaps (two independent devices disagreeing on onset) are suppressed entirely, not guessed. local_date is wake-anchored uniformly regardless of which arm won the frame. Period-identity columns (source_period_id/period_start/period_end/is_current/timezone_offset/period_ingest_transport/period_origin_package/cycle_energy_kilojoule/cycle_average_heart_rate/cycle_max_heart_rate/strain*/recovery*/spo2_percentage/skin_temp_celsius/user_calibrating/source_updated_at) are byte-identical in name and WHOOP-arm value to the prior version — verified in this migration''s verify file — so whoop_cycle_nutrition and whoop_correlation, the only two consumers, need no changes.';

grant select on public.biometric_periods_resolved to authenticated;

-- ============================================================
-- NOT in this migration (deliberately deferred)
--
-- Same-arm, cross-origin_package overlaps within the synthetic arm itself
-- (e.g. Garmin and Fitbit both contributing Health Connect sleep data for
-- one user) are not detected by unreconciled_overlaps, which is scoped to
-- cross-ARM pairs only. That is a "which device wins" problem structurally
-- like biometric_workouts' own dedup, not solved here.
--
-- The independent-device tolerance window (a genuine two-device
-- disagreement within a few minutes, not an exact match) is out of scope,
-- per this migration's own header — such a pair is suppressed, not
-- reconciled, until a tolerance-window design is built.
--
-- sleep_efficiency_percentage as its own output column (Health Connect's
-- distinct, currently-always-NULL sleep metric) is not surfaced — nothing
-- populates it today; logged as a future addition, not built.
--
-- whoop_correlation's lag() window is untouched, still partitioned by
-- (user_id, period_ingest_transport, period_origin_package). This
-- migration establishes that frame_cycles is non-overlapping and
-- contiguous per user (see verify file) specifically so that a future
-- repointing of whoop_correlation onto frame cycles could simplify that
-- window back to a plain partition by user_id — not done here.
--
-- The per-user contiguity invariant does not hold for the two stale WHOOP
-- cycles (whoop-sync follow-up, logged against 20260830170000's verify
-- file) — they get candidate_effective_end = NULL and are neither
-- provably non-overlapping with their successor nor provably contiguous;
-- see V2 in this migration's own verify file for how that is reported
-- rather than hidden. A related, NOT pursued here, question for whoever
-- eventually fixes the whoop-sync backfill: biometric_periods' WHOOP arm
-- trusts whoop_cycles."end" verbatim, unlike biometric_synthetic_cycles,
-- which never trusts a raw end field and always derives cycle_end from
-- lead(next onset). WHOOP's own cycle starts ARE contiguous even for
-- these two rows (the follow-up's own finding), so the same healing
-- WOULD be possible for the WHOOP arm — deliberately not attempted here,
-- since it would mean biometric_periods stops being a faithful,
-- undecorated passthrough of WHOOP's own reported fields, which is a
-- bigger call than this migration's scope.
-- ============================================================
