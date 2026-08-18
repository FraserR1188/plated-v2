-- ============================================================================
-- core_ingredients — post-seed verification suite
--
-- Run AFTER the real import (npx tsx scripts/seedCoreIngredients.ts --cofid <real.csv>),
-- against the Supabase SQL editor or psql. Read-only; safe to run repeatedly.
--
-- Reading order matters: Q1 tells you WHAT is missing, Q3 tells you WHY.
-- A core-four miss + a source that shows CoFID never matched = name-match miss,
-- not a genuine data gap. Chase those before accepting anything as "just missing".
-- ============================================================================


-- 0. Row count vs the seed list ----------------------------------------------
-- Expected: 189 (matches SEED_STAPLES). Fewer => the importer dropped whole rows
-- on total miss rather than inserting a NULL-macro row. Note which behaviour it is;
-- it changes how you read Q1 (absent row vs present-but-NULL row).
select count(*) as total_rows from public.core_ingredients;   -- expect 189


-- 1. Core-four NULL audit — the "invisible to the staple tier" list -----------
-- calories/protein/carbs/fat are NOT NULL everywhere else in the app, so a staple
-- missing any of them cannot become a FoodProduct and falls through to OFF.
-- This is the list to eyeball BY NAME. Include source/source_ref so you can tell
-- a CoFID name-match miss from a real gap in one pass.
select
  slug,
  display_name,
  source,
  source_ref,
  (kcal_100g    is null) as kcal_missing,
  (protein_100g is null) as protein_missing,
  (carbs_100g   is null) as carbs_missing,
  (fat_100g     is null) as fat_missing
from public.core_ingredients
where kcal_100g is null
   or protein_100g is null
   or carbs_100g is null
   or fat_100g is null
order by display_name;
-- If a COMMON ingredient is here and 'source' shows CoFID didn't contribute,
-- suspect the inverted-naming match, not the data. If it's an obscure tail item, shrug.


-- 2. Head-staple alarm — these should NEVER miss the core four -----------------
-- Head staples are exactly the rows with seeded unit_grams (non-empty jsonb).
-- They're the common, well-documented ingredients; any miss here is a red flag.
select slug, display_name, source, kcal_100g, protein_100g, carbs_100g, fat_100g
from public.core_ingredients
where unit_grams <> '{}'::jsonb
  and (kcal_100g is null or protein_100g is null or carbs_100g is null or fat_100g is null);
-- EXPECT: 0 rows. Any row => investigate that staple's CoFID name match first.


-- 3. Source provenance breakdown — the name-match discriminator ----------------
select source, count(*) as n
from public.core_ingredients
group by source
order by n desc;
-- CoFID is primary: expect most rows 'cofid' or 'merged'.
-- A large 'fdc'-only share => CoFID name-matching is missing rows broadly
-- (the inverted "Category, descriptor" naming problem), NOT FDC doing its job well.


-- 4a. Sodium survival — salt NULL rate ----------------------------------------
-- CoFID carries sodium for essentially all foods, and salt is derived from it.
-- So salt_100g NULL should be a small handful at most.
select
  count(*) filter (where salt_100g is null) as salt_null,
  count(*) as total
from public.core_ingredients;
-- Many NULLs => the Inorganics sheet (where sodium lives) didn't survive the
-- flatten into the CSV, so toSaltG() had nothing to run on. This is the specific
-- failure mode to guard: sodium is a separate sheet from the Proximates macros.


-- 4b. Salt magnitude — reference spot-check + conversion-error signatures ------
select slug, display_name, salt_100g
from public.core_ingredients
where slug in ('whole-milk','cheddar','butter','table-salt','soy-sauce')
order by salt_100g nulls first;
-- Order-of-magnitude sanity (exact figures vary by CoFID entry — check the shape, not the decimal):
--   whole-milk ~0.1 g   cheddar ~1.5–1.9 g   butter (salted) ~1.5–1.8 g
--   table-salt ~90–100 g   soy-sauce single-digit g
--
-- Failure signatures — each points at a specific broken step:
--   ~2.5x too low   (e.g. milk ~0.04)      => the x2.5 sodium->salt step was skipped
--   ~1000x too high (e.g. milk ~40–110)    => mg->g (/1000) was skipped
--   NULL where a value is expected         => sodium dropped in the flatten (see 4a)

-- broad outlier catch for the same conversion errors across all rows:
select slug, display_name, salt_100g
from public.core_ingredients
where salt_100g > 5
order by salt_100g desc;
-- Legitimately high: table-salt (~100), stock cubes, yeast extract, soy sauce.
-- If ordinary foods (milk, flour, plain veg) show large numbers here => mg->g missing.


-- 5. Zero-collapse guard — the ?? 0 bug this project keeps stamping out --------
select slug, display_name, source, kcal_100g, protein_100g, carbs_100g, fat_100g
from public.core_ingredients
where kcal_100g = 0
order by display_name;
-- kcal exactly 0 is implausible for virtually every staple in the list => smoking
-- gun for a NULL silently coalesced to 0 on write. EXPECT: 0 rows.
-- (protein/carbs/fat = 0 can be legitimate — oils have 0 carbs, sugar 0 protein —
--  so those are NOT alarms on their own.)


-- 6. Informational — coverage on the legitimately-nullable four ---------------
select
  count(*) filter (where satfat_100g is null) as satfat_null,
  count(*) filter (where sugar_100g  is null) as sugar_null,
  count(*) filter (where fibre_100g  is null) as fibre_null,
  count(*) filter (where salt_100g   is null) as salt_null,
  count(*) as total
from public.core_ingredients;
-- These four are nullable by design; some NULLs are expected and CORRECT — not a bug.
-- One thing to glance at: if fibre_null is suspiciously high, it can hint the AOAC
-- fibre column wasn't the one picked up (Englyst column matched instead, or neither).
