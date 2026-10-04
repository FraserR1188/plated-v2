#!/usr/bin/env bash
# ============================================================================
# Container rig for 20260930120000_receipts.sql (commit 1a) and
# 20260930130000_update_receipt.sql (commit 1b)
#
# Executes the verification for real in a throwaway postgres:16-alpine
# container — no Supabase CLI, no migration chain (CLAUDE.md pattern). Needs
# the Docker daemon up (`docker ps`). Nothing touches the hosted database.
#
# For each variant it creates a fresh database with a stub `auth` schema
# (auth.users + auth.uid() reading request.jwt.claims, as PostgREST sets it),
# applies both migrations, applies the variant's sabotage patch (none for
# `clean`), and runs 20260930120000_rig_tests.sql.
#
#   clean       every check must PASS
#   sabotage N  the named check must FAIL (the sabotage is caught)
#
# Sabotages are SQL patches applied after the migration, equivalent to
# editing the migration text; numbering follows findings §5.
#
# Usage: bash supabase/migrations/verify/20260930120000_rig.sh
# ============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS=("$HERE/../20260930120000_receipts.sql" "$HERE/../20260930130000_update_receipt.sql")
TESTS="$HERE/20260930120000_rig_tests.sql"
CONTAINER="plated-rig-receipts"

psql_in() {  # psql_in <db> < file
  docker exec -i "$CONTAINER" psql -X -q -U postgres -d "$1" -v ON_ERROR_STOP=0 2>&1
}

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

cleanup
docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=rig postgres:16-alpine >/dev/null || exit 1
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
# pg_isready can pass during the image's init restart; wait for a real query.
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" psql -X -q -U postgres -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

psql_in postgres <<'SQL' >/dev/null
create role anon nologin;
create role authenticated nologin;
SQL

BOOTSTRAP=$(cat <<'SQL'
create schema auth;
create table auth.users (id uuid primary key);
insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-00000000000a'),
  ('bbbbbbbb-0000-4000-8000-00000000000b');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema rig;
create function rig.check(name text, ok boolean, detail text) returns void
language plpgsql as $$
begin
  if ok then
    raise notice 'PASS %', name;
  else
    raise notice 'FAIL %: %', name, coalesce(detail, '');
  end if;
end $$;
grant usage on schema rig to anon, authenticated;

-- V9's update path, as two steps that each run in their own savepoint
-- (a plpgsql exception block). By default the whole update is one RPC call
-- in step 1 and step 2 does nothing. Sabotage 7b replaces both to model a
-- client that splits delete and insert into two requests: each step then
-- succeeds or fails on its own, as two transactions would.
create function rig.update_step1(p_id uuid, p_receipt jsonb, p_lines jsonb) returns void
language plpgsql as $$
begin perform public.update_receipt(p_id, p_receipt, p_lines); end $$;
create function rig.update_step2(p_id uuid, p_receipt jsonb, p_lines jsonb) returns void
language plpgsql as $$ begin null; end $$;
SQL
)

declare -A PATCH EXPECT
PATCH[clean]=""
EXPECT[clean]=""

PATCH[s1]="alter policy receipt_lines_insert_own on public.receipt_lines with check (user_id = auth.uid());"
EXPECT[s1]="V4c"

PATCH[s2]="alter function public.save_receipt(jsonb, jsonb) security definer;"
EXPECT[s2]="V3 public.save_receipt(jsonb,jsonb) invoker"

PATCH[s3]=$(cat <<'SQL'
create or replace function public.save_receipt(p_receipt jsonb, p_lines jsonb)
returns public.receipts language plpgsql security invoker set search_path = '' as $$
declare r public.receipts;
begin
  insert into public.receipts (user_id, store, purchased_on, purchased_on_estimated, printed_total_pence, currency)
  values ((p_receipt->>'user_id')::uuid, p_receipt->>'store', (p_receipt->>'purchased_on')::date,
          (p_receipt->>'purchased_on_estimated')::boolean, (p_receipt->>'printed_total_pence')::integer,
          coalesce(p_receipt->>'currency', 'GBP'))
  returning * into r;
  insert into public.receipt_lines (receipt_id, user_id, position, raw_text, qty, qty_unit, unit_price_pence, line_total_pence, is_discount)
  select r.id, (p_receipt->>'user_id')::uuid, x.position, x.raw_text, x.qty, x.qty_unit, x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(position integer, raw_text text, qty numeric, qty_unit text, unit_price_pence integer, line_total_pence integer, is_discount boolean);
  return r;
end $$;
SQL
)
EXPECT[s3]="V4e"

PATCH[s4]="alter table public.receipt_lines alter column line_total_pence set default 0;"
EXPECT[s4]="V5 direct"

PATCH[s5]="alter table public.receipt_lines drop constraint receipt_lines_receipt_id_fkey, add constraint receipt_lines_receipt_id_fkey foreign key (receipt_id) references public.receipts (id);"
EXPECT[s5]="V6"

PATCH[s9]=$(cat <<'SQL'
create or replace function public.delete_receipt(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.receipts where id = p_id and user_id = auth.uid();
end $$;
SQL
)
EXPECT[s9]="V11 deleting again"

# ── 1b ──
PATCH[s6]=$(cat <<'SQL'
create or replace function public.update_receipt(p_id uuid, p_receipt jsonb, p_lines jsonb)
returns public.receipts language plpgsql security invoker set search_path = '' as $$
declare r public.receipts;
begin
  update public.receipts t
     set store = p_receipt->>'store', purchased_on = (p_receipt->>'purchased_on')::date,
         purchased_on_estimated = case when (p_receipt->>'purchased_on')::date is distinct from t.purchased_on
                                       then false else t.purchased_on_estimated end,
         printed_total_pence = (p_receipt->>'printed_total_pence')::integer,
         currency = coalesce(p_receipt->>'currency', t.currency)
   where t.id = p_id and t.user_id = auth.uid()
  returning t.* into r;
  -- sabotage 6: no `if not found` raise
  delete from public.receipt_lines where receipt_id = p_id;
  insert into public.receipt_lines (receipt_id, user_id, position, raw_text, qty, qty_unit, unit_price_pence, line_total_pence, is_discount)
  select p_id, auth.uid(), x.position, x.raw_text, x.qty, x.qty_unit, x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(position integer, raw_text text, qty numeric, qty_unit text, unit_price_pence integer, line_total_pence integer, is_discount boolean);
  return r;
end $$;
SQL
)
EXPECT[s6]="V7 B updating A's receipt raises P0002"

PATCH[s7a]=$(cat <<'SQL'
create or replace function public.update_receipt(p_id uuid, p_receipt jsonb, p_lines jsonb)
returns public.receipts language plpgsql security invoker set search_path = '' as $$
declare r public.receipts;
begin
  update public.receipts t
     set store = p_receipt->>'store', purchased_on = (p_receipt->>'purchased_on')::date,
         purchased_on_estimated = case when (p_receipt->>'purchased_on')::date is distinct from t.purchased_on
                                       then false else t.purchased_on_estimated end,
         printed_total_pence = (p_receipt->>'printed_total_pence')::integer,
         currency = coalesce(p_receipt->>'currency', t.currency)
   where t.id = p_id and t.user_id = auth.uid()
  returning t.* into r;
  if not found then raise exception 'update_receipt: no receipt % for this user', p_id using errcode = 'P0002'; end if;
  delete from public.receipt_lines where receipt_id = p_id;
  -- sabotage 7a: a failing line is swallowed after the delete has run
  begin
  insert into public.receipt_lines (receipt_id, user_id, position, raw_text, qty, qty_unit, unit_price_pence, line_total_pence, is_discount)
  select p_id, auth.uid(), x.position, x.raw_text, x.qty, x.qty_unit, x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(position integer, raw_text text, qty numeric, qty_unit text, unit_price_pence integer, line_total_pence integer, is_discount boolean);
  exception when others then
    return r;
  end;
  return r;
end $$;
SQL
)
EXPECT[s7a]="V9 a failed update leaves the old receipt intact"

# Sabotage 7b: the client-side split. Each step is its own request, so its
# own transaction: a failing step 2 can't undo step 1.
PATCH[s7b]=$(cat <<'SQL'
create or replace function rig.update_step1(p_id uuid, p_receipt jsonb, p_lines jsonb) returns void
language plpgsql as $$
begin
  delete from public.receipt_lines where receipt_id = p_id;   -- request 1: delete_receipt_lines(p_id)
end $$;
create or replace function rig.update_step2(p_id uuid, p_receipt jsonb, p_lines jsonb) returns void
language plpgsql as $$
begin                                                         -- request 2: insert_receipt_lines(...)
  insert into public.receipt_lines (receipt_id, user_id, position, raw_text, qty, qty_unit, unit_price_pence, line_total_pence, is_discount)
  select p_id, auth.uid(), x.position, x.raw_text, x.qty, x.qty_unit, x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(position integer, raw_text text, qty numeric, qty_unit text, unit_price_pence integer, line_total_pence integer, is_discount boolean);
end $$;
SQL
)
EXPECT[s7b]="V9 a failed update leaves the old receipt intact"

PATCH[s8]=$(cat <<'SQL'
create or replace function public.update_receipt(p_id uuid, p_receipt jsonb, p_lines jsonb)
returns public.receipts language plpgsql security invoker set search_path = '' as $$
declare r public.receipts;
begin
  update public.receipts t
     set user_id = (p_receipt->>'user_id')::uuid,   -- sabotage 8
         store = p_receipt->>'store', purchased_on = (p_receipt->>'purchased_on')::date,
         purchased_on_estimated = case when (p_receipt->>'purchased_on')::date is distinct from t.purchased_on
                                       then false else t.purchased_on_estimated end,
         printed_total_pence = (p_receipt->>'printed_total_pence')::integer,
         currency = coalesce(p_receipt->>'currency', t.currency)
   where t.id = p_id and t.user_id = auth.uid()
  returning t.* into r;
  if not found then raise exception 'update_receipt: no receipt % for this user', p_id using errcode = 'P0002'; end if;
  delete from public.receipt_lines where receipt_id = p_id;
  insert into public.receipt_lines (receipt_id, user_id, position, raw_text, qty, qty_unit, unit_price_pence, line_total_pence, is_discount)
  select p_id, (p_receipt->>'user_id')::uuid, x.position, x.raw_text, x.qty, x.qty_unit, x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(position integer, raw_text text, qty numeric, qty_unit text, unit_price_pence integer, line_total_pence integer, is_discount boolean);
  return r;
end $$;
SQL
)
EXPECT[s8]="V8 payload user_id ignored on update"

overall=0
for v in clean s1 s2 s3 s4 s5 s9 s6 s7a s7b s8; do
  db="rig_$v"
  echo "create database $db;" | psql_in postgres >/dev/null
  echo "$BOOTSTRAP" | psql_in "$db" >/dev/null
  mig_out=$(for m in "${MIGRATIONS[@]}"; do psql_in "$db" < "$m"; done)
  if echo "$mig_out" | grep -q 'ERROR'; then
    echo "[$v] MIGRATION ERROR:"; echo "$mig_out"; overall=1; continue
  fi
  if [ -n "${PATCH[$v]}" ]; then
    patch_out=$(echo "${PATCH[$v]}" | psql_in "$db")
    if echo "$patch_out" | grep -q 'ERROR'; then
      echo "[$v] PATCH ERROR:"; echo "$patch_out"; overall=1; continue
    fi
  fi
  out=$(psql_in "$db" < "$TESTS")
  results=$(echo "$out" | sed -n 's/^.*NOTICE:  \(PASS .*\|FAIL .*\)$/\1/p')
  errors=$(echo "$out" | grep 'ERROR' || true)
  npass=$(echo "$results" | grep -c '^PASS' || true)
  nfail=$(echo "$results" | grep -c '^FAIL' || true)

  if [ "$v" = clean ]; then
    echo "[clean] $npass pass, $nfail fail"
    echo "$results" | sed 's/^/    /'
    [ -n "$errors" ] && { echo "    stray errors:"; echo "$errors" | sed 's/^/      /'; }
    [ "$nfail" -eq 0 ] && [ "$npass" -gt 0 ] && [ -z "$errors" ] || overall=1
  else
    caught=$(echo "$results" | grep "^FAIL ${EXPECT[$v]}" || true)
    if [ -n "$caught" ]; then
      echo "[$v] RED as required ($nfail fail): $(echo "$caught" | head -1)"
    else
      echo "[$v] NOT CAUGHT: expected FAIL ${EXPECT[$v]}"; overall=1
    fi
  fi
done

[ "$overall" -eq 0 ] && echo "RIG OK" || echo "RIG FAILED"
exit "$overall"
