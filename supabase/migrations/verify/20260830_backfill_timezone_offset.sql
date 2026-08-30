-- ============================================================
-- Backfill: normalise timezone_offset across all four provider-neutral
-- biometric tables.
--
-- NOT A MIGRATION — deliberately kept in verify/, which `supabase db
-- push` does not sweep (same reason 20260818140000_verify.sql lives
-- here). Everything below is a comment block: copy out one query at a
-- time and run it yourself. Nothing here executes on its own.
--
-- WHY: Health Connect legitimately emits 'Z' for UTC in
-- java.time.ZoneOffset#getId()'s output — a valid ISO-8601 offset, but
-- not a value Postgres's interval literal parser accepts
-- ('Z'::interval raises 22007, invalid_datetime_format). This shape
-- check and the '+00:00' mapping for 'Z' are IDENTICAL to
-- normalizeZoneOffsetId in supabase/functions/health-connect-ingest/
-- mapping.ts (that fix stops NEW rows from ever holding 'Z' again) and
-- to the CASE guard added to biometric_workouts by
-- 20260830130000_biometric_workouts_defensive_local_date.sql (that fix
-- stops a bad value, however it got there, from ever erroring the whole
-- view again). This script is the THIRD piece: correcting the rows that
-- already exist from before either of those two shipped.
--
-- timezone_offset is documented as LABELLING ONLY on all four tables
-- ("Never join on this") — nothing besides biometric_workouts' derived
-- local_date column reads it today, so this backfill's only observable
-- effect is that Health Connect workouts start showing the correct
-- calendar date instead of NULL.
--
-- shape check, shared verbatim with mapping.ts and the view migration:
--   ^[+-]\d{2}:\d{2}(:\d{2})?$
-- (Postgres's ~ operator uses Advanced Regular Expressions by default,
-- which — unlike POSIX ERE — supports \d, so this is copy-identical to
-- the TS regex.)
--
-- RUN ORDER: Step 1 (survey) -> Step 2, per table (preview, then the
-- matching UPDATE only after you've reviewed its preview) -> Step 3
-- (confirm zero remain, all four tables).
-- ============================================================


-- ── STEP 1: SURVEY — what values exist today, across all four tables ──
--
-- select 'biometric_sleep_sessions' as t, timezone_offset, count(*)
-- from public.biometric_sleep_sessions group by 1, 2
-- union all
-- select 'biometric_hrv_samples', timezone_offset, count(*)
-- from public.biometric_hrv_samples group by 1, 2
-- union all
-- select 'biometric_resting_hr', timezone_offset, count(*)
-- from public.biometric_resting_hr group by 1, 2
-- union all
-- select 'biometric_workout_sessions', timezone_offset, count(*)
-- from public.biometric_workout_sessions group by 1, 2
-- order by 1, 2;
--
-- The bug report's own query already showed biometric_workout_sessions
-- for one user: +01:00 (503), Z (60). This step widens that to every
-- table and every user, so you know the true scope before touching
-- anything.


-- ── STEP 2a: biometric_sleep_sessions ──────────────────────────────

-- PREVIEW — only rows that would actually change (already-conforming
-- ±HH:MM(:SS) rows are excluded: their new_value would equal old_value,
-- a no-op not worth showing).
--
-- select timezone_offset as old_value,
--        case when timezone_offset = 'Z' then '+00:00' else null end as new_value,
--        count(*) as row_count
-- from public.biometric_sleep_sessions
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
-- group by 1, 2
-- order by 1;

-- UPDATE — run only after reviewing the preview above.
--
-- update public.biometric_sleep_sessions
-- set timezone_offset = case when timezone_offset = 'Z' then '+00:00' else null end
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$';


-- ── STEP 2b: biometric_hrv_samples ─────────────────────────────────

-- PREVIEW
--
-- select timezone_offset as old_value,
--        case when timezone_offset = 'Z' then '+00:00' else null end as new_value,
--        count(*) as row_count
-- from public.biometric_hrv_samples
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
-- group by 1, 2
-- order by 1;

-- UPDATE
--
-- update public.biometric_hrv_samples
-- set timezone_offset = case when timezone_offset = 'Z' then '+00:00' else null end
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$';


-- ── STEP 2c: biometric_resting_hr ──────────────────────────────────

-- PREVIEW
--
-- select timezone_offset as old_value,
--        case when timezone_offset = 'Z' then '+00:00' else null end as new_value,
--        count(*) as row_count
-- from public.biometric_resting_hr
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
-- group by 1, 2
-- order by 1;

-- UPDATE
--
-- update public.biometric_resting_hr
-- set timezone_offset = case when timezone_offset = 'Z' then '+00:00' else null end
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$';


-- ── STEP 2d: biometric_workout_sessions (the table the bug report was filed against) ──

-- PREVIEW
--
-- select timezone_offset as old_value,
--        case when timezone_offset = 'Z' then '+00:00' else null end as new_value,
--        count(*) as row_count
-- from public.biometric_workout_sessions
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
-- group by 1, 2
-- order by 1;
--
-- On the test account (4dbf04ae-7b46-4511-8122-f17284c622d9) this
-- should show exactly one row: old_value 'Z', new_value '+00:00',
-- row_count 60 — matching the bug report's own count.

-- UPDATE
--
-- update public.biometric_workout_sessions
-- set timezone_offset = case when timezone_offset = 'Z' then '+00:00' else null end
-- where timezone_offset is not null
--   and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$';


-- ── STEP 3: CONFIRM ZERO NON-CONFORMING VALUES REMAIN, ALL FOUR TABLES ──
--
-- select 'biometric_sleep_sessions' as t, count(*) from public.biometric_sleep_sessions
--   where timezone_offset is not null and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
-- union all
-- select 'biometric_hrv_samples', count(*) from public.biometric_hrv_samples
--   where timezone_offset is not null and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
-- union all
-- select 'biometric_resting_hr', count(*) from public.biometric_resting_hr
--   where timezone_offset is not null and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
-- union all
-- select 'biometric_workout_sessions', count(*) from public.biometric_workout_sessions
--   where timezone_offset is not null and timezone_offset !~ '^[+-]\d{2}:\d{2}(:\d{2})?$';
-- Every row must read 0.

-- ── STEP 4: CONFIRM local_date NOW POPULATES for the previously-broken rows ──
--
-- select source_workout_id, timezone_offset, local_date
-- from public.biometric_workouts
-- where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
--   and ingest_transport = 'health_connect'
-- order by local_date desc nulls last
-- limit 20;
-- Every row should now show a non-null local_date (assuming
-- 20260830130000_biometric_workouts_defensive_local_date.sql is already
-- applied — this step depends on that migration, not just this backfill).
-- ============================================================
