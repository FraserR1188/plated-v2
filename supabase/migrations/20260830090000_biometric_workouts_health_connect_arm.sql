-- ============================================================
-- biometric_workouts — Health Connect arm (commit 3, workouts only)
--
-- Adds a second UNION ALL arm to public.biometric_workouts, sourced from
-- public.biometric_workout_sessions (empty until now — created by
-- 20260829072742_biometric_provider_neutral_tables.sql, written to by the
-- health-connect-ingest Edge Function). No client change, no Edge Function
-- change, no new table. Scope is this one view.
--
-- OUT OF SCOPE, deliberately not touched by this migration:
--   biometric_periods, biometric_periods_resolved, whoop_correlation,
--   whoop_cycle_nutrition — the period spine is a later commit.
--
-- ── WHY CREATE OR REPLACE, NOT DROP + CREATE ──────────────────────
-- 20260829111404_biometric_periods_resolved.sql had to DROP + CREATE
-- biometric_periods because it renamed a column (ingest_source ->
-- ingest_transport) and inserted one mid-list (origin_package at position
-- 3) — both operations CREATE OR REPLACE VIEW refuses. This migration
-- does neither: every existing column of biometric_workouts keeps its
-- exact name, type, and position, and the two new columns
-- (ingest_transport, origin_package) are appended at the END of the list,
-- which CREATE OR REPLACE VIEW explicitly permits. That also means the
-- grant this view already carries survives untouched — CREATE OR REPLACE
-- does not revoke and does not need reissuing, unlike a DROP. (The grant
-- statement below is kept anyway, as a harmless no-op, purely to match
-- the house habit of every view section in this file ending with one.)
--
-- ── WHY ingest_source (singular) IS KEPT, NOT RETIRED ─────────────
-- biometric_periods dropped its single ingest_source column in favour of
-- the two-column split because nothing in src/ read it yet (confirmed by
-- grep at the time). biometric_workouts is different: src/store/
-- useStore.ts fetchWorkouts() reads w.ingest_source today, and
-- TodayScreen.tsx renders it verbatim, uppercased, as the workout card's
-- source badge (src/screens/TodayScreen.tsx, "Source mark" comment). This
-- commit is scoped to the view only — no client change — so retiring
-- ingest_source here would silently blank that badge for every WHOOP
-- workout already in production. It stays, unchanged in meaning for the
-- WHOOP arm ('whoop'::text, byte-identical to before). ingest_transport
-- and origin_package are ADDED alongside it, not instead of it, so a
-- future client commit can move onto the split vocabulary without a
-- second migration.
--
-- ── WHAT THE BADGE SHOWS FOR A HEALTH CONNECT ROW ─────────────────
-- ingest_source is aliased to origin_package for the Health Connect arm,
-- NOT to ingest_transport ('health_connect'). Reasoning: for the WHOOP
-- arm, ingest_source already answers "which service actually produced
-- this data" (WHOOP's own API) — it is a provider identity, not a
-- transport label. 'health_connect' would answer a different, less
-- useful question ("did this arrive via Android's aggregator") that
-- collapses Garmin, Fitbit, Samsung Health, and WHOOP's own
-- Health-Connect-routed export into one indistinguishable badge, which
-- also happens to be the one case (WHOOP via Health Connect) where
-- distinguishability matters most — see the known duplication limitation
-- below. origin_package preserves that distinction: a WHOOP-direct
-- workout badges "WHOOP", the same workout re-appearing via Health
-- Connect (if the user also has WHOOP's Android app contributing to
-- Health Connect) badges "COM.WHOOP.ANDROID" — visibly different, so a
-- user staring at two duplicate cards can at least tell them apart. The
-- real cost of this choice is a genuinely ugly, un-prettified badge for
-- every non-WHOOP row (raw reverse-DNS package names were never designed
-- to be read by a human, let alone upper-cased). That is accepted here,
-- not fixed here — pretty-printing (title-casing, a known-vendor lookup
-- table, truncation) is a client display concern, and this commit does
-- not touch the client.
--
-- ── PROVIDER VOCABULARIES: SURFACED NATIVELY, NEVER TRANSLATED ────
-- WHOOP's sport_name and Health Connect's exercise-type vocabulary are
-- different, incompatible naming schemes for "what kind of workout was
-- this" (see biometric_workout_sessions.activity_type's own comment,
-- 20260829072742_biometric_provider_neutral_tables.sql:278). The Health
-- Connect arm below puts bws.activity_type straight into the sport_name
-- output column, completely unmodified — no CASE statement translating
-- Health Connect's codes into WHOOP-style names, no normalisation of
-- either vocabulary towards the other. Both share the column purely
-- because they occupy the same POSITION in a UNION ALL, not because they
-- mean the same thing. Any future "pretty display name for a workout
-- type" logic belongs in the client, reading sport_name alongside
-- ingest_transport to know which vocabulary it's looking at — never in
-- this view.
--
-- ── NO STRAIN FOR HEALTH CONNECT ───────────────────────────────────
-- biometric_workout_sessions has no strain column at all (see its own
-- table comment: "WHOOP-proprietary, no Health Connect equivalent, not
-- synthesized here"). The Health Connect arm below selects
-- null::numeric / null::text literals for strain / strain_score_state —
-- there is nothing to select FROM, so these cannot be anything but
-- explicit NULLs. Never 0, never a derived/estimated figure.
--
-- ── energy_kilojoule WILL READ NULL FOR HEALTH CONNECT ROWS TODAY ──
-- This is expected, not a mapping bug: the app has never requested
-- Health Connect's calories read permission, so
-- biometric_workout_sessions.energy_kilojoule is written NULL for every
-- row today. The column is still mapped live (bws.energy_kilojoule, not
-- a hardcoded null literal) because the underlying table column is real
-- and would start carrying values the day that permission is requested —
-- no second migration would be needed for energy to start flowing.
--
-- ── KNOWN LIMITATION: NO DEDUPLICATION (NOT AN OVERSIGHT) ─────────
-- If a user has WHOOP connected both directly AND has WHOOP's own
-- Android app contributing to Health Connect (origin_package
-- 'com.whoop.android'), the SAME real-world workout will appear TWICE in
-- this view: once from the whoop_workouts arm, once from the
-- biometric_workout_sessions arm. This migration does not attempt to
-- detect or collapse that — reconciling "the same real-world event
-- reported by two providers" is explicitly the period-spine commit's
-- job (see 20260829111404_biometric_periods_resolved.sql's own header,
-- "synthetic cycle reconstruction," and its note that
-- biometric_periods_resolved does not yet resolve a 'workouts' domain
-- either). Anyone reading this file: the duplication is known, expected,
-- and deferred, not missed.
--
-- ── UNION-TYPE COMPATIBILITY, CHECKED COLUMN BY COLUMN ─────────────
-- CORRECTED: an earlier draft of this comment reasoned that Postgres
-- would union integer with numeric by implicit promotion, and called
-- that "narrowing-free and lossless." That reasoning was irrelevant to
-- the operation actually being performed: this is CREATE OR REPLACE
-- VIEW on an EXISTING view, not a bare UNION ALL in isolation. CREATE
-- OR REPLACE VIEW refuses to change an existing output column's type at
-- all — not just a lossy narrowing, ANY change, including a
-- theoretically "safe" integer -> numeric widening. Confirmed the hard
-- way: this migration failed to push with exactly that error
-- (SQLSTATE 42P16) on average_heart_rate and max_heart_rate before this
-- comment and the SELECT below were corrected.
--
-- average_heart_rate / max_heart_rate: whoop_workouts declares both
-- integer; biometric_workout_sessions declares both numeric. The
-- numeric declaration on the provider-neutral table is a generic
-- default sized for whatever a future provider might report, not a
-- signal that Health Connect's own values are fractional — Android's
-- HeartRateRecord samples are whole-number BPM. Nothing real is lost by
-- rounding at this view's boundary, so the Health Connect arm below
-- casts both through round(...)::integer. round() is written
-- explicitly, rather than relying on a bare ::integer cast (which does
-- round numeric values in Postgres, not truncate) — the explicit call
-- makes the rounding visible directly in the SQL instead of depending
-- on a reader's knowledge of that implicit cast behaviour. NULL
-- propagates through round() unchanged, so an absent heart-rate reading
-- stays NULL, never 0. The underlying
-- biometric_workout_sessions.average_heart_rate / max_heart_rate table
-- columns are NOT changed to integer here — numeric is correct there,
-- since a genuinely fractional-reporting provider is not ruled out;
-- only this view's output boundary rounds.
--
-- Every other paired column was checked individually against the VIEW's
-- pre-existing type, not assumed from the general union rule:
--   user_id                uuid / uuid                — unchanged
--   ingest_source           text / text                 — literal 'whoop' / bws.origin_package
--   source_workout_id       text / text                 — w.id::text (pre-existing cast) / provider_record_id (native text)
--   workout_start/end       timestamptz / timestamptz
--   timezone_offset         text / text
--   local_date              date / date                 — computed on both sides, not a table column
--   sport_name              text / text                 — w.sport_name / bws.activity_type
--   strain                  numeric / numeric            — null::numeric literal on arm two
--   strain_score_state      text / text                  — null::text literal on arm two
--   energy_kilojoule        numeric / numeric            — w.kilojoule / bws.energy_kilojoule
--   distance_meter          numeric / numeric
--   altitude_gain_meter     numeric / numeric
--   altitude_change_meter   numeric / numeric            — null::numeric literal on arm two, explicit cast; no HC counterpart column at all
--   source_updated_at       timestamptz / timestamptz
--   ingest_transport / origin_package — text / text, both NEW trailing columns, so there is no pre-existing view type to preserve for these two.
-- No other column pair diverges.
--
-- security_invoker = on (checked immediately below). NULL-not-zero
-- throughout — no coalesce introduced by this migration.
-- ============================================================

create or replace view public.biometric_workouts
with (security_invoker = on) as
-- ── ARM ONE: WHOOP (unchanged from 20260808150000; two columns appended
--    at the tail, see header) ──────────────────────────────────
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
-- Filtered to ingest_transport = 'health_connect' deliberately, even
-- though biometric_workout_sessions' CHECK constraint also permits
-- 'whoop' (that vocabulary is shared verbatim across all four
-- provider-neutral tables for consistency — see
-- 20260829072742_biometric_provider_neutral_tables.sql's header — not
-- because a 'whoop'-transport row here is expected). WHOOP itself only
-- ever writes to whoop_workouts, already covered by arm one; a 'whoop'
-- transport row landing in biometric_workout_sessions would be a
-- different, hypothetical future direct-integration path with its own
-- future arm, not silently absorbed into "the Health Connect arm" this
-- migration is named for.
select
  bws.user_id,

  -- See header, "WHAT THE BADGE SHOWS": origin_package, not
  -- ingest_transport, so a WHOOP-via-Health-Connect duplicate remains
  -- visually distinguishable from its WHOOP-direct twin.
  bws.origin_package                     as ingest_source,
  bws.provider_record_id                 as source_workout_id,

  bws.period_start                       as workout_start,
  bws.period_end                         as workout_end,
  bws.timezone_offset                    as timezone_offset,
  -- Same expression shape as arm one, no coalesce added: an absent or
  -- malformed timezone_offset propagates to a NULL local_date rather
  -- than being guessed at (e.g. defaulted to UTC), consistent with this
  -- codebase's NULL-not-zero stance applied to dates, not just numbers.
  ((bws.period_start at time zone 'UTC') + (bws.timezone_offset)::interval)::date
                                         as local_date,

  -- See header, "PROVIDER VOCABULARIES": Health Connect's native
  -- exercise-type string, unmodified. Not WHOOP's sport_name vocabulary.
  bws.activity_type                      as sport_name,
  -- See header, "NO STRAIN": the column does not exist on this table.
  null::numeric                          as strain,
  null::text                             as strain_score_state,
  -- See header, "UNION-TYPE COMPATIBILITY": the view's existing column
  -- type is integer (from whoop_workouts); CREATE OR REPLACE VIEW
  -- cannot change it, so this arm rounds numeric -> integer explicitly
  -- rather than relying on the WHOOP arm being widened to numeric.
  round(bws.average_heart_rate)::integer as average_heart_rate,
  round(bws.max_heart_rate)::integer     as max_heart_rate,
  -- See header, "energy_kilojoule WILL READ NULL": expected, not a bug.
  bws.energy_kilojoule                   as energy_kilojoule,
  bws.distance_meter                     as distance_meter,
  bws.altitude_gain_meter                as altitude_gain_meter,
  -- No Health Connect counterpart at all (see header, union-type note).
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
-- Run V0 BEFORE applying this migration. Run V1-V3 AFTER. Both the V0
-- snapshot and every AFTER query must run as the SAME role — running one
-- as `postgres` (which bypasses RLS) and the other as `authenticated`
-- compares two different result sets and can hide a real regression. Run
-- everything as `authenticated`, or as the same test user via the app /
-- a JWT-bearing client. Same caution as
-- 20260808150000_biometric_spine_views.sql's own V0/V1.
-- ============================================================================

-- V0. BASELINE — run BEFORE applying this migration. Persists past the
--     migration on purpose (a session-scoped TEMP TABLE would not survive
--     if V0 and V1 are run in separate sessions). Drop it yourself once
--     V1 has passed (see the DROP at the very end of this block).
--
-- create table public._verify_biometric_workouts_pre as
-- select user_id, ingest_source, source_workout_id, workout_start,
--        workout_end, timezone_offset, local_date, sport_name, strain,
--        strain_score_state, average_heart_rate, max_heart_rate,
--        energy_kilojoule, distance_meter, altitude_gain_meter,
--        altitude_change_meter, source_updated_at
-- from public.biometric_workouts
-- where user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393';
--
-- select count(*) from public._verify_biometric_workouts_pre;  -- note this number

-- V1. RLS fails closed (unchanged from the existing check — re-run it
--     here too, since this migration touches the view definition). Sign
--     in as a SECOND account and confirm:
--
-- select count(*) from public.biometric_workouts;  -- expect 0

-- V2. WHOOP ARM IS BYTE-IDENTICAL — EXCEPT, both directions, plus a row
--     count (EXCEPT alone cannot catch a duplicated row on one side).
--     All three must return / match zero and equal counts respectively.
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

-- V3. HEALTH CONNECT ROWS NOW APPEAR, with provenance visible.
--
-- select source_workout_id, workout_start, sport_name, ingest_source,
--        ingest_transport, origin_package
-- from public.biometric_workouts
-- where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
--   and ingest_transport = 'health_connect'
-- order by workout_start desc
-- limit 20;
-- Expect one or more rows, origin_package populated with a real Android
-- package name, strain / strain_score_state NULL on every row.

-- ============================================================
-- NOT in this migration (deliberately deferred)
--
-- Deduplication of the same real-world workout appearing via both a
-- direct WHOOP row and a Health-Connect-routed WHOOP row — see header,
-- "KNOWN LIMITATION." biometric_periods / biometric_periods_resolved /
-- whoop_correlation / whoop_cycle_nutrition — untouched, per this
-- commit's stated scope. Any client change to consume ingest_transport /
-- origin_package directly, or to prettify the source badge — the badge
-- keeps reading the single ingest_source column exactly as it does today.
-- ============================================================
