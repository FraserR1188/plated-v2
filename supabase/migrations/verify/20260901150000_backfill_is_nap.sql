-- ============================================================
-- Backfill: correct biometric_sleep_sessions.is_nap from false to NULL on
-- every row where Health Connect never provided a nap signal at all.
-- is_nap NULL-not-zero fix — commit three of three
--
-- NOT A MIGRATION — deliberately kept in verify/, which `supabase db push`
-- does not sweep (same reason 20260830_backfill_timezone_offset.sql and
-- 20260818140000_verify.sql live here). Everything below is a comment
-- block: copy out one step at a time and run it yourself in the dashboard
-- SQL editor, in the order given. Nothing here executes on its own.
--
-- RUN THIS ONLY AFTER
-- 20260901150000_biometric_sleep_sessions_is_nap_nullable.sql HAS BEEN
-- PUSHED. Before that migration lands, is_nap is still `not null` and the
-- UPDATE in Step 2 will fail outright against the column's own constraint.
-- That failure is a correct signal that this file was run out of order —
-- not a bug in this script, and not something to work around.
--
-- ── WHY ────────────────────────────────────────────────────────────────
-- Health Connect's SleepSessionRecord carries no nap field at all. Every
-- row in this table with ingest_transport = 'health_connect' was written
-- by a mapper (supabase/functions/health-connect-ingest/mapping.ts's
-- mapSleepSession) that never sets is_nap — the column's own former
-- `default false` supplied the stored value, asserting "confirmed not a
-- nap" for data that never carried that information in the first place.
-- This script corrects those existing rows to the value the schema
-- migration now permits: NULL, meaning "no nap signal available," not
-- "confirmed not a nap." See
-- 20260901150000_biometric_sleep_sessions_is_nap_nullable.sql's own header
-- for the full reasoning, including why no mapper change is needed for
-- future rows.
--
-- ── WHY THE PREDICATE IS `ingest_transport = 'health_connect'` ───────────
-- Every row in this table is ingest_transport = 'health_connect' today, so
-- an unfiltered UPDATE would touch the identical set and the predicate
-- looks redundant. It is not. This table's own
-- biometric_sleep_sessions_transport_origin_check already anticipates a
-- second transport (ingest_transport = 'whoop', origin_package like
-- '%.direct' — a future WHOOP direct-integration arm) which COULD write a
-- real, meaningful is_nap of its own, because WHOOP actually reports one.
-- Scoping this one-time correction to 'health_connect' means it can never
-- destroy a real answer on such a row, even if this script is accidentally
-- re-run long after that arm exists.
--
-- ── EXPECTED SHAPE, TO COMPARE AGAINST — NOT A NUMBER TO ASSUME ─────────
-- Per the requester's own measurement on 2026-09-01 (not measured by this
-- script, not re-derived here, and not queried from production by its
-- author): 182 rows total, all ingest_transport = 'health_connect', all
-- origin_package = 'com.whoop.android', all is_nap = false — zero true,
-- zero NULL — split 181 rows under
-- 4dbf04ae-7b46-4511-8122-f17284c622d9 (2026-03-03 to 2026-08-30) and 1
-- row under a8435663-72e9-4d33-9c3f-803c4cbda393 (2026-08-31). BOTH
-- accounts are live Health Connect ingest paths now; neither is an empty
-- control any more (see 20260901140000_verify.sql's V4 CORRECTION).
--
-- New rows may legitimately have landed since that measurement — this
-- table ingests continuously, so a larger count is expected over time and
-- is not itself a problem. What matters is that Step 1's ACTUAL output is
-- read and compared before Step 2 is run, and that Step 2's reported row
-- count is reconciled against it. Do not treat 182 as a required count
-- anywhere in this file.
--
-- RUN ORDER: Step 1 (pre-count) -> Step 2 (the UPDATE, inside its own
-- explicit transaction — inspect the reported row count BEFORE committing)
-- -> Step 3 (post-count, same shape as Step 1) -> Step 4
-- (biometric_synthetic_cycles row count unchanged) -> Step 5 (two-account
-- RLS split unchanged).
-- ============================================================


-- ── STEP 1. PRE-COUNT — record the starting state ─────────────────────────
select ingest_transport, is_nap, count(*)
from public.biometric_sleep_sessions
group by ingest_transport, is_nap
order by ingest_transport, is_nap;
-- PREDICTED: a single row — ingest_transport = 'health_connect',
-- is_nap = false, count = 182. Read what it actually returns and carry
-- that number into Step 2; do not assume 182.


-- ── STEP 2. THE UPDATE — inside its own explicit transaction ──────────────
-- Do NOT run this with autocommit on. Run through the UPDATE, read the row
-- count Postgres reports for it, and only then run COMMIT.
begin;

update public.biometric_sleep_sessions
  set is_nap = null
  where ingest_transport = 'health_connect'
    and is_nap is not null;

-- INSPECT THE REPORTED ROW COUNT HERE, BEFORE COMMITTING.
-- PREDICTED: 182 rows affected — every current row is
-- ingest_transport = 'health_connect' with is_nap = false (i.e. not null),
-- so every current row matches this predicate. Compare that reported count
-- against what Step 1 actually showed for the same slice. If the two do
-- not reconcile, run ROLLBACK instead of COMMIT and find out why before
-- retrying — an unexplained count here is exactly the kind of thing this
-- transaction wrapper exists to let you back out of.

commit;


-- ── STEP 3. POST-COUNT — same shape as Step 1 ─────────────────────────────
select ingest_transport, is_nap, count(*)
from public.biometric_sleep_sessions
group by ingest_transport, is_nap
order by ingest_transport, is_nap;
-- PREDICTED: a single row — ingest_transport = 'health_connect',
-- is_nap = NULL (no longer false), count unchanged from Step 1's total
-- (predicted 182). The whole population moves from the `false` group to
-- the NULL group; nothing is created or destroyed. If a `false` group
-- still shows a non-zero count, the UPDATE did not reach every row it
-- should have — investigate before treating this backfill as complete.


-- ── STEP 4. biometric_synthetic_cycles ROW COUNT — must be UNCHANGED ──────
-- This is the check the whole three-commit sequence exists for.
-- biometric_synthetic_cycles filters on is_nap. Until commit one
-- (20260901140000) shipped, that filter read `is_nap = false`, and because
-- `NULL = false` evaluates to NULL — which WHERE treats as false — Step 2
-- above would have silently emptied that view for every Health Connect
-- user, with no error raised anywhere. Commit one changed the predicate to
-- `is_nap is not true`, which accepts NULL. This query, run AFTER the real
-- backfill, is the proof that the sequencing actually worked — not a
-- restatement of commit one's own already-verified prediction, but the
-- first time the two halves are exercised together against real rows.
select count(*) from public.biometric_synthetic_cycles;
-- PREDICTED: unchanged from the figure 20260901140000_verify.sql's V3
-- recorded post-push (182). `is_nap is not true` accepts NULL exactly as
-- it accepted false, so this backfill should not move this number at all.
-- Compare against that recorded figure. If this returns 0, commit one is
-- not actually deployed — stop, and check
-- 20260901140000_verify.sql's V3b (the catalog predicate check) before
-- doing anything else.


-- ── STEP 5. RLS — same two-account check as 20260901140000_verify.sql V4 ──
-- Run as an authenticated session with a real JWT claim. The dashboard SQL
-- editor connects as a superuser and bypasses RLS entirely, so a bare
-- SELECT here would prove nothing about row-level security.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"4dbf04ae-7b46-4511-8122-f17284c622d9"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.biometric_synthetic_cycles;
-- PREDICTED: row_count = 181, distinct_users = 1 — unchanged from
-- 20260901140000_verify.sql V4's own recorded result. This backfill writes
-- is_nap only; it touches no user_id, no policy, and no row's membership
-- in the view.
rollback;

begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
select count(*) as row_count, count(distinct user_id) as distinct_users
from public.biometric_synthetic_cycles;
-- PREDICTED: row_count = 1, distinct_users = 1 — unchanged from
-- 20260901140000_verify.sql V4's own recorded result. This account is a
-- live Health Connect ingest path, not an empty control — a zero here
-- would be a regression, not a pass.
rollback;
-- 181 + 1 should still sum to Step 4's total. If it does not, rows are
-- being leaked or lost across accounts and that is a bigger problem than
-- this backfill.
