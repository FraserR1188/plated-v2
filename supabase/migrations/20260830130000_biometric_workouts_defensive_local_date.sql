-- ============================================================
-- biometric_workouts — defensive local_date for the Health Connect arm
--
-- BUG, confirmed on-device: the Health Connect arm added by
-- 20260830090000_biometric_workouts_health_connect_arm.sql computed
-- local_date the same way as the WHOOP arm —
--   ((bws.period_start at time zone 'UTC') + (bws.timezone_offset)::interval)::date
-- — which assumes timezone_offset is always Postgres-interval-parseable.
-- It is not: Health Connect legitimately emits 'Z' for UTC (a valid
-- ISO-8601 offset, confirmed via java.time.ZoneOffset#getId()'s own
-- documented contract), and `'Z'::interval` raises 22007
-- (invalid_datetime_format). Confirmed via query: 60 of 563 rows on one
-- test account held 'Z' in biometric_workout_sessions.timezone_offset.
-- Because a cast failure in a SELECT list aborts the WHOLE query, not
-- just the offending row, this did not merely hide Health Connect
-- workouts — it broke fetchWorkouts() for that entire user, WHOOP rows
-- included. Only accounts with zero Health Connect rows were unaffected.
--
-- TWO SEPARATE FIXES, NEITHER SUFFICIENT ALONE:
--   1. Ingest normalisation (supabase/functions/health-connect-ingest/
--      mapping.ts, normalizeZoneOffsetId) — maps 'Z' to '+00:00' and
--      writes NULL (never a guess) for anything else unrecognised, going
--      forward. Fixes the SOURCE for all four provider-neutral tables,
--      not just workouts.
--   2. Backfill (delivered separately as verification SQL, not a
--      migration, per instruction — this repo's convention for a
--      hand-run data correction is a SELECT-before-UPDATE the operator
--      reviews and runs themselves, not a blind migration UPDATE)
--      corrects the 'Z' rows already sitting in all four tables.
--   3. THIS migration — the view itself must not be able to error the
--      entire query over one bad value in the first place. Even with (1)
--      and (2) both applied, a future ingest bug, a manual row, or a
--      third table with 'whoop' as a hypothetical future direct
--      integration could reintroduce a value this expression cannot
--      parse. A display-only derived column erroring an entire user's
--      workout list is a wildly disproportionate failure mode regardless
--      of how the bad value got there — this fix stands on its own.
--
-- WHY A PLAIN CASE, NOT A PLPGSQL FUNCTION:
-- Postgres's CASE WHEN ... THEN ... END short-circuits per row: the
-- THEN branch's expression (including the ::interval cast) is only
-- evaluated for a row when that row's WHEN condition is true. Guarding
-- the cast behind a regex check of the exact shape the cast can safely
-- handle is a single expression, inline, in plain SQL — no function,
-- no PL/pgSQL exception handler (which would need
-- SECURITY DEFINER/INVOKER consideration of its own, a separate
-- CREATE FUNCTION statement to track, and a BEGIN/EXCEPTION block just
-- to do what a WHEN clause already does for free). A plain SQL
-- expression is also directly inlinable and optimisable by the planner
-- the same as any other view column, unlike a function call. Chosen
-- because it is the simplest thing that actually works, not because a
-- function would have been wrong — if a future column ever needed
-- genuinely branching, multi-step recovery logic, a function would be
-- the right call there.
--
-- The regex, '^[+-]\d{2}:\d{2}(:\d{2})?$', is the SAME shape check as
-- normalizeZoneOffsetId's FIXED_OFFSET_SHAPE in mapping.ts — Postgres's
-- `~` operator uses "Advanced Regular Expressions" by default, which
-- (unlike POSIX ERE) supports \d, so the pattern is copy-identical
-- across both languages. Same spirit as validateOriginPackage's own
-- comment in mapping.ts: "Same shape check as the DB CHECK constraint...
-- rejected here, in code, with a clear message" — here it runs in both
-- places for the same reason origin_package's shape check does: catching
-- a bad value at whichever layer sees it first, without the two layers
-- needing to agree on which one is authoritative.
--
-- 'Z' IS DELIBERATELY NOT SPECIAL-CASED HERE, EVEN THOUGH WE KNOW HOW TO
-- HANDLE IT: translating 'Z' to a real date is ingest's job (and the
-- backfill's, for rows that predate that fix). Teaching the view the
-- same translation would mean the same business rule lives in two
-- places that could silently drift apart later. The view's job is
-- narrower and permanent: never error, regardless of WHAT it cannot
-- parse. Until the backfill (2) runs, a pre-existing 'Z' row reads
-- local_date = NULL under this view — safe, visible, and honest, not a
-- crash — and starts reading the correct date the moment the backfill
-- lands, with no further migration needed.
--
-- This yields NULL for anything the expression cannot handle, never a
-- guessed date (e.g. never defaulting to UTC) — the same NULL-not-
-- guessed stance the Health Connect arm's local_date comment already
-- states for a missing offset.
--
-- WHOOP ARM: BYTE-IDENTICAL, NOT TOUCHED. Its local_date expression is
-- exactly what it was in both prior migrations. Verified below with the
-- same snapshot-and-EXCEPT approach as
-- 20260830090000_biometric_workouts_health_connect_arm.sql (that
-- migration's own snapshot table has since been dropped by the operator,
-- so V0 below is a fresh CREATE).
--
-- CREATE OR REPLACE, not DROP + CREATE: only an expression inside an
-- existing column changes, not any column's name, type, or position —
-- CREATE OR REPLACE VIEW permits this. The grant survives untouched;
-- kept below anyway, matching house habit.
-- ============================================================

create or replace view public.biometric_workouts
with (security_invoker = on) as
-- ── ARM ONE: WHOOP (byte-identical to both prior migrations) ──────
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

-- ── ARM TWO: HEALTH CONNECT ────────────────────────────────────
select
  bws.user_id,
  bws.origin_package                     as ingest_source,
  bws.provider_record_id                 as source_workout_id,

  bws.period_start                       as workout_start,
  bws.period_end                         as workout_end,
  bws.timezone_offset                    as timezone_offset,
  -- THE FIX: guarded by the same shape check as ingest's
  -- normalizeZoneOffsetId (see header). A value that does not match
  -- this shape (including the 'Z' this bug was filed over, before the
  -- backfill runs) yields NULL local_date instead of raising 22007 and
  -- aborting the entire query for every row of every arm.
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
where bws.ingest_transport = 'health_connect';

grant select on public.biometric_workouts to authenticated;

-- ============================================================================
-- VERIFICATION
--
-- Run V0 BEFORE applying this migration. Run V1-V4 AFTER. Both the V0
-- snapshot and every AFTER query must run as the SAME role — same caution
-- as every prior migration touching this view.
-- ============================================================================

-- V0. BASELINE — fresh CREATE (the previous migration's snapshot table
--     has already been dropped). Run BEFORE applying this migration.
--
-- create table public._verify_biometric_workouts_pre as
-- select user_id, ingest_source, source_workout_id, workout_start,
--        workout_end, timezone_offset, local_date, sport_name, strain,
--        strain_score_state, average_heart_rate, max_heart_rate,
--        energy_kilojoule, distance_meter, altitude_gain_meter,
--        altitude_change_meter, source_updated_at
-- from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'
--   and ingest_transport = 'whoop';
--
-- select count(*) from public._verify_biometric_workouts_pre;  -- note this number

-- V1. RLS fails closed. Sign in as a SECOND account and confirm:
--
-- select count(*) from public.biometric_workouts;  -- expect 0

-- V2. WHOOP ARM IS BYTE-IDENTICAL — EXCEPT, both directions, plus a row
--     count. All three must return / match zero and equal counts.
--
-- select count(*) from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'
--   and ingest_transport = 'whoop';
-- -- must equal the V0 count noted above
--
-- select user_id, ingest_source, source_workout_id, workout_start,
--        workout_end, timezone_offset, local_date, sport_name, strain,
--        strain_score_state, average_heart_rate, max_heart_rate,
--        energy_kilojoule, distance_meter, altitude_gain_meter,
--        altitude_change_meter, source_updated_at
-- from public._verify_biometric_workouts_pre
-- except
-- select user_id, ingest_source, source_workout_id, workout_start,
--        workout_end, timezone_offset, local_date, sport_name, strain,
--        strain_score_state, average_heart_rate, max_heart_rate,
--        energy_kilojoule, distance_meter, altitude_gain_meter,
--        altitude_change_meter, source_updated_at
-- from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'
--   and ingest_transport = 'whoop';
-- -- expect 0 rows
--
-- select user_id, ingest_source, source_workout_id, workout_start,
--        workout_end, timezone_offset, local_date, sport_name, strain,
--        strain_score_state, average_heart_rate, max_heart_rate,
--        energy_kilojoule, distance_meter, altitude_gain_meter,
--        altitude_change_meter, source_updated_at
-- from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'
--   and ingest_transport = 'whoop'
-- except
-- select user_id, ingest_source, source_workout_id, workout_start,
--        workout_end, timezone_offset, local_date, sport_name, strain,
--        strain_score_state, average_heart_rate, max_heart_rate,
--        energy_kilojoule, distance_meter, altitude_gain_meter,
--        altitude_change_meter, source_updated_at
-- from public._verify_biometric_workouts_pre;
-- -- expect 0 rows
--
-- drop table public._verify_biometric_workouts_pre;

-- V3. THE ACTUAL BUG: the query must no longer error for the affected
--     user, regardless of whether the backfill (delivered separately)
--     has been run yet.
--
-- select count(*) from public.biometric_workouts
-- where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9';
-- Expect a row count back with no error. Before the backfill runs, rows
-- whose timezone_offset was 'Z' read local_date = NULL (safe, not a
-- crash); after the backfill, those same rows read the correct date.

-- V4. Confirm the NULL-yielding branch only fires for genuinely
--     unparseable values, not for good ones sitting alongside them.
--
-- select origin_package, timezone_offset, local_date
-- from public.biometric_workouts
-- where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
--   and ingest_transport = 'health_connect'
-- order by timezone_offset;
-- Every '+HH:MM' (or '+HH:MM:SS') row must show a non-null local_date;
-- 'Z' rows (pre-backfill) or any other anomalous value must show NULL,
-- never an error, never a guessed date.

-- ============================================================
-- NOT in this migration (deliberately deferred)
--
-- The backfill of existing 'Z' (and any other non-conforming)
-- timezone_offset rows across all four provider-neutral tables —
-- delivered separately as verification SQL for the operator to review
-- and run, not as a migration UPDATE. Everything else already listed as
-- deferred in 20260830090000_biometric_workouts_health_connect_arm.sql
-- remains deferred.
-- ============================================================
