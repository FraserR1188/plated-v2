begin;

-- ============================================================================
-- PL-028 DATA REPAIR — REAL RUN (BEGIN ... COMMIT)
--
-- Byte-identical to the dry run that was reviewed and approved, except
-- for this header and the final COMMIT. Approved by Robbie 2026-09-20.
--
-- Writes to two accounts only, both Robbie's: a8435663 (main)
-- and 4dbf04ae (test). Measured, not assumed --
-- every matched row was attributed by user_id before this ran.
--
-- Scope, per product:
--   Chia Seeds  (5060731352170) -> the user's own label, 437 kcal/100 g with
--                                 Sig 1 macros. Both accounts.
--   cucumber    (5010251733911) -> Open Food Facts, re-fetched by barcode.
--   Bio&me bar  (5060853641220) -> Open Food Facts, re-fetched by barcode.
--   Brown onions(20699321)      -> NO DATA CHANGE. Nothing to repair from.
--   Salt items                  -> NO DATA CHANGE. Genuinely 0 kcal.
--
-- salt stays NULL for chia throughout: it was never known, and writing 0
-- there is the exact defect this repair exists to undo.
-- ============================================================================


-- ── 0. Backup. Every row this run could touch, with its OLD values ─────────
--
-- Created before anything is read for update, so a re-run against a
-- half-applied state still has the originals. The table is deliberately
-- plain and over-wide: recovery matters more than tidiness.

create table if not exists public.pl028_repair_backup (
  backed_up_at  timestamptz not null default now(),
  source_table  text        not null,
  row_id        text        not null,
  user_id       uuid,
  name          text,
  barcode       text,
  serving_g     numeric,
  calories      numeric,
  protein       numeric,
  carbs         numeric,
  fat           numeric,
  sat_fat       numeric,
  salt          numeric,
  fibre         numeric,
  sugar         numeric
);

insert into public.pl028_repair_backup
  (source_table, row_id, user_id, name, barcode, serving_g,
   calories, protein, carbs, fat, sat_fat, salt, fibre, sugar)
select 'meal_entries', id::text, user_id, name, barcode, serving_g,
       calories, protein, carbs, fat, sat_fat, salt, fibre, sugar
from public.meal_entries
where barcode in ('5060731352170','5010251733911','5060853641220')
  and calories = 0 and protein = 0 and carbs = 0 and fat = 0;

insert into public.pl028_repair_backup
  (source_table, row_id, user_id, name, barcode, serving_g,
   calories, protein, carbs, fat, sat_fat, salt, fibre, sugar)
select 'saved_ingredients', id::text, user_id, name, barcode, null,
       cal_per100, protein_per100, carbs_per100, fat_per100,
       sat_fat_per100, salt_per100, fibre_per100, sugar_per100
from public.saved_ingredients
where barcode in ('5060731352170','5010251733911','5060853641220');

insert into public.pl028_repair_backup
  (source_table, row_id, user_id, name, barcode, serving_g,
   calories, protein, carbs, fat, sat_fat, salt, fibre, sugar)
select 'meal_composition_items', i.id::text, c.user_id, i.name, i.barcode,
       i.serving_g, i.calories, i.protein, i.carbs, i.fat,
       i.sat_fat, i.salt, i.fibre, i.sugar
from public.meal_composition_items i
join public.meal_compositions c on c.id = i.composition_id
where i.barcode = '5060731352170';


-- ── 1. The repair sources, stated once ────────────────────────────────────
--
-- Per 100 g. Chia: calories from the packet (437), macros from Sig 1 -- see
-- the PL-028 record for why Sig 2 was rejected. Cucumber and the bar:
-- Open Food Facts, re-fetched by barcode 2026-09-20 (8 of 8 keys present).

create temporary table pl028_source (
  barcode        text primary key,
  cal_per100     numeric,
  protein_per100 numeric,
  carbs_per100   numeric,
  fat_per100     numeric,
  sat_fat_per100 numeric,
  salt_per100    numeric,   -- NULL means "leave the column as it is"
  fibre_per100   numeric,
  sugar_per100   numeric
) on commit drop;

insert into pl028_source values
  -- Chia Seeds (AKSOY). salt NULL: never known, and a 0 would be the defect.
  ('5060731352170', 437, 21.9,  6.9,  28.6, 3.3,  null, 31.3, 0.8),
  -- cucumber (Sainsbury's), from OFF.
  ('5010251733911',  52,  2.13, 8.47,  0.37, 0.12, 0.04,  2.0, 5.57),
  -- Fibre & Protein Bar (Bio & me), from OFF.
  ('5060853641220', 365, 23.0, 34.0,  11.0, 2.1,  0.58, 19.0, 12.9);


-- ── 3. The updates ────────────────────────────────────────────────────────
--
-- Scaled by serving_g/100 at 4dp. NOT rounded to display precision: the
-- app stores cal_per100 * f UNROUNDED (ProductScreen :528-539) and only the
-- preview rounds, so a repaired row must be shaped like a logged one.
-- 4dp is below any display precision and keeps float artifacts out.

update public.meal_entries e
set calories = round(s.cal_per100     * e.serving_g / 100, 4),
    protein  = round(s.protein_per100 * e.serving_g / 100, 4),
    carbs    = round(s.carbs_per100   * e.serving_g / 100, 4),
    fat      = round(s.fat_per100     * e.serving_g / 100, 4),
    sat_fat  = round(s.sat_fat_per100 * e.serving_g / 100, 4),
    fibre    = round(s.fibre_per100   * e.serving_g / 100, 4),
    sugar    = round(s.sugar_per100   * e.serving_g / 100, 4),
    -- Explicitly NULL where the source has no salt figure. The zeroed
    -- rows hold salt = 0 from the pre-PL-002 coercion, so "leave it as it
    -- is" would preserve the very defect being repaired.
    salt     = case when s.salt_per100 is null then null
                    else round(s.salt_per100 * e.serving_g / 100, 4) end
from pl028_source s
where e.barcode = s.barcode
  and e.calories = 0 and e.protein = 0 and e.carbs = 0 and e.fat = 0;

update public.saved_ingredients l
set cal_per100     = s.cal_per100,
    protein_per100 = s.protein_per100,
    carbs_per100   = s.carbs_per100,
    fat_per100     = s.fat_per100,
    sat_fat_per100 = s.sat_fat_per100,
    fibre_per100   = s.fibre_per100,
    sugar_per100   = s.sugar_per100,
    salt_per100    = s.salt_per100   -- NULL for chia, by design
from pl028_source s
where l.barcode = s.barcode
  -- Only the zeroed rows. A second chia library row already holds the
  -- correct 437 and must not be rewritten by this repair.
  and l.cal_per100 = 0 and l.protein_per100 = 0
  and l.carbs_per100 = 0 and l.fat_per100 = 0;

-- The chia bundle items: the all-zero one in "Ultimate Yogurt Breakfast"
-- AND the 42.70 one in "New Breaky", which is Sig 1 and reads energy low.
update public.meal_composition_items i
set calories = round(s.cal_per100     * i.serving_g / 100, 4),
    protein  = round(s.protein_per100 * i.serving_g / 100, 4),
    carbs    = round(s.carbs_per100   * i.serving_g / 100, 4),
    fat      = round(s.fat_per100     * i.serving_g / 100, 4),
    sat_fat  = round(s.sat_fat_per100 * i.serving_g / 100, 4),
    fibre    = round(s.fibre_per100   * i.serving_g / 100, 4),
    sugar    = round(s.sugar_per100   * i.serving_g / 100, 4),
    salt     = case when s.salt_per100 is null then null
                    else round(s.salt_per100 * i.serving_g / 100, 4) end
from pl028_source s
where i.barcode = s.barcode
  and i.barcode = '5060731352170';


select jsonb_pretty(jsonb_build_object(
 'A_before_by_account', (select jsonb_agg(to_jsonb(q)) from (
    select left(b.user_id::text,8) as account, b.name, count(*) as zeroed_rows
    from public.pl028_repair_backup b where b.source_table='meal_entries'
    group by 1,2 order by 2,1) q),
 'B_entries_diff', (select jsonb_agg(to_jsonb(q)) from (
    select left(b.user_id::text,8) as acct, b.name, b.serving_g::float as g,
           b.calories::float as old_kcal, e.calories::float as new_kcal,
           b.fat::float as old_fat, e.fat::float as new_fat,
           b.fibre::float as old_fib, e.fibre::float as new_fib,
           b.salt as old_salt, e.salt as new_salt, count(*) over () as n
    from public.pl028_repair_backup b join public.meal_entries e on e.id::text=b.row_id
    where b.source_table='meal_entries'
    group by b.user_id,b.name,b.serving_g,b.calories,e.calories,b.fat,e.fat,b.fibre,e.fibre,b.salt,e.salt
    order by 2,1) q),
 'C_library_diff', (select jsonb_agg(to_jsonb(q)) from (
    select b.name, b.calories::float as old_cal100, l.cal_per100::float as new_cal100,
           b.salt as old_salt100, l.salt_per100 as new_salt100
    from public.pl028_repair_backup b join public.saved_ingredients l on l.id::text=b.row_id
    where b.source_table='saved_ingredients' order by 1) q),
 'D_bundle_items_diff', (select jsonb_agg(to_jsonb(q)) from (
    select b.name, b.serving_g::float as g, b.calories::float as old_kcal,
           i.calories::float as new_kcal, b.fibre::float as old_fib, i.fibre::float as new_fib
    from public.pl028_repair_backup b join public.meal_composition_items i on i.id::text=b.row_id
    where b.source_table='meal_composition_items' order by 1) q),
 'E_checks', (select to_jsonb(q) from (
    select (select count(*) from public.meal_entries where barcode in ('5060731352170','5010251733911','5060853641220') and calories=0 and protein=0 and carbs=0 and fat=0) as zeroed_left,
           (select count(*) filter (where salt is null) from public.meal_entries where barcode='5060731352170') as chia_salt_null,
           (select count(*) filter (where salt is not null) from public.meal_entries where barcode='5060731352170') as chia_salt_written,
           (select count(*) from public.meal_composition_items where name='Salt' and calories=0) as salt_items_untouched,
           (select count(*) from public.meal_composition_items where barcode='20699321' and calories=0) as onion_items_untouched,
           (select count(*) from public.pl028_repair_backup) as backup_rows) q)
)) as results;

commit;
