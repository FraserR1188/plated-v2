-- ============================================================================
-- 20260901140000_biometric_synthetic_cycles_is_nap_null_tolerant.sql
-- is_nap NULL-not-zero fix — commit one of three, VIEW SIDE ONLY
--
-- This commit changes NO column definition and NO data. It changes exactly
-- one predicate in public.biometric_synthetic_cycles's source_rows CTE
-- (20260830170000_biometric_synthetic_cycles.sql:233):
--
--     and is_nap = false
-- becomes:
--     and is_nap is not true
--
-- Nothing else in the view is touched — same CTE chain, same column list,
-- same column order, same security_invoker, same comment, same grant.
--
-- ── WHY THIS HAS TO GO FIRST ─────────────────────────────────────────────
-- public.biometric_sleep_sessions.is_nap is `boolean not null default false`.
-- The Health Connect ingest mapper (supabase/functions/health-connect-ingest/
-- mapping.ts) never sets it — Health Connect's SleepSessionRecord carries no
-- nap signal at all (confirmed by reading react-native-health-connect's own
-- type declarations: IntervalRecord gives startTime/endTime, SleepStage gives
-- a 7-value stage enum with no nap member, Metadata gives no nap-adjacent
-- field either). Every one of the 182 rows in that table today is WHOOP data
-- ingested through Health Connect — the nap signal WHOOP itself tracks was
-- destroyed in transit through Health Connect's data model before this app
-- ever saw it. The column default is silently asserting "confirmed not a
-- nap" where the truth is "no nap signal was available."
--
-- A future commit (two) makes the column nullable and drops the default; a
-- further commit (three) backfills the 182 existing rows to NULL. Neither is
-- done here. But `is_nap = false` is a WHERE-clause equality test, and
-- `NULL = false` evaluates to NULL, which a WHERE clause treats as false —
-- the row is silently dropped, not passed through. The moment ANY row's
-- is_nap becomes NULL, this predicate as it stands today would start
-- excluding that row from biometric_synthetic_cycles, and since the eventual
-- backfill sets ALL 182 rows to NULL, this view would empty out entirely and
-- permanently for every Health Connect user, with no error raised anywhere.
-- Sequencing the view-side fix before the schema/backfill commits means the
-- view is already tolerant by the time NULL values can occur — nothing is
-- ever caught by the old, narrower predicate.
--
-- ── WHY `is_nap is not true`, NOT SOME OTHER FIX ─────────────────────────
-- `is not true` excludes only a CONFIRMED true (a real, reported nap) and
-- keeps everything else — false and NULL alike — exactly matching what
-- "confirmed not a nap OR no signal available" should mean. It is not,
-- itself, doing the nap-exclusion work: that work is done entirely by the
-- adjacent, unchanged duration floor,
-- `(period_end - period_start) >= interval '3 hours'` — a real, measured
-- signal that actually exists for every row. is_nap was never carrying any
-- of that weight (see the original migration's own GUARD 1 commentary,
-- 20260830170000_biometric_synthetic_cycles.sql:35-45, which already
-- diagnoses is_nap = false as a structural no-op for Health Connect data
-- today) and this change does not ask it to start pretending otherwise —
-- it just stops the column's own NULL-not-zero defect from being able to
-- silently empty this view once that defect is corrected upstream.
--
-- ── PREDICTED, NOT MEASURED — NOTHING HAS BEEN PUSHED YET ────────────────
-- This change is expected to alter ZERO rows and ZERO cells in
-- biometric_synthetic_cycles's output today: production is_nap is false on
-- all 182 rows (measured by the requester, not re-derived or queried here),
-- and both `is_nap = false` and `is_nap is not true` accept a literal false
-- identically. No row currently reads NULL or true, so there is nothing for
-- the predicate change to affect yet. This is a prediction based on that
-- given fact, not a measurement taken by this migration — the paired verify
-- file (supabase/migrations/verify/20260901140000_verify.sql) is what
-- actually confirms it against the live database before and after this
-- migration is applied.
--
-- ── SCOPE, EXPLICIT ───────────────────────────────────────────────────────
-- NOT in this commit: the is_nap column's NOT NULL/default (commit two), any
-- backfill of existing rows (commit three), any change to the Health Connect
-- ingest mapper or any Edge Function, any change to whoop_sleeps.nap or
-- whoop-sync (a separate, adjacent, uncommented `?? false` coalesce noticed
-- while investigating this — logged as its own follow-up, not touched here).
-- ============================================================================

create or replace view public.biometric_synthetic_cycles
with (security_invoker = on) as
with source_rows as (
  select
    user_id,
    origin_package,
    provider_record_id,
    period_start,
    period_end,
    timezone_offset
  from public.biometric_sleep_sessions
  where ingest_transport = 'health_connect'
    and is_nap is not true
    and (period_end - period_start) >= interval '3 hours'
),

-- Gaps-and-islands: a session starts a new block only when the gap since
-- the LATEST period_end among all strictly preceding qualifying sessions
-- exceeds 4 hours (or there is no preceding session at all — coalesce(...,
-- true) covers the first row in each partition, where the frame below is
-- empty and max() over zero rows is NULL).
--
-- Running max, not lag(): see GUARD 2 above. "rows between unbounded
-- preceding and 1 preceding" explicitly excludes the current row, so this
-- is the max end seen strictly BEFORE this session, never including it.
-- A nested/overlapping session (starts later than an earlier session but
-- ends before it) naturally produces a negative or small gap against that
-- earlier, later-ending session's end, and merges correctly — not because
-- lag() happened to land on a similar value, but because the comparison
-- is against the true latest end regardless of which row produced it.
gapped as (
  select
    *,
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
  select
    *,
    sum(case when starts_new_block then 1 else 0 end)
      over (
        partition by user_id, origin_package
        order by period_start, provider_record_id
        rows between unbounded preceding and current row
      ) as block_id
  from gapped
),

-- One row per block: identity/cycle_start/label-offset from the block's
-- FIRST-STARTING session (min period_start); the true wake instant + ITS
-- OWN offset from whichever session achieves the block's MAXIMUM
-- period_end. Ordering last_of_block by period_end desc (not period_start
-- desc) is deliberate and load-bearing: "the block's last session" means
-- the one that ends latest, not the one that starts latest. Those
-- coincide only when sessions within a block never overlap or nest —
-- nothing here enforces that (see GUARD 2 above for the same distinction
-- applied to block formation) — so ordering by period_start desc would
-- silently pick the wrong session's period_end as the wake instant on
-- exactly the fragmented/overlapping nights this merge guard exists to
-- handle. Deterministic tiebreak on provider_record_id in both CTEs,
-- matching the "arbitrary but stable" convention used throughout the
-- biometric layer (biometric_periods_resolved, biometric_workouts' dedup
-- migration).
first_of_block as (
  select distinct on (user_id, origin_package, block_id)
    user_id, origin_package, block_id,
    provider_record_id as source_period_id,
    period_start        as cycle_start,
    timezone_offset
  from blocked
  order by user_id, origin_package, block_id, period_start asc, provider_record_id asc
),
last_of_block as (
  select distinct on (user_id, origin_package, block_id)
    user_id, origin_package, block_id,
    period_end      as block_wake_at,
    timezone_offset as wake_timezone_offset
  from blocked
  order by user_id, origin_package, block_id, period_end desc, provider_record_id desc
),
blocks as (
  select
    f.user_id, f.origin_package, f.block_id,
    f.source_period_id, f.cycle_start, f.timezone_offset,
    l.block_wake_at, l.wake_timezone_offset
  from first_of_block f
  join last_of_block l
    on l.user_id = f.user_id
   and l.origin_package = f.origin_package
   and l.block_id = f.block_id
),

onsets as (
  select
    *,
    lag(cycle_start)  over w as prev_onset,
    lead(cycle_start) over w as next_onset
  from blocks
  window w as (partition by user_id, origin_package order by cycle_start)
),
classified as (
  select
    *,
    (next_onset is not null
       and next_onset - cycle_start > interval '36 hours')  as exceeds_ceiling,
    (prev_onset is not null
       and cycle_start - prev_onset <= interval '36 hours') as continuity
  from onsets
)

select
  user_id,
  'health_connect'::text as ingest_transport,
  origin_package,
  source_period_id,
  cycle_start,
  next_onset             as cycle_end,
  (next_onset is null)   as is_current,
  timezone_offset,
  case
    when wake_timezone_offset ~ '^[+-]\d{2}:\d{2}(:\d{2})?$'
      then ((block_wake_at at time zone 'UTC') + wake_timezone_offset::interval)::date
    else null::date
  end as local_date,
  -- Emitted so local_date is reconstructible from this view's own output,
  -- not a value a consumer must take on faith or recompute (wrongly, from
  -- cycle_start) — see the local_date section above.
  block_wake_at,
  wake_timezone_offset,
  continuity
from classified
where not exceeds_ceiling;

comment on view public.biometric_synthetic_cycles is
  'Health Connect sleep sessions reconstructed into WHOOP-shaped onset-to-onset cycles. Same-night sessions merged when the gap to the running max(period_end) of earlier sessions is <=4h (nesting/overlap safe, not just non-adjacent-in-start-order safe); the block''s first-starting session is the cycle boundary. A candidate cycle spanning >36h to its next onset is suppressed, not emitted with a null/guessed end. local_date is keyed on the wake instant — the period_end of whichever session in the block has the MAXIMUM period_end, not the latest-starting one — never onset; block_wake_at/wake_timezone_offset are emitted so local_date is reconstructible, not onset-anchored like biometric_periods'' own local_date. is_current is unqualified by recency (mirrors biometric_periods.is_current) — any consumer aggregating against an open cycle must apply its own staleness gate, the way whoop_cycle_nutrition.effective_end does for the WHOOP arm. No consumer reads this view yet.';

grant select on public.biometric_synthetic_cycles to authenticated;
