-- ============================================================================
-- Verification for 20260930120000_receipts.sql (receipt scanner commit 1a)
--              and 20260930130000_update_receipt.sql (commit 1b)
--
-- TWO PARTS
--   Container rig — ALREADY RUN, before any push:
--     bash supabase/migrations/verify/20260930120000_rig.sh
--     applies both migrations to a throwaway postgres:16-alpine and executes
--     V2–V11 for real, plus sabotages 1–9 (findings §5).
--     MEASURED 2026-09-30 (1a alone): clean 41/41.
--     MEASURED 2026-10-04 (1a + 1b): clean 59/59 pass; every sabotage red on
--     its named check:
--       s1  lines insert policy without the parent check  → V4c red
--       s2  save_receipt SECURITY DEFINER                 → V3 red
--       s3  save_receipt takes user_id from the payload    → V4e red
--       s4  line_total_pence default 0                     → V5 direct red
--       s5  receipt_id FK without ON DELETE CASCADE        → V6 red
--       s9  delete_receipt without `if not found`          → V11 red
--       s6  update_receipt without `if not found`          → V7 red ("returned normally")
--       s7a insert wrapped in a swallowing handler         → V9 red ("0 lines remain")
--       s7b delete and insert as two client requests       → V9 red ("0 lines remain")
--       s8  update_receipt takes user_id from the payload  → V8 red
--
--   Hosted — this file, AS RUN on 2026-10-04 (dashboard SQL editor,
--   production), 1a and 1b pushed together:
--     BEFORE the push   V1 BEFORE (per-row snapshot) + reachability check
--     push              npx supabase db push
--     AFTER the push    V1 AFTER → V1c → V2 → V3 → V4a–e → V5
--                       → V7/V8/V9 + date flag → V6 + V11 → clean-up
--
-- V1–V3 run as the dashboard superuser, which BYPASSES RLS, so they are
-- table-wide on purpose. V4 onward are single DO blocks that switch to
-- `authenticated` with a real JWT claim (the only way to test RLS), catch
-- their own expected errors, and ALWAYS end with `raise exception`, so
-- nothing they write is ever kept. A pass shows as an error whose text
-- starts with PASS; any other error text is a failure.
--
-- WHY DO BLOCKS AND NOT begin … rollback: the dashboard stops at the first
-- error, so the savepoint / `rollback to savepoint` pattern can't run there.
-- The container rig (above) keeps its own form and is unchanged.
--
-- V10's updated_at half is container-only: it needs two committed
-- transactions, and the hosted database is not a place for probe rows. The
-- date-flag half also ran hosted, inside the V7/V8/V9 block.
-- ============================================================================


-- ── V1. SNAPSHOT: consumption untouched — BEFORE and AFTER ─────────────────
-- Receipts are grocery spending only and must never write meal_entries
-- (checklist: neither migration file references the table in code). The
-- whole-row text covers every column, including any added since, and renders
-- NULL distinctly from ''.
--
-- TESTERS MAY WRITE BETWEEN THE TWO SNAPSHOTS, so a mismatch is not by itself
-- a failure: it is diffed by id (V1c) first. Only a change nobody can account
-- for is an alarm. Inserts can be placed in time (logged_at is DB-owned);
-- edits and deletes can't (meal_entries has no updated_at), so those are
-- alarms until a tester confirms them. The snapshot lives in `maintenance`,
-- never `public` (PL-031), and is dropped at the end.
--
-- AS RUN 2026-10-04:

-- ── V1 BEFORE (quiet hour, before `npx supabase db push`) ──────────────────
-- The dashboard warned that the table had no RLS; "Run and enable RLS" was
-- chosen, which is equivalent to the explicit `enable row level security`
-- line below.
create table maintenance.receipts_v1_snapshot as
select m.id, md5(m::text) as row_hash, m.logged_at, now() as taken_at
from public.meal_entries m;

alter table maintenance.receipts_v1_snapshot enable row level security;

revoke all on maintenance.receipts_v1_snapshot from public, anon, authenticated;

select count(*) as rows,
       md5(string_agg(row_hash, '' order by id)) as content_hash
from maintenance.receipts_v1_snapshot;
-- MEASURED BEFORE: 1440 rows, 1a23d53787541a1729b8d2843c1b7679


-- ── V1 snapshot not reachable from the app ─────────────────────────────────
select has_schema_privilege('anon', 'maintenance', 'USAGE')          as anon_schema,
       has_schema_privilege('authenticated', 'maintenance', 'USAGE') as auth_schema,
       has_table_privilege('authenticated', 'maintenance.receipts_v1_snapshot', 'SELECT') as auth_table;
-- MEASURED: false, false, false


-- ── V1 AFTER (straight after the push) ─────────────────────────────────────
select count(*) as rows,
       md5(string_agg(md5(m::text), '' order by m.id)) as content_hash
from public.meal_entries m;
-- MEASURED AFTER: 1440 rows, 1a23d53787541a1729b8d2843c1b7679 (identical)


-- ── V1c: row-by-row diff (run regardless; required only if V1 differs) ─────
with s as (select * from maintenance.receipts_v1_snapshot),
     w as (select min(taken_at) as t0 from s),
     n as (select m.id, md5(m::text) as row_hash, m.logged_at from public.meal_entries m)
select coalesce(n.id, s.id) as id,
       case
         when s.id is null and n.logged_at >= (select t0 from w) then 'ok: added during window (tester write)'
         when s.id is null then 'ALARM: added but backdated'
         when n.id is null then 'ALARM: deleted (confirm with tester)'
         else 'ALARM: edited (confirm with tester)'
       end as verdict
from s full join n on n.id = s.id
where s.id is null or n.id is null or s.row_hash <> n.row_hash;
-- MEASURED: 0 rows


-- ── V2. SCHEMA (after the push) ─────────────────────────────────────────────
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('receipts', 'receipt_lines')
order by table_name, ordinal_position;
-- PREDICTED: receipts 9 columns, receipt_lines 10.
--   printed_total_pence, line_total_pence   integer  YES  NULL   ← no default
--   purchased_on_estimated                  boolean  NO   NULL   ← caller must say
--   currency  character  NO  'GBP'::bpchar;  updated_at  NO  now()
-- MEASURED (container): as predicted.
-- MEASURED (hosted):    2026-10-04: 19 columns (receipts 9, receipt_lines 10), as predicted.

select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid in ('public.receipts'::regclass, 'public.receipt_lines'::regclass)
order by 1, 2;
-- PREDICTED: receipts_store_len, receipts_total_nonneg, receipts_currency_iso,
-- receipt_lines_sign, the column CHECKs, unique (receipt_id, position), and
-- three FKs all ON DELETE CASCADE (receipt_id → receipts; both user_id →
-- auth.users).
-- MEASURED (hosted): 2026-10-04: 15 constraints; the three FKs ON DELETE CASCADE.

select tgname, tgtype, tgenabled
from pg_trigger
where tgrelid = 'public.receipts'::regclass and not tgisinternal;
-- PREDICTED: receipts_touch_updated_at, tgtype 19 (BEFORE | ROW | UPDATE), O.
-- MEASURED (hosted): 2026-10-04: receipts_touch_updated_at, tgtype 19, enabled O.


-- ── V3. SECURITY SURFACE (after the push) ───────────────────────────────────
select 'rls ' || relname as item, relrowsecurity::text as detail
from pg_class where oid in ('public.receipts'::regclass, 'public.receipt_lines'::regclass)
union all
select 'policy ' || tablename || '.' || policyname,
       cmd || ' USING ' || coalesce(qual, '-') || ' CHECK ' || coalesce(with_check, '-')
from pg_policies where schemaname = 'public' and tablename in ('receipts', 'receipt_lines')
union all
select 'anon table privilege',
       (has_table_privilege('anon', 'public.receipts', 'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('anon', 'public.receipt_lines', 'SELECT,INSERT,UPDATE,DELETE'))::text
union all
select 'fn ' || p.oid::regprocedure::text,
       'secdef=' || p.prosecdef || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-')
       || ' anon_exec=' || has_function_privilege('anon', p.oid, 'EXECUTE')
       || ' auth_exec=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
from pg_proc p
where p.oid in ('public.save_receipt(jsonb,jsonb)'::regprocedure,
                'public.delete_receipt(uuid)'::regprocedure,
                'public.update_receipt(uuid,jsonb,jsonb)'::regprocedure,
                'public.receipts_touch_updated_at()'::regprocedure)
order by 1;
-- PREDICTED: rls true ×2; 4 + 4 policies, receipt_lines INSERT and UPDATE
-- CHECK containing "FROM receipts r"; anon table privilege false;
-- save_receipt, delete_receipt and update_receipt secdef=false
-- config=search_path="" anon_exec=false auth_exec=true;
-- receipts_touch_updated_at auth_exec=false.
-- MEASURED (container): as predicted (V3, 14 checks).
-- MEASURED (hosted):    2026-10-04: as predicted. rls true x2; 8 policies, lines insert/update
-- with the parent check; anon table privilege false; save/update/delete_receipt
-- secdef=false search_path="" anon_exec=false auth_exec=true;
-- receipts_touch_updated_at auth_exec=false.


-- ── V4a–e: RLS with two accounts ───────────────────────────────────────────
do $$
declare
  a constant uuid := 'a8435663-72e9-4d33-9c3f-803c4cbda393';
  b constant uuid := '4dbf04ae-7b46-4511-8122-f17284c622d9';
  rid uuid; n int; u uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', a)::text, true);
  select id into rid from public.save_receipt(
    '{"store":"__v4_probe__","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":100}',
    '[{"position":0,"raw_text":"MILK","line_total_pence":150},
      {"position":1,"raw_text":"Nectar Price Saving","line_total_pence":-50,"is_discount":true}]');
  select count(*) into n from public.receipt_lines where receipt_id = rid and user_id = a;
  if n <> 2 then raise exception 'FAIL V4a: A owns % lines, expected 2', n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', b)::text, true);
  select count(*) into n from public.receipts where id = rid;
  if n <> 0 then raise exception 'FAIL V4b: B can see A''s receipt'; end if;
  select count(*) into n from public.receipt_lines where receipt_id = rid;
  if n <> 0 then raise exception 'FAIL V4b: B can see A''s lines'; end if;

  begin
    insert into public.receipt_lines (receipt_id, user_id, position, raw_text)
    values (rid, b, 5, 'INJECTED');
    raise exception 'FAIL V4c: B attached a line to A''s receipt';
  exception when insufficient_privilege then null;
  end;

  update public.receipts set store = 'x' where id = rid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL V4d: B updated A''s receipt'; end if;

  select user_id into u from public.save_receipt(
    json_build_object('user_id', a, 'purchased_on', '2026-09-21', 'purchased_on_estimated', true)::jsonb, '[]');
  if u <> b then raise exception 'FAIL V4e: payload user_id was used'; end if;

  raise exception 'PASS V4a-e (rolled back)';
end $$;
-- MEASURED: P0001: PASS V4a-e (rolled back)


-- ── V5: constraints and NULL-not-zero ──────────────────────────────────────
do $$
declare
  a constant uuid := 'a8435663-72e9-4d33-9c3f-803c4cbda393';
  rid uuid; rec record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', a)::text, true);

  select id into rid from public.save_receipt(
    '{"purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":null}',
    '[{"position":0,"raw_text":"LOOSE CARROTS","qty":0.512,"qty_unit":"kg"}]');
  select r.printed_total_pence as t, r.currency as c, l.line_total_pence as lt, l.qty as q
    into rec
    from public.receipts r join public.receipt_lines l on l.receipt_id = r.id
   where r.id = rid;
  if rec.t is not null or rec.lt is not null then
    raise exception 'FAIL V5: NULL read back as % / %', rec.t, rec.lt; end if;
  if rec.q <> 0.512 then raise exception 'FAIL V5: qty %', rec.q; end if;
  if rec.c <> 'GBP' then raise exception 'FAIL V5: currency %', rec.c; end if;

  begin
    perform public.save_receipt('{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
      '[{"position":0,"raw_text":"SAVING","line_total_pence":250,"is_discount":true}]');
    raise exception 'FAIL V5: positive discount accepted';
  exception when check_violation then null;
  end;

  begin
    perform public.save_receipt(
      '{"purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":-1}', '[]');
    raise exception 'FAIL V5: negative total accepted';
  exception when check_violation then null;
  end;

  begin
    perform public.save_receipt('{"purchased_on":"2026-09-20"}', '[]');
    raise exception 'FAIL V5: missing estimated flag accepted';
  exception when not_null_violation then null;
  end;

  raise exception 'PASS V5 (rolled back)';
end $$;
-- MEASURED: P0001: PASS V5 (rolled back)


-- ── V7, V8, V9 and the date flag: the update path ──────────────────────────
do $$
declare
  a constant uuid := 'a8435663-72e9-4d33-9c3f-803c4cbda393';
  b constant uuid := '4dbf04ae-7b46-4511-8122-f17284c622d9';
  rid uuid; h0 text; h1 text; old_ids uuid[]; n int; rec record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', a)::text, true);
  select id into rid from public.save_receipt(
    '{"store":"__v7_probe__","purchased_on":"2026-09-20","purchased_on_estimated":true,"printed_total_pence":300}',
    '[{"position":0,"raw_text":"A","line_total_pence":100},
      {"position":1,"raw_text":"B","line_total_pence":100},
      {"position":2,"raw_text":"C","line_total_pence":100}]');
  select md5(r::text || (select string_agg(l::text, '|' order by l.position)
                           from public.receipt_lines l where l.receipt_id = r.id))
    into h0 from public.receipts r where r.id = rid;

  -- V7: B editing A's receipt raises P0002
  perform set_config('request.jwt.claims', json_build_object('sub', b)::text, true);
  begin
    perform public.update_receipt(rid,
      '{"store":"hijack","purchased_on":"2026-09-20","printed_total_pence":1,"currency":"GBP"}', '[]');
    raise exception 'FAIL V7: B''s update of A''s receipt returned normally';
  exception when no_data_found then null;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', a)::text, true);
  select md5(r::text || (select string_agg(l::text, '|' order by l.position)
                           from public.receipt_lines l where l.receipt_id = r.id))
    into h1 from public.receipts r where r.id = rid;
  if h1 <> h0 then raise exception 'FAIL V7: A''s receipt changed'; end if;

  -- V9: a failing line leaves the old receipt intact
  begin
    perform public.update_receipt(rid,
      '{"store":"changed","purchased_on":"2026-09-20","printed_total_pence":300,"currency":"GBP"}',
      '[{"position":0,"raw_text":"X","line_total_pence":1},
        {"position":1,"raw_text":"BAD","line_total_pence":250,"is_discount":true}]');
    raise exception 'FAIL V9: invalid line accepted';
  exception when check_violation then null;
  end;
  select md5(r::text || (select string_agg(l::text, '|' order by l.position)
                           from public.receipt_lines l where l.receipt_id = r.id))
    into h1 from public.receipts r where r.id = rid;
  if h1 <> h0 then raise exception 'FAIL V9: old receipt not intact'; end if;

  -- V8: lines replaced exactly; payload user_id and flag ignored; same date keeps the flag
  select array_agg(id) into old_ids from public.receipt_lines where receipt_id = rid;
  perform public.update_receipt(rid,
    json_build_object('user_id', b, 'purchased_on_estimated', false, 'store', 'edited',
                      'purchased_on', '2026-09-20', 'printed_total_pence', 200, 'currency', 'GBP')::jsonb,
    '[{"position":0,"raw_text":"NEW1","line_total_pence":120},
      {"position":1,"raw_text":"NEW2","line_total_pence":80}]');
  select count(*) into n from public.receipt_lines
   where receipt_id = rid and user_id = a and raw_text in ('NEW1', 'NEW2');
  if n <> 2 then raise exception 'FAIL V8: expected exactly NEW1, NEW2'; end if;
  select count(*) into n from public.receipt_lines where receipt_id = rid;
  if n <> 2 then raise exception 'FAIL V8: % lines, expected 2', n; end if;
  if exists (select 1 from public.receipt_lines where id = any(old_ids)) then
    raise exception 'FAIL V8: old lines remain'; end if;
  select user_id, purchased_on_estimated as est into rec from public.receipts where id = rid;
  if rec.user_id <> a then raise exception 'FAIL V8: owner changed'; end if;
  if rec.est is not true then raise exception 'FAIL date flag: same date cleared it'; end if;

  -- changing the date clears the flag
  perform public.update_receipt(rid,
    '{"store":"edited","purchased_on":"2026-09-21","printed_total_pence":200,"currency":"GBP"}', '[]');
  select purchased_on_estimated into rec from public.receipts where id = rid;
  if rec.purchased_on_estimated is not false then
    raise exception 'FAIL date flag: new date kept it'; end if;

  raise exception 'PASS V7 V8 V9 + date flag (rolled back)';
end $$;
-- MEASURED: P0001: PASS V7 V8 V9 + date flag (rolled back)


-- ── V6 + V11: delete cascades and is loud ──────────────────────────────────
do $$
declare
  a constant uuid := 'a8435663-72e9-4d33-9c3f-803c4cbda393';
  b constant uuid := '4dbf04ae-7b46-4511-8122-f17284c622d9';
  rid uuid; n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', a)::text, true);
  select id into rid from public.save_receipt(
    '{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
    '[{"position":0,"raw_text":"A","line_total_pence":1},
      {"position":1,"raw_text":"B","line_total_pence":2}]');

  perform set_config('request.jwt.claims', json_build_object('sub', b)::text, true);
  begin
    perform public.delete_receipt(rid);
    raise exception 'FAIL V11: B deleted A''s receipt without error';
  exception when no_data_found then null;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', a)::text, true);
  if not exists (select 1 from public.receipts where id = rid) then
    raise exception 'FAIL V11: A''s receipt gone after B''s attempt'; end if;

  perform public.delete_receipt(rid);
  select count(*) into n from public.receipt_lines where receipt_id = rid;
  if n <> 0 then raise exception 'FAIL V6: % lines survived', n; end if;

  begin
    perform public.delete_receipt(rid);
    raise exception 'FAIL V11: second delete returned normally';
  exception when no_data_found then null;
  end;

  begin
    perform public.update_receipt(rid,
      '{"purchased_on":"2026-09-20","currency":"GBP"}', '[]');
    raise exception 'FAIL V11: edit after delete returned normally';
  exception when no_data_found then null;
  end;

  raise exception 'PASS V6 V11 (rolled back)';
end $$;
-- MEASURED: P0001: PASS V6 V11 (rolled back)


-- ── Clean-up ───────────────────────────────────────────────────────────────
drop table maintenance.receipts_v1_snapshot;


-- ============================================================================
-- MANUAL CHECKLIST (commits 1a and 1b, pushed together 2026-10-04)
--
-- [x] Docker up; container rig clean 59/59 with both migrations; sabotages
--     1–9 each red on their named check (2026-10-04, see top).
-- [x] `grep -c meal_entries` on both migration files, every hit a comment.
--     MEASURED 2026-10-04: 20260930120000_receipts.sql 1, 20260930130000_
--     update_receipt.sql 0. The one hit is line 99, inside the
--     `comment on table public.receipts` text ("nothing here is ever written
--     to meal_entries"): table documentation, not a reference to the table.
-- [x] V1 BEFORE: 1440 rows, 1a23d53787541a1729b8d2843c1b7679. Snapshot table
--     RLS on, privileges revoked; anon/authenticated schema and table
--     privileges all false.
-- [x] npx supabase db push (2026-10-04).
-- [x] V1 AFTER: 1440 rows, same hash. V1c: 0 rows. Snapshot table dropped.
-- [x] V2, V3 as predicted (MEASURED above).
-- [x] V4a–e, V5, V7/V8/V9 + date flag, V6 + V11: all PASS, rolled back.
-- [x] Dashboard → Table editor RLS check: covered by V3 (relrowsecurity
--     true on both tables, MEASURED 2026-10-04).
-- [x] docs/account-deletion-runbook.md: READ 2026-09-30, it lists no
--     per-table checks, and delete-account touches no user table directly
--     (account_deletions, whoop_tokens, storage). Both new tables go by
--     ON DELETE CASCADE from auth.users (V2). Nothing to update.
-- ============================================================================
