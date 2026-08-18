-- V0: RUN THIS BEFORE APPLYING. Keep the numbers.
select count(*) as total,
       count(sat_fat) as sat_fat_present,
       count(salt)    as salt_present,
       count(fibre)   as fibre_present,
       count(sugar)   as sugar_present
from public.meal_entries;

-- V1: after apply. All eight rows must read YES / null.
select table_name, column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('meal_entries', 'meal_composition_items')
  and column_name in ('sat_fat', 'salt', 'fibre', 'sugar')
order by table_name, column_name;

-- V2: big four untouched. All eight rows must read NO / 0.
select table_name, column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('meal_entries', 'meal_composition_items')
  and column_name in ('calories', 'protein', 'carbs', 'fat')
order by table_name, column_name;

-- V3: no rows harmed. Must match V0 exactly. DROP DEFAULT touches no existing
-- row, so any movement means something else ran.
select count(*) as total,
       count(sat_fat) as sat_fat_present,
       count(salt)    as salt_present,
       count(fibre)   as fibre_present,
       count(sugar)   as sugar_present
from public.meal_entries;
