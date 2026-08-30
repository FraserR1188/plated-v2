-- ============================================================================
-- Verification — 20260830180000_biometric_periods_resolved_cross_provider.sql
-- ============================================================================

-- ── V0. BASELINE — run BEFORE applying this migration ─────────────────────
-- The only two real consumers of biometric_periods_resolved. Persisted past
-- the migration on purpose (session-scoped TEMP would not survive a
-- separate before/after session). Drop both once V1 has passed.
--
-- create table public._snapshot_whoop_cycle_nutrition_pre as
-- select * from public.whoop_cycle_nutrition
-- where user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
--                    '4dbf04ae-7b46-4511-8122-f17284c622d9');
--
-- create table public._snapshot_whoop_correlation_pre as
-- select * from public.whoop_correlation
-- where user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
--                    '4dbf04ae-7b46-4511-8122-f17284c622d9');
--
-- select count(*) from public._snapshot_whoop_cycle_nutrition_pre;  -- note
-- select count(*) from public._snapshot_whoop_correlation_pre;      -- note


-- ── V1. BYTE-IDENTICAL PROOF — run AFTER applying this migration ─────────
-- MUST be scoped to WHOOP-covered cycles, not a bare diff of the whole
-- table. frame_cycles now emits synthetic-only frames too: for 4dbf04ae
-- that is 180 synthetic cycles minus the 8 that collapsed into an exact
-- WHOOP match, so roughly 172 new rows flow into whoop_cycle_nutrition,
-- each aggregating meals against a Health-Connect-derived cycle. That is
-- the feature working, not a regression — but neither
-- whoop_cycle_nutrition nor whoop_correlation exposes
-- period_ingest_transport in their own output (only used internally to
-- key whoop_correlation's lag window), so the scope has to come from a
-- join to whoop_cycles on cycle_id, not a column filter on the consumer's
-- own output.
--
-- a8435663 has no Health Connect data of its own (confirmed:
-- biometric_synthetic_cycles is empty for that user_id), so its WHOOP-
-- covered subset is its ENTIRE output — its rows should be completely
-- unchanged, and that is itself a check worth keeping separate from
-- 4dbf04ae's, since 4dbf04ae's comparison passing does not prove
-- a8435663 was unaffected.
-- COLUMN LIST IS EXPLICIT, NOT `p.*`/`n.*`, AND OMITS effective_end ON
-- PURPOSE. whoop_cycle_nutrition computes effective_end as
-- coalesce(period_end, case when period_start > now() - interval '36
-- hours' then now() end) — for any in-progress cycle that evaluates to
-- the CURRENT CLOCK, so it differs between the moment the snapshot was
-- taken and the moment this query runs, on every single execution. A
-- snapshot freezes a now()-derived value; the live view re-evaluates it.
-- `select p.*` can never pass while that column is in scope — confirmed
-- live: cycle 1755266350 (an in-progress cycle) diffed on effective_end
-- alone, 13:19:03.145074 vs 13:20:09.293571, with every other column
-- identical. THE RULE: a now()-derived column cannot participate in a
-- snapshot diff at all, ever — not "usually doesn't," structurally can't.
-- Any future snapshot test must enumerate columns, never select *, so a
-- newly added now()-derived column is a conscious choice to exclude, not
-- a silent, permanent failure discovered by surprise.
with whoop_cycle_ids as (
  select user_id, id::text as cycle_id
  from public.whoop_cycles
  where user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
                     '4dbf04ae-7b46-4511-8122-f17284c622d9')
)
(
  select
    p.user_id, p.cycle_id, p.cycle_start, p.cycle_end, p.is_in_progress,
    p.score_state, p.strain, p.kilojoule, p.average_heart_rate, p.timezone_offset,
    p.meal_count, p.kcal, p.protein, p.carbs, p.fat, p.sat_fat, p.salt, p.fibre, p.sugar,
    p.has_estimated_times, p.first_meal_at, p.last_meal_at
  from public._snapshot_whoop_cycle_nutrition_pre p
  join whoop_cycle_ids w on w.user_id = p.user_id and w.cycle_id = p.cycle_id
  except
  select
    n.user_id, n.cycle_id, n.cycle_start, n.cycle_end, n.is_in_progress,
    n.score_state, n.strain, n.kilojoule, n.average_heart_rate, n.timezone_offset,
    n.meal_count, n.kcal, n.protein, n.carbs, n.fat, n.sat_fat, n.salt, n.fibre, n.sugar,
    n.has_estimated_times, n.first_meal_at, n.last_meal_at
  from public.whoop_cycle_nutrition n
  join whoop_cycle_ids w on w.user_id = n.user_id and w.cycle_id = n.cycle_id
)
union all
(
  select
    n.user_id, n.cycle_id, n.cycle_start, n.cycle_end, n.is_in_progress,
    n.score_state, n.strain, n.kilojoule, n.average_heart_rate, n.timezone_offset,
    n.meal_count, n.kcal, n.protein, n.carbs, n.fat, n.sat_fat, n.salt, n.fibre, n.sugar,
    n.has_estimated_times, n.first_meal_at, n.last_meal_at
  from public.whoop_cycle_nutrition n
  join whoop_cycle_ids w on w.user_id = n.user_id and w.cycle_id = n.cycle_id
  except
  select
    p.user_id, p.cycle_id, p.cycle_start, p.cycle_end, p.is_in_progress,
    p.score_state, p.strain, p.kilojoule, p.average_heart_rate, p.timezone_offset,
    p.meal_count, p.kcal, p.protein, p.carbs, p.fat, p.sat_fat, p.salt, p.fibre, p.sugar,
    p.has_estimated_times, p.first_meal_at, p.last_meal_at
  from public._snapshot_whoop_cycle_nutrition_pre p
  join whoop_cycle_ids w on w.user_id = p.user_id and w.cycle_id = p.cycle_id
);
-- Expect ZERO rows.

-- whoop_correlation does NOT select effective_end at all, so `p.*`/`c.*`
-- is currently safe here — but that is an accident of what this view
-- happens to expose today, not evidence the star is a sound pattern. The
-- same rule applies: if whoop_correlation ever grows a now()-derived
-- column, this diff silently starts failing on every run, the same way
-- the nutrition diff above just did. Left as `p.*`/`c.*` for now rather
-- than enumerated speculatively — enumerate it the day it actually grows
-- one, not before.
with whoop_cycle_ids as (
  select user_id, id::text as cycle_id
  from public.whoop_cycles
  where user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
                     '4dbf04ae-7b46-4511-8122-f17284c622d9')
)
(
  select p.* from public._snapshot_whoop_correlation_pre p
  join whoop_cycle_ids w on w.user_id = p.user_id and w.cycle_id = p.cycle_id
  except
  select c.* from public.whoop_correlation c
  join whoop_cycle_ids w on w.user_id = c.user_id and w.cycle_id = c.cycle_id
)
union all
(
  select c.* from public.whoop_correlation c
  join whoop_cycle_ids w on w.user_id = c.user_id and w.cycle_id = c.cycle_id
  except
  select p.* from public._snapshot_whoop_correlation_pre p
  join whoop_cycle_ids w on w.user_id = p.user_id and w.cycle_id = p.cycle_id
);
-- Expect ZERO rows.
--
-- drop table public._snapshot_whoop_cycle_nutrition_pre;
-- drop table public._snapshot_whoop_correlation_pre;


-- ── V1b. SYNTHETIC-ONLY ADDITIONS — asserted separately, not as a diff ───
-- The rows V1 deliberately excludes. Reported as a count to confirm
-- against, not asserted as a hardcoded expectation this file has not
-- itself run against live data.
select
  n.user_id,
  count(*) as synthetic_only_cycle_nutrition_rows
from public.whoop_cycle_nutrition n
where n.user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
                     '4dbf04ae-7b46-4511-8122-f17284c622d9')
  and not exists (
    select 1 from public.whoop_cycles c
    where c.user_id = n.user_id and c.id::text = n.cycle_id
  )
group by n.user_id;
-- Expect a8435663: 0 rows (or a 0 count — it has no Health Connect data,
-- so it must show no synthetic-only additions at all; if it shows any,
-- something is leaking across users). Expect 4dbf04ae: roughly 172 (180
-- Health Connect cycles minus the 8 that collapsed into an exact WHOOP
-- match) — confirm the actual number here rather than trusting the
-- estimate; if it lands far from 172, check whether frame reconciliation
-- is actually collapsing the exact matches (F1 in this file proves the
-- mechanism in isolation, this proves it against live data).
-- Run the same shape against whoop_correlation for completeness:
select
  c.user_id,
  count(*) as synthetic_only_correlation_rows
from public.whoop_correlation c
where c.user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
                     '4dbf04ae-7b46-4511-8122-f17284c622d9')
  and not exists (
    select 1 from public.whoop_cycles w
    where w.user_id = c.user_id and w.id::text = c.cycle_id
  )
group by c.user_id;


-- ── V2. CROSS-PROVIDER NON-OVERLAP PROOF (live data) ──────────────────────
-- Two categories, reported SEPARATELY. Silently filtering NULL-
-- effective_end rows out of the comparison would repeat the exact blind
-- spot logged against commit one's own early contiguity check
-- (`where prev_cycle_end is not null` silently skipped the two rows that
-- mattered, then reported "53/53 boundaries checked" as if every boundary
-- had actually been examined).

-- 2a. Frames of UNKNOWN extent. A frame whose period_end is NULL and
-- whose period_start is more than 36h old (candidate_effective_end could
-- not be computed) is neither provably non-overlapping with its successor
-- nor provably contiguous — reported explicitly, never excluded silently.
select user_id, source_period_id, period_start, period_end, is_current
from public.biometric_periods_resolved
where period_end is null
  and period_start <= now() - interval '36 hours';
-- Expect: the two known stale WHOOP cycles (whoop-sync follow-up, logged
-- against 20260830170000's verify file). If this count ever changes,
-- that is new information about the backfill defect, not a regression in
-- this view.

-- 2b. Overlap proof over every frame this query CAN evaluate. Tests
-- OVERLAP, not adjacency: a legitimate suppression gap (>36h ceiling, or
-- this migration's hard gate) leaves an expected gap between two
-- surviving frames and must not fail this check. The two rows from 2a
-- fall out of THIS query on their own (period_end is null for the row
-- being tested as "current"), which is exactly why 2a exists as its own
-- explicit query rather than a silent precondition here.
with ordered as (
  select
    user_id, period_start, period_end,
    lead(period_start) over (partition by user_id order by period_start) as next_period_start
  from public.biometric_periods_resolved
)
select *
from ordered
where period_end is not null
  and next_period_start is not null
  and next_period_start < period_end;
-- Expect ZERO rows. Read together with 2a: "non-overlapping across every
-- frame with a known end, plus N frames of unknown extent pending the
-- whoop-sync backfill" — not "56 boundaries checked" when 2 were quietly
-- skipped.


-- ── V3. RLS FAILS CLOSED ───────────────────────────────────────────────────
-- Sign in as a third, unrelated account:
--
-- select count(*) from public.biometric_periods_resolved;  -- expect 0
--
-- Then as each of the two named accounts:
--
-- select distinct user_id from public.biometric_periods_resolved;
-- -- each must show only its own id, never the other's.


-- ============================================================================
-- FIXTURES — self-contained, no table data or Docker required.
--
-- F1-F3 copy the migration's own whoop_periods / synthetic_periods /
-- all_periods / bounded_periods / unreconciled_overlaps / clean_periods /
-- ranked_periods / frame_cycles chain verbatim, with whoop_periods and
-- synthetic_periods swapped for VALUES blocks — the same technique as
-- commit one, extended to two swappable inputs instead of one.
--
-- F4-F6 test the PER-DOMAIN candidate/ranking logic specifically. For
-- these, frame_cycles itself is hardcoded as a VALUES block (the
-- reconciliation machinery upstream of it is not what is under test —
-- F1-F3 already cover that in isolation) and only the relevant event-grain
-- CTE (sleep_candidates' or hrv_candidates' or resting_hr_candidates'
-- Health-Connect arm) is copied verbatim from the shipped view. This is a
-- narrower unit test of one mechanism, not a weaker one: F1-F3 already
-- prove frame_cycles' own construction, so re-deriving it from scratch in
-- every fixture would test the same thing five more times and the
-- boundary case six times over instead of once.
-- ============================================================================

-- ── F1. WHOOP + synthetic, identical cycle_start — precedence + collapse ──
-- whoop-A (2026-06-01 22:00, cycle_end via next onset 2026-06-02 22:00,
-- strain populated) and hc-A (SAME instant, 2026-06-01 22:00, no strain —
-- structurally can't have one) describe the same real night. Must collapse
-- to ONE frame, WHOOP's, carrying strain.
with whoop_periods as (
  select * from (values
    ('00000000-0000-0000-0000-000000000101'::uuid, 'whoop-A', '2026-06-01 22:00:00+00'::timestamptz,
     '2026-06-02 22:00:00+00'::timestamptz, false, '+00:00'::text, 'whoop'::text, 'whoop.direct'::text,
     null::numeric, null::integer, null::integer, 14.2::numeric, 'SCORED'::text,
     55::numeric, 'SCORED'::text, null::numeric, null::numeric, false::boolean, null::timestamptz,
     null::numeric, 'SCORED'::text, 45::numeric, 'rmssd'::text, 'ms'::text, 52::numeric,
     '2026-06-02 06:00:00+00'::timestamptz, '+00:00'::text)
  ) as t(user_id, source_period_id, cycle_start, cycle_end, is_current, timezone_offset,
         ingest_transport, origin_package, cycle_energy_kilojoule, cycle_average_heart_rate,
         cycle_max_heart_rate, strain, strain_score_state, recovery_score, recovery_score_state,
         spo2_percentage, skin_temp_celsius, user_calibrating, source_updated_at,
         sleep_performance, sleep_score_state, hrv, hrv_method, hrv_unit, resting_heart_rate,
         wake_at, wake_timezone_offset)
),
synthetic_periods as (
  select * from (values
    ('00000000-0000-0000-0000-000000000101'::uuid, 'hc-A', '2026-06-01 22:00:00+00'::timestamptz,
     '2026-06-02 22:00:00+00'::timestamptz, false, '+00:00'::text, 'health_connect'::text, 'com.example.fixture'::text,
     null::numeric, null::integer, null::integer, null::numeric, null::text,
     null::numeric, null::text, null::numeric, null::numeric, null::boolean, null::timestamptz,
     null::numeric, null::text, null::numeric, null::text, null::text, null::numeric,
     '2026-06-02 06:00:00+00'::timestamptz, '+00:00'::text)
  ) as t(user_id, source_period_id, cycle_start, cycle_end, is_current, timezone_offset,
         ingest_transport, origin_package, cycle_energy_kilojoule, cycle_average_heart_rate,
         cycle_max_heart_rate, strain, strain_score_state, recovery_score, recovery_score_state,
         spo2_percentage, skin_temp_celsius, user_calibrating, source_updated_at,
         sleep_performance, sleep_score_state, hrv, hrv_method, hrv_unit, resting_heart_rate,
         wake_at, wake_timezone_offset)
),
all_periods as (
  select * from whoop_periods union all select * from synthetic_periods
),
bounded_periods as (
  select *, coalesce(cycle_end, case when cycle_start > now() - interval '36 hours' then now() end) as candidate_effective_end
  from all_periods
),
unreconciled_overlaps as (
  select distinct a.user_id, a.source_period_id, a.ingest_transport, a.origin_package
  from bounded_periods a
  join bounded_periods b
    on b.user_id = a.user_id and b.ingest_transport <> a.ingest_transport
   and b.cycle_start is distinct from a.cycle_start
   and a.cycle_start < b.candidate_effective_end and b.cycle_start < a.candidate_effective_end
),
clean_periods as (
  select bp.* from bounded_periods bp
  where not exists (select 1 from unreconciled_overlaps u
    where u.user_id = bp.user_id and u.source_period_id = bp.source_period_id
      and u.ingest_transport = bp.ingest_transport and u.origin_package = bp.origin_package)
),
ranked_periods as (
  select *, row_number() over (partition by user_id, cycle_start
    order by (ingest_transport = 'whoop') desc, origin_package asc) as rn
  from clean_periods
)
select user_id, source_period_id, cycle_start, cycle_end, ingest_transport, origin_package, strain
from ranked_periods where rn = 1;
-- EXPECT: exactly 1 row. source_period_id = 'whoop-A', ingest_transport =
-- 'whoop', strain = 14.2. 'hc-A' does not appear — it lost the tiebreak,
-- it was not suppressed by the hard gate (cycle_start matched exactly, so
-- unreconciled_overlaps never sees this pair at all).


-- ── F2. Independent-device overlap, 90 seconds apart — hard gate ─────────
-- whoop-B onset 2026-06-05 22:00:00. hc-B onset 2026-06-05 22:01:30 — 90
-- seconds later, NOT an exact match, but both cycles span most of a day so
-- their [start, end) ranges overlap heavily. Reconciliation cannot collapse
-- them (different cycle_start), and the hard gate must suppress BOTH.
with whoop_periods as (
  select * from (values
    ('00000000-0000-0000-0000-000000000102'::uuid, 'whoop-B', '2026-06-05 22:00:00+00'::timestamptz,
     '2026-06-06 22:00:00+00'::timestamptz, false, '+00:00'::text, 'whoop'::text, 'whoop.direct'::text,
     null::numeric, null::integer, null::integer, null::numeric, null::text,
     null::numeric, null::text, null::numeric, null::numeric, null::boolean, null::timestamptz,
     null::numeric, null::text, null::numeric, null::text, null::text, null::numeric,
     '2026-06-06 06:00:00+00'::timestamptz, '+00:00'::text)
  ) as t(user_id, source_period_id, cycle_start, cycle_end, is_current, timezone_offset,
         ingest_transport, origin_package, cycle_energy_kilojoule, cycle_average_heart_rate,
         cycle_max_heart_rate, strain, strain_score_state, recovery_score, recovery_score_state,
         spo2_percentage, skin_temp_celsius, user_calibrating, source_updated_at,
         sleep_performance, sleep_score_state, hrv, hrv_method, hrv_unit, resting_heart_rate,
         wake_at, wake_timezone_offset)
),
synthetic_periods as (
  select * from (values
    ('00000000-0000-0000-0000-000000000102'::uuid, 'hc-B', '2026-06-05 22:01:30+00'::timestamptz,
     '2026-06-06 22:01:30+00'::timestamptz, false, '+00:00'::text, 'health_connect'::text, 'com.example.fixture'::text,
     null::numeric, null::integer, null::integer, null::numeric, null::text,
     null::numeric, null::text, null::numeric, null::numeric, null::boolean, null::timestamptz,
     null::numeric, null::text, null::numeric, null::text, null::text, null::numeric,
     '2026-06-06 06:01:30+00'::timestamptz, '+00:00'::text)
  ) as t(user_id, source_period_id, cycle_start, cycle_end, is_current, timezone_offset,
         ingest_transport, origin_package, cycle_energy_kilojoule, cycle_average_heart_rate,
         cycle_max_heart_rate, strain, strain_score_state, recovery_score, recovery_score_state,
         spo2_percentage, skin_temp_celsius, user_calibrating, source_updated_at,
         sleep_performance, sleep_score_state, hrv, hrv_method, hrv_unit, resting_heart_rate,
         wake_at, wake_timezone_offset)
),
all_periods as (
  select * from whoop_periods union all select * from synthetic_periods
),
bounded_periods as (
  select *, coalesce(cycle_end, case when cycle_start > now() - interval '36 hours' then now() end) as candidate_effective_end
  from all_periods
),
unreconciled_overlaps as (
  select distinct a.user_id, a.source_period_id, a.ingest_transport, a.origin_package
  from bounded_periods a
  join bounded_periods b
    on b.user_id = a.user_id and b.ingest_transport <> a.ingest_transport
   and b.cycle_start is distinct from a.cycle_start
   and a.cycle_start < b.candidate_effective_end and b.cycle_start < a.candidate_effective_end
),
clean_periods as (
  select bp.* from bounded_periods bp
  where not exists (select 1 from unreconciled_overlaps u
    where u.user_id = bp.user_id and u.source_period_id = bp.source_period_id
      and u.ingest_transport = bp.ingest_transport and u.origin_package = bp.origin_package)
),
ranked_periods as (
  select *, row_number() over (partition by user_id, cycle_start
    order by (ingest_transport = 'whoop') desc, origin_package asc) as rn
  from clean_periods
)
select user_id, source_period_id, cycle_start, cycle_end, ingest_transport
from ranked_periods where rn = 1;
-- EXPECT: 0 rows. Neither whoop-B nor hc-B appears. SABOTAGE: change
-- unreconciled_overlaps' join condition from `b.cycle_start is distinct
-- from a.cycle_start` to `b.cycle_start = a.cycle_start` (i.e. disable the
-- gate by making it require the exact-match case it exists to catch the
-- ABSENCE of) and re-run from unreconciled_overlaps onward — confirm it
-- goes red: unreconciled_overlaps becomes empty, nothing is excluded, and
-- BOTH whoop-B and hc-B now appear as two separate, silently overlapping
-- frame_cycles rows — they do not even compete in the same
-- `partition by user_id, cycle_start` group, since their cycle_start
-- values genuinely differ, so there is no tiebreak to resolve it either.
-- That is the exact defect this gate exists to prevent.


-- ── F3. Stale is_current frame — effective_end stops over-claiming ───────
-- whoop-C onset 2026-01-01 22:00:00, cycle_end NULL (never backfilled,
-- mirrors the real production defect), and "now" in this fixture's frame
-- of reference is far more than 36h past that onset. An HRV sample at
-- 2026-06-10 (many months later) must NOT be claimed by whoop-C.
with whoop_periods as (
  select * from (values
    ('00000000-0000-0000-0000-000000000103'::uuid, 'whoop-C', '2026-01-01 22:00:00+00'::timestamptz,
     null::timestamptz, true, '+00:00'::text, 'whoop'::text, 'whoop.direct'::text,
     null::numeric, null::integer, null::integer, null::numeric, null::text,
     null::numeric, null::text, null::numeric, null::numeric, null::boolean, null::timestamptz,
     null::numeric, null::text, 40::numeric, 'rmssd'::text, 'ms'::text, null::numeric,
     null::timestamptz, null::text)
  ) as t(user_id, source_period_id, cycle_start, cycle_end, is_current, timezone_offset,
         ingest_transport, origin_package, cycle_energy_kilojoule, cycle_average_heart_rate,
         cycle_max_heart_rate, strain, strain_score_state, recovery_score, recovery_score_state,
         spo2_percentage, skin_temp_celsius, user_calibrating, source_updated_at,
         sleep_performance, sleep_score_state, hrv, hrv_method, hrv_unit, resting_heart_rate,
         wake_at, wake_timezone_offset)
),
synthetic_periods as (
  select * from (values
    (null::uuid, null::text, null::timestamptz, null::timestamptz, null::boolean, null::text,
     null::text, null::text, null::numeric, null::integer, null::integer, null::numeric, null::text,
     null::numeric, null::text, null::numeric, null::numeric, null::boolean, null::timestamptz,
     null::numeric, null::text, null::numeric, null::text, null::text, null::numeric,
     null::timestamptz, null::text)
  ) as t(user_id, source_period_id, cycle_start, cycle_end, is_current, timezone_offset,
         ingest_transport, origin_package, cycle_energy_kilojoule, cycle_average_heart_rate,
         cycle_max_heart_rate, strain, strain_score_state, recovery_score, recovery_score_state,
         spo2_percentage, skin_temp_celsius, user_calibrating, source_updated_at,
         sleep_performance, sleep_score_state, hrv, hrv_method, hrv_unit, resting_heart_rate,
         wake_at, wake_timezone_offset)
  where false  -- empty: this fixture has no synthetic candidate at all
),
all_periods as (
  select * from whoop_periods union all select * from synthetic_periods
),
bounded_periods as (
  select *, coalesce(cycle_end, case when cycle_start > now() - interval '36 hours' then now() end) as candidate_effective_end
  from all_periods
),
frame_cycles as (
  select user_id, source_period_id, cycle_start, candidate_effective_end as effective_end, hrv, hrv_method, hrv_unit
  from bounded_periods
),
-- The hrv_candidates HC-arm join, copied verbatim from the shipped view.
hrv_candidates_hc as (
  select fc.user_id, fc.source_period_id as frame_key
  from (values
    ('00000000-0000-0000-0000-000000000103'::uuid, 30::numeric, 'rmssd'::text, 'ms'::text,
     '2026-06-10 03:00:00+00'::timestamptz, 'com.example.fixture'::text)
  ) as h(user_id, hrv_value, hrv_method, hrv_unit, measured_at, origin_package)
  join frame_cycles fc
    on fc.user_id = h.user_id
   and h.measured_at >= fc.cycle_start
   and fc.effective_end is not null
   and h.measured_at <  fc.effective_end
)
select * from hrv_candidates_hc;
-- EXPECT: 0 rows. whoop-C's effective_end is NULL (cycle_start is far more
-- than 36h before now()), so `h.measured_at < fc.effective_end` compares
-- against NULL and is never true — the June HRV sample is not claimed.
-- (The explicit `fc.effective_end is not null` guard is redundant with
-- that NULL propagation on its own; it stays for the same reason the rest
-- of this codebase writes explicit IS NOT NULL checks even where SQL's
-- NULL semantics would already produce the same result — the intent
-- should not depend on a reader recalling three-valued-logic rules.)
-- SABOTAGE, and it has to be this specific change to actually bite:
-- replace `h.measured_at < fc.effective_end` with
-- `h.measured_at < coalesce(fc.effective_end, now())` — merely deleting
-- the `is not null` guard line does NOT reproduce the hazard, since the
-- bare `<` comparison against a NULL effective_end already safely
-- evaluates to false on its own. With the coalesce substitution in place,
-- confirm this goes red: the June sample gets wrongly attached to the
-- January cycle.


-- ── F4. Health Connect sleep, onset-vs-midpoint misassignment ────────────
-- Frame X: 2026-07-01 22:00:00 to 2026-07-02 22:00:00 (X's own night).
-- Frame Y: 2026-07-02 22:00:00 to 2026-07-03 22:00:00 (the FOLLOWING
-- night). An independent device's sleep session for X's own night is
-- recorded as 2026-07-01 21:50:00 to 2026-07-02 06:00:00 -- its ONSET
-- (21:50 on 07-01) falls squarely inside frame X, no ambiguity there; the
-- case this fixture actually targets is a session whose onset drifts
-- PAST a boundary. Session: 2026-07-02 21:50:00 to 2026-07-03 05:50:00 --
-- onset 21:50 on 07-02 is 10 minutes BEFORE frame Y's own cycle_start
-- (22:00:00 07-02), i.e. onset-based containment would place it in frame
-- X (wrong -- this is Y's night); its MIDPOINT, 2026-07-03 01:50:00, falls
-- solidly inside frame Y.
with frame_cycles as (
  select * from (values
    ('00000000-0000-0000-0000-000000000104'::uuid, 'frame-X', '2026-07-01 22:00:00+00'::timestamptz, '2026-07-02 22:00:00+00'::timestamptz),
    ('00000000-0000-0000-0000-000000000104'::uuid, 'frame-Y', '2026-07-02 22:00:00+00'::timestamptz, '2026-07-03 22:00:00+00'::timestamptz)
  ) as t(user_id, source_period_id, cycle_start, effective_end)
),
-- sleep_candidates' HC-arm join, copied verbatim (midpoint containment).
sleep_candidates_hc as (
  select fc.user_id, fc.source_period_id as frame_key, s.origin_package
  from (values
    ('00000000-0000-0000-0000-000000000104'::uuid, '2026-07-02 21:50:00+00'::timestamptz,
     '2026-07-03 05:50:00+00'::timestamptz, 'com.example.fixture'::text)
  ) as s(user_id, period_start, period_end, origin_package)
  join frame_cycles fc
    on fc.user_id = s.user_id
   and (s.period_start + (s.period_end - s.period_start) / 2) >= fc.cycle_start
   and fc.effective_end is not null
   and (s.period_start + (s.period_end - s.period_start) / 2) <  fc.effective_end
)
select * from sleep_candidates_hc;
-- EXPECT: exactly 1 row, frame_key = 'frame-Y' — the midpoint
-- (2026-07-03 01:50:00) correctly lands the session in the night it
-- belongs to. SABOTAGE: replace the midpoint expression with s.period_start
-- (plain onset containment) and confirm this goes red: frame_key flips to
-- 'frame-X', the wrong night.


-- ── F5. Resting-HR sample exactly on a frame boundary instant ────────────
-- Frame Z: 2026-08-01 22:00:00 to 2026-08-02 22:00:00. A resting-HR
-- reading measured at EXACTLY 2026-08-02 22:00:00 -- the boundary instant
-- itself -- must belong to the NEXT frame (containment is
-- half-open, [start, end)), not frame Z.
with frame_cycles as (
  select * from (values
    ('00000000-0000-0000-0000-000000000105'::uuid, 'frame-Z',  '2026-08-01 22:00:00+00'::timestamptz, '2026-08-02 22:00:00+00'::timestamptz),
    ('00000000-0000-0000-0000-000000000105'::uuid, 'frame-Z2', '2026-08-02 22:00:00+00'::timestamptz, '2026-08-03 22:00:00+00'::timestamptz)
  ) as t(user_id, source_period_id, cycle_start, effective_end)
),
-- resting_hr_candidates' HC-arm join, copied verbatim.
resting_hr_candidates_hc as (
  select fc.user_id, fc.source_period_id as frame_key
  from (values
    ('00000000-0000-0000-0000-000000000105'::uuid, 55::numeric,
     '2026-08-02 22:00:00+00'::timestamptz, 'com.example.fixture'::text)
  ) as r(user_id, resting_heart_rate, measured_at, origin_package)
  join frame_cycles fc
    on fc.user_id = r.user_id
   and r.measured_at >= fc.cycle_start
   and fc.effective_end is not null
   and r.measured_at <  fc.effective_end
)
select * from resting_hr_candidates_hc;
-- EXPECT: exactly 1 row, frame_key = 'frame-Z2'. The reading does NOT
-- also appear against 'frame-Z' (its effective_end is exclusive) — this
-- one query proves both the boundary assignment and the absence of a
-- double-count in a single result set.


-- ── F6. Empty HRV candidate source — NULL provenance, frame not dropped ──
-- A SYNTHETIC-ONLY frame (whoop_or_hc = 'health_connect' -- no WHOOP data
-- covers this night at all) with zero Health Connect HRV rows either (the
-- actual production shape today -- WHOOP writes zero HRV records to
-- Health Connect, and this is the one path where the frame has genuinely
-- NO candidate from either source, not merely a null-valued one: a WHOOP
-- frame always self-nominates via the WHOOP branch below, even with null
-- fields, so it can never be dropped by an inner join -- this fixture
-- specifically avoids that self-nomination to test the real risk).
with frame_cycles as (
  select
    '00000000-0000-0000-0000-000000000106'::uuid as user_id,
    'hc-D'::text as source_period_id,
    '2026-09-01 22:00:00+00'::timestamptz as cycle_start,
    '2026-09-02 22:00:00+00'::timestamptz as effective_end,
    null::numeric as whoop_hrv,
    null::text    as whoop_hrv_method,
    null::text    as whoop_hrv_unit,
    'health_connect'::text as whoop_or_hc
),
-- hrv_candidates, copied verbatim -- the HC-arm subquery reads an empty
-- VALUES block standing in for "zero rows in biometric_hrv_samples",
-- exactly today's real state.
hrv_candidates as (
  select
    user_id, source_period_id as frame_key,
    whoop_hrv as hrv, whoop_hrv_method as hrv_method, whoop_hrv_unit as hrv_unit,
    'whoop'::text as ingest_transport, 'whoop.direct'::text as origin_package
  from frame_cycles
  where whoop_or_hc = 'whoop'
  union all
  select fc.user_id, fc.source_period_id as frame_key,
    h.hrv_value, h.hrv_method, h.hrv_unit, 'health_connect'::text, h.origin_package
  from (
    select null::uuid as user_id, null::numeric as hrv_value, null::text as hrv_method,
           null::text as hrv_unit, null::timestamptz as measured_at, null::text as origin_package
    where false
  ) as h
  join frame_cycles fc on fc.user_id = h.user_id
   and h.measured_at >= fc.cycle_start and h.measured_at < fc.effective_end
),
hrv_winner as (
  select *, row_number() over (partition by user_id, frame_key order by (origin_package like '%.direct') desc) as rn
  from hrv_candidates
)
select fc.user_id, fc.source_period_id, hw.hrv, hw.hrv_method, hw.hrv_unit, hw.ingest_transport
from frame_cycles fc
left join (select * from hrv_winner where rn = 1) hw
  on hw.user_id = fc.user_id and hw.frame_key = fc.source_period_id;
-- EXPECT: exactly 1 row. source_period_id = 'hc-D', hrv = NULL,
-- hrv_method = NULL (never a fabricated 'rmssd' -- there is no candidate
-- to have fabricated one from), hrv_ingest_transport (the ingest_transport
-- column here) = NULL. The frame row itself is still present -- proving
-- the LEFT JOIN, not an INNER JOIN, is what ships, on the one path where
-- that distinction is actually live: hrv_candidates produces genuinely
-- ZERO rows for this frame (not a WHOOP branch, not an HC branch).
-- SABOTAGE: change the final join to a plain `join` and confirm this goes
-- red: zero rows, the frame silently vanishes.


-- ── F7. NULL WHOOP candidate must not outrank a real HC value ────────────
-- Frame W: a WHOOP frame whose recovery never arrived, so
-- whoop_resting_heart_rate is NULL -- a real production shape (B1b showed
-- three such cycles for the actual test accounts). A Health Connect
-- resting-HR reading with a REAL value sits inside the same frame. Before
-- the fix, the WHOOP arm nominated a NULL-valued candidate unconditionally
-- and won the .direct tiebreak by existing, regardless of its own value --
-- provenance said WHOOP supplied this reading when WHOOP supplied
-- nothing. The fix adds `and whoop_resting_heart_rate is not null` to the
-- WHOOP arm's own WHERE clause, copied verbatim below.
with frame_cycles as (
  select
    '00000000-0000-0000-0000-000000000107'::uuid as user_id,
    'whoop-E'::text as source_period_id,
    '2026-10-01 22:00:00+00'::timestamptz as cycle_start,
    '2026-10-02 22:00:00+00'::timestamptz as effective_end,
    null::numeric as whoop_resting_heart_rate,
    'whoop'::text as whoop_or_hc
),
-- resting_hr_candidates, copied verbatim including the fix's WHERE clause.
resting_hr_candidates as (
  select
    user_id, source_period_id as frame_key,
    whoop_resting_heart_rate as resting_heart_rate,
    'whoop'::text as ingest_transport, 'whoop.direct'::text as origin_package
  from frame_cycles
  where whoop_or_hc = 'whoop'
    and whoop_resting_heart_rate is not null
  union all
  select fc.user_id, fc.source_period_id as frame_key,
    r.resting_heart_rate, 'health_connect'::text, r.origin_package
  from (values
    ('00000000-0000-0000-0000-000000000107'::uuid, 58::numeric,
     '2026-10-02 06:00:00+00'::timestamptz, 'com.example.fixture'::text)
  ) as r(user_id, resting_heart_rate, measured_at, origin_package)
  join frame_cycles fc
    on fc.user_id = r.user_id
   and r.measured_at >= fc.cycle_start
   and fc.effective_end is not null
   and r.measured_at <  fc.effective_end
),
resting_hr_ranked as (
  select *, row_number() over (partition by user_id, frame_key order by (origin_package like '%.direct') desc) as rn
  from resting_hr_candidates
)
select fc.user_id, fc.source_period_id, rw.resting_heart_rate, rw.ingest_transport
from frame_cycles fc
left join (select * from resting_hr_ranked where rn = 1) rw
  on rw.user_id = fc.user_id and rw.frame_key = fc.source_period_id;
-- EXPECT: exactly 1 row. source_period_id = 'whoop-E',
-- resting_heart_rate = 58, ingest_transport = 'health_connect'. The WHOOP
-- arm nominated nothing (filtered out by its own NULL value), so the only
-- real candidate wins and provenance correctly credits Health Connect.
-- SABOTAGE: delete the `and whoop_resting_heart_rate is not null` line
-- and confirm this goes red: resting_heart_rate flips to NULL,
-- ingest_transport flips to 'whoop' — a NULL value credited to a provider
-- that supplied nothing, while the real 58 sits unused.
