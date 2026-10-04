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
--   Hosted — this file, when the push is asked for:
--     BEFORE the push   V1a (per-row snapshot)
--     push              npx supabase db push   (1a and 1b together)
--     AFTER the push    V1b (V1c if it differs) → V2 → V3 → V4 → V5 → V6
--                       → V7 → V8 → V9 → V11
--
-- The dashboard SQL editor runs as a superuser and BYPASSES RLS. V1–V3 are
-- table-wide on purpose. V4 onward switch to `authenticated` with a real JWT
-- claim — the only way to test RLS — and every one of them rolls back. Run
-- each numbered block on its own (the editor shows only the last result).
-- V10 is container-only: it must commit, and the hosted database is not a
-- place for probe rows.
-- ============================================================================


-- ── V1. SNAPSHOT: consumption untouched — BEFORE and AFTER ─────────────────
-- Receipts are grocery spending only and must never write meal_entries
-- (checklist: neither migration file references the table in code). The
-- whole-row text covers every column, including any added since, and renders
-- NULL distinctly from ''.
--
-- TESTERS MAY WRITE BETWEEN THE TWO SNAPSHOTS, so a mismatch is not by itself
-- a failure. The BEFORE snapshot is therefore kept per row, by id, and a
-- mismatch is diffed (V1c) before anything is concluded. The scratch table
-- lives in `maintenance`, never `public` (PL-031), and V1d drops it.

-- V1a. BEFORE the push.
create table maintenance._diag_receipts_v1_pre as
select m.id, m.user_id, m.logged_at, md5(m::text) as row_hash, now() as snapped_at
from public.meal_entries m;
revoke all on maintenance._diag_receipts_v1_pre from anon, authenticated;

select count(*)                                          as meal_entries_rows,
       md5(string_agg(m::text, E'\n' order by m.id))     as content_hash
from public.meal_entries m;
-- MEASURED BEFORE: (fill in rows + hash; the scratch table's snapped_at is
-- the start of the window)

-- V1b. AFTER the push: the same aggregate.
select count(*)                                          as meal_entries_rows,
       md5(string_agg(m::text, E'\n' order by m.id))     as content_hash
from public.meal_entries m;
-- PREDICTED: identical to BEFORE if nobody logged in between. If it differs,
-- run V1c before treating it as a failure.
-- MEASURED AFTER: (fill in)

-- V1c. Only if V1b differs: the diff, by id.
with pre as (select * from maintenance._diag_receipts_v1_pre),
     post as (select m.id, m.user_id, m.logged_at, md5(m::text) as row_hash from public.meal_entries m),
     win as (select min(snapped_at) as t0 from pre)
select coalesce(post.id, pre.id)              as id,
       coalesce(post.user_id, pre.user_id)    as user_id,
       coalesce(post.logged_at, pre.logged_at) as logged_at,
       case
         when pre.id is null  and post.logged_at >= win.t0 then 'added in the window: tester write, expected'
         when pre.id is null                               then 'ALARM: added with logged_at before the window'
         when post.id is null                              then 'removed: confirm a tester deleted it, else ALARM'
         else                                                   'changed: confirm a tester edited it, else ALARM'
       end as verdict
from pre
full join post using (id)
cross join win
where pre.id is null or post.id is null or pre.row_hash <> post.row_hash
order by verdict, logged_at;
-- PREDICTED: 0 rows, or only "added in the window" rows.
-- Why edits and deletes can't be cleared automatically: meal_entries has no
-- updated_at (no touch trigger), so a change can't be timestamped. logged_at
-- is when the row was created and is DB-owned, so an insert CAN be placed
-- inside or outside the window. A changed or removed row is an alarm until a
-- tester confirms they made that edit during the window. Only a change to a
-- row that nobody touched in the window is a real alarm.
-- MEASURED: (fill in)

-- V1d. Cleanup, once V1 is settled.
-- drop table maintenance._diag_receipts_v1_pre;


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
-- MEASURED (hosted):    (fill in)

select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid in ('public.receipts'::regclass, 'public.receipt_lines'::regclass)
order by 1, 2;
-- PREDICTED: receipts_store_len, receipts_total_nonneg, receipts_currency_iso,
-- receipt_lines_sign, the column CHECKs, unique (receipt_id, position), and
-- three FKs all ON DELETE CASCADE (receipt_id → receipts; both user_id →
-- auth.users).
-- MEASURED (hosted): (fill in)

select tgname, tgtype, tgenabled
from pg_trigger
where tgrelid = 'public.receipts'::regclass and not tgisinternal;
-- PREDICTED: receipts_touch_updated_at, tgtype 19 (BEFORE | ROW | UPDATE), O.
-- MEASURED (hosted): (fill in)


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
-- MEASURED (hosted):    (fill in)


-- ── V4. RLS WITH TWO ACCOUNTS — rolled back ─────────────────────────────────
-- A = a8435663-72e9-4d33-9c3f-803c4cbda393, B = 4dbf04ae-7b46-4511-8122-f17284c622d9.
-- Returns one row of booleans; every column must be true.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v4 on commit drop as
select (public.save_receipt(
  '{"store":"__v4_probe__","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":100}',
  '[{"position":0,"raw_text":"MILK","line_total_pence":150},
    {"position":1,"raw_text":"Nectar Price Saving","line_total_pence":-50,"is_discount":true}]')).id as a_id;
select
  (select count(*) from public.receipts r join v4 on r.id = v4.a_id
    where r.user_id = auth.uid()) = 1                                     as a_owns_receipt,
  (select count(*) from public.receipt_lines l join v4 on l.receipt_id = v4.a_id
    where l.user_id = auth.uid()) = 2                                     as a_owns_2_lines;
-- (b)–(d) as B, same transaction:
select set_config('request.jwt.claims', '{"sub":"4dbf04ae-7b46-4511-8122-f17284c622d9"}', true);
select
  (select count(*) from public.receipts r join v4 on r.id = v4.a_id) = 0     as b_cannot_see_a_receipt,
  (select count(*) from public.receipt_lines l join v4 on l.receipt_id = v4.a_id) = 0 as b_cannot_see_a_lines;
rollback;
-- PREDICTED: all true.  MEASURED (container, V4a/V4b): pass.  MEASURED (hosted): (fill in)

-- (c) B attaching a line to A's receipt is refused.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v4c on commit drop as
select (public.save_receipt('{"purchased_on":"2026-09-20","purchased_on_estimated":false}', '[]')).id as a_id;
select set_config('request.jwt.claims', '{"sub":"4dbf04ae-7b46-4511-8122-f17284c622d9"}', true);
insert into public.receipt_lines (receipt_id, user_id, position, raw_text)
select a_id, auth.uid(), 5, 'INJECTED' from v4c;
rollback;
-- PREDICTED: ERROR — new row violates row-level security policy for table
-- "receipt_lines". MEASURED (container, V4c): pass. MEASURED (hosted): (fill in)

-- (d) B updating A's receipt touches 0 rows; (e) B's payload naming A is ignored.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v4d on commit drop as
select (public.save_receipt('{"purchased_on":"2026-09-20","purchased_on_estimated":false}', '[]')).id as a_id;
select set_config('request.jwt.claims', '{"sub":"4dbf04ae-7b46-4511-8122-f17284c622d9"}', true);
with upd as (
  update public.receipts set store = 'x' where id = (select a_id from v4d) returning 1
), saved as (
  select public.save_receipt(
    '{"user_id":"a8435663-72e9-4d33-9c3f-803c4cbda393","purchased_on":"2026-09-21","purchased_on_estimated":true}',
    '[]') as r
)
select (select count(*) from upd) = 0                               as b_update_touches_0_rows,
       (select (r).user_id from saved) = auth.uid()                 as b_payload_user_id_ignored;
rollback;
-- PREDICTED: both true. MEASURED (container, V4d/V4e): pass. MEASURED (hosted): (fill in)


-- ── V5. CONSTRAINTS AND NULL-NOT-0 — rolled back ────────────────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
-- The save goes in its own statement: a CTE calling save_receipt can't see
-- the rows the function inserts in that same statement (it returns 0 rows).
create temp table v5 on commit drop as
select (public.save_receipt(
  '{"purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":null}',
  '[{"position":0,"raw_text":"LOOSE CARROTS","qty":0.512,"qty_unit":"kg"}]')).id as id;
select r.printed_total_pence is null  as total_null,
       l.line_total_pence is null     as line_total_null,
       l.qty = 0.512                  as qty_kept,
       r.currency = 'GBP'             as currency_defaulted
from v5 s join public.receipts r on r.id = s.id join public.receipt_lines l on l.receipt_id = s.id;
rollback;
-- PREDICTED: all true. MEASURED (container): pass. MEASURED (hosted): (fill in)

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
select public.save_receipt(
  '{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
  '[{"position":0,"raw_text":"SAVING","line_total_pence":250,"is_discount":true}]');
rollback;
-- PREDICTED: ERROR — violates check constraint "receipt_lines_sign".
-- (The container also refuses a negative total, blank raw_text and a missing
-- purchased_on_estimated, and shows a failing line leaves no header.)
-- MEASURED (hosted): (fill in)


-- ── V6 + V11. DELETE CASCADES, AND IS LOUD — rolled back ────────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v6 on commit drop as
select (public.save_receipt(
  '{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
  '[{"position":0,"raw_text":"A","line_total_pence":1},{"position":1,"raw_text":"B","line_total_pence":2}]')).id as a_id;
select public.delete_receipt(a_id) from v6;
select count(*) = 0 as lines_cascaded
from public.receipt_lines where receipt_id = (select a_id from v6);
select public.delete_receipt(a_id) from v6;
rollback;
-- PREDICTED: lines_cascaded true; then the second delete_receipt raises
-- ERROR: delete_receipt: no receipt … for this user (SQLSTATE P0002).
-- (Cross-account delete → P0002 and A's row survives: container V11.)
-- MEASURED (hosted): (fill in)


-- ── V7. CROSS-ACCOUNT UPDATE RAISES, A UNCHANGED (1b) — rolled back ────────
-- The temp table holds A's probe id and A's hash. The failing call is inside
-- a savepoint so the transaction can still read A's hash back afterwards.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v7 on commit drop as
select (public.save_receipt(
  '{"store":"__v7_probe__","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":300}',
  '[{"position":0,"raw_text":"A","line_total_pence":100},{"position":1,"raw_text":"B","line_total_pence":200}]')).id as a_id;
alter table v7 add column h1 text;
update v7 set h1 = md5((select r::text from public.receipts r where r.id = a_id)
                       || (select string_agg(l::text, E'\n' order by l.position)
                             from public.receipt_lines l where l.receipt_id = a_id));
select set_config('request.jwt.claims', '{"sub":"4dbf04ae-7b46-4511-8122-f17284c622d9"}', true);
savepoint v7;
select public.update_receipt(a_id, '{"store":"hijack","purchased_on":"2026-09-20"}', '[]') from v7;
-- PREDICTED: ERROR: update_receipt: no receipt … for this user (SQLSTATE P0002)
rollback to savepoint v7;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
select h1 = md5((select r::text from public.receipts r where r.id = a_id)
                || (select string_agg(l::text, E'\n' order by l.position)
                      from public.receipt_lines l where l.receipt_id = a_id)) as a_unchanged
from v7;
rollback;
-- PREDICTED: the P0002 error, then a_unchanged true.
-- MEASURED (container, V7): pass. MEASURED (hosted): (fill in)


-- ── V8. UPDATE REPLACES THE LINES EXACTLY (1b) — rolled back ────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v8 on commit drop as
select (public.save_receipt(
  '{"store":"OLD","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":600}',
  '[{"position":0,"raw_text":"X","line_total_pence":100},
    {"position":1,"raw_text":"Y","line_total_pence":200},
    {"position":2,"raw_text":"Z","line_total_pence":300}]')).id as a_id;
create temp table v8_old on commit drop as
select id from public.receipt_lines where receipt_id = (select a_id from v8);
select public.update_receipt(a_id,
  '{"store":"NEW","purchased_on":"2026-09-20","printed_total_pence":175}',
  '[{"position":0,"raw_text":"NEW ONE","qty":2,"qty_unit":"each","unit_price_pence":125,"line_total_pence":250},
    {"position":1,"raw_text":"Nectar Price Saving","line_total_pence":-75,"is_discount":true}]') is not null as updated
from v8;
select
  (select count(*) from public.receipt_lines where receipt_id = (select a_id from v8)) = 2   as exactly_2_lines,
  (select count(*) from public.receipt_lines where id in (select id from v8_old)) = 0       as no_old_ids,
  (select string_agg(position || ':' || raw_text || ':' || coalesce(qty::text, '-') || ':'
                     || coalesce(line_total_pence::text, '-') || ':' || is_discount, ' | ' order by position)
     from public.receipt_lines where receipt_id = (select a_id from v8))                     as lines,
  (select store || '/' || printed_total_pence from public.receipts where id = (select a_id from v8)) as header;
rollback;
-- PREDICTED: exactly_2_lines t, no_old_ids t,
--   lines  "0:NEW ONE:2.000:250:false | 1:Nectar Price Saving:-:-75:true"
--   header "NEW/175"
-- (The container also checks column-for-column both ways, and that a payload
-- user_id naming B leaves the receipt and lines A's.)
-- MEASURED (container, V8): pass. MEASURED (hosted): (fill in)


-- ── V9. A MID-UPDATE FAILURE LEAVES THE OLD RECEIPT INTACT (1b) — rolled back
-- The second new line violates receipt_lines_sign AFTER the delete has run.
-- Once a statement fails the transaction can read nothing, so the failing
-- call runs inside `savepoint v9 … rollback to savepoint v9` and the hash is
-- read after. In the app, PostgREST's per-request transaction rolls back the
-- whole call the same way.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v9 on commit drop as
select (public.save_receipt(
  '{"store":"__v9_old__","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":600}',
  '[{"position":0,"raw_text":"X","line_total_pence":100},
    {"position":1,"raw_text":"Y","line_total_pence":200},
    {"position":2,"raw_text":"Z","line_total_pence":300}]')).id as a_id;
alter table v9 add column h1 text;
update v9 set h1 = md5((select r::text from public.receipts r where r.id = a_id)
                       || (select string_agg(l::text, E'\n' order by l.position)
                             from public.receipt_lines l where l.receipt_id = a_id));
savepoint v9;
select public.update_receipt(a_id,
  '{"store":"__v9_new__","purchased_on":"2026-09-20","printed_total_pence":300}',
  '[{"position":0,"raw_text":"FINE","line_total_pence":100},
    {"position":1,"raw_text":"BAD SAVING","line_total_pence":250,"is_discount":true}]') from v9;
-- PREDICTED: ERROR — violates check constraint "receipt_lines_sign"
rollback to savepoint v9;
select h1 = md5((select r::text from public.receipts r where r.id = a_id)
                || (select string_agg(l::text, E'\n' order by l.position)
                      from public.receipt_lines l where l.receipt_id = a_id)) as old_receipt_intact,
       (select count(*) from public.receipt_lines where receipt_id = a_id) as lines_remaining
from v9;
rollback;
-- PREDICTED: the check-violation error, then old_receipt_intact t,
-- lines_remaining 3 (old store, old 3 lines, updated_at unmoved).
-- MEASURED (container, V9): pass. MEASURED (hosted): (fill in)


-- ── V11 (1b half). UPDATE AFTER DELETE IS LOUD — rolled back ────────────────
-- "Deleted on another device, then Save here": P0002, and nothing resurrected.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393"}', true);
create temp table v11 on commit drop as
select (public.save_receipt('{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
  '[{"position":0,"raw_text":"A","line_total_pence":1}]')).id as a_id;
select public.delete_receipt(a_id) from v11;
savepoint v11;
select public.update_receipt(a_id, '{"purchased_on":"2026-09-20"}',
  '[{"position":0,"raw_text":"RESURRECTED","line_total_pence":1}]') from v11;
-- PREDICTED: ERROR: update_receipt: no receipt … for this user (SQLSTATE P0002)
rollback to savepoint v11;
select (select count(*) from public.receipts where id = a_id) = 0
   and (select count(*) from public.receipt_lines where receipt_id = a_id) = 0 as nothing_resurrected
from v11;
rollback;
-- PREDICTED: the P0002 error, then nothing_resurrected t.
-- MEASURED (container, V11): pass. MEASURED (hosted): (fill in)


-- ============================================================================
-- MANUAL CHECKLIST (commits 1a and 1b, pushed together)
--
-- [x] Docker up; container rig clean 59/59 with both migrations; sabotages
--     1–9 each red on their named check (2026-10-04, see top).
-- [x] `grep -c meal_entries` on both migration files, every hit a comment.
--     MEASURED 2026-10-04: 20260930120000_receipts.sql 1, 20260930130000_
--     update_receipt.sql 0. The one hit is line 99, inside the
--     `comment on table public.receipts` text ("nothing here is ever written
--     to meal_entries"): table documentation, not a reference to the table.
--     Re-run before the push if either file changes.
-- [ ] V1a BEFORE the push — record rows, hash, and the window start.
-- [ ] npx supabase db push   (only when asked; 1a and 1b together)
-- [ ] V1b AFTER. If it differs, V1c: only "added in the window" rows, or
--     changes a tester confirms. Then V1d (drop the scratch table).
-- [ ] V2, V3 as predicted.
-- [ ] V4 (a–e), V5, V6 + V11, V7, V8, V9, V11 (update half) as predicted on
--     hosted, all rolled back.
-- [ ] Dashboard → Table editor: receipts and receipt_lines show RLS enabled.
-- [x] docs/account-deletion-runbook.md: READ 2026-09-30, it lists no
--     per-table checks, and delete-account touches no user table directly
--     (account_deletions, whoop_tokens, storage). Both new tables go by
--     ON DELETE CASCADE from auth.users (V2). Nothing to update.
-- ============================================================================
