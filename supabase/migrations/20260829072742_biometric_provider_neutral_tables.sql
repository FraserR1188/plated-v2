-- ============================================================
-- Provider-neutral biometric tables — commit 1 of N
--
-- Four EMPTY tables. No backfill, no data movement, no view touched. The
-- WHOOP tables (whoop_cycles / whoop_sleeps / whoop_recoveries /
-- whoop_workouts) are untouched and keep ingesting exactly as before —
-- this migration adds a second, parallel storage shape for a future
-- Health Connect (or other direct) integration to write into, plus the
-- CHECK constraints that whoop_correlation / biometric_periods currently
-- lack entirely: ingest_source and hrv_method are today unenforced SQL
-- literals ('whoop'::text, 'rmssd'::text) baked into two view SELECT
-- lists (supabase/migrations/20260808150000_biometric_spine_views.sql:24,
-- 56, 90) with nothing stopping a typo'd 'Whoop' the day a second
-- provider's ingest code is written. These tables make that mistake
-- impossible to insert, not just unlikely.
--
-- ingest_source is split into two dimensions on purpose:
--   ingest_transport — HOW the data got here: 'whoop' (WHOOP's own REST
--                      API) or 'health_connect' (Android's on-device
--                      aggregator, which itself re-exports many vendors).
--   origin_package    — WHICH app/vendor actually produced the record.
--                      For a health_connect row this is the contributing
--                      app's Android package name (e.g.
--                      'com.garmin.android.apps.connectmobile'). For a
--                      direct integration (no Health Connect involved,
--                      same shape WHOOP already uses) there is no Android
--                      package, so a reserved dotted namespace stands in:
--                      'whoop.direct', 'garmin.direct'. NEVER NULL — a
--                      NULL here would make "unknown origin" and "no
--                      origin" indistinguishable, and would make
--                      `nulls not distinct` load-bearing in the upsert
--                      conflict target, which is exactly the ambiguity
--                      this split exists to avoid.
--
-- NULL discipline mirrors supabase/functions/whoop-sync/index.ts:136-143
-- (num()/int(): a WHOOP field that wasn't scored becomes NULL, never 0).
-- Every nullable numeric/bigint column below carries NO DEFAULT for the
-- same reason: absent means absent, not zero.
--
-- RLS/grant posture mirrors 20260712120000_whoop_data.sql section 2
-- exactly: user SELECTs own rows, every write is service_role, and the
-- default anon/authenticated DML grants are revoked so RLS is not the
-- single point of failure.
--
-- NOT in this migration (deliberately deferred to later commits):
--   - Any view. No provider-agnostic spine reads these tables yet.
--   - Any Edge Function write path.
--   - Any precedence/de-duplication logic between a health_connect row
--     and a whoop row describing the same real-world sleep/workout —
--     that's what (user_id, ingest_transport, origin_package) is indexed
--     for, in the layer that consumes it.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- biometric_sleep_sessions
-- ════════════════════════════════════════════════════════════

create table if not exists public.biometric_sleep_sessions (
  user_id             uuid not null references auth.users (id) on delete cascade,

  -- ── shared provenance columns (see header) ──────────────────
  ingest_transport    text not null check (ingest_transport in ('whoop', 'health_connect')),
  origin_package      text not null check (origin_package <> '' and origin_package ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  provider_record_id  text not null,
  timezone_offset     text,           -- LABELLING ONLY, mirrors whoop_cycles.timezone_offset. Never join on this.
  raw                 jsonb not null,
  source_updated_at   timestamptz,
  synced_at           timestamptz not null default now(),

  -- ── sleep-specific ───────────────────────────────────────────
  period_start        timestamptz not null,
  period_end          timestamptz not null,
  is_nap              boolean not null default false,

  -- Stage totals in MILLISECONDS, nullable, NO DEFAULT — a stage a
  -- provider didn't report is absent, not zero minutes of it.
  total_in_bed_ms     bigint,
  total_awake_ms      bigint,
  total_light_ms      bigint,
  -- Health Connect's stage vocabulary has no "slow wave" concept — its
  -- SleepStageRecord reports STAGE_TYPE_DEEP. WHOOP's nearest field is
  -- total_slow_wave_sleep_time_milli, which is closely related but not
  -- defined identically. total_deep_ms is deliberately its own column,
  -- not renamed to match WHOOP's term — do not silently equate the two
  -- in any consumer. That reconciliation, if it ever happens, belongs in
  -- a later layer, not this table.
  total_deep_ms       bigint,
  total_rem_ms        bigint,
  total_sleep_ms      bigint,
  sleep_efficiency_percentage numeric,

  -- ingest_transport <-> origin_package coherence. A 'whoop' (direct
  -- integration) row must use the reserved '<vendor>.direct' namespace; a
  -- 'health_connect' row must carry a real Android package name and must
  -- NOT use that reserved namespace. Without this, a row could claim
  -- ingest_transport = 'health_connect' with origin_package =
  -- 'whoop.direct' — internally incoherent, and precedence resolution in
  -- a later layer would have no way to detect it was fed garbage.
  constraint biometric_sleep_sessions_transport_origin_check check (
    (ingest_transport = 'whoop'          and origin_package like '%.direct')
    or
    (ingest_transport = 'health_connect' and origin_package not like '%.direct')
  ),

  primary key (user_id, origin_package, provider_record_id)
);

comment on table public.biometric_sleep_sessions is
  'Provider-neutral sleep sessions. One row per (user, origin_package, provider_record_id). No view reads this yet.';
comment on column public.biometric_sleep_sessions.origin_package is
  'Android package name for a Health Connect-sourced row, or a reserved "<vendor>.direct" namespace for a direct API integration (e.g. whoop.direct). Never NULL. Case is preserved verbatim, NEVER folded to lowercase: Health Connect package names are case-sensitive and legitimately mixed-case (Fitbit''s own package is com.fitbit.FitbitMobile) — lower-casing on write would silently merge it with a different, lowercase-only package. Do not re-add a lower() check here.';
comment on column public.biometric_sleep_sessions.total_deep_ms is
  'Health Connect "deep sleep" vocabulary. Not a renamed WHOOP slow-wave-sleep value — the two are related, not identical. Do not pool them.';

create index if not exists biometric_sleep_sessions_user_period_idx
  on public.biometric_sleep_sessions (user_id, period_start);
create index if not exists biometric_sleep_sessions_user_transport_package_idx
  on public.biometric_sleep_sessions (user_id, ingest_transport, origin_package);

alter table public.biometric_sleep_sessions enable row level security;

create policy biometric_sleep_sessions_select_own on public.biometric_sleep_sessions
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.biometric_sleep_sessions from anon, authenticated;


-- ════════════════════════════════════════════════════════════
-- biometric_hrv_samples
-- ════════════════════════════════════════════════════════════

create table if not exists public.biometric_hrv_samples (
  user_id             uuid not null references auth.users (id) on delete cascade,

  -- ── shared provenance columns (see header) ──────────────────
  ingest_transport    text not null check (ingest_transport in ('whoop', 'health_connect')),
  origin_package      text not null check (origin_package <> '' and origin_package ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  provider_record_id  text not null,
  timezone_offset     text,
  raw                 jsonb not null,
  source_updated_at   timestamptz,
  synced_at           timestamptz not null default now(),

  -- ── HRV-specific ─────────────────────────────────────────────
  measured_at         timestamptz not null,
  hrv_value           numeric,        -- nullable: an unscored/pending sample carries no value

  -- hrv_method / hrv_window / hrv_unit are NOT NULL with NO DEFAULT,
  -- unlike hrv_value. An HRV number with an unstated method is not a
  -- missing field, it is a correctness hazard: RMSSD and SDNN are not
  -- interchangeable and averaging across them silently produces a
  -- meaningless number (see biometric_periods.hrv_method comment,
  -- 20260808150000_biometric_spine_views.sql:56, "load-bearing: never
  -- pool with SDNN"). A default here would let that mistake insert
  -- silently; the absence of one forces every write site to say what it
  -- means.
  hrv_method          text not null check (hrv_method in ('rmssd', 'sdnn')),
  -- The measurement window the value describes (e.g. 'sleep', '5min').
  -- Free text, not an enum: providers disagree on window vocabulary and
  -- a CHECK enumerating them would reject a real value from a provider
  -- not yet on the list. Not-empty is the only thing enforced.
  hrv_window          text not null check (hrv_window <> ''),
  hrv_unit            text not null check (hrv_unit = 'ms'),

  -- ingest_transport <-> origin_package coherence — see the identical
  -- constraint on biometric_sleep_sessions for the full rationale.
  constraint biometric_hrv_samples_transport_origin_check check (
    (ingest_transport = 'whoop'          and origin_package like '%.direct')
    or
    (ingest_transport = 'health_connect' and origin_package not like '%.direct')
  ),

  primary key (user_id, origin_package, provider_record_id)
);

comment on table public.biometric_hrv_samples is
  'Provider-neutral HRV samples. hrv_method/hrv_window/hrv_unit are mandatory, undefaulted — never average across differing hrv_method values.';
comment on column public.biometric_hrv_samples.hrv_window is
  'The measurement window the value describes, e.g. "sleep" or "5min". Free text by design: providers disagree on vocabulary. Never empty.';

create index if not exists biometric_hrv_samples_user_measured_idx
  on public.biometric_hrv_samples (user_id, measured_at);
create index if not exists biometric_hrv_samples_user_transport_package_idx
  on public.biometric_hrv_samples (user_id, ingest_transport, origin_package);

alter table public.biometric_hrv_samples enable row level security;

create policy biometric_hrv_samples_select_own on public.biometric_hrv_samples
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.biometric_hrv_samples from anon, authenticated;


-- ════════════════════════════════════════════════════════════
-- biometric_resting_hr
-- ════════════════════════════════════════════════════════════

create table if not exists public.biometric_resting_hr (
  user_id             uuid not null references auth.users (id) on delete cascade,

  -- ── shared provenance columns (see header) ──────────────────
  ingest_transport    text not null check (ingest_transport in ('whoop', 'health_connect')),
  origin_package      text not null check (origin_package <> '' and origin_package ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  provider_record_id  text not null,
  timezone_offset     text,
  raw                 jsonb not null,
  source_updated_at   timestamptz,
  synced_at           timestamptz not null default now(),

  -- ── resting-HR-specific ──────────────────────────────────────
  measured_at         timestamptz not null,
  resting_heart_rate  numeric,        -- nullable: same NULL-not-zero discipline as WHOOP's promoted columns

  -- WHOOP's resting_heart_rate is a per-CYCLE value (bounded by a
  -- wake-to-wake period). Health Connect's RestingHeartRateRecord is
  -- typically a per-CALENDAR-DAY aggregate with no cycle concept at all.
  -- Averaging a period-bounded value against a calendar-day aggregate as
  -- if they were the same kind of number silently corrupts both. This
  -- column exists so no consumer can do that without noticing.
  -- NOT NULL, NO DEFAULT: same reasoning as hrv_method above — an
  -- unstated scope is a correctness hazard, not a missing field.
  measurement_scope   text not null check (measurement_scope in ('period', 'calendar_day')),

  -- ingest_transport <-> origin_package coherence — see the identical
  -- constraint on biometric_sleep_sessions for the full rationale.
  constraint biometric_resting_hr_transport_origin_check check (
    (ingest_transport = 'whoop'          and origin_package like '%.direct')
    or
    (ingest_transport = 'health_connect' and origin_package not like '%.direct')
  ),

  primary key (user_id, origin_package, provider_record_id)
);

comment on table public.biometric_resting_hr is
  'Provider-neutral resting heart rate. measurement_scope distinguishes a period-bounded value (WHOOP cycle) from a calendar-day aggregate (Health Connect) — never mix them in one series.';
comment on column public.biometric_resting_hr.measurement_scope is
  '''period'' = bounded by a provider-defined period (e.g. a WHOOP cycle). ''calendar_day'' = a calendar-day aggregate (e.g. Health Connect). Mandatory: an unstated scope is a correctness hazard.';

create index if not exists biometric_resting_hr_user_measured_idx
  on public.biometric_resting_hr (user_id, measured_at);
create index if not exists biometric_resting_hr_user_transport_package_idx
  on public.biometric_resting_hr (user_id, ingest_transport, origin_package);

alter table public.biometric_resting_hr enable row level security;

create policy biometric_resting_hr_select_own on public.biometric_resting_hr
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.biometric_resting_hr from anon, authenticated;


-- ════════════════════════════════════════════════════════════
-- biometric_workout_sessions
--
-- NOTE: public.biometric_workouts already exists as a VIEW (over
-- whoop_workouts, 20260808150000_biometric_spine_views.sql:86). This
-- table is deliberately named biometric_workout_sessions, not
-- biometric_workouts, so it cannot collide with that view name.
-- ════════════════════════════════════════════════════════════

create table if not exists public.biometric_workout_sessions (
  user_id             uuid not null references auth.users (id) on delete cascade,

  -- ── shared provenance columns (see header) ──────────────────
  ingest_transport    text not null check (ingest_transport in ('whoop', 'health_connect')),
  origin_package      text not null check (origin_package <> '' and origin_package ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  provider_record_id  text not null,
  timezone_offset     text,
  raw                 jsonb not null,
  source_updated_at   timestamptz,
  synced_at           timestamptz not null default now(),

  -- ── workout-specific ─────────────────────────────────────────
  period_start           timestamptz not null,
  period_end             timestamptz not null,
  activity_type           text,       -- provider-specific naming (WHOOP sport_name, Health Connect ExerciseType) — do not pool across sources
  average_heart_rate      numeric,
  max_heart_rate          numeric,
  energy_kilojoule        numeric,    -- kJ, NOT kcal. Never expose a unit-free "energy" (4.184x trap)
  distance_meter          numeric,
  altitude_gain_meter     numeric,

  -- No strain column, deliberately. Strain is a WHOOP-proprietary,
  -- algorithmically-derived score with no Health Connect equivalent.
  -- Synthesizing one from heart-rate data would be an invented metric
  -- presented as if it were the provider's own — not done here.

  -- ingest_transport <-> origin_package coherence — see the identical
  -- constraint on biometric_sleep_sessions for the full rationale.
  constraint biometric_workout_sessions_transport_origin_check check (
    (ingest_transport = 'whoop'          and origin_package like '%.direct')
    or
    (ingest_transport = 'health_connect' and origin_package not like '%.direct')
  ),

  primary key (user_id, origin_package, provider_record_id)
);

comment on table public.biometric_workout_sessions is
  'Provider-neutral workout sessions. Named _sessions (not _workouts) to avoid colliding with the existing public.biometric_workouts view. No strain column: WHOOP-proprietary, no Health Connect equivalent, not synthesized here.';

create index if not exists biometric_workout_sessions_user_period_idx
  on public.biometric_workout_sessions (user_id, period_start);
create index if not exists biometric_workout_sessions_user_transport_package_idx
  on public.biometric_workout_sessions (user_id, ingest_transport, origin_package);

alter table public.biometric_workout_sessions enable row level security;

create policy biometric_workout_sessions_select_own on public.biometric_workout_sessions
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.biometric_workout_sessions from anon, authenticated;
