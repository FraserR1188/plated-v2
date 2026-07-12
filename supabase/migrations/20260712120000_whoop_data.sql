-- ============================================================
-- WHOOP integration — migration 2 of 2
--
-- Adds:
--   whoop_cycles / whoop_sleeps / whoop_recoveries / whoop_workouts
--   the token refresh lease (rotation is unforgiving; see below)
--   the correlation views — cycle-INTERVAL joins, both lags baked in
--   eaten_at_estimated on meal_entries
--
-- Same posture as migration 1: user SELECTs own rows, every write is
-- service_role, and the default anon/authenticated DML grants are revoked
-- so that RLS is not the single point of failure.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. Fixes to migration 1
-- ════════════════════════════════════════════════════════════

-- ─── whoop_connections: separate "attempted" from "succeeded" ─
--
-- last_sync_at only ever moves on SUCCESS: it is both the UI string and the
-- anchor for the next sync window, so moving it on a failure would punch a
-- permanent hole in the data.
--
-- Which means it CANNOT be the throttle key. If WHOOP has a bad afternoon,
-- last_sync_at stops moving, the 15-minute throttle never engages, and every
-- app foreground fires another attempt — forever, for every user, against an
-- API that is already struggling. And because WHOOP rate-limits per APP and
-- not per user, that burns the 10,000/day budget for the entire user base.
--
-- So: attempts throttle, successes anchor.

alter table public.whoop_connections
  add column if not exists last_sync_attempt_at timestamptz,
  add column if not exists last_sync_error      text;

comment on column public.whoop_connections.last_sync_at is
  'Last SUCCESSFUL sync. Anchors the next sync window. Never moves on failure.';
comment on column public.whoop_connections.last_sync_attempt_at is
  'Last sync ATTEMPT, success or not. This is the throttle key, not last_sync_at.';
comment on column public.whoop_connections.last_sync_error is
  'Error code from the last failed sync; null when the last sync succeeded.';

-- Migration 1 gave this table RLS but left the default anon/authenticated
-- DML grants in place. RLS blocks writes today because there is no write
-- policy — but the same "one stray `disable row level security` during
-- debugging" argument that earned whoop_tokens its revoke applies here too,
-- and the blast radius is a client that can mark any user connected or
-- cross-wire whoop_user_id to another account.
revoke insert, update, delete on public.whoop_connections from anon, authenticated;


-- ─── whoop_tokens: the refresh lease ─────────────────────────
--
-- Refresh tokens ROTATE. Using one invalidates the old access AND refresh
-- token. Two concurrent refreshes race: the first wins, the second presents
-- a token that WHOOP has already killed — and the connection is dead for
-- good, with no way for the user to tell beyond a "Reconnect" chip.
--
-- A plain `SELECT ... FOR UPDATE` does not solve this. The row lock dies
-- with the transaction, and the WHOOP HTTP exchange happens outside it
-- (supabase-js is auto-commit per statement). What survives the commit is
-- this column: a LEASE. See whoop_token_lease() below.

alter table public.whoop_tokens
  add column if not exists refresh_locked_until timestamptz;

comment on column public.whoop_tokens.refresh_locked_until is
  'Refresh lease. Set by whoop_token_lease(), cleared by whoop_token_commit()/_release(). Expires on its own so a crashed refresh cannot wedge the connection.';

-- updated_at was `default now()` with no trigger. Defaults do not fire on
-- UPDATE, so the "when did we last rotate" breadcrumb — the exact thing you
-- squint at when a connection dies mysteriously — would freeze at first
-- connect unless every write path remembered to set it by hand.
-- A trigger is cheaper than a convention.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists whoop_tokens_set_updated_at on public.whoop_tokens;
create trigger whoop_tokens_set_updated_at
  before update on public.whoop_tokens
  for each row execute function public.set_updated_at();


-- ─── meal_entries ────────────────────────────────────────────
--
-- eaten_at defaults to now(), so a meal logged at 21:00 for a breakfast
-- eaten at 07:30 carries a fictional timestamp — and the interval join
-- believes it. This flag is the difference between a correlation you can
-- defend and one you cannot.
--
-- DEFAULT TRUE is deliberate and fails safe. If the client forgets to set
-- it, every row reads as "estimated" — useless but honest. Default false
-- would silently claim a precision the data does not have.
--
-- This cannot be backfilled. Every day it is not in place, the ceiling on
-- correlation quality drops permanently.
alter table public.meal_entries
  add column if not exists eaten_at_estimated boolean not null default true;

comment on column public.meal_entries.eaten_at_estimated is
  'True when eaten_at was defaulted rather than chosen by the user. Fails safe: default true.';

-- The interval join lives or dies on this index.
create index if not exists meal_entries_user_eaten_at_idx
  on public.meal_entries (user_id, eaten_at);


-- ════════════════════════════════════════════════════════════
-- 2. WHOOP data tables
--
-- Shape: RAW JSONB + PROMOTED COLUMNS.
--   raw              — never normalise on ingest. WHOOP re-scores records
--                      retroactively and you cannot re-derive what you dropped.
--   promoted columns — because pure-JSONB correlation queries are miserable
--                      and index badly.
--   whoop_updated_at — WHOOP's own updated_at. The upsert GATE: only write
--                      if theirs is newer than ours. Makes sync idempotent
--                      and makes re-scores land automatically.
--
-- No score_state CHECK constraints: WHOOP can add values, and a constraint
-- that rejects an unknown state turns a shrug into a failed sync.
--
-- No FKs between these tables. A recovery can arrive before its cycle
-- depending on pagination order; an FK would make sync order load-bearing.
-- The views left-join and surface the gaps instead.
-- ════════════════════════════════════════════════════════════

-- ─── whoop_cycles ────────────────────────────────────────────
-- The join key for the entire product. `end` is NULL while in progress.
create table if not exists public.whoop_cycles (
  user_id             uuid   not null references auth.users (id) on delete cascade,
  id                  bigint not null,               -- WHOOP cycle id (int64)

  start               timestamptz not null,
  "end"               timestamptz,                   -- NULL = in progress
  timezone_offset     text,                          -- LABELLING ONLY. Never join on this.

  score_state         text,                          -- SCORED | PENDING_SCORE | UNSCORABLE
  strain              numeric,
  kilojoule           numeric,
  average_heart_rate  integer,
  max_heart_rate      integer,

  raw                 jsonb  not null,
  whoop_updated_at    timestamptz,
  synced_at           timestamptz not null default now(),

  primary key (user_id, id)
);

comment on column public.whoop_cycles.timezone_offset is
  'For LABELLING a cycle in the UI. Never for joining. Meals join on the UTC interval.';

create index if not exists whoop_cycles_user_start_idx
  on public.whoop_cycles (user_id, start);

-- Finding the open cycle on every sync, cheaply.
create index if not exists whoop_cycles_open_idx
  on public.whoop_cycles (user_id)
  where "end" is null;


-- ─── whoop_sleeps ────────────────────────────────────────────
-- v2 ids are UUIDs (they were integers in v1).
create table if not exists public.whoop_sleeps (
  user_id                          uuid not null references auth.users (id) on delete cascade,
  id                               uuid not null,

  start                            timestamptz not null,
  "end"                            timestamptz not null,
  timezone_offset                  text,
  nap                              boolean not null default false,

  score_state                      text,

  -- stage_summary
  total_in_bed_time_milli          bigint,
  total_awake_time_milli           bigint,
  total_light_sleep_time_milli     bigint,
  total_slow_wave_sleep_time_milli bigint,
  total_rem_sleep_time_milli       bigint,
  sleep_cycle_count                integer,
  disturbance_count                integer,

  sleep_performance_percentage     numeric,
  sleep_efficiency_percentage      numeric,
  sleep_consistency_percentage     numeric,
  respiratory_rate                 numeric,

  raw                              jsonb not null,
  whoop_updated_at                 timestamptz,
  synced_at                        timestamptz not null default now(),

  primary key (user_id, id)
);

create index if not exists whoop_sleeps_user_start_idx
  on public.whoop_sleeps (user_id, start);


-- ─── whoop_recoveries ────────────────────────────────────────
-- No id of its own: keyed on cycle_id, and carries sleep_id.
--
-- sleep_id is what makes the sleep join unambiguous. A WHOOP cycle runs
-- wake-to-wake, so the night's sleep sits at the TAIL of cycle N-1 by
-- interval but PRODUCES the recovery for cycle N. Interval-joining sleep to
-- cycles gets it off by one at precisely the boundary that carries the
-- signal. So sleep(N) is defined as "the sleep that recovery(N) points at",
-- full stop.
create table if not exists public.whoop_recoveries (
  user_id             uuid   not null references auth.users (id) on delete cascade,
  cycle_id            bigint not null,
  sleep_id            uuid,

  score_state         text,
  user_calibrating    boolean,

  recovery_score      numeric,
  resting_heart_rate  numeric,
  hrv_rmssd_milli     numeric,
  spo2_percentage     numeric,
  skin_temp_celsius   numeric,

  raw                 jsonb  not null,
  whoop_updated_at    timestamptz,
  synced_at           timestamptz not null default now(),

  primary key (user_id, cycle_id)
);

create index if not exists whoop_recoveries_user_sleep_idx
  on public.whoop_recoveries (user_id, sleep_id);


-- ─── whoop_workouts ──────────────────────────────────────────
-- In scope now, not because the dashboard needs it, but because backfill is
-- the expensive rate-limited operation and skipping workouts means paying
-- for a second one later out of a budget shared with live users.
-- Table + ingest only this session. No view surface, no UI.
create table if not exists public.whoop_workouts (
  user_id                uuid not null references auth.users (id) on delete cascade,
  id                     uuid not null,

  start                  timestamptz not null,
  "end"                  timestamptz not null,
  timezone_offset        text,
  sport_name             text,

  score_state            text,
  strain                 numeric,
  average_heart_rate     integer,
  max_heart_rate         integer,
  kilojoule              numeric,
  distance_meter         numeric,
  altitude_gain_meter    numeric,
  altitude_change_meter  numeric,

  raw                    jsonb not null,
  whoop_updated_at       timestamptz,
  synced_at              timestamptz not null default now(),

  primary key (user_id, id)
);

create index if not exists whoop_workouts_user_start_idx
  on public.whoop_workouts (user_id, start);


-- ─── RLS: read own, write service_role, belt and braces ──────
alter table public.whoop_cycles     enable row level security;
alter table public.whoop_sleeps     enable row level security;
alter table public.whoop_recoveries enable row level security;
alter table public.whoop_workouts   enable row level security;

create policy whoop_cycles_select_own on public.whoop_cycles
  for select to authenticated using (auth.uid() = user_id);
create policy whoop_sleeps_select_own on public.whoop_sleeps
  for select to authenticated using (auth.uid() = user_id);
create policy whoop_recoveries_select_own on public.whoop_recoveries
  for select to authenticated using (auth.uid() = user_id);
create policy whoop_workouts_select_own on public.whoop_workouts
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.whoop_cycles     from anon, authenticated;
revoke insert, update, delete on public.whoop_sleeps     from anon, authenticated;
revoke insert, update, delete on public.whoop_recoveries from anon, authenticated;
revoke insert, update, delete on public.whoop_workouts   from anon, authenticated;


-- ════════════════════════════════════════════════════════════
-- 3. The token refresh lease
--
-- whoop_token_lease() runs in ONE transaction:
--   SELECT ... FOR UPDATE  → takes the row lock
--   check expiry           → still fresh? hand it back, take no lease
--   check the lease        → someone else refreshing? return 'busy'
--   UPDATE the lease       → commit
--
-- A second concurrent caller BLOCKS on the FOR UPDATE, then re-reads the
-- committed row (READ COMMITTED) and sees the lease → 'busy'. It backs off
-- and re-reads rather than presenting a refresh token that is already dead.
--
-- The lock does not need to survive the HTTP call. The LEASE does, and it
-- expires on its own so a crashed Edge Function cannot wedge a connection.
-- ════════════════════════════════════════════════════════════

create or replace function public.whoop_token_lease(
  p_user_id       uuid,
  p_skew_seconds  integer default 300,   -- refresh if expiring within 5 min
  p_lease_seconds integer default 30     -- > WHOOP_TIMEOUT_MS, < any sane retry
)
returns table (
  outcome       text,   -- 'valid' | 'leased' | 'busy' | 'missing'
  access_token  text,
  refresh_token text,   -- ONLY populated for 'leased'
  expires_at    timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.whoop_tokens%rowtype;
begin
  select * into v
    from public.whoop_tokens
   where user_id = p_user_id
     for update;

  if not found then
    return query select 'missing'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if v.expires_at - now() > make_interval(secs => p_skew_seconds) then
    return query select 'valid'::text, v.access_token, null::text, v.expires_at;
    return;
  end if;

  if v.refresh_locked_until is not null and v.refresh_locked_until > now() then
    return query select 'busy'::text, null::text, null::text, v.expires_at;
    return;
  end if;

  update public.whoop_tokens
     set refresh_locked_until = now() + make_interval(secs => p_lease_seconds)
   where user_id = p_user_id;

  return query select 'leased'::text, v.access_token, v.refresh_token, v.expires_at;
end;
$$;


-- Success path: store the ROTATED pair and clear the lease, atomically.
-- An RPC rather than a bare update so that "clear the lease" cannot be
-- forgotten by a future caller.
create or replace function public.whoop_token_commit(
  p_user_id       uuid,
  p_access_token  text,
  p_refresh_token text,
  p_expires_at    timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.whoop_tokens
     set access_token         = p_access_token,
         refresh_token        = p_refresh_token,
         expires_at           = p_expires_at,
         refresh_locked_until = null
   where user_id = p_user_id;
  -- updated_at is handled by the trigger.
end;
$$;


-- Transient-failure path: drop the lease, touch nothing else.
-- A WHOOP 503 or a timeout must NOT revoke the connection — with rotation,
-- a wrongly-revoked connection is unrecoverable without a manual reconnect.
create or replace function public.whoop_token_release(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.whoop_tokens
     set refresh_locked_until = null
   where user_id = p_user_id;
end;
$$;


-- ─── CRITICAL ────────────────────────────────────────────────
-- SECURITY DEFINER functions are granted EXECUTE to PUBLIC by default.
-- whoop_token_lease() RETURNS A REFRESH TOKEN. Left as-is, any signed-in
-- user could call it with any user_id and walk out with someone else's
-- long-lived WHOOP credentials. service_role only.
revoke all on function public.whoop_token_lease(uuid, integer, integer)  from public, anon, authenticated;
revoke all on function public.whoop_token_commit(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.whoop_token_release(uuid)                  from public, anon, authenticated;


-- ════════════════════════════════════════════════════════════
-- 4. The views
--
-- security_invoker = on is NOT optional. Views default to running as their
-- OWNER, which bypasses RLS on the underlying tables and hands every user
-- everyone else's health data. Requires PG15+; if this line errors, stop.
-- ════════════════════════════════════════════════════════════

-- ─── whoop_cycle_nutrition ───────────────────────────────────
-- The interval join. Meals belong to the cycle whose interval CONTAINS
-- eaten_at. No timezone arithmetic, no date-string reconciliation: a 01:00
-- meal correctly belongs to the cycle that began the previous morning,
-- which a `date` column gets wrong and this gets right.
create or replace view public.whoop_cycle_nutrition
with (security_invoker = on) as
with bounded as (
  select
    c.user_id,
    c.id                     as cycle_id,
    c.start                  as cycle_start,
    c."end"                  as cycle_end,
    (c."end" is null)        as is_in_progress,
    c.score_state,
    c.strain,
    c.kilojoule,
    c.average_heart_rate,
    c.timezone_offset,
    -- coalesce(end, now()) is a bug waiting for a flat battery: a strap left
    -- on the bedside table leaves the last cycle open forever, and that open
    -- interval would swallow every meal logged since. An open cycle older
    -- than 36h is not "current", it is stale — its effective_end is NULL and
    -- it owns nothing. Those meals surface in whoop_unassigned_meals.
    coalesce(
      c."end",
      case when c.start > now() - interval '36 hours' then now() end
    ) as effective_end
  from public.whoop_cycles c
)
select
  b.user_id,
  b.cycle_id,
  b.cycle_start,
  b.cycle_end,
  b.effective_end,
  b.is_in_progress,
  b.score_state,
  b.strain,
  b.kilojoule,
  b.average_heart_rate,
  b.timezone_offset,

  count(m.id)                         as meal_count,
  coalesce(sum(m.calories), 0)        as kcal,
  coalesce(sum(m.protein),  0)        as protein,
  coalesce(sum(m.carbs),    0)        as carbs,
  coalesce(sum(m.fat),      0)        as fat,
  coalesce(sum(m.sat_fat),  0)        as sat_fat,
  coalesce(sum(m.salt),     0)        as salt,
  coalesce(sum(m.fibre),    0)        as fibre,
  coalesce(sum(m.sugar),    0)        as sugar,

  -- Honesty column. If any meal in the cycle carries a defaulted eaten_at,
  -- the whole cycle's nutrition timing is soft, and any consumer plotting
  -- it should say so.
  coalesce(bool_or(m.eaten_at_estimated), false) as has_estimated_times,
  min(m.eaten_at)                     as first_meal_at,
  max(m.eaten_at)                     as last_meal_at

from bounded b
left join public.meal_entries m
       on m.user_id  = b.user_id
      and b.effective_end is not null
      and m.eaten_at is not null
      and m.eaten_at >= b.cycle_start
      and m.eaten_at <  b.effective_end
group by
  b.user_id, b.cycle_id, b.cycle_start, b.cycle_end, b.effective_end,
  b.is_in_progress, b.score_state, b.strain, b.kilojoule,
  b.average_heart_rate, b.timezone_offset;

comment on view public.whoop_cycle_nutrition is
  'Meals aggregated per WHOOP cycle by UTC INTERVAL containment of eaten_at. LEFT JOIN: a cycle with meal_count = 0 is a real cycle with nothing logged, not a missing cycle.';


-- ─── whoop_unassigned_meals ──────────────────────────────────
-- The meals the join could not place. SURFACE THESE. Silently dropping them
-- is how a chart comes to look fine and mean nothing.
create or replace view public.whoop_unassigned_meals
with (security_invoker = on) as
with span as (
  select user_id, min(start) as first_cycle_start
    from public.whoop_cycles
   group by user_id
)
select
  m.id,
  m.user_id,
  m.eaten_at,
  m.name,
  m.calories,
  case
    when m.eaten_at is null then 'no_eaten_at'   -- nullable column; join drops these
    else 'no_cycle'                              -- strap off, gap in WHOOP data,
  end as reason                                  -- or a stale open cycle
from public.meal_entries m
join span s on s.user_id = m.user_id
left join public.whoop_cycles c
       on c.user_id  = m.user_id
      and m.eaten_at >= c.start
      and m.eaten_at <  coalesce(
            c."end",
            case when c.start > now() - interval '36 hours' then now() end
          )
where c.id is null
  and (m.eaten_at is null or m.eaten_at >= s.first_cycle_start);

comment on view public.whoop_unassigned_meals is
  'Meals with no owning WHOOP cycle. Bounded to the period where cycle data exists, so meals predating the WHOOP connection are not reported as gaps.';


-- ─── whoop_correlation ───────────────────────────────────────
--
-- THE VIEW. Both lags baked in so that no downstream consumer — including a
-- future LLM reading this schema — can get them backwards.
--
--   cycle N-1                    |  cycle N
--   -----------------------------+--------------------------
--   meals eaten here ---+        |
--                       |  sleep |
--                       +------->|  recovery(N)
--                                |  strain(N) accumulates here
--                                |  ^
--                                |  +-- fuelled by meals in cycle N
--
--   *_prev_cycle  columns pair with  recovery_* and sleep_*   (the USP)
--   *_same_cycle  columns pair with  strain                   (did I fuel it)
--
-- A naive nutrition_day == recovery_day join gets the first one wrong by a
-- FULL CYCLE and produces a chart that looks fine and means nothing.
create or replace view public.whoop_correlation
with (security_invoker = on) as
with lagged as (
  select
    n.*,
    lag(n.cycle_id)            over w as prev_cycle_id,
    lag(n.cycle_start)         over w as prev_cycle_start,
    lag(n.cycle_end)           over w as prev_cycle_end,
    lag(n.meal_count)          over w as prev_meal_count,
    lag(n.kcal)                over w as prev_kcal,
    lag(n.protein)             over w as prev_protein,
    lag(n.carbs)               over w as prev_carbs,
    lag(n.fat)                 over w as prev_fat,
    lag(n.sat_fat)             over w as prev_sat_fat,
    lag(n.salt)                over w as prev_salt,
    lag(n.fibre)               over w as prev_fibre,
    lag(n.sugar)               over w as prev_sugar,
    lag(n.last_meal_at)        over w as prev_last_meal_at,
    lag(n.has_estimated_times) over w as prev_has_estimated_times
  from public.whoop_cycle_nutrition n
  window w as (partition by n.user_id order by n.cycle_start)
)
select
  l.user_id,
  l.cycle_id,
  l.cycle_start,
  l.cycle_end,
  l.is_in_progress,
  l.timezone_offset,
  -- Label only. Derived from timezone_offset for display. NEVER a join key.
  (l.cycle_start + coalesce(l.timezone_offset, '+00:00')::interval)::date
    as cycle_local_date,

  -- ── SAME CYCLE: nutrition(N) fuels strain(N) ──────────────
  l.strain,
  l.kilojoule,
  l.average_heart_rate,
  l.meal_count      as meal_count_same_cycle,
  l.kcal            as kcal_same_cycle,
  l.protein         as protein_same_cycle,
  l.carbs           as carbs_same_cycle,
  l.fat             as fat_same_cycle,
  l.sat_fat         as sat_fat_same_cycle,
  l.salt            as salt_same_cycle,
  l.fibre           as fibre_same_cycle,
  l.sugar           as sugar_same_cycle,

  -- ── LAGGED: nutrition(N-1) -> recovery(N), sleep(N) ───────
  l.prev_cycle_id,
  l.prev_meal_count as meal_count_prev_cycle,
  l.prev_kcal       as kcal_prev_cycle,
  l.prev_protein    as protein_prev_cycle,
  l.prev_carbs      as carbs_prev_cycle,
  l.prev_fat        as fat_prev_cycle,
  l.prev_sat_fat    as sat_fat_prev_cycle,
  l.prev_salt       as salt_prev_cycle,
  l.prev_fibre      as fibre_prev_cycle,
  l.prev_sugar      as sugar_prev_cycle,
  l.prev_last_meal_at as last_meal_before_sleep_at,

  r.recovery_score,
  r.hrv_rmssd_milli,
  r.resting_heart_rate,
  r.spo2_percentage,
  r.skin_temp_celsius,
  r.user_calibrating,

  -- sleep(N) := the sleep recovery(N) POINTS AT. Not an interval join.
  s.id                               as sleep_id,
  s.sleep_performance_percentage,
  s.sleep_efficiency_percentage,
  s.sleep_consistency_percentage,
  s.respiratory_rate,
  s.total_in_bed_time_milli,
  s.total_slow_wave_sleep_time_milli,
  s.total_rem_sleep_time_milli,
  s.total_awake_time_milli,
  s.disturbance_count,
  s.nap                              as sleep_was_nap,

  -- ── TRUST FLAGS. Filter on these before plotting anything. ──
  (l.score_state = 'SCORED')                          as cycle_scored,
  (r.score_state = 'SCORED')                          as recovery_scored,
  (s.score_state = 'SCORED')                          as sleep_scored,
  (l.meal_count > 0)                                  as nutrition_present,
  (l.prev_cycle_id is not null
     and coalesce(l.prev_meal_count, 0) > 0)          as prev_nutrition_present,
  -- Is cycle N-1 actually the cycle before this one, or is there a strap-off
  -- gap between them? If they are not contiguous, the lag is meaningless.
  (l.prev_cycle_end is not null
     and l.cycle_start - l.prev_cycle_end < interval '2 hours')
                                                      as prev_cycle_contiguous,
  l.has_estimated_times                               as timing_estimated_same_cycle,
  coalesce(l.prev_has_estimated_times, false)         as timing_estimated_prev_cycle

from lagged l
left join public.whoop_recoveries r
       on r.user_id = l.user_id
      and r.cycle_id = l.cycle_id
left join public.whoop_sleeps s
       on s.user_id = r.user_id
      and s.id      = r.sleep_id;

comment on view public.whoop_correlation is
  'One row per WHOOP cycle. *_prev_cycle nutrition pairs with recovery_* and sleep_* (what you ate BEFORE the night). *_same_cycle nutrition pairs with strain (what fuelled the day). Do not cross them. Filter on cycle_scored / recovery_scored / prev_nutrition_present / prev_cycle_contiguous before drawing any conclusion, and exclude is_in_progress = true — its strain is partial.';

grant select on public.whoop_cycle_nutrition  to authenticated;
grant select on public.whoop_unassigned_meals to authenticated;
grant select on public.whoop_correlation      to authenticated;