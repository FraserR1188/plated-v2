-- ============================================================================
-- Container rig tests for 20260930120000_receipts.sql (commit 1a) and
-- 20260930130000_update_receipt.sql (commit 1b)
--
-- Run by 20260930120000_rig.sh against a throwaway postgres:16-alpine
-- database that has the stub auth schema and the migration applied. NOT for
-- the hosted database: V10 commits (and cleans up after itself), and every
-- block assumes the rig's two fixed accounts.
--
-- Every check prints exactly one line through rig.check(): "PASS <id>" or
-- "FAIL <id>: <detail>". An unexpected error inside a block is caught and
-- reported as FAIL for that block, so one broken check can't hide the rest.
--
-- Accounts: A = aaaaaaaa-0000-4000-8000-00000000000a
--           B = bbbbbbbb-0000-4000-8000-00000000000b
-- ============================================================================

\set A '''aaaaaaaa-0000-4000-8000-00000000000a'''
\set B '''bbbbbbbb-0000-4000-8000-00000000000b'''

-- One receipt's header and lines as text, for "unchanged" checks (V7, V9).
-- Runs as the caller, so it sees only what RLS lets them see.
create or replace function rig.receipt_hash(p uuid) returns text
language sql stable as $$
  select md5(coalesce((select r::text from public.receipts r where r.id = p), '<no header>')
             || '#' ||
             coalesce((select string_agg(l::text, E'\n' order by l.position)
                         from public.receipt_lines l where l.receipt_id = p), '<no lines>'))
$$;


-- ── V2. SCHEMA (superuser) ──────────────────────────────────────────────────
do $$
declare
  n int;
  t int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'receipts';
  perform rig.check('V2 receipts has 9 columns', n = 9, n::text);

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'receipt_lines';
  perform rig.check('V2 receipt_lines has 10 columns', n = 10, n::text);

  -- NULL, never 0: both money columns nullable with no default.
  select count(*) into n from information_schema.columns
   where table_schema = 'public'
     and (table_name, column_name) in (('receipts', 'printed_total_pence'),
                                       ('receipt_lines', 'line_total_pence'))
     and is_nullable = 'YES' and column_default is null;
  perform rig.check('V2 money columns nullable, no default', n = 2, n::text);

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'receipts'
     and column_name = 'purchased_on_estimated'
     and is_nullable = 'NO' and column_default is null;
  perform rig.check('V2 purchased_on_estimated NOT NULL, no default', n = 1, n::text);

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'receipts'
     and column_name = 'updated_at' and is_nullable = 'NO' and column_default = 'now()';
  perform rig.check('V2 updated_at NOT NULL default now()', n = 1, n::text);

  select count(*) into n from pg_constraint
   where conname in ('receipts_store_len', 'receipts_total_nonneg',
                     'receipts_currency_iso', 'receipt_lines_sign');
  perform rig.check('V2 four named CHECKs', n = 4, n::text);

  -- BEFORE (2) | ROW (1) | UPDATE (16) = 19
  select tgtype into t from pg_trigger
   where tgrelid = 'public.receipts'::regclass
     and tgname = 'receipts_touch_updated_at' and not tgisinternal;
  perform rig.check('V2 trigger BEFORE UPDATE FOR EACH ROW', t = 19, coalesce(t::text, 'missing'));

  select count(*) into n from pg_constraint
   where conrelid = 'public.receipt_lines'::regclass and contype = 'f'
     and confrelid = 'public.receipts'::regclass and confdeltype = 'c';
  perform rig.check('V2 lines.receipt_id ON DELETE CASCADE', n = 1, n::text);

  select count(*) into n from pg_constraint
   where conrelid in ('public.receipts'::regclass, 'public.receipt_lines'::regclass)
     and contype = 'f' and confrelid = 'auth.users'::regclass and confdeltype = 'c';
  perform rig.check('V2 both user_id cascade from auth.users', n = 2, n::text);
exception when others then
  perform rig.check('V2 block', false, sqlerrm);
end $$;


-- ── V3. SECURITY SURFACE (superuser) ────────────────────────────────────────
do $$
declare
  n int;
  f text;
begin
  select count(*) into n from pg_class
   where oid in ('public.receipts'::regclass, 'public.receipt_lines'::regclass)
     and relrowsecurity;
  perform rig.check('V3 RLS on both tables', n = 2, n::text);

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'receipts';
  perform rig.check('V3 receipts has 4 policies', n = 4, n::text);
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'receipt_lines';
  perform rig.check('V3 receipt_lines has 4 policies', n = 4, n::text);

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'receipt_lines'
     and cmd in ('INSERT', 'UPDATE') and with_check like '%receipts%';
  perform rig.check('V3 lines insert+update check the parent', n = 2, n::text);

  perform rig.check('V3 anon has no table privilege',
    not has_table_privilege('anon', 'public.receipts', 'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon', 'public.receipt_lines', 'SELECT,INSERT,UPDATE,DELETE'), null);

  foreach f in array array['public.save_receipt(jsonb,jsonb)', 'public.delete_receipt(uuid)',
                           'public.update_receipt(uuid,jsonb,jsonb)'] loop
    select count(*) into n from pg_proc
     where oid = f::regprocedure and not prosecdef
       and array_to_string(proconfig, ',') like 'search_path=%';
    perform rig.check('V3 ' || f || ' invoker + pinned search_path', n = 1, n::text);
    perform rig.check('V3 ' || f || ' anon cannot execute',
      not has_function_privilege('anon', f, 'EXECUTE'), null);
    perform rig.check('V3 ' || f || ' authenticated can execute',
      has_function_privilege('authenticated', f, 'EXECUTE'), null);
  end loop;
exception when others then
  perform rig.check('V3 block', false, sqlerrm);
end $$;


-- ── V4. RLS WITH TWO ACCOUNTS — rolled back ─────────────────────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  r public.receipts;
  n int;
  m int;
begin
  -- (a) As A: save with 2 lines.
  r := public.save_receipt(
    '{"store":"Sainsbury''s","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":100}',
    '[{"position":0,"raw_text":"MILK","line_total_pence":150},
      {"position":1,"raw_text":"Nectar Price Saving","line_total_pence":-50,"is_discount":true}]');
  select count(*) into n from public.receipts where id = r.id and user_id = a;
  select count(*) into m from public.receipt_lines where receipt_id = r.id and user_id = a;
  perform rig.check('V4a A saves 1 receipt + 2 lines, all A''s', n = 1 and m = 2, n || '/' || m);

  -- (b) Switch to B: sees nothing.
  perform set_config('request.jwt.claims', '{"sub":"' || b || '"}', true);
  select count(*) into n from public.receipts;
  select count(*) into m from public.receipt_lines;
  perform rig.check('V4b B sees 0 receipts, 0 lines', n = 0 and m = 0, n || '/' || m);

  -- (c) B attaches a line to A's receipt.
  begin
    insert into public.receipt_lines (receipt_id, user_id, position, raw_text)
    values (r.id, b, 5, 'INJECTED');
    perform rig.check('V4c B cannot add a line to A''s receipt', false, 'insert succeeded');
  exception when insufficient_privilege then
    perform rig.check('V4c B cannot add a line to A''s receipt', true, null);
  end;

  -- (d) B updates A's header: 0 rows.
  update public.receipts set store = 'x' where id = r.id;
  get diagnostics n = row_count;
  perform rig.check('V4d B updating A''s receipt touches 0 rows', n = 0, n::text);
exception when others then
  perform rig.check('V4 block', false, sqlerrm);
end $$;
rollback;

-- (e) On its own, so it can't be masked by an earlier V4 failure: B saves
-- with a payload naming A as user_id, and the row is B's.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :B || '"}', true);
do $$
declare
  b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  r public.receipts;
  m int;
begin
  begin
    r := public.save_receipt(
      '{"user_id":"aaaaaaaa-0000-4000-8000-00000000000a","purchased_on":"2026-09-21","purchased_on_estimated":true}',
      '[{"position":0,"raw_text":"BREAD","line_total_pence":95,"user_id":"aaaaaaaa-0000-4000-8000-00000000000a"}]');
    select count(*) into m from public.receipt_lines where receipt_id = r.id and user_id = b;
    perform rig.check('V4e payload user_id ignored: row and line are B''s',
      r.user_id = b and m = 1, r.user_id || ' lines ' || m);
  exception when others then
    perform rig.check('V4e payload user_id ignored: row and line are B''s', false, sqlerrm);
  end;
end $$;
rollback;


-- ── V5. CONSTRAINTS AND NULL-NOT-0 — rolled back ────────────────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  r public.receipts;
  rid uuid;
  v_total integer;
  v_line integer;
  v_qty numeric;
  v_cur text;
begin
  begin
    perform public.save_receipt(
      '{"purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":-1}', '[]');
    perform rig.check('V5 negative total refused', false, 'accepted');
  exception when check_violation then
    perform rig.check('V5 negative total refused', true, null);
  end;

  begin
    perform public.save_receipt(
      '{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
      '[{"position":0,"raw_text":"SAVING","line_total_pence":250,"is_discount":true}]');
    perform rig.check('V5 positive discount refused', false, 'accepted');
  exception when check_violation then
    perform rig.check('V5 positive discount refused', true, null);
  end;

  begin
    perform public.save_receipt(
      '{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
      '[{"position":0,"raw_text":"   ","line_total_pence":100}]');
    perform rig.check('V5 blank raw_text refused', false, 'accepted');
  exception when check_violation then
    perform rig.check('V5 blank raw_text refused', true, null);
  end;

  -- A failing line rolls the header back with it (one statement).
  begin
    perform public.save_receipt(
      '{"store":"__v5_atomic__","purchased_on":"2026-09-20","purchased_on_estimated":false}',
      '[{"position":0,"raw_text":"OK","line_total_pence":100},
        {"position":1,"raw_text":"BAD","line_total_pence":250,"is_discount":true}]');
  exception when check_violation then
    null;
  end;
  perform rig.check('V5 a failing line leaves no header behind',
    not exists (select 1 from public.receipts where store = '__v5_atomic__'), null);

  begin
    perform public.save_receipt('{"purchased_on":"2026-09-20"}', '[]');
    perform rig.check('V5 missing purchased_on_estimated refused', false, 'accepted');
  exception when not_null_violation then
    perform rig.check('V5 missing purchased_on_estimated refused', true, null);
  end;

  -- Unreadable figures through the RPC: JSON null total, omitted line total.
  r := public.save_receipt(
    '{"purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":null}',
    '[{"position":0,"raw_text":"LOOSE CARROTS","qty":0.512,"qty_unit":"kg"}]');
  select printed_total_pence, currency into v_total, v_cur from public.receipts where id = r.id;
  select line_total_pence, qty into v_line, v_qty from public.receipt_lines where receipt_id = r.id;
  perform rig.check('V5 RPC: unreadable total and line total read back NULL',
    v_total is null and v_line is null,
    coalesce(v_total::text, 'null') || '/' || coalesce(v_line::text, 'null'));
  perform rig.check('V5 qty 0.512 kg accepted', v_qty = 0.512, v_qty::text);
  perform rig.check('V5 omitted currency is GBP', v_cur = 'GBP', v_cur);

  -- Direct inserts that OMIT the money columns: a default would show here.
  insert into public.receipts (user_id, purchased_on, purchased_on_estimated)
  values (a, '2026-09-20', true) returning id into rid;
  insert into public.receipt_lines (receipt_id, user_id, position, raw_text)
  values (rid, a, 0, 'NO PRICE');
  select printed_total_pence into v_total from public.receipts where id = rid;
  select line_total_pence into v_line from public.receipt_lines where receipt_id = rid;
  perform rig.check('V5 direct: omitted money columns read back NULL, not 0',
    v_total is null and v_line is null,
    coalesce(v_total::text, 'null') || '/' || coalesce(v_line::text, 'null'));
exception when others then
  perform rig.check('V5 block', false, sqlerrm);
end $$;
rollback;


-- ── V6. CASCADE — rolled back ───────────────────────────────────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  r public.receipts;
  n int;
begin
  r := public.save_receipt(
    '{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
    '[{"position":0,"raw_text":"A","line_total_pence":1},{"position":1,"raw_text":"B","line_total_pence":2}]');
  perform public.delete_receipt(r.id);
  select count(*) into n from public.receipt_lines where receipt_id = r.id;
  perform rig.check('V6 delete_receipt cascades to its lines', n = 0, n::text);
exception when others then
  perform rig.check('V6 delete_receipt cascades to its lines', false, sqlerrm);
end $$;
rollback;


-- ── V10. updated_at MOVES — container only, COMMITS, cleans up ──────────────
-- now() is the transaction start time, so insert and update must be separate
-- transactions or updated_at can't move even when the trigger works. psql is
-- in autocommit here: each statement below is its own transaction.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', false);
select (public.save_receipt(
  '{"store":"__v10__","purchased_on":"2026-09-20","purchased_on_estimated":true}', '[]')).id is not null as v10_saved;
select pg_sleep(0.02);
-- A direct PostgREST-style update as authenticated, so the trigger is proven
-- to fire for the client role (its EXECUTE is revoked from authenticated).
update public.receipts set store = '__v10b__' where store = '__v10__';
do $$
declare
  c timestamptz;
  u timestamptz;
begin
  select created_at, updated_at into c, u from public.receipts where store = '__v10b__';
  perform rig.check('V10 updated_at moves on update', u > c, c || ' -> ' || u);
exception when others then
  perform rig.check('V10 updated_at moves on update', false, sqlerrm);
end $$;
select public.delete_receipt(id) from public.receipts where store = '__v10b__';
reset role;
select set_config('request.jwt.claims', '', false);
do $$ begin
  perform rig.check('V10 probe cleaned up',
    not exists (select 1 from public.receipts where store like '__v10%'), null);
end $$;


-- ── V11. DELETE IS LOUD — rolled back ───────────────────────────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  r public.receipts;
  n int;
begin
  r := public.save_receipt(
    '{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
    '[{"position":0,"raw_text":"A","line_total_pence":1}]');

  perform set_config('request.jwt.claims', '{"sub":"' || b || '"}', true);
  begin
    perform public.delete_receipt(r.id);
    perform rig.check('V11 B deleting A''s receipt raises P0002', false, 'returned normally');
  exception when sqlstate 'P0002' then
    perform rig.check('V11 B deleting A''s receipt raises P0002', true, null);
  end;

  perform set_config('request.jwt.claims', '{"sub":"' || a || '"}', true);
  select count(*) into n from public.receipts where id = r.id;
  perform rig.check('V11 A''s receipt survives B''s attempt', n = 1, n::text);

  perform public.delete_receipt(r.id);
  select count(*) into n from public.receipt_lines where receipt_id = r.id;
  perform rig.check('V11 A deletes own receipt, lines gone', n = 0, n::text);

  begin
    perform public.delete_receipt(r.id);
    perform rig.check('V11 deleting again raises P0002', false, 'returned normally');
  exception when sqlstate 'P0002' then
    perform rig.check('V11 deleting again raises P0002', true, null);
  end;
exception when others then
  perform rig.check('V11 block', false, sqlerrm);
end $$;
rollback;


-- ============================================================================
-- 1b — update_receipt (20260930130000)
-- ============================================================================

-- ── V7. CROSS-ACCOUNT UPDATE RAISES, A UNCHANGED — rolled back ──────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  r public.receipts;
  h1 text;
  h2 text;
begin
  r := public.save_receipt(
    '{"store":"MINE","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":300}',
    '[{"position":0,"raw_text":"A","line_total_pence":100},{"position":1,"raw_text":"B","line_total_pence":200}]');
  h1 := rig.receipt_hash(r.id);

  perform set_config('request.jwt.claims', '{"sub":"' || b || '"}', true);
  begin
    perform public.update_receipt(r.id,
      '{"store":"hijack","purchased_on":"2026-09-20","printed_total_pence":1}', '[]');
    perform rig.check('V7 B updating A''s receipt raises P0002', false, 'returned normally');
  exception
    when sqlstate 'P0002' then
      perform rig.check('V7 B updating A''s receipt raises P0002', true, null);
    when others then
      perform rig.check('V7 B updating A''s receipt raises P0002', false, sqlstate || ' ' || sqlerrm);
  end;

  perform set_config('request.jwt.claims', '{"sub":"' || a || '"}', true);
  h2 := rig.receipt_hash(r.id);
  perform rig.check('V7 A''s receipt and lines unchanged', h1 = h2, null);
exception when others then
  perform rig.check('V7 block', false, sqlerrm);
end $$;
rollback;


-- ── V8. UPDATE REPLACES THE LINES EXACTLY — rolled back ─────────────────────
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  r public.receipts;
  u public.receipts;
  old_ids uuid[];
  n int;
  mismatches int;
  p_lines jsonb := '[{"position":0,"raw_text":"NEW ONE","qty":2,"qty_unit":"each","unit_price_pence":125,"line_total_pence":250},
                     {"position":1,"raw_text":"Nectar Price Saving","line_total_pence":-75,"is_discount":true}]';
begin
  r := public.save_receipt(
    '{"store":"OLD","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":600}',
    '[{"position":0,"raw_text":"X","line_total_pence":100},
      {"position":1,"raw_text":"Y","line_total_pence":200},
      {"position":2,"raw_text":"Z","line_total_pence":300}]');
  select array_agg(id) into old_ids from public.receipt_lines where receipt_id = r.id;

  u := public.update_receipt(r.id,
    '{"store":"NEW","purchased_on":"2026-09-20","printed_total_pence":175,"currency":"GBP"}', p_lines);

  select count(*) into n from public.receipt_lines where receipt_id = r.id;
  perform rig.check('V8 exactly the 2 payload lines remain', n = 2, n::text);

  select count(*) into n from public.receipt_lines where id = any (old_ids);
  perform rig.check('V8 none of the 3 original line ids remain', n = 0, n::text);

  -- Column for column, both directions.
  select count(*) into mismatches from (
    (select position, raw_text, qty, qty_unit, unit_price_pence, line_total_pence, is_discount
       from public.receipt_lines where receipt_id = r.id
     except
     select x.position, x.raw_text, x.qty, x.qty_unit, x.unit_price_pence, x.line_total_pence,
            coalesce(x.is_discount, false)
       from jsonb_to_recordset(p_lines) as x(position integer, raw_text text, qty numeric, qty_unit text,
                                               unit_price_pence integer, line_total_pence integer, is_discount boolean))
    union all
    (select x.position, x.raw_text, x.qty, x.qty_unit, x.unit_price_pence, x.line_total_pence,
            coalesce(x.is_discount, false)
       from jsonb_to_recordset(p_lines) as x(position integer, raw_text text, qty numeric, qty_unit text,
                                               unit_price_pence integer, line_total_pence integer, is_discount boolean)
     except
     select position, raw_text, qty, qty_unit, unit_price_pence, line_total_pence, is_discount
       from public.receipt_lines where receipt_id = r.id)
  ) d;
  perform rig.check('V8 saved lines match the payload column for column', mismatches = 0, mismatches::text);

  perform rig.check('V8 header replaced and returned',
    u.store = 'NEW' and u.printed_total_pence = 175 and u.user_id = r.user_id,
    u.store || '/' || u.printed_total_pence);
exception when others then
  perform rig.check('V8 block', false, sqlerrm);
end $$;
rollback;

-- Sabotage 8's check, on its own: A's update with a payload naming B leaves
-- the receipt and its lines A's.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  r public.receipts;
  u public.receipts;
  n int;
begin
  r := public.save_receipt('{"purchased_on":"2026-09-20","purchased_on_estimated":false}', '[]');
  begin
    u := public.update_receipt(r.id,
      '{"user_id":"bbbbbbbb-0000-4000-8000-00000000000b","purchased_on":"2026-09-20"}',
      '[{"position":0,"raw_text":"MINE","line_total_pence":100,"user_id":"bbbbbbbb-0000-4000-8000-00000000000b"}]');
    select count(*) into n from public.receipt_lines where receipt_id = r.id and user_id = a;
    perform rig.check('V8 payload user_id ignored on update', u.user_id = a and n = 1,
      u.user_id || ' lines ' || n);
  exception when others then
    perform rig.check('V8 payload user_id ignored on update', false, sqlerrm);
  end;
end $$;
rollback;


-- ── V9. A MID-UPDATE FAILURE LEAVES THE OLD RECEIPT INTACT — rolled back ────
-- The update runs through rig.update_step1 then rig.update_step2, each in its
-- own savepoint (a plpgsql exception block): a step that fails is rolled back
-- to its savepoint, a step that succeeds stays. Unsabotaged, step 1 is the
-- single update_receipt call and step 2 is a no-op, so the failing line takes
-- the header update and the delete back with it. Under sabotage 7b the two
-- steps are the client's two requests, and step 1's delete survives step 2's
-- failure — as it would across two transactions.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  r public.receipts;
  h1 text;
  h2 text;
  raised boolean := false;
  p_receipt jsonb := '{"store":"__v9_new__","purchased_on":"2026-09-20","printed_total_pence":300}';
  -- The second line violates receipt_lines_sign AFTER the delete has run.
  p_lines jsonb := '[{"position":0,"raw_text":"FINE","line_total_pence":100},
                     {"position":1,"raw_text":"BAD SAVING","line_total_pence":250,"is_discount":true}]';
begin
  r := public.save_receipt(
    '{"store":"__v9_old__","purchased_on":"2026-09-20","purchased_on_estimated":false,"printed_total_pence":600}',
    '[{"position":0,"raw_text":"X","line_total_pence":100},
      {"position":1,"raw_text":"Y","line_total_pence":200},
      {"position":2,"raw_text":"Z","line_total_pence":300}]');
  h1 := rig.receipt_hash(r.id);

  begin
    perform rig.update_step1(r.id, p_receipt, p_lines);
  exception when check_violation then
    raised := true;
  end;
  begin
    perform rig.update_step2(r.id, p_receipt, p_lines);
  exception when check_violation then
    raised := true;
  end;

  h2 := rig.receipt_hash(r.id);
  perform rig.check('V9 the failing line raises check_violation', raised, null);
  perform rig.check('V9 a failed update leaves the old receipt intact', h1 = h2,
    (select count(*) from public.receipt_lines where receipt_id = r.id) || ' lines remain');
exception when others then
  perform rig.check('V9 block', false, sqlerrm);
end $$;
rollback;


-- ── V10 (1b half). THE DATE FLAG — container only, COMMITS, cleans up ───────
-- Separate transactions again, so updated_at can move between them.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', false);
select (public.save_receipt(
  '{"store":"__v10d__","purchased_on":"2026-09-20","purchased_on_estimated":true}', '[]')).id as v10_id \gset
select set_config('rig.v10_id', :'v10_id', false);
select pg_sleep(0.02);
-- T2: an edit that keeps the date.
select (public.update_receipt(:'v10_id', '{"store":"__v10d__ edited","purchased_on":"2026-09-20"}', '[]')).id is not null as v10_t2;
do $$
declare
  c timestamptz;
  u timestamptz;
  est boolean;
begin
  select created_at, updated_at, purchased_on_estimated into c, u, est
    from public.receipts where id = current_setting('rig.v10_id')::uuid;
  perform rig.check('V10 update_receipt moves updated_at', u > c, c || ' -> ' || u);
  perform rig.check('V10 same date keeps purchased_on_estimated true', est, est::text);
exception when others then
  perform rig.check('V10 T2 block', false, sqlerrm);
end $$;
-- T3: an edit that changes the date.
select (public.update_receipt(:'v10_id', '{"store":"__v10d__ edited","purchased_on":"2026-09-21"}', '[]')).id is not null as v10_t3;
do $$
declare
  est boolean;
begin
  select purchased_on_estimated into est
    from public.receipts where id = current_setting('rig.v10_id')::uuid;
  perform rig.check('V10 changed date sets purchased_on_estimated false', not est, est::text);
exception when others then
  perform rig.check('V10 T3 block', false, sqlerrm);
end $$;
select public.delete_receipt(:'v10_id');
reset role;
select set_config('request.jwt.claims', '', false);
do $$ begin
  perform rig.check('V10 date-flag probe cleaned up',
    not exists (select 1 from public.receipts where store like '__v10d__%'), null);
end $$;


-- ── V11 (1b half). UPDATE AFTER DELETE IS LOUD — rolled back ────────────────
-- "Deleted on another device, then Save here": no row is resurrected.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":' || '"' || :A || '"}', true);
do $$
declare
  r public.receipts;
  n int;
begin
  r := public.save_receipt('{"purchased_on":"2026-09-20","purchased_on_estimated":false}',
    '[{"position":0,"raw_text":"A","line_total_pence":1}]');
  perform public.delete_receipt(r.id);
  begin
    perform public.update_receipt(r.id, '{"purchased_on":"2026-09-20"}',
      '[{"position":0,"raw_text":"RESURRECTED","line_total_pence":1}]');
    perform rig.check('V11 update after delete raises P0002', false, 'returned normally');
  exception
    when sqlstate 'P0002' then
      perform rig.check('V11 update after delete raises P0002', true, null);
    when others then
      perform rig.check('V11 update after delete raises P0002', false, sqlstate || ' ' || sqlerrm);
  end;
  select count(*) into n from public.receipt_lines where receipt_id = r.id;
  perform rig.check('V11 no lines resurrected', n = 0, n::text);
exception when others then
  perform rig.check('V11 update block', false, sqlerrm);
end $$;
rollback;
