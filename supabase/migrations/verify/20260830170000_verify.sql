-- ============================================================================
-- Verification — 20260830170000_biometric_synthetic_cycles.sql
--
-- Run V1-V5 after applying the migration. V1 needs a second/third signed-in
-- account, as noted. Fixtures F1-F5 are standalone — no migration or table
-- data required — and can be run any time, before or after.
-- ============================================================================

-- ── V1. RLS FAILS CLOSED ──────────────────────────────────────────────────
-- Sign in as an account that is NOT one of the two test accounts below and
-- confirm:
--
-- select count(*) from public.biometric_synthetic_cycles;  -- expect 0
--
-- Then sign in as each of the two test accounts in turn and confirm each
-- only ever sees its own user_id:
--
-- select distinct user_id from public.biometric_synthetic_cycles;
-- -- signed in as 4dbf04ae-7b46-4511-8122-f17284c622d9: expect only that id
-- -- signed in as a8435663-72e9-4d33-9c3f-803c4cbda393: expect 0 rows (this
-- --   account has no Health Connect data of its own)


-- ── V2. ACCEPTANCE TEST, PART 1 — strict same-user boundary reproduction ──
-- 4dbf04ae's 8 WHOOP cycles (2026-08-22 to 2026-08-29) against 4dbf04ae's
-- own synthetic cycles over the same records. Symmetric EXCEPT, both
-- directions, in one result set via a `direction` tag.
--
-- SCOPE, stated explicitly: cycle_start / cycle_end / is_current only.
-- local_date is NOT compared. biometric_periods' WHOOP arm keys local_date
-- off cycle START (onset); this view deliberately keys it off the WAKE
-- instant instead (see migration header, "known trap"). The two are
-- expected to disagree on any night whose onset and wake fall on different
-- calendar dates — that is the reason wake-keying was chosen, not a defect
-- to reconcile here. source_period_id and continuity are also not
-- compared: whoop_cycles has no equivalent of either.
with whoop_side as (
  select c.start as cycle_start, c."end" as cycle_end, (c."end" is null) as is_current
  from public.whoop_cycles c
  where c.user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
),
synthetic_side as (
  select cycle_start, cycle_end, is_current
  from public.biometric_synthetic_cycles
  where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
)
-- Parenthesized explicitly: EXCEPT and UNION ALL are equal-precedence and
-- left-associative in Postgres, so without parentheses this would parse as
-- ((A except B) union all C) except D, not the symmetric pair intended.
(
  select 'whoop_minus_synthetic' as direction, cycle_start, cycle_end, is_current
  from whoop_side
  except
  select 'whoop_minus_synthetic', cycle_start, cycle_end, is_current
  from synthetic_side
)
union all
(
  select 'synthetic_minus_whoop', cycle_start, cycle_end, is_current
  from synthetic_side
  except
  select 'synthetic_minus_whoop', cycle_start, cycle_end, is_current
  from whoop_side
);
-- Expect ZERO rows.


-- ── V3. ACCEPTANCE TEST, PART 2 — supplementary cross-user comparison ────
-- ASSUMPTION, stated explicitly, not smuggled in: a8435663's 48 WHOOP
-- cycles (2026-07-04 to 2026-08-28) are recorded under a DIFFERENT Supabase
-- account than the Health Connect data (all 180 sessions of which belong to
-- 4dbf04ae), because both Supabase accounts are fed by the SAME physical
-- WHOOP strap — confirmed empirically: all 48 of a8435663's cycle starts
-- exactly match a Health Connect sleep onset recorded under 4dbf04ae. This
-- is a property of this specific test setup, not a system guarantee. If
-- this query starts returning rows, check FIRST whether the two accounts
-- still share one physical device (a second device added to either account
-- would explain a divergence on its own) before suspecting the
-- reconstruction logic. Same column scope as V2, same reasoning for what's
-- excluded.
with whoop_side as (
  select c.start as cycle_start, c."end" as cycle_end, (c."end" is null) as is_current
  from public.whoop_cycles c
  where c.user_id = 'a8435663-72e9-4d33-9c3f-803c4cbda393'
    -- Excludes stale NULL-end WHOOP rows. Confirmed on-device: cycles
    -- 1663052944 (start 2026-07-23 20:29:14.88) and 1752555617 (start
    -- 2026-08-28 19:54:24.4) both carry end = NULL in whoop_cycles even
    -- though a later Health Connect sleep onset exists for both nights, so
    -- biometric_synthetic_cycles correctly computes a real cycle_end via
    -- lead() while whoop_cycles was simply never backfilled after the
    -- cycle actually closed. That is a whoop-sync defect (see the
    -- follow-up note below this query), not a reconstruction defect — a
    -- NULL-end WHOOP row can never match a correctly-closed synthetic
    -- cycle, and excluding it here is the correct comparison, not a
    -- loosened one. 46 of 46 genuinely-closed cycles matched exactly
    -- before this predicate was added; confirmed zero rows with it.
    and c."end" is not null
),
synthetic_side as (
  select cycle_start, cycle_end, is_current
  from public.biometric_synthetic_cycles
  where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9'
)
-- Parenthesized for the same reason as V2 above.
(
  select 'whoop(a8435663)_minus_synthetic(4dbf04ae)' as direction, cycle_start, cycle_end, is_current
  from whoop_side
  except
  select 'whoop(a8435663)_minus_synthetic(4dbf04ae)', cycle_start, cycle_end, is_current
  from synthetic_side
)
union all
(
  select 'synthetic(4dbf04ae)_minus_whoop(a8435663)', cycle_start, cycle_end, is_current
  from synthetic_side
  except
  select 'synthetic(4dbf04ae)_minus_whoop(a8435663)', cycle_start, cycle_end, is_current
  from whoop_side
);
-- Expect ZERO rows, PROVIDED 4dbf04ae's Health Connect history actually
-- extends back to cover 2026-07-04. If it doesn't, real (expected,
-- non-bug) rows will appear for the uncovered dates — that is a coverage
-- gap in the test data, not a reconstruction defect. Check coverage first:
--
-- select min(cycle_start), max(cycle_start)
-- from public.biometric_synthetic_cycles
-- where user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9';


-- ── FOLLOW-UP (logged here, not fixed): whoop-sync never backfills "end" ──
-- Three NULL-end whoop_cycles rows exist in this dataset. One is
-- legitimately open (4dbf04ae, start 2026-08-29 19:59, synced 2026-08-30
-- 10:07 — no later onset exists yet, so it really is the current cycle).
-- The other two are the stale rows excluded from V3 above. Their own
-- timestamps show the shape of the defect: cycle 1663052944 has
-- whoop_updated_at 2026-07-24 14:38 and synced_at 2026-07-24 19:02 — WHOOP
-- itself last touched the row a full 18h after the cycle's own start with
-- end still NULL, and no later sync ever revisited it to pick up the close
-- WHOOP presumably recorded afterward. That points at whoop-sync's
-- incremental sync window/cursor, not the mapper: whatever range it
-- requests on each run, it is not re-fetching a cycle it has already seen
-- once that cycle closes. This needs its own read-only investigation
-- before any fix is proposed — the actual shape depends on how the sync
-- window and cursor are built (supabase/functions/whoop-sync/index.ts),
-- which this file does not read.
--
-- Consequence today: whoop_cycle_nutrition's `b.effective_end is not null`
-- predicate silently drops both stale rows from nutrition aggregation —
-- correct given effective_end's own 36h-staleness definition (these rows
-- are far older than 36h), but silent, with nothing surfacing that two
-- historical cycles are contributing zero nutrition because of a sync gap
-- rather than because nothing was logged.
--
-- METHODOLOGY NOTE, carried forward from this same discovery: an earlier
-- check of whoop_cycles' own contiguity (cited in this migration's header
-- as "53/53 boundaries checked, zero gaps, zero overlaps") used
-- `where prev_cycle_end is not null`, which silently EXCLUDES a NULL-end
-- row from the boundary count rather than confirming it. That reported
-- 53 contiguous boundaries as though every boundary had been checked, when
-- it had actually skipped exactly the two broken rows found here. Any
-- future contiguity check on whoop_cycles must count NULL ends as a
-- finding (as V3's exclusion above does explicitly), never filter them out
-- silently — this migration's own V4 non-overlap proof does this
-- correctly via IS DISTINCT FROM, which treats NULL as a real value to
-- compare, not an automatic pass.


-- ── V4. NON-OVERLAP / ADJACENCY PROOF ──────────────────────────────────────
-- Whenever a cycle claims continuity = true with its predecessor, that
-- predecessor's own cycle_end must equal this row's cycle_start exactly —
-- by construction, continuity = true and "the predecessor was not
-- suppressed" are driven by the identical gap comparison, so the
-- predecessor is guaranteed present in the output whenever continuity is
-- true. A mismatch here means the continuity flag and the emitted boundary
-- disagree with each other, which is an internal inconsistency, not a
-- legitimate suppression gap (a suppression gap only ever appears on a row
-- with continuity = false, which this check does not touch).
with ordered as (
  select
    user_id, origin_package, cycle_start, cycle_end, continuity,
    lag(cycle_end) over (partition by user_id, origin_package order by cycle_start) as prev_cycle_end
  from public.biometric_synthetic_cycles
)
select *
from ordered
where continuity = true
  and cycle_start is distinct from prev_cycle_end;
-- Expect ZERO rows.


-- ── V5. NULL local_date COUNT ──────────────────────────────────────────────
-- The `else null::date` branch in the view is a silent fallback for a
-- malformed timezone_offset. All reference rows parse today, so this
-- should read 0 — track it here so a future malformed row fails loudly in
-- a verification query instead of silently landing as an unexplained null
-- weeks later.
select count(*) as null_local_date_rows
from public.biometric_synthetic_cycles
where local_date is null;
-- Expect 0.


-- ============================================================================
-- SABOTAGE FIXTURES — self-contained, no table data or Docker required.
--
-- Each fixture is the migration's own post-source_rows logic, copied
-- verbatim (gapped / blocked / first_of_block / last_of_block / blocks /
-- onsets / classified / final select — byte-identical to
-- 20260830170000_biometric_synthetic_cycles.sql as amended, including the
-- running-max(period_end) gap computation and the period_end-desc ordering
-- in last_of_block), with exactly one line changed: source_rows reads from
-- a literal VALUES list instead of public.biometric_sleep_sessions. Passing
-- here is evidence about the logic that ships, not about a reimplementation
-- that could drift from it.
--
-- F1-F4 were re-synced against the amended CTE chain when the two defects
-- below were fixed (running max(period_end) instead of lag(period_end) in
-- gapped; last_of_block ordered by period_end desc instead of period_start
-- desc). None of F1-F4 contain an overlapping or nested session, so their
-- expected output is unchanged by either fix — confirmed by hand-tracing
-- each against both the old and new logic before this file was written.
-- F5 is new and is the one fixture that actually distinguishes the two.
-- ============================================================================

-- ── F1. 45-minute afternoon session — duration floor should reject it ─────
-- is_nap = false is present but structurally irrelevant here (see migration
-- header): the floor is what actually excludes this row.
with source_rows as (
  select user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset
  from (values
    ('00000000-0000-0000-0000-000000000001'::uuid, 'com.example.fixture', 'nap-1',
     '2026-02-01 14:00:00+00'::timestamptz, '2026-02-01 14:45:00+00'::timestamptz,
     '+00:00', 'health_connect', false)
  ) as t(user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset, ingest_transport, is_nap)
  where ingest_transport = 'health_connect'
    and is_nap = false
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
where not exceeds_ceiling;
-- EXPECT: 0 rows.


-- ── F2. Duration floor boundary, both sides ───────────────────────────────
-- Row A: exactly 3:00:00 -> must pass. Row B: 2:59:59, 21h after Row A's
-- end -> must fail.
--
-- 21h is deliberate, not incidental: it sits under the 36h ceiling (so if
-- the floor sabotage admits Row B, Row A gets a real next_onset instead of
-- being suppressed) and over the 4h merge threshold (so Row B forms its
-- own second block rather than merging into Row A's). That means a
-- sabotaged floor changes the ROW COUNT (1 -> 2), not just which row
-- survives — an earlier version of this fixture placed the two rows 48h
-- apart, which put the gap over the ceiling and made a sabotaged floor
-- suppress Row A instead, so the output stayed at 1 row with a different
-- source_period_id. Still a valid, if less obvious, signal — but row-count
-- divergence is the clearer sabotage tell and is what this fixture now
-- tests for.
with source_rows as (
  select user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset
  from (values
    ('00000000-0000-0000-0000-000000000002'::uuid, 'com.example.fixture', 'floor-pass',
     '2026-05-01 12:00:00+00'::timestamptz, '2026-05-01 15:00:00+00'::timestamptz,
     '+00:00', 'health_connect', false),
    ('00000000-0000-0000-0000-000000000002'::uuid, 'com.example.fixture', 'floor-fail',
     '2026-05-02 12:00:00+00'::timestamptz, '2026-05-02 14:59:59+00'::timestamptz,
     '+00:00', 'health_connect', false)
  ) as t(user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset, ingest_transport, is_nap)
  where ingest_transport = 'health_connect'
    and is_nap = false
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
where not exceeds_ceiling;
-- EXPECT: exactly 1 row. source_period_id = 'floor-pass',
-- cycle_start = 2026-05-01 12:00:00+00, cycle_end = null, is_current = true,
-- continuity = false (no predecessor), block_wake_at = 2026-05-01 15:00:00+00,
-- local_date = 2026-05-01. 'floor-fail' must not appear anywhere in the
-- output. SABOTAGE (floor loosened to admit floor-fail, e.g. change the 3h
-- threshold in source_rows to interval '0'): expect 2 rows — floor-pass
-- gains cycle_end = 2026-05-02 12:00:00+00 and is_current flips to false
-- (continuity stays false, it's still the first block); floor-fail appears
-- as a second row, continuity = true, is_current = true, cycle_end = null.


-- ── F3. Fabricated two-night gap — suppression + continuity = false ──────
-- sessA onset 2026-03-01 23:00 (qualifies). sessB onset 2026-03-04 23:00 —
-- 72h / 3 days after sessA's onset, i.e. two nights missing in between.
-- sessC onset 2026-03-05 23:00 — a normal 16h after sessB's onset. No
-- overlap between any of these three, so both fixes are inert here; kept
-- in sync with the shipped logic regardless.
with source_rows as (
  select user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset
  from (values
    ('00000000-0000-0000-0000-000000000003'::uuid, 'com.example.fixture', 'sessA',
     '2026-03-01 23:00:00+00'::timestamptz, '2026-03-02 07:00:00+00'::timestamptz, '+00:00', 'health_connect', false),
    ('00000000-0000-0000-0000-000000000003'::uuid, 'com.example.fixture', 'sessB',
     '2026-03-04 23:00:00+00'::timestamptz, '2026-03-05 07:00:00+00'::timestamptz, '+00:00', 'health_connect', false),
    ('00000000-0000-0000-0000-000000000003'::uuid, 'com.example.fixture', 'sessC',
     '2026-03-05 23:00:00+00'::timestamptz, '2026-03-06 07:00:00+00'::timestamptz, '+00:00', 'health_connect', false)
  ) as t(user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset, ingest_transport, is_nap)
  where ingest_transport = 'health_connect'
    and is_nap = false
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
order by cycle_start;
-- EXPECT: exactly 2 rows.
--   source_period_id = 'sessB', cycle_start = 2026-03-04 23:00:00+00,
--     cycle_end = 2026-03-05 23:00:00+00, is_current = false,
--     continuity = false, block_wake_at = 2026-03-05 07:00:00+00,
--     local_date = 2026-03-05.
--   source_period_id = 'sessC', cycle_start = 2026-03-05 23:00:00+00,
--     cycle_end = null, is_current = true, continuity = true,
--     block_wake_at = 2026-03-06 07:00:00+00, local_date = 2026-03-06.
-- 'sessA' must not appear anywhere in the output (suppressed).


-- ── F4. Same-night double session, 15 minutes apart — merge test ─────────
-- frag-1: 2026-04-01 22:00 - 2026-04-02 01:00 (3h, qualifies).
-- frag-2: 2026-04-02 01:15 - 2026-04-02 07:00 (5h45m, qualifies), starting
-- after local midnight, 15 minutes after frag-1 ends -> must merge into ONE
-- block whose cycle_start is frag-1's onset, not two cycles. frag-2 both
-- starts and ends later than frag-1 (no overlap), so both fixes are inert
-- here; kept in sync with the shipped logic regardless.
with source_rows as (
  select user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset
  from (values
    ('00000000-0000-0000-0000-000000000004'::uuid, 'com.example.fixture', 'frag-1',
     '2026-04-01 22:00:00+00'::timestamptz, '2026-04-02 01:00:00+00'::timestamptz, '+00:00', 'health_connect', false),
    ('00000000-0000-0000-0000-000000000004'::uuid, 'com.example.fixture', 'frag-2',
     '2026-04-02 01:15:00+00'::timestamptz, '2026-04-02 07:00:00+00'::timestamptz, '+00:00', 'health_connect', false)
  ) as t(user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset, ingest_transport, is_nap)
  where ingest_transport = 'health_connect'
    and is_nap = false
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
where not exceeds_ceiling;
-- EXPECT: exactly 1 row. source_period_id = 'frag-1',
-- cycle_start = 2026-04-01 22:00:00+00 (frag-1's onset, NOT frag-2's),
-- cycle_end = null, is_current = true, continuity = false (no predecessor),
-- block_wake_at = 2026-04-02 07:00:00+00 (frag-2's period_end — the block's
-- true wake instant — not frag-1's), local_date = 2026-04-02.


-- ── F5. Overlapping / nested session pair inside one block ───────────────
-- nest-outer: 2026-05-01 18:00:00 - 2026-05-02 20:00:00 (26h — starts
-- FIRST and ends LAST). nest-inner: 2026-05-01 19:00:00 - 2026-05-01
-- 23:00:00 (4h — starts SECOND, one hour after nest-outer, but ends nearly
-- a full day EARLIER than nest-outer, entirely nested inside it). Both
-- qualify individually (>=3h, non-nap). Ordered by period_start:
-- nest-outer, then nest-inner — nest-inner is the "latest-starting"
-- session, but nest-outer is the one that ends last.
--
-- This is the fixture defect 1 exists for: with the BUGGY last_of_block
-- (order by period_start desc), the picked "last" row is nest-inner ->
-- block_wake_at = nest-inner.period_end = 2026-05-01 23:00:00+00 ->
-- local_date = 2026-05-01. With the FIXED last_of_block (order by
-- period_end desc), the picked row is nest-outer -> block_wake_at =
-- nest-outer.period_end = 2026-05-02 20:00:00+00 -> local_date =
-- 2026-05-02. The two versions disagree on the calendar date, not just
-- the timestamp, which is why this fixture is a meaningful sabotage
-- target: a one-line revert flips the answer, visibly.
--
-- (The gapped/blocked running-max fix is exercised here too, though it
-- doesn't change the merge OUTCOME for this pair: nest-inner's period_start
-- falls before nest-outer's period_end under both the old lag()-based gap
-- and the new running-max gap, since nest-outer is the only, and therefore
-- also the max-so-far, preceding row when nest-inner is evaluated. The
-- distinguishing case for that half of defect 1 needs a THIRD row after an
-- inner session ends but while an outer session is still open, which is
-- deliberately not added here to keep this fixture isolated to the
-- last_of_block half of the defect it was written to prove.)
with source_rows as (
  select user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset
  from (values
    ('00000000-0000-0000-0000-000000000005'::uuid, 'com.example.fixture', 'nest-outer',
     '2026-05-01 18:00:00+00'::timestamptz, '2026-05-02 20:00:00+00'::timestamptz, '+00:00', 'health_connect', false),
    ('00000000-0000-0000-0000-000000000005'::uuid, 'com.example.fixture', 'nest-inner',
     '2026-05-01 19:00:00+00'::timestamptz, '2026-05-01 23:00:00+00'::timestamptz, '+00:00', 'health_connect', false)
  ) as t(user_id, origin_package, provider_record_id, period_start, period_end, timezone_offset, ingest_transport, is_nap)
  where ingest_transport = 'health_connect'
    and is_nap = false
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
-- SABOTAGE: change `period_end desc` below back to `period_start desc` (the
-- pre-fix ordering) and re-run this fixture. Expect it to go red: the
-- output should then show source_period_id = 'nest-outer' still (that part
-- is unaffected — first_of_block is untouched by this defect) but
-- block_wake_at = 2026-05-01 23:00:00+00 and local_date = 2026-05-01,
-- both wrong, both different from the values asserted below.
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
where not exceeds_ceiling;
-- EXPECT (fixed logic): exactly 1 row. source_period_id = 'nest-outer'
-- (min period_start, unaffected by this defect), cycle_start =
-- 2026-05-01 18:00:00+00, cycle_end = null, is_current = true,
-- continuity = false, block_wake_at = 2026-05-02 20:00:00+00 (nest-outer's
-- OWN period_end — the block's true max, not nest-inner's earlier one),
-- local_date = 2026-05-02.
