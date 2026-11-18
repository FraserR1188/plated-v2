-- ============================================================================
-- Verification — 20261025120000_incomplete_nutrients.sql (PL-059)
--
-- Run V1 BEFORE applying the migration. Apply it. Run V2-V6 after. V7
-- (cleanup) is commented out; run it yourself once satisfied.
--
-- Every "Expect" below is PREDICTED unless it says MEASURED. "MEASURED in the
-- rig" lines come from 20261025120000_rig.sh (a throwaway postgres:16-alpine
-- container with stub tables, not the hosted database). "MEASURED 2026-11-18
-- (hosted)" lines are the hosted run; each keeps its original prediction
-- beside it.
-- ============================================================================

-- ── V0. COLUMN INVENTORY — run BEFORE the push ────────────────────────────
-- V1's hash enumerates columns explicitly. This lists what the tables really
-- have, so a column the hash missed is visible rather than silently skipped.
select table_name, string_agg(column_name, ', ' order by ordinal_position) as columns
from information_schema.columns
where table_schema = 'public'
  and table_name in ('meal_entries', 'meal_composition_items')
group by table_name;
-- Expect (PREDICTED) exactly the columns hashed in V1, in some order:
--   meal_entries: id, user_id, date, logged_at, name, brand, source, barcode,
--     off_id, serving_g, meal_type, calories, protein, carbs, fat, sat_fat,
--     salt, fibre, sugar, eaten_at, planned, confirmed_at, skipped_at,
--     image_url, image_path, custom_food_id, eaten_at_estimated
--   meal_composition_items: id, composition_id, user_id, position, name,
--     brand, serving_g, calories, protein, carbs, fat, sat_fat, salt, fibre,
--     sugar, meal_type, eaten_time, barcode, off_id, image_url, image_path,
--     custom_food_id (plus created_at if the table has one)
-- If either list has a column not in V1, add it to V1 AND V2 before going on.
-- MEASURED 2026-11-18 (hosted): live columns match V1's lists exactly —
-- meal_entries 27, meal_composition_items 22.


-- ── V1. PRE-SNAPSHOT — run BEFORE the push ─────────────────────────────────
-- Real tables, not TEMP: they must survive across the before/after sessions.
-- Hashes over the EXISTING columns only, enumerated explicitly, ordered by id.

create table public._diag_inc_pre as
select
  (select count(*) from public.meal_entries)             as me_rows,
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), ''))
     from (select id, user_id, date, logged_at, name, brand, source, barcode,
                  off_id, serving_g, meal_type, calories, protein, carbs, fat,
                  sat_fat, salt, fibre, sugar, eaten_at, planned, confirmed_at,
                  skipped_at, image_url, image_path, custom_food_id,
                  eaten_at_estimated
             from public.meal_entries) t)                as me_hash,
  (select count(*) from public.meal_composition_items)   as mci_rows,
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), ''))
     from (select id, composition_id, user_id, position, name, brand,
                  serving_g, calories, protein, carbs, fat, sat_fat, salt,
                  fibre, sugar, meal_type, eaten_time, barcode, off_id,
                  image_url, image_path, custom_food_id
             from public.meal_composition_items) t)      as mci_hash;

select * from public._diag_inc_pre;


-- ── APPLY THE MIGRATION NOW ────────────────────────────────────────────────


-- ── V2. POST-SNAPSHOT — the same columns, the same order ──────────────────

create table public._diag_inc_post as
select
  (select count(*) from public.meal_entries)             as me_rows,
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), ''))
     from (select id, user_id, date, logged_at, name, brand, source, barcode,
                  off_id, serving_g, meal_type, calories, protein, carbs, fat,
                  sat_fat, salt, fibre, sugar, eaten_at, planned, confirmed_at,
                  skipped_at, image_url, image_path, custom_food_id,
                  eaten_at_estimated
             from public.meal_entries) t)                as me_hash,
  (select count(*) from public.meal_composition_items)   as mci_rows,
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), ''))
     from (select id, composition_id, user_id, position, name, brand,
                  serving_g, calories, protein, carbs, fat, sat_fat, salt,
                  fibre, sugar, meal_type, eaten_time, barcode, off_id,
                  image_url, image_path, custom_food_id
             from public.meal_composition_items) t)      as mci_hash;

select
  pre.me_rows   = post.me_rows   as me_rows_equal,
  pre.me_hash   = post.me_hash   as me_hash_equal,
  pre.mci_rows  = post.mci_rows  as mci_rows_equal,
  pre.mci_hash  = post.mci_hash  as mci_hash_equal
from public._diag_inc_pre pre, public._diag_inc_post post;
-- Expect (PREDICTED): all four true. Run V1/V2 a second time with no
-- migration in between if any is false — a write from the app between the
-- two snapshots also changes the hash, and that is not this migration.
-- MEASURED in the rig (R1): true/true/true/true on 3 + 2 stub rows.
-- MEASURED 2026-11-18 (hosted): pre and post identical —
--   me_rows 2837, me_hash 54a4bc17fce6215622c5e5cd71aeaed8;
--   mci_rows 141, mci_hash cf222d46921e8fcc7b641a771b18d2d4;
--   all four equal = true.


-- ── V3. EVERY EXISTING ROW IS NULL ─────────────────────────────────────────
select
  (select count(*) filter (where incomplete_nutrients is not null)
     from public.meal_entries)           as me_flagged,
  (select count(*) filter (where incomplete_nutrients is not null)
     from public.meal_composition_items) as mci_flagged;
-- Expect (PREDICTED): 0, 0.  MEASURED in the rig (R2): 0, 0.
-- MEASURED 2026-11-18 (hosted): 0, 0.


-- ── V4. SHAPE — column type and the six constraints ────────────────────────
select table_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and column_name = 'incomplete_nutrients'
order by table_name;
-- Expect (PREDICTED): two rows, ARRAY / _text, YES, NULL default.
-- MEASURED 2026-11-18 (hosted): both columns _text, nullable, default NULL.

select conrelid::regclass as tbl, conname, convalidated
from pg_constraint
where conname like '%incomplete_nutrients%'
order by 1, 2;
-- Expect (PREDICTED): six rows (three per table: _nonempty, _small_four,
-- _has_value), convalidated = true on all six.
-- MEASURED 2026-11-18 (hosted): six constraints, all validated.


-- ── V5. SABOTAGE INSERTS — every one must be REFUSED ──────────────────────
-- One DO block. Each insert runs in its own sub-block, so a refusal is
-- caught, its constraint name logged, and the next one still runs. An insert
-- that SUCCEEDS logs FAIL with the RETURNING id.
--
-- The Supabase dashboard does not show RAISE NOTICE output, so the log is
-- built up in v_log and RAISEd as an EXCEPTION at the end. That makes the
-- log the error message the dashboard displays, AND rolls back every insert
-- in the block, the valid row and the sabotage composition included. The
-- "error" is the expected result; read its text.
--
-- Replace <YOUR USER UUID> with your own auth user id (the dashboard runs as
-- a superuser, so RLS is not what's being tested here — the CHECKs are).
do $$
declare
  v_user uuid := '<YOUR USER UUID>';
  v_comp uuid;
  v_id   uuid;
  v_con  text;
  v_log  text := '';
  cases text[][] := array[
    -- label,                 incomplete_nutrients, fibre,  expected constraint suffix
    array['S1 empty array',   '{}',                 '2.0',  'nonempty'],
    array['S2 big-four name', '{protein}',          '2.0',  'small_four'],
    array['S3 listed, NULL',  '{fibre}',            NULL,   'has_value'],
    array['S4 NULL element',  '{NULL}',             '2.0',  'small_four']
  ];
  c text[];
begin
  insert into public.meal_compositions (user_id, name)
  values (v_user, '_diag_inc sabotage bundle')
  returning id into v_comp;

  foreach c slice 1 in array cases loop
    -- meal_entries
    begin
      insert into public.meal_entries
        (user_id, date, logged_at, name, meal_type, source,
         calories, protein, carbs, fat, fibre,
         eaten_at, eaten_at_estimated, incomplete_nutrients)
      values
        (v_user, (now() - interval '1 day')::date, now(), '_diag_inc ' || c[1],
         'lunch', 'batch', 100, 1, 1, 1, c[3]::numeric,
         now() - interval '1 day', false, c[2]::text[])
      returning id into v_id;
      v_log := v_log || format(E'FAIL meal_entries %s: inserted id %s\n', c[1], v_id);
    exception when check_violation then
      get stacked diagnostics v_con = constraint_name;
      v_log := v_log || format(E'%s meal_entries %s: refused by %s\n',
        case when v_con = 'meal_entries_incomplete_nutrients_' || c[4]
             then 'PASS' else 'WRONG-CONSTRAINT' end,
        c[1], v_con);
    end;

    -- meal_composition_items (a bundle item: meal_type + eaten_time required)
    begin
      insert into public.meal_composition_items
        (composition_id, user_id, position, name,
         calories, protein, carbs, fat, fibre,
         meal_type, eaten_time, incomplete_nutrients)
      values
        (v_comp, v_user, 0, '_diag_inc ' || c[1],
         100, 1, 1, 1, c[3]::numeric,
         'lunch', '12:00', c[2]::text[])
      returning id into v_id;
      v_log := v_log || format(E'FAIL meal_composition_items %s: inserted id %s\n', c[1], v_id);
    exception when check_violation then
      get stacked diagnostics v_con = constraint_name;
      v_log := v_log || format(E'%s meal_composition_items %s: refused by %s\n',
        case when v_con = 'meal_composition_items_incomplete_nutrients_' || c[4]
             then 'PASS' else 'WRONG-CONSTRAINT' end,
        c[1], v_con);
    end;
  end loop;

  -- Non-vacuity: a VALID flagged row must be ACCEPTED, or the four refusals
  -- above prove nothing (a constraint that refuses everything also "passes").
  insert into public.meal_entries
    (user_id, date, logged_at, name, meal_type, source,
     calories, protein, carbs, fat, salt, fibre,
     eaten_at, eaten_at_estimated, incomplete_nutrients)
  values
    (v_user, (now() - interval '1 day')::date, now(), '_diag_inc valid',
     'lunch', 'batch', 100, 1, 1, 1, 0.4, 2.0,
     now() - interval '1 day', false, '{salt,fibre}')
  returning id into v_id;
  v_log := v_log || format(E'PASS valid {salt,fibre} row accepted, id %s\n', v_id);

  raise exception E'V5 log (raised on purpose: shows in the dashboard and rolls back):\n%', v_log;
end $$;

-- Leftover check — run separately, after the block above. The RAISE rolled
-- everything back, so nothing named _diag_inc may remain.
select
  (select count(*) from public.meal_entries
    where left(name, 9) = '_diag_inc')            as me_leftover,
  (select count(*) from public.meal_composition_items
    where left(name, 9) = '_diag_inc')            as mci_leftover;
-- Expect: 0, 0.  MEASURED 2026-11-18 (hosted): 0, 0.

-- Expect (PREDICTED): 8 PASS lines (S1-S4 × two tables) naming the expected
-- constraint, then "PASS valid {salt,fibre} row accepted". No FAIL, no
-- WRONG-CONSTRAINT. MEASURED in the rig (R3): exactly that, on stub tables.
-- MEASURED 2026-11-18 (hosted, the RAISE version above): 8 PASS on the
-- expected constraint, then the valid {salt,fibre} row accepted; leftover
-- check 0/0.
-- MEASURED sabotage (rig variants, each constraint dropped on both tables):
--   drop _nonempty   -> S1 FAIL on both tables, everything else PASS
--   drop _small_four -> S2 and S4 FAIL on both tables, everything else PASS
--   drop _has_value  -> S3 FAIL on both tables, everything else PASS
-- So each constraint is the only thing standing between its case and the
-- table — none of the four refusals is accidental cover from another one.


-- ── V6. RLS — two accounts, every view that touches meal_entries ──────────
-- Policies are unchanged; this proves the new column didn't open anything
-- and that a follower can read it exactly where they can read the row.
-- Views reading meal_entries (pg_depend, V6a): whoop_cycle_nutrition,
-- whoop_unassigned_meals, saved_ingredients_scored, and whoop_correlation
-- through whoop_cycle_nutrition.

-- V6a. The dependency list, so the four names below aren't taken on trust.
select distinct v.relname as view_name
from pg_depend d
join pg_rewrite r on r.oid = d.objid
join pg_class v   on v.oid = r.ev_class
join pg_class t   on t.oid = d.refobjid
where t.relname = 'meal_entries' and t.relnamespace = 'public'::regnamespace
  and v.oid <> t.oid
order by 1;
-- Expect (PREDICTED): saved_ingredients_scored, whoop_cycle_nutrition,
-- whoop_unassigned_meals. (whoop_correlation depends on whoop_cycle_nutrition,
-- not on meal_entries directly.) If any other view appears, add it to V6b.

-- V6b. As user A, then as user B — one DO block each. Replace each UUID.
-- set_config(..., true) and SET LOCAL ROLE are transaction-local, and the
-- final RAISE (the dashboard does not show NOTICEs) rolls them back, so the
-- session is left as it was. own_entries / wcn_own are non-vacuity: they
-- prove the role switch took and RLS is returning that user's own rows.
-- Every "foreign" count must be 0.
do $$
declare
  v_me  uuid := '<USER A UUID>';
  n_own_entries bigint; n_ff bigint; n_wcn_own bigint;
  n_wcn_foreign bigint; n_wc_foreign bigint; n_wum_foreign bigint; n_sis_foreign bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_me)::text, true);
  set local role authenticated;

  select count(*) into n_own_entries from public.meal_entries where user_id = v_me;
  select count(*) into n_ff from public.meal_entries
    where user_id <> v_me and incomplete_nutrients is not null;
  select count(*) into n_wcn_own from public.whoop_cycle_nutrition where user_id = v_me;
  select count(*) into n_wcn_foreign from public.whoop_cycle_nutrition where user_id <> v_me;
  select count(*) into n_wc_foreign from public.whoop_correlation where user_id <> v_me;
  select count(*) into n_wum_foreign from public.whoop_unassigned_meals where user_id <> v_me;
  select count(*) into n_sis_foreign from public.saved_ingredients_scored where user_id <> v_me;

  raise exception 'V6b user A: own_entries %, wcn_own % | foreign_flagged_visible %, wcn_foreign %, wc_foreign %, wum_foreign %, sis_foreign %',
    n_own_entries, n_wcn_own, n_ff, n_wcn_foreign, n_wc_foreign, n_wum_foreign, n_sis_foreign;
end $$;

do $$
declare
  v_me  uuid := '<USER B UUID>';
  n_own_entries bigint; n_ff bigint; n_wcn_own bigint;
  n_wcn_foreign bigint; n_wc_foreign bigint; n_wum_foreign bigint; n_sis_foreign bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_me)::text, true);
  set local role authenticated;

  select count(*) into n_own_entries from public.meal_entries where user_id = v_me;
  select count(*) into n_ff from public.meal_entries
    where user_id <> v_me and incomplete_nutrients is not null;
  select count(*) into n_wcn_own from public.whoop_cycle_nutrition where user_id = v_me;
  select count(*) into n_wcn_foreign from public.whoop_cycle_nutrition where user_id <> v_me;
  select count(*) into n_wc_foreign from public.whoop_correlation where user_id <> v_me;
  select count(*) into n_wum_foreign from public.whoop_unassigned_meals where user_id <> v_me;
  select count(*) into n_sis_foreign from public.saved_ingredients_scored where user_id <> v_me;

  raise exception 'V6b user B: own_entries %, wcn_own % | foreign_flagged_visible %, wcn_foreign %, wc_foreign %, wum_foreign %, sis_foreign %',
    n_own_entries, n_wcn_own, n_ff, n_wcn_foreign, n_wc_foreign, n_wum_foreign, n_sis_foreign;
end $$;
-- Expect (PREDICTED) for each user: foreign_flagged_visible 0 (no row is
-- flagged yet, and a follower's rows are gated by the unchanged follower
-- policy anyway); wcn_users <= 1; wcn_foreign, wc_foreign, wum_foreign,
-- sis_foreign all 0.
-- MEASURED 2026-11-18 (hosted, the DO-block version above):
--   A: own_entries 1475, wcn_own 129, every foreign count 0.
--   B: own_entries 42,   wcn_own 200, every foreign count 0.


-- ── V7. CLEANUP — run yourself once satisfied ──────────────────────────────
-- drop table public._diag_inc_pre;
-- drop table public._diag_inc_post;
