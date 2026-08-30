-- ============================================================
-- biometric_synthetic_cycles — Health Connect sleep reconstructed into
-- WHOOP-shaped cycles (commit one of N)
--
-- ONE view. No consumer, no repointing of biometric_periods /
-- biometric_periods_resolved / whoop_correlation / whoop_cycle_nutrition /
-- biometric_workouts (all five untouched, not read by this file), no
-- client code. Reads only public.biometric_sleep_sessions.
--
-- ── CORRECTED PREMISE ──────────────────────────────────────────────
-- Prior design notes in this repo (and earlier drafts of this one) assumed
-- WHOOP cycles are wake-to-wake. They are not — verified against
-- production data this commit is built from:
--   - whoop_cycles.start equals whoop_sleeps.start of the sleep that
--     produced that cycle's recovery, exact to the microsecond, 53/53.
--   - WHOOP cycles are contiguous: cycle end == next cycle start, delta
--     exactly 00:00:00, zero gaps, zero overlaps, 53 boundaries checked.
--   - So a WHOOP cycle is SLEEP-ONSET TO SLEEP-ONSET: it opens at sleep
--     onset, contains that night's sleep, then the following waking day.
--   - biometric_resting_hr.measured_at equals the sleep session's
--     period_end exactly, 180/180 rows — it is the wake instant
--     restamped, not an independent measurement time.
--   - All 56 WHOOP cycle starts equal a Health Connect sleep period_start
--     exactly (same physical device writing both paths).
-- This view reconstructs that same onset-to-onset shape from Health
-- Connect sleep sessions alone, for users who never get a WHOOP cycle
-- table populated.
--
-- ── SHAPE ────────────────────────────────────────────────────────────
-- lead()/lag() over qualifying, MERGED sleep-onset blocks, partitioned by
-- (user_id, origin_package), ordered by period_start. Cycle N =
-- [block N's first onset, block N+1's first onset). See guards below for
-- what "qualifying" and "merged" mean.
--
-- ── GUARD 1: NAP EXCLUSION + DURATION FLOOR ─────────────────────────
-- is_nap = false is checked below, but for Health Connect data today it
-- is a structural no-op, not a screen: mapSleepSession() in
-- supabase/functions/health-connect-ingest/mapping.ts never sets is_nap
-- to true — Health Connect's SleepSessionRecord carries no nap signal at
-- all, and the column's own `not null default false` supplies the value
-- Postgres-side. Every Health Connect row reads is_nap = false regardless
-- of whether it was a nap. Health Connect did not confirm anything; the
-- check is kept for the day a provider that DOES report naps is wired in,
-- and because it costs nothing to state honestly rather than silently
-- rely on.
--
-- The duration floor is therefore the only thing actually excluding a
-- daytime nap from Health Connect data: (period_end - period_start) >=
-- 3 hours. There is no real nap in the reference corpus to calibrate
-- against (observed minimum real night: 4.86h) — 3 hours is a judgment
-- call, chosen to sit comfortably below that minimum (~1.9h of headroom)
-- while comfortably clearing typical daytime nap durations reported in
-- the sleep literature (commonly under 2-3h). Inclusive (>=): a session
-- of exactly 3:00:00 passes.
--
-- ── GUARD 2: SAME-NIGHT MERGE ────────────────────────────────────────
-- A qualifying (non-nap, >=3h) onset does NOT automatically start a new
-- cycle. It only does if the gap since the LATEST period_end among all
-- earlier qualifying sessions in the partition exceeds 4 hours; otherwise
-- it is treated as a continuation of the same sleep block, and the
-- BLOCK's first onset is the cycle boundary.
--
-- This is measured against a running max(period_end) over strictly
-- preceding rows, not lag(period_end) (the immediately-preceding-by-
-- start-order row's own end). Nothing — not a constraint, not the
-- mapper, not Health Connect itself — guarantees sessions within a
-- partition never overlap or nest. A session that starts later than its
-- predecessor but ends earlier (nesting/overlap) would make lag()
-- compare against the wrong, earlier end; a running max is correct by
-- construction regardless of nesting, not merely by coincidence of the
-- data happening not to nest today.
--
-- This is not a robustness nicety, it is load-bearing. Without it, two
-- qualifying sessions in one fragmented night produce two back-to-back
-- synthetic cycles. The first spans only sleep with near-zero waking
-- time and therefore near-zero meals; a future one-cycle-lag consumer
-- (the whoop_correlation pattern) would then pair the FOLLOWING cycle's
-- recovery against that empty window instead of against the real
-- previous day's nutrition — silently destroying that day's correlation
-- while the numbers still look like numbers. That is exactly the failure
-- class the project's existing invariants exist to prevent, so this
-- guard does not wait for the reference corpus to exhibit a fragmented
-- night before earning its place.
--
-- 4 hours is data-driven, not a judgment call the way the duration floor
-- is: the minimum observed real waking-day gap (qualifying-session-end to
-- next qualifying-session-start, across genuinely separate nights) is
-- 11.76h. 4 hours leaves ~3x headroom under that — no real night-to-night
-- transition in the corpus can be mistaken for a same-night fragment, and
-- any two sessions closer together than that are far more likely to be
-- one interrupted sleep than two distinct nights.
--
-- The two guards catch different things and both stay: the duration
-- floor rejects an isolated short session (a mid-afternoon nap); the
-- merge rule collapses multiple long sessions that belong to one night
-- (a split night) rather than rejecting either of them.
--
-- ── GUARD 3: MAXIMUM CYCLE LENGTH (CEILING) ──────────────────────────
-- 36 hours, reused verbatim from whoop_cycle_nutrition's existing
-- effective_end convention (20260829111404_biometric_periods_resolved.sql)
-- rather than a second magic number. Observed max real waking-day gap is
-- 24.35h; 36h leaves ~48% headroom.
--
-- A candidate cycle whose span to the next onset exceeds the ceiling is
-- SUPPRESSED — dropped from the output entirely, not emitted with a
-- fabricated or nulled-out end. A null cycle_end reads as "still open" to
-- anything that later does coalesce(cycle_end, now()) the way
-- whoop_cycle_nutrition's effective_end does — that would swallow every
-- meal from the gap all the way to the present, which is the exact
-- monster-cycle failure this guard exists to prevent, merely deferred
-- rather than avoided. No row means no consumer can aggregate against
-- one. The gap is not lost information: the FOLLOWING cycle's continuity
-- flag (below) says a break happened; its own predecessor timestamp
-- (visible by widening the query) says where.
--
-- ── continuity ────────────────────────────────────────────────────────
-- Boolean, register matches whoop_correlation.prev_cycle_contiguous.
-- True only when a predecessor onset exists in the same partition within
-- the 36h ceiling. False covers both "no predecessor at all" (first known
-- onset for this user+origin_package) and "predecessor bridged/
-- suppressed" (gap exceeded the ceiling) — a future consumer must refuse
-- to lag-pair across either. "Predecessor from a different source" is not
-- separately encoded: it cannot occur within one (user_id, origin_package)
-- partition by construction; adjudicating across origin_packages for the
-- same user is a later commit's problem (biometric_periods_resolved's own
-- per-domain resolution, not touched here).
--
-- ── is_current: DELIBERATELY UNQUALIFIED BY RECENCY ──────────────────
-- is_current = (next_onset is null), exactly mirroring
-- biometric_periods.is_current = (c."end" is null) for the WHOOP arm. It
-- means "no later onset has been recorded yet," not "this cycle is
-- fresh" — a user who stops syncing leaves their last cycle is_current =
-- true forever, exactly as an abandoned WHOOP strap does in
-- biometric_periods today. This is a deliberate choice, not an oversight:
-- baking a now()-based staleness cutoff into is_current here would make
-- the same column name mean two different things across the two spine
-- views that are supposed to share vocabulary, and there is no consumer
-- of this view yet for a stale open cycle to actually harm (no
-- coalesce(cycle_end, now())-style aggregation exists against it in this
-- commit). WHOOP's own spine defers that judgment to
-- whoop_cycle_nutrition's effective_end, computed fresh at query time from
-- period_start; the first consumer that aggregates against
-- biometric_synthetic_cycles must add the equivalent staleness gate
-- itself, reading cycle_start against now(), rather than trusting
-- is_current alone to mean "safe to extend to now()".
--
-- ── local_date: KEYED ON THE WAKE INSTANT, NOT ONSET ─────────────────
-- local_date is computed from the WAKE instant of the block (the
-- period_end of whichever session achieves the block's maximum
-- period_end — see last_of_block above, NOT simply the latest-starting
-- session), never from cycle_start. Keying off onset produced three
-- phantom "missing nights" in the reference corpus, each followed by a
-- doubled day, on nights whose sleep began after local midnight. Keyed on
-- wake date: 180 sessions across 180 consecutive nights, no gaps.
--
-- This is a DIFFERENT anchor than biometric_periods' local_date, which is
-- computed from cycle START (onset) for the WHOOP arm — that is correct
-- there because a WHOOP cycle's own timezone_offset is captured once, at
-- the moment the cycle opens, with no merge concept at all. A consumer
-- that recomputes local_date the way biometric_periods does (from
-- cycle_start/timezone_offset) will get a DIFFERENT, wrong-for-this-view
-- answer here, and only on merged blocks where onset and wake instant
-- fall on different calendar dates. block_wake_at and wake_timezone_offset
-- are emitted below precisely so local_date is reconstructible from
-- columns this view exposes, rather than being a value a consumer has to
-- take on faith or recompute incorrectly from cycle_start. See the
-- deferred-work note at the end of this file for what a future consumer
-- must do with this distinction.
--
-- KNOWN, ACCEPTED IMPRECISION (follow-up, not fixed here):
-- biometric_sleep_sessions.timezone_offset only ever captures the START
-- zone offset (mapSleepSession reads r.startZoneOffset, there is no
-- stored end-side offset). This view converts the wake instant using the
-- LAST session-in-the-block's own timezone_offset — its own start offset,
-- not an offset captured at the wake instant itself — as the
-- closest-available stand-in. This is correct whenever the device's
-- timezone did not change between that session's bedtime and its wake
-- (true for the reference corpus), and would misdate a cycle that spans a
-- timezone change or DST transition mid-sleep. Fixing this needs a stored
-- end-side offset on biometric_sleep_sessions, which is a table change
-- out of scope for a one-view commit — logged, not fixed here.
--
-- The regex-gated conversion below is defensive against a malformed
-- offset (mirrors 20260830130000_biometric_workouts_defensive_local_date.sql):
-- an offset that doesn't parse yields local_date = NULL rather than a
-- guessed date. All 180 reference rows parse today; the null-count check
-- in the verification SQL exists so a future malformed row fails loudly,
-- not silently.
--
-- ── source_period_id ──────────────────────────────────────────────────
-- The onset (first, earliest) session's own provider_record_id. No
-- separate "get back to the source row" column is added:
-- (user_id, origin_package, source_period_id) IS the primary key of
-- biometric_sleep_sessions for that row, so it already round-trips.
--
-- ── security_invoker = on: CHECKED ────────────────────────────────────
-- Re-verified by reading the CREATE VIEW statement below immediately
-- before writing this line. Omitting it fails open — the view would run
-- as its owner and bypass biometric_sleep_sessions' own RLS, handing
-- every user's reconstructed cycles to every other user.
--
-- ── VOCABULARY ─────────────────────────────────────────────────────────
-- user_id / cycle_start / cycle_end / is_current / timezone_offset /
-- local_date name and mean the same thing as their biometric_periods
-- counterparts (period_start/period_end renamed to cycle_start/cycle_end
-- because this view's grain is a reconstructed cycle, not a raw period —
-- matching whoop_cycle_nutrition's own cycle_start/cycle_end naming for
-- the same concept). ingest_transport is always the literal
-- 'health_connect' (this view has exactly one source table, which itself
-- only ever carries 'health_connect' rows in practice — WHOOP writes its
-- own native cycles to whoop_cycles directly and has no need of
-- reconstruction). Filtering explicitly to ingest_transport =
-- 'health_connect' rather than reading the whole table unfiltered follows
-- the same precedent as 20260830090000_biometric_workouts_health_connect_arm.sql's
-- Health Connect arm: a hypothetical future 'whoop'-transport row landing
-- in biometric_sleep_sessions would be a different, not-yet-designed
-- direct-integration path, not silently absorbed into "the Health Connect
-- reconstruction" this view is named for.
-- ============================================================

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
    and is_nap = false
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

-- ============================================================
-- NOT in this migration (deliberately deferred) — commit three's checklist
--
-- Repointing biometric_periods / biometric_periods_resolved /
-- whoop_correlation / whoop_cycle_nutrition onto this view (the eventual
-- Health Connect union arm biometric_periods' own header already marks as
-- "commit three's problem," 20260829111404_biometric_periods_resolved.sql)
-- is not done here. When it is, that commit must add a now()-based
-- staleness gate for any period read from biometric_synthetic_cycles with
-- is_current = true, the way whoop_cycle_nutrition.effective_end already
-- does for the WHOOP arm (coalesce(period_end, case when period_start >
-- now() - interval '36 hours' then now() end)). is_current here is
-- deliberately unqualified by recency (see the section above) — that is
-- safe only as long as nothing aggregates against it with a bare
-- coalesce(cycle_end, now()). This item must not be allowed to live only
-- in that comment; carry it into commit three's own plan explicitly.
--
-- Also carried forward: the timezone_offset-captures-bedtime-only
-- limitation (local_date section above), and
-- biometric_periods_resolved's per-domain ranking partitioning by
-- (user_id, source_period_id), which is provider-scoped and so never
-- actually adjudicates cross-provider (logged against that migration,
-- not re-logged in full here).
--
-- Found while verifying this migration against production, not by this
-- migration's own design (full detail in
-- supabase/migrations/verify/20260830170000_verify.sql, immediately after
-- V3): whoop-sync (supabase/functions/whoop-sync/index.ts) never backfills
-- whoop_cycles."end" for a cycle it already saw once that cycle closes —
-- two historical cycles are stuck permanently NULL-end as a result, which
-- whoop_cycle_nutrition's effective_end predicate silently excludes from
-- nutrition aggregation. Needs its own read-only investigation into the
-- sync window/cursor before any fix. Also carried forward from the same
-- discovery: any future contiguity check on whoop_cycles must count a
-- NULL end as a finding, never filter it out via `is not null` — that is
-- exactly how the "53/53 boundaries checked" figure in this file's own
-- CORRECTED PREMISE section undercounted two broken rows as if they were
-- never there.
-- ============================================================
