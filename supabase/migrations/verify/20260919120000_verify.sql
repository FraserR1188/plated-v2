-- ============================================================================
-- Verification for 20260919120000_saved_ingredients_null_not_zero.sql
--
-- ORDER:
--   BEFORE the push   V1 (snapshot) → V3, V4 (baseline) → V0 (pre-flight)
--                     → V1 again (must equal the first V1: V0 left nothing)
--   push              npx supabase db push
--   AFTER the push    V1 (must equal BEFORE) → V2 → V3 → V4 → V5
--
-- The dashboard SQL editor runs as a superuser and BYPASSES RLS: V0–V3 and
-- V1's counts are table-wide on purpose. V4 and V5 switch to an
-- authenticated session with a real JWT claim — the only way to test RLS.
-- Run each numbered block on its own (the editor shows only the last
-- result). Every block is read-only or rolls itself back.
-- ============================================================================


-- ── V0. PRE-FLIGHT: does the LIVE CHECK accept NULL? (before the push) ──────
-- Drops NOT NULL, writes NULL to all four small macros on one REAL row, then
-- ALWAYS raises — so the whole DO statement, ALTER included, is rolled back
-- and nothing is kept. The result is therefore ALWAYS an ERROR; read its
-- message. Holds an ACCESS EXCLUSIVE lock on saved_ingredients for a few ms.
do $$
declare
  touched int;
begin
  alter table public.saved_ingredients
    alter column sat_fat_per100 drop not null,
    alter column salt_per100    drop not null,
    alter column fibre_per100   drop not null,
    alter column sugar_per100   drop not null;

  update public.saved_ingredients
     set sat_fat_per100 = null,
         salt_per100    = null,
         fibre_per100   = null,
         sugar_per100   = null
   where id = (select id from public.saved_ingredients order by id limit 1);
  get diagnostics touched = row_count;

  if touched <> 1 then
    raise exception 'PREFLIGHT INCONCLUSIVE — % rows probed (expected 1). Rolled back; nothing changed.', touched;
  end if;
  raise exception 'PREFLIGHT PASS — the live CHECK accepted NULL on a real row. Rolled back; nothing changed.';
exception
  when check_violation then
    raise exception 'PREFLIGHT FAIL — %. The live CHECK rejects NULL. Rolled back; nothing changed. DO NOT PUSH.', sqlerrm;
end $$;
-- PREDICTED: ERROR: PREFLIGHT PASS — ...
-- MEASURED: (fill in)


-- ── V1. SNAPSHOT — run BEFORE and AFTER; the two must be identical ─────────
-- Every column enumerated explicitly (no SELECT *). content_hash covers every
-- value of every row; the migration is schema-only, so it must not move.
-- NULL is rendered as a token so a NULL can't be confused with '' or shift
-- fields.
select
  count(*)                                    as total_rows,
  count(distinct user_id)                     as users,
  count(sat_fat_per100)                       as sat_fat_nonnull,
  count(salt_per100)                          as salt_nonnull,
  count(fibre_per100)                         as fibre_nonnull,
  count(sugar_per100)                         as sugar_nonnull,
  count(*) filter (where sat_fat_per100 = 0)  as sat_fat_zero,
  count(*) filter (where salt_per100 = 0)     as salt_zero,
  count(*) filter (where fibre_per100 = 0)    as fibre_zero,
  count(*) filter (where sugar_per100 = 0)    as sugar_zero,
  count(*) filter (where sat_fat_per100 = 0 and salt_per100 = 0
                     and fibre_per100 = 0 and sugar_per100 = 0) as all_four_zero,
  md5(string_agg(
    concat_ws('|',
      id::text, user_id::text, name,
      coalesce(brand, '<null>'),
      cal_per100::text, protein_per100::text, carbs_per100::text, fat_per100::text,
      coalesce(sat_fat_per100::text, '<null>'),
      coalesce(salt_per100::text,    '<null>'),
      coalesce(fibre_per100::text,   '<null>'),
      coalesce(sugar_per100::text,   '<null>'),
      coalesce(barcode, '<null>'),
      coalesce(off_id,  '<null>'),
      use_count::text,
      created_at::text),
    E'\n' order by id))                       as content_hash
from public.saved_ingredients;
-- PREDICTED (both runs): total_rows 378; *_nonnull 378 each; zeros
-- 32 / 48 / 63 / 32; all_four_zero 8; content_hash identical BEFORE, after
-- V0, and AFTER the push.
-- MEASURED BEFORE: (fill in)
-- MEASURED AFTER:  (fill in)
--
-- The hash only covers the columns listed. V2 lists the table's full column
-- set — if it shows a column not named above, extend this list and re-run
-- BEFORE the push.


-- ── V2. SCHEMA (after the push) ─────────────────────────────────────────────
select column_name, data_type, numeric_precision, numeric_scale,
       is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'saved_ingredients'
order by ordinal_position;
-- PREDICTED:
--   sat_fat_per100  numeric  NULL/NULL  YES  NULL   ← unconstrained, deliberately
--   salt_per100     numeric  8/2        YES  NULL
--   fibre_per100    numeric  8/2        YES  NULL
--   sugar_per100    numeric  8/2        YES  NULL
--   cal/protein/carbs/fat_per100  numeric 8/2  NO  0   ← unchanged
-- MEASURED: (fill in)


-- ── V3. BASELINE: view, CHECK, policies — run BEFORE and AFTER ─────────────
-- On record before any future commit goes near saved_ingredients_scored.
select 'view reloptions' as item, coalesce(array_to_string(c.reloptions, ','), '<none>') as detail
from pg_class c
where c.relname = 'saved_ingredients_scored' and c.relnamespace = 'public'::regnamespace
union all
select 'check ' || con.conname, pg_get_constraintdef(con.oid)
from pg_constraint con
where con.conrelid = 'public.saved_ingredients'::regclass and con.contype = 'c'
union all
select 'policy ' || p.policyname,
       p.cmd || ' USING ' || coalesce(p.qual, '-') || ' CHECK ' || coalesce(p.with_check, '-')
from pg_policies p
where p.schemaname = 'public' and p.tablename = 'saved_ingredients'
union all
select 'view depends on', string_agg(a.attname, ',' order by a.attname)
from pg_depend d
join pg_rewrite r   on r.oid = d.objid
join pg_class v     on v.oid = r.ev_class
join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
where d.refobjid = 'public.saved_ingredients'::regclass
  and v.relname = 'saved_ingredients_scored'
  and a.attname in ('sat_fat_per100', 'salt_per100', 'fibre_per100', 'sugar_per100')
order by 1;
-- PREDICTED (both runs): view reloptions contains security_invoker=on;
-- check saved_ingredients_sat_fat_per100_check CHECK ((sat_fat_per100 >= (0)::numeric));
-- four policies, all auth.uid() = user_id; view depends on
-- fibre_per100,salt_per100,sat_fat_per100,sugar_per100.
-- MEASURED BEFORE: (fill in)
-- MEASURED AFTER:  (fill in)


-- ── V4. RLS — two accounts, table AND view (BEFORE and AFTER) ──────────────
-- The app reads saved_ingredients_scored, a security_invoker view. If that
-- property were ever lost the view would run as its owner and show EVERY
-- user's rows — so the view is checked, not just the table.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
select
  (select count(*) from public.saved_ingredients)                                  as table_rows,
  (select count(*) from public.saved_ingredients where user_id <> auth.uid())        as table_foreign_rows,
  (select count(*) from public.saved_ingredients_scored)                           as view_rows,
  (select count(*) from public.saved_ingredients_scored where user_id <> auth.uid()) as view_foreign_rows;
rollback;
-- PREDICTED: table_foreign_rows = 0, view_foreign_rows = 0,
-- table_rows = view_rows = this account's own count (same BEFORE and AFTER).
-- MEASURED BEFORE: (fill in)
-- MEASURED AFTER:  (fill in)

begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"4dbf04ae-7b46-4511-8122-f17284c622d9"}';
select
  (select count(*) from public.saved_ingredients)                                  as table_rows,
  (select count(*) from public.saved_ingredients where user_id <> auth.uid())        as table_foreign_rows,
  (select count(*) from public.saved_ingredients_scored)                           as view_rows,
  (select count(*) from public.saved_ingredients_scored where user_id <> auth.uid()) as view_foreign_rows;
rollback;
-- PREDICTED: as above, for this account.
-- MEASURED BEFORE: (fill in)
-- MEASURED AFTER:  (fill in)

-- Cross-check (superuser, table-wide): each account's own row count, to
-- compare against the in-session table_rows above.
select user_id, count(*) as rows
from public.saved_ingredients
where user_id in ('a8435663-72e9-4d33-9c3f-803c4cbda393',
                  '4dbf04ae-7b46-4511-8122-f17284c622d9')
group by user_id;


-- ── V5. LIVE BEHAVIOUR (after the push) — rolled back ───────────────────────
-- (a) An insert that OMITS the small four — exactly what the client sends
--     for an unknown macro — now stores NULL, and the view passes it through.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
insert into public.saved_ingredients
  (user_id, name, cal_per100, protein_per100, carbs_per100, fat_per100)
values (auth.uid(), '__v5_probe__', 100, 5, 10, 2);
select sat_fat_per100, salt_per100, fibre_per100, sugar_per100, decay_score
from public.saved_ingredients_scored
where name = '__v5_probe__';
rollback;
-- PREDICTED: one row, all four NULL, decay_score 0.
-- MEASURED: (fill in)

-- (b) The CHECK still does its real job: a negative sat fat is refused.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}';
insert into public.saved_ingredients
  (user_id, name, cal_per100, protein_per100, carbs_per100, fat_per100, sat_fat_per100)
values (auth.uid(), '__v5_probe__', 100, 5, 10, 2, -1);
rollback;
-- PREDICTED: ERROR — new row violates check constraint
-- "saved_ingredients_sat_fat_per100_check". (The rollback then runs on an
-- aborted transaction; that is expected.)
-- MEASURED: (fill in)


-- ============================================================================
-- MANUAL TEST CHECKLIST (Pixel 9, after the push, BEFORE the code commit ships)
--
-- [ ] Search an OFF product with no fibre (or salt) data; log it. Then:
--       select name, sat_fat_per100, salt_per100, fibre_per100, sugar_per100
--       from public.saved_ingredients order by created_at desc limit 1;
--     → the missing macro is NULL (not 0). sat_fat is still 0 if OFF lacked
--       it — expected until the code commit.
-- [ ] Re-add that food from My Library → ProductScreen shows "—" for the
--     missing macro; the new meal_entries row has it NULL.
-- [ ] Log a food WITH all four known → the library row stores the numbers.
-- [ ] Existing library items still open and log normally (no crash on the
--     378 pre-existing rows, none of which are NULL yet).
-- ============================================================================
