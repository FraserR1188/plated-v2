#!/usr/bin/env bash
# ============================================================================
# Container rig for 20261025130000_whoop_cycle_nutrition_incomplete_known.sql
# (PL-059)
#
# Executes the view change for real in a throwaway postgres:16-alpine
# container — no Supabase CLI, no migration chain (CLAUDE.md pattern). Needs
# the Docker daemon up (`docker ps`). Nothing touches the hosted database.
#
# For each variant, a fresh database:
#   1. stub auth schema (auth.uid() reading request.jwt.claims, as PostgREST
#      sets it) and the anon/authenticated roles;
#   2. STUB TABLES for every real-table read of whoop_cycle_nutrition and
#      whoop_correlation (meal_entries, biometric_periods_resolved,
#      whoop_sleeps, biometric_sleep_sessions), each with RLS on user_id;
#   3. the CURRENT whoop_cycle_nutrition (20260831120000) and the CURRENT
#      whoop_correlation (20260901130000), extracted verbatim from those
#      migrations — so the replace runs with the real dependent in place;
#   4. the fixture rows, then a snapshot of the OLD view (rig.old_wcn);
#   5. this migration, with the variant's sabotage edit applied to its text;
#   6. 20261025130000_rig_tests.sql.
#
#   clean          every check must PASS
#   revert_count   *_known_meals back to plain count(m.x): F1, F1b, F6, F6b
#                  and F9c must FAIL
#   no_invoker     `with (security_invoker = on)` removed: F8, F9, F9b and
#                  F9c must FAIL
#
# Usage: bash supabase/migrations/verify/20261025130000_rig.sh
# ============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../20261025130000_whoop_cycle_nutrition_incomplete_known.sql"
OLD_WCN="$HERE/../20260831120000_whoop_cycle_nutrition_known_meals.sql"
OLD_WC="$HERE/../20260901130000_whoop_correlation_hc_sleep_widening.sql"
TESTS="$HERE/20261025130000_rig_tests.sql"
CONTAINER="plated-rig-wcn-incomplete"
A="aaaaaaaa-0000-4000-8000-00000000000a"
B="bbbbbbbb-0000-4000-8000-00000000000b"

psql_in() {  # psql_in <db> < sql
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
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" psql -X -q -U postgres -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

psql_in postgres <<'SQL' >/dev/null
create role anon nologin;
create role authenticated nologin;
SQL

# The two current view definitions, verbatim from their migrations.
OLD_WCN_SQL=$(awk '/^create or replace view public.whoop_cycle_nutrition/{on=1} on{print} on && /b.average_heart_rate, b.timezone_offset;/{exit}' "$OLD_WCN")
OLD_WC_SQL=$(awk '/^create view public.whoop_correlation/{on=1} on{print} on && /rv.sleep_source_record_id;/{exit}' "$OLD_WC")

BOOTSTRAP=$(cat <<SQL
create schema auth;
create function auth.uid() returns uuid language sql stable as \$\$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid
\$\$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema rig;
create function rig.check(name text, ok boolean, detail text) returns void
language plpgsql as \$f\$
begin
  if coalesce(ok, false) then raise notice 'PASS %', name;
  else raise notice 'FAIL %: %', name, coalesce(detail, ''); end if;
end \$f\$;
grant usage on schema rig to anon, authenticated;

create table public.meal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, eaten_at timestamptz not null,
  planned boolean not null default false, confirmed_at timestamptz,
  eaten_at_estimated boolean not null default false,
  calories numeric not null, protein numeric not null,
  carbs numeric not null, fat numeric not null,
  sat_fat numeric, salt numeric, fibre numeric, sugar numeric,
  incomplete_nutrients text[]
);
create table public.biometric_periods_resolved (
  user_id uuid not null, source_period_id text not null,
  period_start timestamptz not null, period_end timestamptz,
  strain_score_state text, strain numeric,
  cycle_energy_kilojoule numeric, cycle_average_heart_rate numeric,
  timezone_offset text,
  recovery_score numeric, recovery_score_state text,
  spo2_percentage numeric, skin_temp_celsius numeric, user_calibrating boolean,
  resting_heart_rate numeric, hrv numeric, hrv_method text, hrv_unit text,
  sleep_performance numeric, sleep_score_state text,
  sleep_ingest_transport text, sleep_origin_package text,
  sleep_source_record_id text
);
create table public.whoop_sleeps (
  user_id uuid not null, id text not null, start timestamptz not null,
  sleep_efficiency_percentage numeric, sleep_consistency_percentage numeric,
  respiratory_rate numeric, total_in_bed_time_milli bigint,
  total_slow_wave_sleep_time_milli bigint, total_rem_sleep_time_milli bigint,
  total_awake_time_milli bigint, disturbance_count integer, nap boolean
);
create table public.biometric_sleep_sessions (
  user_id uuid not null, origin_package text, provider_record_id text,
  total_in_bed_ms bigint, total_awake_ms bigint, total_light_ms bigint,
  total_deep_ms bigint, total_rem_ms bigint, total_sleep_ms bigint
);
do \$d\$
declare t text;
begin
  foreach t in array array['meal_entries','biometric_periods_resolved',
                           'whoop_sleeps','biometric_sleep_sessions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated
                    using (auth.uid() = user_id)', t || '_own', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end \$d\$;

$OLD_WCN_SQL
grant select on public.whoop_cycle_nutrition to authenticated;
$OLD_WC_SQL
grant select on public.whoop_correlation to authenticated;

-- ── Fixture ────────────────────────────────────────────────────────────
insert into public.biometric_periods_resolved
  (user_id, source_period_id, period_start, period_end, strain_score_state, timezone_offset)
values
  ('$A', 'C1', '2026-10-20T06:00Z', '2026-10-21T06:00Z', 'SCORED', '+01:00'),
  ('$A', 'C2', '2026-10-21T06:00Z', '2026-10-22T06:00Z', 'SCORED', '+01:00'),
  ('$A', 'C3', '2026-10-22T06:00Z', '2026-10-23T06:00Z', 'SCORED', '+01:00'),
  ('$B', 'B1', '2026-10-20T06:00Z', '2026-10-21T06:00Z', 'SCORED', '+01:00');

insert into public.meal_entries
  (user_id, eaten_at, planned, calories, protein, carbs, fat,
   sat_fat, salt, fibre, sugar, incomplete_nutrients)
values
  ('$A', '2026-10-20T08:00Z', false, 300, 10, 40, 8, null, 0.5,  5,    0,    null),
  ('$A', '2026-10-20T13:00Z', false, 500, 25, 50, 15, null, 0.2, 3,    4,    '{fibre,sugar}'),
  ('$A', '2026-10-20T19:00Z', false, 400, 20, 30, 12, null, null, null, null, null),
  ('$A', '2026-10-20T21:00Z', true,  200, 5,  20, 5,  null, null, 10,   null, '{fibre}'),
  ('$A', '2026-10-21T12:00Z', false, 450, 30, 40, 10, 3,    0.8,  7,    6,    null),
  ('$B', '2026-10-20T12:00Z', false, 350, 15, 35, 9,  1,    0.3,  2,    5,    '{fibre}');

create table rig.old_wcn as select * from public.whoop_cycle_nutrition;
SQL
)

run_variant() {  # run_variant <name> <sed-expression applied to the migration>
  local db="rig_$1"
  echo "=================== $1 ==================="
  psql_in postgres <<<"create database $db;" >/dev/null
  psql_in "$db" <<<"$BOOTSTRAP" | grep -E "ERROR" || true
  sed -E "$2" "$MIG" | psql_in "$db" | grep -E "ERROR" || true
  psql_in "$db" < "$TESTS" | grep -E "PASS|FAIL|ERROR"
}

run_variant clean "s/^$//"
run_variant revert_count \
  's/count\(m\.([a-z_]+)\)[[:space:]]+filter \(where not coalesce\([^)]*\), false\)\)/count(m.\1)/'
run_variant no_invoker 's/^with \(security_invoker = on\) as$/as/'
