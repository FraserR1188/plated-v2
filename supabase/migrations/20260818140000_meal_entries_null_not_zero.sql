-- NULL-not-zero, phase 4: meal_entries and meal_composition_items.
--
-- Companion to 20260814100000_custom_foods_null_not_zero.sql, which did the
-- same for custom_foods. This closes the loop on the two tables that feed the
-- WHOOP nutrition-biometric correlation.
--
-- WHY THE DEFAULT EXISTS: sat_fat/salt/fibre/sugar sit after meal_type and
-- brand in ordinal position, i.e. they were added by a later ALTER TABLE ADD
-- COLUMN. DEFAULT 0 was there to backfill existing rows at that moment. That
-- purpose expired long ago; what remains is a footgun where an omitted key
-- fabricates a zero at the DB layer.
--
-- SAFE TO DROP: both meal_entries insert sites pass all four explicitly
-- (src/lib/entries.ts applyEntries, src/store/useStore.ts addEntry), verified
-- by independent grep, not by trusting the AST-walk test. No third insert
-- site exists. The composition-apply path (draftsFromComposition) terminates
-- at applyEntries.
--
-- meal_composition_items is included because 20260713120000_meal_bundles.sql
-- documents it as mirroring meal_entries column-for-column INCLUDING
-- nullability, and because draftsFromComposition() passes its values straight
-- through into meal_entries -- a fabricated zero there becomes a real number
-- downstream and passes every guard.
--
-- NO BACKFILL. Pre-existing zeros are ambiguous and stay ambiguous, on the
-- same rationale ratified in 20260814100000 lines 30-37. A fabricated 0 and a
-- genuine 0 are byte-identical; neither table carries updated_at, so no
-- forensic reconstruction is possible. Sizing query returned 0 rows on
-- 2026-08-18 -- this migration is preventive, not remedial.
--
-- OUT OF SCOPE: calories/protein/carbs/fat remain NOT NULL DEFAULT 0 on both
-- tables. Same defect shape, far larger blast radius, already ratified as
-- deferred in 20260814100000 lines 22-28.
--
-- NO RLS SURFACE TOUCHED: no policy, view, or security_invoker change, so no
-- second-account check is performed. Stated explicitly so its absence is not
-- read as an omission.

alter table public.meal_entries alter column sat_fat drop default;
alter table public.meal_entries alter column salt    drop default;
alter table public.meal_entries alter column fibre   drop default;
alter table public.meal_entries alter column sugar   drop default;

alter table public.meal_composition_items alter column sat_fat drop default;
alter table public.meal_composition_items alter column salt    drop default;
alter table public.meal_composition_items alter column fibre   drop default;
alter table public.meal_composition_items alter column sugar   drop default;
