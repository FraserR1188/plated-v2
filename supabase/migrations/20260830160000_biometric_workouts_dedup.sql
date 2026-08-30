-- ============================================================
-- biometric_workouts — read-time deduplication across providers
--
-- BUG (not an error this time, a data-quality issue): a user with a
-- direct WHOOP integration AND the same WHOOP Android app contributing
-- to Health Connect sees the same real-world workout TWICE — once from
-- each arm. Confirmed on-device: identical start timestamps
-- (drift_seconds = 0.000 across 20 rows), direct row carrying strain/
-- distance/energy, Health Connect copy carrying none of them. This was
-- flagged as a known, explicitly deferred limitation in both prior
-- migrations on this view; this migration is that deferred work.
--
-- NEVER DELETE. This is a settled project invariant, restated here
-- because it is the reason this whole migration is a VIEW change and
-- not a cleanup script: precedence picks a winner per event at READ
-- time; the losing row stays in biometric_workout_sessions /
-- whoop_workouts untouched. If the user later disconnects their direct
-- WHOOP integration, the Health Connect copy is still there and simply
-- starts winning by default (no preference row) the next time the view
-- is queried — no data was ever destroyed, so there is nothing to
-- restore. Deleting the losing row instead would be unrecoverable the
-- moment Health Connect's changes token has advanced past it.
--
-- ── REUSING biometric_periods_resolved's SHAPE — WHERE IT FITS ────
-- The 3-tier precedence order below (an explicit per-domain preference
-- wins first; failing that, a direct integration outranks Health
-- Connect by default; failing that, a deterministic tiebreak) is
-- reused VERBATIM from biometric_periods_resolved's sleep_ranked /
-- hrv_ranked / resting_hr_ranked CTEs
-- (20260829111404_biometric_periods_resolved.sql). Same meaning, same
-- order, same reasoning: a user's explicit choice beats a structural
-- default, which beats an arbitrary-but-stable tiebreak.
--
-- ── WHERE IT DOES NOT FIT, AND WHY ─────────────────────────────────
-- periods_resolved ranks candidates with
-- `row_number() over (partition by user_id, source_period_id order by
-- ...)` — a window function over a SHARED grouping key. That key exists
-- for periods because every provider's period ultimately maps onto the
-- same WHOOP-numbered cycle_id today (with only one arm live). It does
-- NOT exist here: WHOOP's workout id (a UUID) and Health Connect's
-- provider_record_id (a clientRecordId or device-local id string) are
-- two completely disjoint identifier schemes with no shared key to
-- partition by. Partitioning by a shared id is what this migration is
-- explicitly told NOT to fake — "do not special-case WHOOP's
-- 'whoop://workout/<uuid>' convention... an id-matching shortcut would
-- have to be replaced the first time a Garmin user connects Garmin
-- directly." A window function cannot group rows by a key that must
-- itself be DISCOVERED (via time overlap) before grouping can happen —
-- that is circular. So instead of ranking within a known group, this
-- migration uses a pairwise self-join with a `NOT EXISTS (a strictly
-- better, overlapping row)` test: the SAME precedence order, expressed
-- as a lexicographic ROW() comparison instead of a window ORDER BY,
-- because the grouping itself is discovered pairwise, not given
-- upfront. It is a different SQL shape solving a different sub-problem
-- (discover the group) on top of the same precedence idiom (rank within
-- it) — not a second, unrelated idiom invented from scratch.
--
-- ── biometric_source_preferences: 'workouts' DOMAIN APPLIES HERE ───
-- The CHECK constraint on biometric_source_preferences already
-- enumerates 'workouts' as a valid domain, but
-- biometric_periods_resolved deliberately never looks it up — its own
-- header says why: "biometric_periods is PERIOD-grain, not
-- workout-grain: a workout does not belong to exactly one cycle... this
-- view never looks up a 'workouts' preference row... that is
-- structurally out of scope for a period-grained result, and
-- biometric_workouts is where that preference must eventually be
-- honoured instead." This IS that view. The 'workouts' domain
-- preference is looked up and honoured below, at tier 1 — the first
-- and only place in the schema where it can correctly apply.
--
-- ── MATCHING: TIME OVERLAP, NOT ID ─────────────────────────────────
-- Two rows for the same user are the same real-world event when BOTH:
--   (a) their workout_start values are within 60 seconds of each
--       other, AND
--   (b) their [workout_start, workout_end) intervals overlap.
-- (a) alone is not used because two genuinely distinct, very short
-- activities that happen to start close together but don't overlap in
-- duration (e.g. a 10-second logging error immediately followed by an
-- unrelated activity) would otherwise be conflated on start-time
-- proximity alone; (b) alone is not used because it is not sufficient
-- to declare identity — see the window justification below.
--
-- WHY 60 SECONDS: the on-device evidence for a genuine same-event
-- duplicate showed drift_seconds = 0.000 across 20 rows — the two write
-- paths (WHOOP's own REST API vs. WHOOP's Android app writing the same
-- start instant into Health Connect) already agree to the second in
-- practice. 60 seconds is roughly a 60x margin over that observed
-- drift: generous enough to absorb clock skew, rounding, or timestamp
-- truncation differences between the two paths, without approaching
-- the failure mode at the UPPER bound — too wide a window risks
-- collapsing two truly DISTINCT, back-to-back activities (e.g. a
-- strength session ending and a separate cardio session starting a few
-- minutes later, both deliberately logged as separate workouts) into
-- one, which would SILENTLY HIDE a real workout from the user rather
-- than merely leaving a harmless visible duplicate. A false merge is
-- strictly worse than a false non-merge here (a missed duplicate is
-- just an ugly extra card; a wrongful merge deletes a real workout from
-- the user's view, even though the row itself survives in the
-- database) — so the window is kept tight rather than generous.
--
-- NOT restricted to cross-provider pairs only (i.e. this does not add
-- `a.origin_package <> b.origin_package`): the matcher's job is "is
-- this the same event," which time overlap answers regardless of which
-- two rows are being compared. Two rows from the SAME app that
-- genuinely overlap (e.g. a duplicate ingest after a phone switch
-- assigns a fresh provider_record_id to the same real session) are just
-- as much a duplicate as a cross-provider pair, and get resolved by the
-- exact same rule rather than needing a second, narrower rule bolted on
-- for that case.
--
-- ── PRECEDENCE: DIRECT WINS BY DEFAULT, ON MERIT ───────────────────
-- Absent a preference, a direct integration (origin_package like
-- '%.direct') outranks a Health Connect row. This is not merely
-- consistency with the period spine's own default (though it is that
-- too) — the direct row is the RICHER record: it carries strain,
-- distance, and energy_kilojoule, none of which the Health Connect
-- Exercise Session record type can ever report (see
-- 20260829072742_biometric_provider_neutral_tables.sql and
-- mapExerciseSession's own comment: Health Connect's ExerciseSession
-- carries no heart-rate, calorie, distance, or altitude fields at all).
-- The richer record winning is a decision on the merits of the data
-- itself, not just an arbitrary default.
--
-- ── DETERMINISTIC TIEBREAK ──────────────────────────────────────────
-- origin_package ascending (identical to periods_resolved's own
-- tiebreak, same "arbitrary but stable" reasoning — see its comment,
-- "Deterministic, clock-independent tiebreak"), with source_workout_id
-- ascending as a final tiebreak beyond what periods_resolved needed:
-- periods_resolved's candidates are always from DIFFERENT providers (one
-- per source_period_id per arm), so origin_package alone is always
-- distinct between them. Here, two candidates CAN legitimately share an
-- origin_package (e.g. two Health-Connect rows from the same app that
-- happen to overlap, whether a genuine duplicate or a rare data
-- anomaly) and still need a single deterministic winner, so
-- source_workout_id is added as the final tuple element. Never
-- synced_at or any other clock-dependent column, per the standing rule
-- — a value that changes on re-sync must never flip which copy wins.
--
-- ── NULL-not-zero / no coalesce: unchanged from both prior migrations.
--    security_invoker = on: unchanged, and the new
--    biometric_source_preferences lookup below runs under it too — a
--    caller only ever sees THEIR OWN preference row, per that table's
--    own RLS policy, regardless of how the query is planned.
-- ============================================================

create or replace view public.biometric_workouts
with (security_invoker = on) as
with raw as (
  -- ── ARM ONE: WHOOP (byte-identical to every prior migration) ────
  select
    w.user_id,
    'whoop'::text                          as ingest_source,
    w.id::text                             as source_workout_id,

    w.start                                as workout_start,
    w."end"                                as workout_end,
    w.timezone_offset                      as timezone_offset,
    ((w.start at time zone 'UTC') + (w.timezone_offset)::interval)::date
                                           as local_date,

    w.sport_name                           as sport_name,
    w.strain                               as strain,
    w.score_state                          as strain_score_state,
    w.average_heart_rate                   as average_heart_rate,
    w.max_heart_rate                       as max_heart_rate,
    w.kilojoule                            as energy_kilojoule,
    w.distance_meter                       as distance_meter,
    w.altitude_gain_meter                  as altitude_gain_meter,
    w.altitude_change_meter                as altitude_change_meter,

    w.whoop_updated_at                     as source_updated_at,

    'whoop'::text                          as ingest_transport,
    'whoop.direct'::text                   as origin_package
  from public.whoop_workouts w

  union all

  -- ── ARM TWO: HEALTH CONNECT (byte-identical to the prior migration,
  --    including the defensive local_date CASE) ─────────────────────
  select
    bws.user_id,
    bws.origin_package                     as ingest_source,
    bws.provider_record_id                 as source_workout_id,

    bws.period_start                       as workout_start,
    bws.period_end                         as workout_end,
    bws.timezone_offset                    as timezone_offset,
    case
      when bws.timezone_offset ~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
        then ((bws.period_start at time zone 'UTC') + (bws.timezone_offset)::interval)::date
      else null::date
    end                                    as local_date,

    bws.activity_type                      as sport_name,
    null::numeric                          as strain,
    null::text                             as strain_score_state,
    round(bws.average_heart_rate)::integer as average_heart_rate,
    round(bws.max_heart_rate)::integer     as max_heart_rate,
    bws.energy_kilojoule                   as energy_kilojoule,
    bws.distance_meter                     as distance_meter,
    bws.altitude_gain_meter                as altitude_gain_meter,
    null::numeric                          as altitude_change_meter,

    bws.source_updated_at                  as source_updated_at,

    bws.ingest_transport                   as ingest_transport,
    bws.origin_package                     as origin_package
  from public.biometric_workout_sessions bws
  where bws.ingest_transport = 'health_connect'
),

-- Precedence inputs computed once per row: an explicit 'workouts'
-- preference match, and the structural direct-vs-Health-Connect
-- default. LEFT JOIN: a user with no preference row set (the default,
-- untouched biometric_source_preferences ships empty) gets
-- is_preferred = false for every row, never NULL — the boolean
-- expression short-circuits to false rather than propagating the LEFT
-- JOIN's NULL, so no coalesce is needed to keep this NULL-safe.
ranked as (
  select
    raw.*,
    (pref.ingest_transport is not null
       and pref.ingest_transport = raw.ingest_transport
       and pref.origin_package  = raw.origin_package)   as is_preferred,
    (raw.origin_package like '%.direct')                as is_direct
  from raw
  left join public.biometric_source_preferences pref
    on pref.user_id = raw.user_id and pref.domain = 'workouts'
)

select
  a.user_id,
  a.ingest_source,
  a.source_workout_id,
  a.workout_start,
  a.workout_end,
  a.timezone_offset,
  a.local_date,
  a.sport_name,
  a.strain,
  a.strain_score_state,
  a.average_heart_rate,
  a.max_heart_rate,
  a.energy_kilojoule,
  a.distance_meter,
  a.altitude_gain_meter,
  a.altitude_change_meter,
  a.source_updated_at,
  a.ingest_transport,
  a.origin_package
from ranked a
where not exists (
  select 1
  from ranked b
  where b.user_id = a.user_id
    -- Not itself. (origin_package, source_workout_id) is this view's
    -- true composite identity: arm one is always 'whoop.direct' and arm
    -- two is never '%.direct' (enforced by
    -- biometric_workout_sessions_transport_origin_check), so the two
    -- arms' origin_package spaces never collide, and within one arm
    -- this pair matches that table's own primary key exactly
    -- (whoop_workouts (user_id, id); biometric_workout_sessions
    -- (user_id, origin_package, provider_record_id)).
    and (b.origin_package, b.source_workout_id)
        is distinct from (a.origin_package, a.source_workout_id)
    -- SAME EVENT (see header): within 60 seconds AND overlapping.
    and b.workout_start between a.workout_start - interval '60 seconds'
                             and a.workout_start + interval '60 seconds'
    and b.workout_start < a.workout_end
    and a.workout_start < b.workout_end
    -- B OUTRANKS A: lexicographic tuple compare, ascending = better.
    -- not is_preferred / not is_direct so that TRUE (the better state)
    -- sorts first (false < true in Postgres boolean ordering); then the
    -- same deterministic tiebreak as periods_resolved, extended with
    -- source_workout_id for a genuine total order (see header).
    and row(not b.is_preferred, not b.is_direct, b.origin_package, b.source_workout_id)
      < row(not a.is_preferred, not a.is_direct, a.origin_package, a.source_workout_id)
);

grant select on public.biometric_workouts to authenticated;

-- ============================================================================
-- PERFORMANCE
--
-- This adds a self-join (NOT EXISTS) over the view's own row set, for
-- ~1000 workouts per user. No index added — reasoning follows; do not
-- add one speculatively ahead of this reasoning being wrong in practice.
--
-- The self-join's comparison set is bounded by ONE USER's total workout
-- count, not the whole table's, regardless of how Postgres plans the
-- `ranked` CTE (materialized once vs. inlined per reference — it is
-- referenced twice, as `a` and `b`). That bound holds independently of
-- CTE planning because RLS is enforced at the BASE TABLE scan, beneath
-- the CTE layer: whoop_workouts and biometric_workout_sessions both
-- carry `auth.uid() = user_id` policies, and security_invoker = on
-- means those policies apply to the actual scan that feeds `raw`, not
-- to some later filter on the view's output. So even in the worst case
-- (the planner materializes `ranked` once), it is materializing exactly
-- one user's rows, never the whole table's.
--
-- At ~1000 rows for one user, a correlated NOT EXISTS comparing every
-- row against every other row is at most ~1,000,000 tuple comparisons —
-- entirely in memory (both base-table fetches are already index-backed:
-- whoop_workouts' primary key (user_id, id), and
-- biometric_workout_sessions_user_period_idx on (user_id, period_start)
-- from 20260829072742_biometric_provider_neutral_tables.sql), no disk
-- I/O in the comparison step itself. This is sub-millisecond-to-low-
-- single-digit-millisecond work for Postgres; nowhere near a scale
-- where an index-driven join would out-perform a nested-loop over an
-- already-fetched, already-small in-memory set. ~1000 workouts per user
-- is itself a generous ceiling — even a very dedicated athlete logging
-- daily for a decade is under 4000, and this app's actual population is
-- nowhere near that yet.
--
-- If this view's own row count per user ever grew by orders of
-- magnitude beyond that (not expected), the lever would be a GiST
-- index over a tstzrange built from (workout_start, workout_end),
-- enabling an index-assisted `&&` overlap lookup instead of a
-- nested-loop scan — not proposed here, since nothing today justifies
-- its maintenance cost.
-- ============================================================================

-- ============================================================================
-- VERIFICATION
--
-- Run V0 BEFORE applying this migration. Run V1-V5 AFTER. Both the V0
-- snapshot and every AFTER query must run as the SAME role — same
-- caution as every prior migration touching this view.
-- ============================================================================

-- V0. BASELINE — fresh CREATE, covering BOTH test accounts (the
--     WHOOP-only user, whose output must not change at all, and the
--     both-sources user, whose output SHOULD change — this snapshot is
--     also what V4 below uses to show which rows were dropped and why).
--     Run BEFORE applying this migration.
--
-- create table public._verify_biometric_workouts_pre as
-- select user_id, ingest_source, source_workout_id, workout_start,
--        workout_end, timezone_offset, local_date, sport_name, strain,
--        strain_score_state, average_heart_rate, max_heart_rate,
--        energy_kilojoule, distance_meter, altitude_gain_meter,
--        altitude_change_meter, source_updated_at, ingest_transport,
--        origin_package
-- from public.biometric_workouts
-- where user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
--                    '4dbf04ae-7b46-4511-8122-f17284c622d9');
--
-- select user_id, count(*) from public._verify_biometric_workouts_pre
-- group by 1;  -- note both counts

-- V1. RLS fails closed. Sign in as a THIRD, unrelated account and confirm:
--
-- select count(*) from public.biometric_workouts;  -- expect 0

-- V2. WHOOP-ONLY USER: BYTE-IDENTICAL — EXCEPT, both directions, plus a
--     row count. This user has no Health Connect rows at all, so no
--     candidate pair can ever satisfy the overlap condition — every row
--     is vacuously kept. All three checks must return / match zero and
--     equal counts.
--
-- select count(*) from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393';
-- -- must equal this user's V0 count noted above
--
-- select * from public._verify_biometric_workouts_pre
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'
-- except
-- select * from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393';
-- -- expect 0 rows
--
-- select * from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'
-- except
-- select * from public._verify_biometric_workouts_pre
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393';
-- -- expect 0 rows

-- V3. BOTH-SOURCES USER: count drops from the pre-migration total to a
--     deduplicated count.
--
-- select count(*) from public.biometric_workouts
-- where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9';
-- Compare against this user's V0 count. Expect fewer rows — exactly one
-- fewer per genuine duplicate pair resolved.

-- V4. WHICH ROWS WERE DROPPED, AND WHY — eyeball that the right copy
--     won. For every pre-migration row now missing from the live view,
--     shows the surviving row that beat it and the reason.
--
-- select
--   lost.source_workout_id   as dropped_id,
--   lost.origin_package      as dropped_origin,
--   lost.workout_start       as dropped_start,
--   lost.strain              as dropped_strain,
--   lost.distance_meter      as dropped_distance,
--   winner.source_workout_id as winning_id,
--   winner.origin_package    as winning_origin,
--   winner.workout_start     as winning_start,
--   winner.strain            as winning_strain,
--   winner.distance_meter    as winning_distance,
--   case
--     when winner.origin_package like '%.direct'
--          and lost.origin_package not like '%.direct'
--       then 'direct integration outranks Health Connect (default, no preference set)'
--     else 'deterministic tiebreak (identical precedence tier)'
--   end as reason
-- from public._verify_biometric_workouts_pre lost
-- join public.biometric_workouts winner
--   on winner.user_id = lost.user_id
--  and (winner.origin_package, winner.source_workout_id)
--      is distinct from (lost.origin_package, lost.source_workout_id)
--  and winner.workout_start between lost.workout_start - interval '60 seconds'
--                                and lost.workout_start + interval '60 seconds'
--  and winner.workout_start < lost.workout_end
--  and lost.workout_start   < winner.workout_end
-- where lost.user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
--   and (lost.origin_package, lost.source_workout_id) not in (
--     select origin_package, source_workout_id from public.biometric_workouts
--     where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
--   );
-- Expect: dropped rows are the thinner records (no strain, no
-- distance), winning rows are the richer ones, reason mostly reads
-- "direct integration outranks Health Connect."

-- V5. Cleanup.
--
-- drop table public._verify_biometric_workouts_pre;

-- ============================================================
-- NOT in this migration (deliberately deferred)
--
-- Everything already listed as deferred in
-- 20260830090000_biometric_workouts_health_connect_arm.sql, minus the
-- deduplication item it named — that item is this migration.
-- ============================================================
