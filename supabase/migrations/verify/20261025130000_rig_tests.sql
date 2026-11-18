-- ============================================================================
-- Fixture checks for 20261025130000_whoop_cycle_nutrition_incomplete_known.sql
-- Run by 20261025130000_rig.sh after the migration (and any sabotage) is
-- applied. Each check prints PASS or FAIL via rig.check().
--
-- Fixture (seeded by the rig, user A unless noted; every cycle closed so
-- effective_end = cycle_end and nothing is now()-dependent):
--   C1  m1 fibre 5,  salt 0.5, sugar 0, sat_fat NULL, not flagged
--       m2 fibre 3,  salt 0.2, sugar 4, sat_fat NULL, flagged {fibre,sugar}
--       m3 fibre NULL, salt NULL, sugar NULL, sat_fat NULL
--       m4 PLANNED, unconfirmed, fibre 10, flagged {} -> excluded by the gate
--   C2  m5 everything known, not flagged
--   C3  no meals
--   B1  user B, one flagged meal
-- ============================================================================

-- F1. THE FIX: a lower bound is not counted as known.
select rig.check('F1 C1 fibre_known_meals = 1 (m1 only; m2 is a lower bound)',
  fibre_known_meals = 1, format('got %s', fibre_known_meals))
from public.whoop_cycle_nutrition where cycle_id = 'C1';

select rig.check('F1b C1 sugar_known_meals = 1 (m1''s real 0; m2 flagged)',
  sugar_known_meals = 1, format('got %s', sugar_known_meals))
from public.whoop_cycle_nutrition where cycle_id = 'C1';

-- F2. Sums unchanged: a lower bound still contributes its known part.
select rig.check('F2 C1 sums: fibre 8, salt 0.7, sugar 4, sat_fat NULL',
  fibre = 8 and salt = 0.7 and sugar = 4 and sat_fat is null,
  format('fibre %s salt %s sugar %s sat_fat %s', fibre, salt, sugar, sat_fat))
from public.whoop_cycle_nutrition where cycle_id = 'C1';

-- F3. Unflagged nutrients count exactly as count(m.x) always did.
select rig.check('F3 C1 salt_known_meals = 2, sat_fat_known_meals = 0',
  salt_known_meals = 2 and sat_fat_known_meals = 0,
  format('salt %s sat_fat %s', salt_known_meals, sat_fat_known_meals))
from public.whoop_cycle_nutrition where cycle_id = 'C1';

-- F4. The gate still excludes the unconfirmed plan; meal_count unchanged.
select rig.check('F4 C1 meal_count = 3 (m4 planned, excluded)',
  meal_count = 3, format('got %s', meal_count))
from public.whoop_cycle_nutrition where cycle_id = 'C1';

-- F5. LEFT JOIN preserved: a zero-meal cycle is still a row.
select rig.check('F5 C3 present, meal_count 0, all known 0',
  count(*) = 1 and bool_and(meal_count = 0 and fibre_known_meals = 0
                            and salt_known_meals = 0 and sugar_known_meals = 0
                            and sat_fat_known_meals = 0),
  format('rows %s', count(*)))
from public.whoop_cycle_nutrition where cycle_id = 'C3';

-- F6. whoop_correlation picks the new counts up with no change of its own:
-- same cycle on C1, and lagged (C1 -> C2's *_prev_cycle).
select rig.check('F6 correlation C1 fibre_known_meals_same_cycle = 1',
  fibre_known_meals_same_cycle = 1, format('got %s', fibre_known_meals_same_cycle))
from public.whoop_correlation where cycle_id = 'C1';

select rig.check('F6b correlation C2 fibre/sugar_known_meals_prev_cycle = 1, same_cycle = 1',
  fibre_known_meals_prev_cycle = 1 and sugar_known_meals_prev_cycle = 1
    and fibre_known_meals_same_cycle = 1,
  format('fibre prev %s sugar prev %s fibre same %s',
         fibre_known_meals_prev_cycle, sugar_known_meals_prev_cycle,
         fibre_known_meals_same_cycle))
from public.whoop_correlation where cycle_id = 'C2';

-- F7. Parity: with no flags on any row (every pre-release row), the new view
-- is row-for-row identical to the OLD view's snapshot (taken by the rig
-- before the migration, with every flag cleared). Both directions.
begin;
update public.meal_entries set incomplete_nutrients = null;
select rig.check('F7 unflagged data: new view = old view, every column, both directions',
  not exists (select * from rig.old_wcn except select * from public.whoop_cycle_nutrition)
  and not exists (select * from public.whoop_cycle_nutrition except select * from rig.old_wcn),
  format('old %s rows, new %s rows',
         (select count(*) from rig.old_wcn),
         (select count(*) from public.whoop_cycle_nutrition)));
rollback;

-- F8. security_invoker restated.
select rig.check('F8 reloptions security_invoker=on',
  coalesce('security_invoker=on' = any (reloptions), false),
  format('reloptions %s', reloptions))
from pg_class where relname = 'whoop_cycle_nutrition' and relnamespace = 'public'::regnamespace;

-- F9. RLS through both views, as user A then user B.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a"}';
select rig.check('F9 as A: own 3 cycles in whoop_cycle_nutrition, 0 of B''s',
  (select count(*) from public.whoop_cycle_nutrition) = 3
  and (select count(*) from public.whoop_cycle_nutrition
        where user_id <> 'aaaaaaaa-0000-4000-8000-00000000000a') = 0,
  format('visible %s', (select count(*) from public.whoop_cycle_nutrition)));
select rig.check('F9b as A: 0 of B''s rows in whoop_correlation',
  (select count(*) from public.whoop_correlation
    where user_id <> 'aaaaaaaa-0000-4000-8000-00000000000a') = 0,
  format('foreign %s', (select count(*) from public.whoop_correlation
    where user_id <> 'aaaaaaaa-0000-4000-8000-00000000000a')));
rollback;

begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-00000000000b"}';
select rig.check('F9c as B: own 1 cycle with fibre_known_meals 0 (flagged), 0 of A''s',
  (select count(*) from public.whoop_cycle_nutrition) = 1
  and (select fibre_known_meals from public.whoop_cycle_nutrition) = 0,
  format('visible %s', (select count(*) from public.whoop_cycle_nutrition)));
rollback;
