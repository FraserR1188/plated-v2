-- ⚠️ STALE. Historical record of the v2 schema only.
-- Missing: eaten_at, sat_fat, custom_foods, profiles, follows,
-- ai_extractions, whoop_*, storage policies.
-- The live schema is the remote DB. Do not read this to learn the schema.
-- Do not run this.

-- ================================================================
-- plated. — Supabase Schema v2
-- Ingredient-based tracking with saved library
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ================================================================

create extension if not exists "uuid-ossp";

-- ── SAVED INGREDIENTS LIBRARY ─────────────────────────────────
-- Ingredients the user has used before — for quick re-adding.

create table if not exists saved_ingredients (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  name         text not null,
  brand        text,
  cal_per100   numeric(8,2) not null default 0,
  protein_per100 numeric(8,2) not null default 0,
  carbs_per100 numeric(8,2) not null default 0,
  fat_per100   numeric(8,2) not null default 0,
  salt_per100  numeric(8,2) not null default 0,
  fibre_per100 numeric(8,2) not null default 0,
  sugar_per100 numeric(8,2) not null default 0,
  barcode      text,
  off_id       text,
  use_count    integer not null default 1,
  created_at   timestamptz not null default now()
);

create index if not exists saved_ingredients_user
  on saved_ingredients(user_id, use_count desc);

-- ── MEAL ENTRIES ──────────────────────────────────────────────
-- One row per ingredient logged. Grouped by date + meal_type.

create table if not exists meal_entries (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  date         date not null,
  logged_at    timestamptz not null default now(),
  meal_type    text not null default 'breakfast', -- breakfast|lunch|dinner|snacks
  name         text not null,
  brand        text,
  serving_g    numeric(8,2) not null default 100,
  calories     numeric(8,2) not null default 0,
  protein      numeric(8,2) not null default 0,
  carbs        numeric(8,2) not null default 0,
  fat          numeric(8,2) not null default 0,
  salt         numeric(8,2) not null default 0,
  fibre        numeric(8,2) not null default 0,
  sugar        numeric(8,2) not null default 0,
  source       text not null default 'manual',
  barcode      text,
  off_id       text,
  saved_ingredient_id uuid references saved_ingredients(id) on delete set null
);

create index if not exists meal_entries_user_date
  on meal_entries(user_id, date desc);

-- ── GOALS ────────────────────────────────────────────────────

create table if not exists goals (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  calories   integer not null default 2000,
  protein    integer not null default 150,
  carbs      integer not null default 200,
  fat        integer not null default 65,
  salt       numeric(4,1) not null default 6,
  fibre      integer not null default 30,
  sugar      integer not null default 30,
  updated_at timestamptz not null default now()
);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────

alter table saved_ingredients enable row level security;
alter table meal_entries       enable row level security;
alter table goals              enable row level security;

create policy "Users read own saved ingredients"    on saved_ingredients for select using (auth.uid() = user_id);
create policy "Users insert own saved ingredients"  on saved_ingredients for insert with check (auth.uid() = user_id);
create policy "Users update own saved ingredients"  on saved_ingredients for update using (auth.uid() = user_id);
create policy "Users delete own saved ingredients"  on saved_ingredients for delete using (auth.uid() = user_id);

create policy "Users read own entries"    on meal_entries for select using (auth.uid() = user_id);
create policy "Users insert own entries"  on meal_entries for insert with check (auth.uid() = user_id);
create policy "Users delete own entries"  on meal_entries for delete using (auth.uid() = user_id);

create policy "Users read own goals"    on goals for select using (auth.uid() = user_id);
create policy "Users upsert own goals"  on goals for insert with check (auth.uid() = user_id);
create policy "Users update own goals"  on goals for update using (auth.uid() = user_id);
