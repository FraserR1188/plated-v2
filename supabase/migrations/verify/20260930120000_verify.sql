-- ============================================================================
-- Verification for 20260930120000_receipts.sql (receipt scanner commit 1a)
--
-- TWO PARTS
--   Container rig — ALREADY RUN, before any push:
--     bash supabase/migrations/verify/20260930120000_rig.sh
--     executes V2–V6, V10 and V11 for real against a throwaway
--     postgres:16-alpine, plus sabotages 1–5 and 9 (findings §5).
--     MEASURED 2026-09-30: clean 41/41 pass; every sabotage red on its check:
--       s1 lines insert policy without the parent check  → V4c red
--       s2 save_receipt SECURITY DEFINER                 → V3 red
--       s3 save_receipt takes user_id from the payload    → V4e red
--       s4 line_total_pence default 0                     → V5 direct red
--       s5 receipt_id FK without ON DELETE CASCADE        → V6 red
--       s9 delete_receipt without `if not found`          → V11 red
--
--   Hosted — this file, when the push is asked for:
--     BEFORE the push   V1 (snapshot)
--     push              npx supabase db push   (1a and 1b together, findings)
--     AFTER the push    V1 (must equal BEFORE) → V2 → V3 → V4 → V5 → V6 → V11
--
-- The dashboard SQL editor runs as a superuser and BYPASSES RLS. V1–V3 are
-- table-wide on purpose. V4 onward switch to `authenticated` with a real JWT
-- claim — the only way to test RLS — and every one of them rolls back. Run
-- each numbered block on its own (the editor shows only the last result).
-- V10 is container-only: it must commit, and the hosted database is not a
-- place for probe rows.
-- ============================================================================


-- ── V1. SNAPSHOT: consumption untouched — BEFORE and AFTER, must be equal ──
-- Receipts are grocery spending only and must never write meal_entries. The
-- whole-row text covers every column, including any added since, and renders
-- NULL distinctly from ''.
select count(*)                                          as meal_entries_rows,
       md5(string_agg(m::text, E'\n' order by m.id))     as content_hash
from public.meal_entries m;
-- PREDICTED: identical BEFORE and AFTER (no app writes in between — run both
-- within a few minutes, with the app closed).
-- MEASURED BEFORE: (fill in)
-- MEASURED AFTER:  (fill in)


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
                'public.receipts_touch_updated_at()'::regprocedure)
order by 1;
-- PREDICTED: rls true ×2; 4 + 4 policies, receipt_lines INSERT and UPDATE
-- CHECK containing "FROM receipts r"; anon table privilege false;
-- save_receipt and delete_receipt secdef=false config=search_path=""
-- anon_exec=false auth_exec=true; receipts_touch_updated_at auth_exec=false.
-- MEASURED (container): as predicted (V3, 11 checks).
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


-- ============================================================================
-- MANUAL CHECKLIST (commit 1a; pushed together with 1b)
--
-- [x] Docker up; container rig clean 41/41; sabotages 1–5 and 9 each red
--     (2026-09-30, see top).
-- [ ] V1 BEFORE the push — record the hash.
-- [ ] npx supabase db push   (only when asked; 1a and 1b together)
-- [ ] V1 AFTER: identical. V2, V3 as predicted.
-- [ ] V4 (a–e), V5, V6 + V11 as predicted on hosted, all rolled back.
-- [ ] Dashboard → Table editor: receipts and receipt_lines show RLS enabled.
-- [x] docs/account-deletion-runbook.md: READ 2026-09-30, it lists no
--     per-table checks, and delete-account touches no user table directly
--     (account_deletions, whoop_tokens, storage). Both new tables go by
--     ON DELETE CASCADE from auth.users (V2). Nothing to update.
-- ============================================================================
