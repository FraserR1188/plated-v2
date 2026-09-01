-- ============================================================================
-- Verification — 20260901140000_biometric_synthetic_cycles_is_nap_null_tolerant.sql
-- is_nap NULL-not-zero fix, commit one of three (view side only)
--
-- Run V1-V2 BEFORE applying the migration (V1 cannot be recreated
-- afterwards). Apply the migration. Run V3-V4 after. Fixtures V5-V6 are
-- standalone — no migration or table data required, no db push needed at
-- all — and were executed against a throwaway plain-Postgres container as
-- part of writing this file; their actual output is transcribed below, not
-- hand-traced.
--
-- V3b MUST be run FIRST after the push, before V3's own snapshot and diff
-- are trusted — see V3b's own comment for why.
--
-- Every number in V2-V4 below that describes what THIS push will do is
-- PREDICTED, not measured — nothing has been pushed yet. The one exception
-- is the 182-row / all-false production count, which is the requester's own
-- already-measured fact (supplied 2026-09-01), reproduced here as a stated
-- input, not something this file or its author queried production for.
-- ============================================================================

-- ── V1. PRE-PUSH SNAPSHOT — run BEFORE applying the migration ─────────────
-- Column list reviewed against the CURRENT (pre-push) view definition
-- (20260830170000_biometric_synthetic_cycles.sql) before writing this
-- snapshot: user_id, ingest_transport, origin_package, source_period_id,
-- cycle_start, cycle_end, is_current, timezone_offset, local_date,
-- block_wake_at, wake_timezone_offset, continuity — 12 columns, all of them.
--
-- VOLATILITY CHECK: none of the 12 is now()-derived. is_current is
-- `(next_onset is null)` — purely structural (whether a later onset row has
-- been recorded), not a function of the current wall-clock time the way
-- whoop_cycle_nutrition.effective_end's `coalesce(period_end, case when
-- period_start > now() - interval '36 hours' then now() end)` is. Every
-- other column is a plain passthrough or a deterministic date/interval
-- computation over stored values. Nothing is omitted from this snapshot as
-- a result — there is no effective_end-shaped column on this view to worry
-- about.
--
-- Dashboard note: when creating this table via the SQL editor, if prompted
-- to enable RLS, enable it WITH NO POLICY. That makes the table
-- unreadable to anon/authenticated (matching every other _diag table this
-- schema has used, e.g. 20260901130000_verify.sql's _diag_wc3_pre/_post) —
-- it is a throwaway diagnostic table read only by you as the DB owner via
-- the SQL editor, not a table any client role should ever see rows from.
create table public._diag_hc_isnap_pre as
select
  user_id, ingest_transport, origin_package, source_period_id,
  cycle_start, cycle_end, is_current, timezone_offset, local_date,
  block_wake_at, wake_timezone_offset, continuity
from public.biometric_synthetic_cycles;


-- ── V2. ROW COUNTS ON BOTH SIDES — captured pre-push so V3's diff cannot
--       pass vacuously later ─────────────────────────────────────────────
-- Both counts read from the SAME pre-push state (the live view and the
-- snapshot just taken from it), so they are expected to be identical
-- trivially right now — that is not the interesting assertion. The
-- interesting one is comparing THIS number against V3's post-push count.
select
  (select count(*) from public.biometric_synthetic_cycles) as pre_live_view_count,
  (select count(*) from public._diag_hc_isnap_pre)          as pre_snapshot_count;
-- PREDICTED: both columns equal, and both equal to the requester's own
-- already-measured 182-row biometric_sleep_sessions count IF (and only
-- if) every one of those 182 rows survives the source_rows CTE's other two
-- gates (transport = 'health_connect', duration >= 3h) into exactly 182
-- worth of qualifying rows post-merge — this file does not re-derive that
-- merge arithmetic from the 182 raw rows, only asserts the two counts here
-- must match each other. Record whatever this actually returns; that
-- recorded number, not 182 itself, is what V3 must reproduce.
-- MEASURED (2026-09-01, after the push): pre_live_view_count = 182,
-- pre_snapshot_count = 182. Matches the prediction exactly.


-- ══════════════════════════════════════════════════════════════════════════
-- APPLY THE MIGRATION NOW: 20260901140000_biometric_synthetic_cycles_is_nap_
-- null_tolerant.sql
-- ══════════════════════════════════════════════════════════════════════════


-- ── V3. POST-PUSH SNAPSHOT + NON-VACUOUS DIFF, BOTH DIRECTIONS ────────────
-- Identical column list to V1 — the migration adds no column, renames none,
-- reorders none.
create table public._diag_hc_isnap_post as
select
  user_id, ingest_transport, origin_package, source_period_id,
  cycle_start, cycle_end, is_current, timezone_offset, local_date,
  block_wake_at, wake_timezone_offset, continuity
from public.biometric_synthetic_cycles;

-- EXCEPT between two empty sets returns zero rows and proves nothing on its
-- own — a silently-broken migration that emptied this view would pass a
-- bare "expect zero rows" check just as cleanly as a correct one. The counts
-- below must BOTH be non-zero AND equal to each other, and to V2's recorded
-- pre-push number, before the zero-rows diffs below are read as meaningful.
select
  (select count(*) from public._diag_hc_isnap_pre)  as pre_count,
  (select count(*) from public._diag_hc_isnap_post) as post_count;
-- PREDICTED: pre_count = post_count = V2's recorded number, and neither is
-- 0. If post_count is 0 while pre_count is not, the predicate change (or
-- something else in this push) emptied the view — the exact failure mode
-- this whole commit exists to prevent, now happening for a different
-- reason. Do not proceed to trust the diffs below until this row confirms
-- non-zero and equal.
-- MEASURED (2026-09-01, after the push): pre_count = 182, post_count =
-- 182 — non-zero and equal. Confirmed safe to trust the diffs below.

(
  select 'pre_minus_post' as direction, pre.*
  from public._diag_hc_isnap_pre pre
  except
  select 'pre_minus_post', post.*
  from public._diag_hc_isnap_post post
)
union all
(
  select 'post_minus_pre', post.*
  from public._diag_hc_isnap_post post
  except
  select 'post_minus_pre', pre.*
  from public._diag_hc_isnap_pre pre
);
-- PREDICTED: ZERO rows both directions. Per the requester's own measured
-- production fact, all 182 biometric_sleep_sessions rows are is_nap = false
-- today, and `is_nap = false` / `is_nap is not true` accept a literal false
-- identically — there is no false-vs-NULL divergence for this predicate
-- change to expose yet. This diff is what actually confirms that, not this
-- comment.
-- MEASURED (2026-09-01, after the push): ZERO rows both directions. The
-- predicate change was inert, exactly as predicted.


-- ── V3b. DID THE PUSH ACTUALLY LAND? ────────────────────────────────────
-- Every other check in this file is designed to pass when NOTHING changed —
-- zero change is the expected result of this whole migration, per the
-- PREDICTED comments above. That makes every one of them silent on the
-- separate question of whether the migration was applied at all: a push
-- that silently no-ops, a post-snapshot taken before the push actually ran,
-- or a migration file that was never swept by `db push` would all produce
-- the exact same clean bidirectional diff, matching row counts, and a
-- passing RLS check as a correctly-applied one — because in the intended
-- outcome, correct and not-applied-yet look identical everywhere else in
-- this file. V3b is the only query here that can tell them apart: it reads
-- the view's actual definition off the catalog, not its output.
select
  pg_get_viewdef('public.biometric_synthetic_cycles'::regclass, true)
    ilike '%is_nap is not true%' as new_predicate_present,
  pg_get_viewdef('public.biometric_synthetic_cycles'::regclass, true)
    ilike '%is_nap = false%'     as old_predicate_still_present;
-- REQUIRED: new_predicate_present = true, old_predicate_still_present =
-- false. If both are false the view does not read is_nap at all and
-- something is badly wrong. If the old predicate is still true, the push
-- did not land and V2/V3/V4's green results are meaningless — stop and do
-- not read them.
-- MEASURED (2026-09-01, after the push): new_predicate_present = true,
-- old_predicate_still_present = false. The push landed.


-- ── V4. RLS — second account, in-session, not the dashboard's superuser ───
-- The dashboard SQL editor connects as a superuser and bypasses RLS
-- entirely — it cannot tell you anything about row-level security. This
-- must run as an authenticated session with a real JWT claim, per this
-- schema's own established convention (20260830170000_verify.sql V1;
-- 20260901130000_verify.sql V9).
--
-- 4dbf04ae-7b46-4511-8122-f17284c622d9 is the account already established
-- (20260830170000_verify.sql V1) as the one holding Health Connect data.
--
-- CORRECTION, 2026-09-01 (measured, after the push) — this file originally
-- repeated 20260830170000_verify.sql V1's note that a8435663 "has no
-- Health Connect data of its own." That was accurate when it was written
-- and is stale now: a8435663 acquired Health Connect data after the August
-- verify was written — Health Connect permissions were granted on that
-- account and one sleep session has since been ingested under it
-- (period_start 2026-08-31 20:04:22.18+00, provider_record_id
-- whoop://sleep/8df93a09-0d50-4892-b998-8033775d4a25, origin_package
-- com.whoop.android — the same physical WHOOP arriving via Health
-- Connect). Confirmed against biometric_sleep_sessions: 4dbf04ae holds 181
-- rows (2026-03-03 to 2026-08-30), a8435663 holds 1 (2026-08-31).
--
-- 181 + 1 = 182 = V3's post_count, so RLS is correct: each account sees
-- only its own rows and nothing is leaked or lost. The PREDICTION was
-- stale, not the check.
--
-- FORWARD-LOOKING WARNING: a8435663 is now a live Health Connect ingest
-- path and is no longer an empty control. Any later verify file predicting
-- zero rows for it on this table — including commit three's backfill — is
-- wrong on that assumption.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"4dbf04ae-7b46-4511-8122-f17284c622d9"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.biometric_synthetic_cycles;
-- PREDICTED: row_count = V3's post_count (this account holds ALL of it),
-- distinct_users = 1.
-- MEASURED (2026-09-01, after the push): row_count = 181, distinct_users
-- = 1. NOT all of V3's post_count (182) — see the CORRECTION above: as of
-- this push a8435663 also holds 1 row of its own, so 4dbf04ae no longer
-- holds the entire table. 181 + 1 = 182 confirms nothing was lost or
-- leaked; the rows are simply partitioned across two accounts now, not
-- one.
rollback;

begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.biometric_synthetic_cycles;
-- PREDICTED: row_count = 0 — this account has no Health Connect data of
-- its own (20260830170000_verify.sql V1).
-- CORRECTED / MEASURED (2026-09-01, after the push): row_count = 1,
-- distinct_users = 1 — NOT 0. That prediction (inherited from
-- 20260830170000_verify.sql V1) is stale, not this check — see the
-- CORRECTION above the first begin/rollback block in this V4 for the full
-- explanation (one sleep session ingested under this account since that
-- August verify was written).
rollback;

-- security_invoker survived the CREATE OR REPLACE:
select relname, c.reloptions
from pg_class c
where c.relname = 'biometric_synthetic_cycles'
  and c.relnamespace = 'public'::regnamespace;
-- PREDICTED: reloptions includes security_invoker=true.
-- MEASURED (2026-09-01, after the push): security_invoker=on present in
-- reloptions. Confirmed.


-- ============================================================================
-- V5 and V6 below are self-contained fixtures — no real table, no migration,
-- no db push. Both were EXECUTED (not hand-traced) against a throwaway
-- plain-Postgres container (docker run --rm -d -e POSTGRES_PASSWORD=...
-- postgres:16-alpine, psql -U postgres, container torn down immediately
-- after) while writing this file. Their actual output is transcribed
-- verbatim below each query, not reasoned about.
--
-- Each is the shipped view's own post-source_rows CTE chain — gapped /
-- blocked / first_of_block / last_of_block / blocks / onsets / classified /
-- final select — copied character-for-character from
-- 20260901140000_biometric_synthetic_cycles_is_nap_null_tolerant.sql, with
-- exactly one line changed: source_rows reads from a literal VALUES list
-- instead of public.biometric_sleep_sessions. Passing here is evidence
-- about the logic that ships, not about a reimplementation that could drift
-- from it — same convention as F1-F5 in 20260830170000_verify.sql.
--
-- Fixture rows, each its own (user_id, origin_package) partition (distinct
-- user_id, same fixture origin_package) so none of them can merge with or
-- gap against each other — the merge/ceiling machinery is deliberately kept
-- out of scope here, it is already proven by F1-F5 in the prior migration's
-- verify file and is not what this predicate change touches:
--   null-long   (...101): health_connect, is_nap = NULL,  8h  duration — MUST appear
--   true-long   (...102): health_connect, is_nap = true,  8h  duration — MUST NOT appear
--   false-long  (...103): health_connect, is_nap = false, 8h  duration — MUST appear (no regression)
--   null-short  (...104): health_connect, is_nap = NULL, 45m duration — MUST NOT appear (duration gate, not is_nap, excludes this one)
-- ============================================================================

-- ── V5. NULL FIXTURE — the important one ──────────────────────────────────
-- EXPECTED: exactly 2 rows, source_period_id in ('null-long', 'false-long').
-- Both: cycle_start = 2026-06-01 22:00:00+00, cycle_end = NULL,
-- is_current = true, continuity = false, block_wake_at =
-- 2026-06-02 06:00:00+00, local_date = 2026-06-02. 'true-long' and
-- 'null-short' must not appear anywhere in the output.
with source_rows as (
  select user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset
  from (values
    ('00000000-0000-0000-0000-000000000101'::uuid, 'com.example.fixture', 'null-long',
     '2026-06-01 22:00:00+00'::timestamptz, '2026-06-02 06:00:00+00'::timestamptz,
     '+00:00', 'health_connect', null::boolean),
    ('00000000-0000-0000-0000-000000000102'::uuid, 'com.example.fixture', 'true-long',
     '2026-06-01 22:00:00+00'::timestamptz, '2026-06-02 06:00:00+00'::timestamptz,
     '+00:00', 'health_connect', true::boolean),
    ('00000000-0000-0000-0000-000000000103'::uuid, 'com.example.fixture', 'false-long',
     '2026-06-01 22:00:00+00'::timestamptz, '2026-06-02 06:00:00+00'::timestamptz,
     '+00:00', 'health_connect', false::boolean),
    ('00000000-0000-0000-0000-000000000104'::uuid, 'com.example.fixture', 'null-short',
     '2026-06-01 14:00:00+00'::timestamptz, '2026-06-01 14:45:00+00'::timestamptz,
     '+00:00', 'health_connect', null::boolean)
  ) as t(user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset, ingest_transport, is_nap)
  where ingest_transport = 'health_connect'
    and is_nap is not true
    and (period_end - period_start) >= interval '3 hours'
),
gapped as (
  select *,
    coalesce(
      period_start - max(period_end) over (
        partition by user_id, origin_package
        order by period_start, provider_record_id
        rows between unbounded preceding and 1 preceding
      ) > interval '4 hours',
      true
    ) as starts_new_block
  from source_rows
),
blocked as (
  select *, sum(case when starts_new_block then 1 else 0 end)
    over (partition by user_id, origin_package order by period_start, provider_record_id
          rows between unbounded preceding and current row) as block_id
  from gapped
),
first_of_block as (
  select distinct on (user_id, origin_package, block_id)
    user_id, origin_package, block_id, provider_record_id as source_period_id,
    period_start as cycle_start, timezone_offset
  from blocked
  order by user_id, origin_package, block_id, period_start asc, provider_record_id asc
),
last_of_block as (
  select distinct on (user_id, origin_package, block_id)
    user_id, origin_package, block_id, period_end as block_wake_at, timezone_offset as wake_timezone_offset
  from blocked
  order by user_id, origin_package, block_id, period_end desc, provider_record_id desc
),
blocks as (
  select f.user_id, f.origin_package, f.block_id, f.source_period_id, f.cycle_start,
         f.timezone_offset, l.block_wake_at, l.wake_timezone_offset
  from first_of_block f
  join last_of_block l on l.user_id = f.user_id and l.origin_package = f.origin_package and l.block_id = f.block_id
),
onsets as (
  select *, lag(cycle_start) over w as prev_onset, lead(cycle_start) over w as next_onset
  from blocks
  window w as (partition by user_id, origin_package order by cycle_start)
),
classified as (
  select *,
    (next_onset is not null and next_onset - cycle_start > interval '36 hours') as exceeds_ceiling,
    (prev_onset is not null and cycle_start - prev_onset <= interval '36 hours') as continuity
  from onsets
)
select user_id, 'health_connect'::text as ingest_transport, origin_package, source_period_id,
       cycle_start, next_onset as cycle_end, (next_onset is null) as is_current, timezone_offset,
       case when wake_timezone_offset ~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
         then ((block_wake_at at time zone 'UTC') + wake_timezone_offset::interval)::date
         else null::date end as local_date,
       block_wake_at, wake_timezone_offset, continuity
from classified
where not exceeds_ceiling
order by source_period_id;
-- ACTUALLY EXECUTED (throwaway container, transcribed verbatim):
--
--                user_id                | ingest_transport |   origin_package    | source_period_id |      cycle_start       | cycle_end | is_current | timezone_offset | local_date |     block_wake_at      | wake_timezone_offset | continuity
-- --------------------------------------+------------------+---------------------+------------------+------------------------+-----------+------------+-----------------+------------+------------------------+----------------------+------------
--  00000000-0000-0000-0000-000000000103 | health_connect   | com.example.fixture | false-long       | 2026-06-01 22:00:00+00 |           | t          | +00:00          | 2026-06-02 | 2026-06-02 06:00:00+00 | +00:00               | f
--  00000000-0000-0000-0000-000000000101 | health_connect   | com.example.fixture | null-long        | 2026-06-01 22:00:00+00 |           | t          | +00:00          | 2026-06-02 | 2026-06-02 06:00:00+00 | +00:00               | f
-- (2 rows)
--
-- Matches prediction exactly: null-long and false-long both present,
-- true-long and null-short both absent, cycle_end NULL / is_current true /
-- local_date 2026-06-02 / continuity false on both surviving rows.


-- ── V6. SABOTAGE VARIANT — identical except the predicate reverts to
--       `is_nap = false` ─────────────────────────────────────────────────
-- If this sabotage stayed GREEN (null-long still present), the fixture
-- above would not actually discriminate between the old and new predicate,
-- and the FIXTURE is what would need fixing, not this assertion — the same
-- standard 20260830170000_verify.sql's own F1-F5 hold themselves to.
-- EXPECTED (and required, for V5 to mean anything): RED. Exactly 1 row,
-- 'false-long' only — 'null-long' must disappear.
with source_rows as (
  select user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset
  from (values
    ('00000000-0000-0000-0000-000000000101'::uuid, 'com.example.fixture', 'null-long',
     '2026-06-01 22:00:00+00'::timestamptz, '2026-06-02 06:00:00+00'::timestamptz,
     '+00:00', 'health_connect', null::boolean),
    ('00000000-0000-0000-0000-000000000102'::uuid, 'com.example.fixture', 'true-long',
     '2026-06-01 22:00:00+00'::timestamptz, '2026-06-02 06:00:00+00'::timestamptz,
     '+00:00', 'health_connect', true::boolean),
    ('00000000-0000-0000-0000-000000000103'::uuid, 'com.example.fixture', 'false-long',
     '2026-06-01 22:00:00+00'::timestamptz, '2026-06-02 06:00:00+00'::timestamptz,
     '+00:00', 'health_connect', false::boolean),
    ('00000000-0000-0000-0000-000000000104'::uuid, 'com.example.fixture', 'null-short',
     '2026-06-01 14:00:00+00'::timestamptz, '2026-06-01 14:45:00+00'::timestamptz,
     '+00:00', 'health_connect', null::boolean)
  ) as t(user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset, ingest_transport, is_nap)
  where ingest_transport = 'health_connect'
    and is_nap = false  -- SABOTAGE: reverted from `is_nap is not true`
    and (period_end - period_start) >= interval '3 hours'
),
gapped as (
  select *,
    coalesce(
      period_start - max(period_end) over (
        partition by user_id, origin_package
        order by period_start, provider_record_id
        rows between unbounded preceding and 1 preceding
      ) > interval '4 hours',
      true
    ) as starts_new_block
  from source_rows
),
blocked as (
  select *, sum(case when starts_new_block then 1 else 0 end)
    over (partition by user_id, origin_package order by period_start, provider_record_id
          rows between unbounded preceding and current row) as block_id
  from gapped
),
first_of_block as (
  select distinct on (user_id, origin_package, block_id)
    user_id, origin_package, block_id, provider_record_id as source_period_id,
    period_start as cycle_start, timezone_offset
  from blocked
  order by user_id, origin_package, block_id, period_start asc, provider_record_id asc
),
last_of_block as (
  select distinct on (user_id, origin_package, block_id)
    user_id, origin_package, block_id, period_end as block_wake_at, timezone_offset as wake_timezone_offset
  from blocked
  order by user_id, origin_package, block_id, period_end desc, provider_record_id desc
),
blocks as (
  select f.user_id, f.origin_package, f.block_id, f.source_period_id, f.cycle_start,
         f.timezone_offset, l.block_wake_at, l.wake_timezone_offset
  from first_of_block f
  join last_of_block l on l.user_id = f.user_id and l.origin_package = f.origin_package and l.block_id = f.block_id
),
onsets as (
  select *, lag(cycle_start) over w as prev_onset, lead(cycle_start) over w as next_onset
  from blocks
  window w as (partition by user_id, origin_package order by cycle_start)
),
classified as (
  select *,
    (next_onset is not null and next_onset - cycle_start > interval '36 hours') as exceeds_ceiling,
    (prev_onset is not null and cycle_start - prev_onset <= interval '36 hours') as continuity
  from onsets
)
select user_id, 'health_connect'::text as ingest_transport, origin_package, source_period_id,
       cycle_start, next_onset as cycle_end, (next_onset is null) as is_current, timezone_offset,
       case when wake_timezone_offset ~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
         then ((block_wake_at at time zone 'UTC') + wake_timezone_offset::interval)::date
         else null::date end as local_date,
       block_wake_at, wake_timezone_offset, continuity
from classified
where not exceeds_ceiling
order by source_period_id;
-- ACTUALLY EXECUTED (throwaway container, transcribed verbatim):
--
--                user_id                | ingest_transport |   origin_package    | source_period_id |      cycle_start       | cycle_end | is_current | timezone_offset | local_date |     block_wake_at      | wake_timezone_offset | continuity
-- --------------------------------------+------------------+---------------------+------------------+------------------------+-----------+------------+-----------------+------------+------------------------+----------------------+------------
--  00000000-0000-0000-0000-000000000103 | health_connect   | com.example.fixture | false-long       | 2026-06-01 22:00:00+00 |           | t          | +00:00          | 2026-06-02 | 2026-06-02 06:00:00+00 | +00:00               | f
-- (1 row)
--
-- Went RED exactly as required: null-long disappeared under the reverted
-- predicate, false-long unaffected. The fixture discriminates.


-- ============================================================================
-- NOTE: F1-F5 in 20260830170000_verify.sql still carry the OLD
-- `is_nap = false` predicate in their own copied CTE chains and will
-- continue to pass unchanged — none of their fixture rows use NULL is_nap,
-- so this predicate change is invisible to them. They are the record of
-- that migration's own push and are deliberately NOT being edited here.
-- This file's V5/V6 supersede the predicate for is_nap specifically;
-- F1-F5 remain the reference for the merge/ceiling/nesting logic, which
-- this commit does not touch.
-- ============================================================================


-- ── V7. CLEANUP — run yourself once satisfied ─────────────────────────────
-- drop table public._diag_hc_isnap_pre;
-- drop table public._diag_hc_isnap_post;
