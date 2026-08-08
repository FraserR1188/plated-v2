-- ============================================================================
-- 20260808140000_core_ingredients.sql
-- Recipe scanner, Phase 1 — public.core_ingredients
--
-- A curated staples table (CoFID + USDA FoodData Central, seeded by a
-- one-off importer script — see scripts/seedCoreIngredients.ts, NOT app code)
-- that the client-side resolver (src/lib/ingredients.ts) checks BEFORE
-- falling back to an Open Food Facts search. Read-only reference data: the
-- app only ever SELECTs from this table.
--
-- NULL, NEVER 0, FOR A MISSING NUTRIENT
--   Same rule as meal_entries (see meal_bundles.sql's comment on sat_fat/
--   salt/fibre/sugar). NULL = we don't know. 0 = we know, it's zero. The
--   importer must preserve this per-field, not collapse an unknown into a
--   default. See scripts/seedCoreIngredients.ts's coalesceMacros().
--
-- SALT IS DERIVED, NEVER STORED RAW
--   salt_100g = (sodium_mg / 1000) * 2.5 (UK label convention). Sodium
--   itself is not a column here — there is nothing else in this table that
--   would read it, so keeping it around would just be a second place for
--   the two numbers to drift apart. roundSalt() (src/lib/macros.ts) stays a
--   DISPLAY-time concern; this column holds the precise derived value.
--
-- WHY set_updated_at() ISN'T DEFINED HERE
--   It already exists — created by 20260712120000_whoop_data.sql for
--   whoop_tokens. Redefining it would just be a second copy of the same
--   function to keep in sync; this migration reuses it directly.
-- ============================================================================

create extension if not exists pg_trgm;

create table if not exists public.core_ingredients (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,          -- 'plain-flour'
  display_name  text not null,                 -- 'Plain flour'
  aliases       text[] not null default '{}',  -- ['all-purpose flour','ap flour','white flour']

  -- Macros per 100g edible portion. NULL = unknown — see header comment.
  kcal_100g     numeric,
  protein_100g  numeric,
  carbs_100g    numeric,
  fat_100g      numeric,
  satfat_100g   numeric,
  sugar_100g    numeric,
  fibre_100g    numeric,
  salt_100g     numeric,          -- derived: (sodium_mg / 1000) * 2.5

  -- Quantity -> grams. Per-100g stays canonical above; this is a SEPARATE
  -- mechanism, not a rescale of it — see estimateGrams() in
  -- src/lib/ingredients.ts. Don't repeat meal_entries' nullable-serving_g
  -- rescale trap by conflating the two.
  unit_grams        jsonb   not null default '{}'::jsonb,  -- {"large":50,"medium":44,"tbsp":8,"tsp":2.7}
  density_g_per_ml  numeric,                               -- optional, volume fallback for liquids

  -- Provenance.
  source      text not null check (source in ('cofid','fdc','merged')),
  source_ref  text,                                        -- CoFID food code / FDC fdcId
  verified    boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint core_ingredients_slug_not_blank check (length(btrim(slug)) > 0)
);

comment on table public.core_ingredients is
  'Curated staple ingredients (CoFID + USDA FDC) for the recipe scanner '
  'resolver. Read-only reference data — app SELECTs only, writes are '
  'service-role via the seed importer script.';

comment on column public.core_ingredients.salt_100g is
  'Derived from sodium at import time: (sodium_mg / 1000) * 2.5. NULL when '
  'sodium was unknown at the source — never coalesced to 0.';

comment on column public.core_ingredients.unit_grams is
  'Count-word / spoon -> grams for THIS ingredient (e.g. {"large":50,'
  '"tbsp":8}). Empty object is a valid, common state: it means grams must '
  'come from the human, not a guess. See estimateGrams().';

create index if not exists core_ingredients_aliases_gin
  on public.core_ingredients using gin (aliases);

create index if not exists core_ingredients_name_trgm
  on public.core_ingredients using gin (display_name gin_trgm_ops);

drop trigger if exists core_ingredients_set_updated_at on public.core_ingredients;
create trigger core_ingredients_set_updated_at
  before update on public.core_ingredients
  for each row execute function public.set_updated_at();


-- ─── RLS ─────────────────────────────────────────────────────────────────
--
-- Reference data: authenticated may SELECT, nobody gets INSERT/UPDATE/
-- DELETE through RLS. Writes happen only via the seed importer's
-- service-role key, which bypasses RLS entirely — deliberately no policy
-- for those verbs, same shape as the WHOOP tables (Edge-Function-only
-- writes) rather than meal_bundles (client writes both).

alter table public.core_ingredients enable row level security;

create policy core_ingredients_select_all on public.core_ingredients
  for select to authenticated using (true);

grant select on public.core_ingredients to authenticated;


-- ============================================================================
-- VERIFICATION — run as `authenticated`, NOT in the SQL editor as postgres.
-- The postgres role bypasses RLS and will cheerfully tell you everything is
-- fine. Run these AFTER the Phase 2 seed importer has populated the table.
-- ============================================================================

-- V1. Salt sanity: nothing absurd, and salt-free items really are salt-free.
--
-- select slug, salt_100g from public.core_ingredients
--   where salt_100g > 10 order by salt_100g desc;

-- V2. NULL preservation — missing nutrients are NULL, not 0.
--
-- select
--   count(*) filter (where fibre_100g is null) as missing_fibre,
--   count(*) filter (where sugar_100g  is null) as missing_sugar,
--   count(*) filter (where salt_100g   is null) as missing_salt,
--   count(*) as total
-- from public.core_ingredients;

-- V3. RLS is on and the read policy exists. Expect 1 row, cmd = SELECT.
--
-- select tablename, policyname, cmd
--   from pg_policies
--  where tablename = 'core_ingredients';

-- V4. RLS actually bites, as `authenticated`:
--
-- select count(*) from public.core_ingredients;              -- expect: succeeds, rows visible
-- insert into public.core_ingredients (slug, display_name, source)
--   values ('test-slug', 'Test', 'merged');                  -- expect: ERROR — row-level security policy violation

-- V5. updated_at actually moves on UPDATE (service role only, since there's
--     no client update policy):
--
-- update public.core_ingredients set verified = true where slug = '<some slug>';
-- select slug, created_at, updated_at from public.core_ingredients where slug = '<some slug>';
--     Expect: updated_at > created_at.
