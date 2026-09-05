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
-- MEASURED 2026-09-06 (the actual run, after the DDL migration was
-- pushed): the count HAD moved — 186, not 182. Four additional Health
-- Connect sleep sessions were ingested between the 2026-09-01 measurement
-- above and the run. This is precisely the drift this section was written
-- to anticipate: the 182 figure was correct when it was written, and this
-- file's own instruction to compare rather than assume is what absorbed
-- the difference, with no change to any SQL in it. Every PREDICTED figure
-- below reads 182 and every MEASURED one reads 186; neither is wrong, and
-- both are left in place deliberately so the drift itself stays legible.
--
-- RUN ORDER: Step 1 (pre-count) -> Step 2 (the UPDATE — begin, UPDATE and
-- commit as a SINGLE execution, then reconcile the returned rows against
-- Step 1; see that step's own header for why it cannot be run as separate
-- executions in the dashboard) -> Step 3 (post-count, same shape as Step
-- 1) -> Step 4 (biometric_synthetic_cycles row count unchanged) -> Step 5
-- (two-account RLS split unchanged).
-- ============================================================


-- ── STEP 1. PRE-COUNT — record the starting state ─────────────────────────
select ingest_transport, is_nap, count(*)
from public.biometric_sleep_sessions
group by ingest_transport, is_nap
order by ingest_transport, is_nap;
-- PREDICTED: a single row — ingest_transport = 'health_connect',
-- is_nap = false, count = 182. Read what it actually returns and carry
-- that number into Step 2; do not assume 182.
-- MEASURED (2026-09-06): a single row — ingest_transport =
-- 'health_connect', is_nap = false, count = 186. The predicted SHAPE held
-- exactly (one group, all health_connect, all false, zero true, zero
-- NULL); only the count drifted, by the four sessions ingested since
-- 2026-09-01. 186 is the number carried into Step 2.


-- ── STEP 2. THE UPDATE — run begin / UPDATE / commit as ONE execution ────
-- Run `begin;`, the UPDATE and `commit;` as a SINGLE execution. The
-- Supabase dashboard SQL editor does not hold a transaction open across
-- separate executions — running `begin;` plus the UPDATE in one execution
-- and `commit;` in another silently discards the whole transaction, and
-- the bare `commit;` returns "Success. No rows returned" either way, so it
-- looks like it worked when nothing was written. Observed during the
-- 2026-09-06 run: the post-count still read `false` after an apparently
-- successful commit.
--
-- WHAT THAT COSTS, AND WHY IT IS ACCEPTABLE HERE: running it as one
-- execution means there is no point at which you can inspect the count and
-- roll back. The `returning` clause is what compensates — it prints one
-- row per updated record, so the count is a result set you can reconcile
-- against Step 1 AFTER the fact. This UPDATE is idempotent
-- (`is_nap is not null` matches nothing on a second run), so a mismatch is
-- recoverable by investigating rather than by rolling back. If you need a
-- genuine inspect-before-commit gate for a backfill that is NOT
-- idempotent, the dashboard cannot give you one — use psql.
begin;

update public.biometric_sleep_sessions
  set is_nap = null
  where ingest_transport = 'health_connect'
    and is_nap is not null
  returning user_id, provider_record_id;

commit;

-- RECONCILE THE RETURNED ROWS AGAINST STEP 1 — AFTER THE FACT.
-- PREDICTED: 182 rows returned — every current row is
-- ingest_transport = 'health_connect' with is_nap = false (i.e. not null),
-- so every current row matches this predicate. Compare that count against
-- what Step 1 actually showed for the same slice. If the two do not
-- reconcile, investigate against Step 3's post-count before running
-- anything else — note that the ROLLBACK escape this file originally
-- offered here does not exist under the single-execution instruction
-- above, which is why it is idempotence, not rollback, that makes this
-- step safe to re-run.
-- MEASURED (2026-09-06): 186 rows returned, reconciling exactly against
-- Step 1's measured 186 — nothing unexplained. (At run time the
-- `returning` clause was added ad hoc; it is now part of the statement
-- above, so a future operator gets that count without improvising.)
--
-- ── OPERATIONAL NOTE — how the above was discovered, 2026-09-06 ─────────
-- The single-execution instruction is not theoretical. This file
-- originally told the operator to run `begin;` + UPDATE, inspect the
-- count, and only then run `commit;` as a separate execution — and that is
-- what was tried first. The transaction was silently discarded and Step
-- 3's post-count still read `false`, which is how the dashboard's
-- behaviour was found at all. The inspect-before-commit gate was, in the
-- end, satisfied by that discarded execution: it had already returned and
-- reconciled its 186 rows before anything was committed, and the retry was
-- safe only because this UPDATE is idempotent.


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
-- MEASURED (2026-09-06): a single row — ingest_transport =
-- 'health_connect', is_nap = NULL, count = 186. NO `false` group remains.
-- The whole population moved and the total matches Step 1's 186 exactly:
-- nothing created, nothing destroyed. (On the first, discarded attempt
-- this same query still read `false` — that reading is what exposed the
-- dashboard transaction behaviour recorded in Step 2's operational note.)


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
-- MEASURED (2026-09-06): 186 — UNCHANGED by the backfill, matching Step
-- 3's post-count exactly (the four-row drift from 182 is ingest, not this
-- UPDATE). This is the payoff of the entire three-commit sequence and the
-- first time both halves were exercised together against real rows: with
-- every is_nap now NULL, the ORIGINAL `is_nap = false` predicate would
-- return ZERO here, because NULL = false is NULL and WHERE treats that as
-- false. Commit one (20260901140000) is the only reason this reads 186
-- instead of 0.


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
-- MEASURED (2026-09-06): row_count = 181, distinct_users = 1 — exactly as
-- predicted, and still 181 even though the table itself grew by four rows
-- since 2026-09-01. NONE of the four new sessions landed under this
-- account; see the next block for where they did.
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
-- MEASURED (2026-09-06): row_count = 5, distinct_users = 1 — NOT 1. ALL
-- FOUR sessions ingested between 2026-09-01 and this run landed under THIS
-- account (1 -> 5) while 4dbf04ae stayed flat at 181: a8435663 is the
-- account actively syncing Health Connect now. That does not contradict
-- the "live ingest path, not an empty control" warning carried in
-- 20260901140000_verify.sql's V4 — it is that warning coming true within
-- five days. Any later check that predicts a fixed, or zero, count for
-- this account on this table will go stale the same way this one did.
rollback;
-- 181 + 1 should still sum to Step 4's total. If it does not, rows are
-- being leaked or lost across accounts and that is a bigger problem than
-- this backfill.
-- MEASURED (2026-09-06): 181 + 5 = 186 = Step 4's measured total. The
-- accounts partition the view exactly; nothing leaked, nothing lost.
