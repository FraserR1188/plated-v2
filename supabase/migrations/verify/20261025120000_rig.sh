#!/usr/bin/env bash
# ============================================================================
# Container rig for 20261025120000_incomplete_nutrients.sql (PL-059)
#
# Executes the migration and its verify file's V1/V2/V3/V5 for real in a
# throwaway postgres:16-alpine container — no Supabase CLI, no migration
# chain (CLAUDE.md pattern). Needs the Docker daemon up (`docker ps`).
# Nothing touches the hosted database.
#
# meal_entries / meal_compositions / meal_composition_items are STUBS with
# the columns V1 hashes, a few seed rows, and none of the real triggers or
# policies — the rig proves the migration's own DDL and the verify SQL, not
# the rest of the schema.
#
# Variants (each a fresh database):
#   clean             R1 hashes equal, R2 0/0, R3 8 PASS + valid row accepted
#   drop_nonempty     sabotage: S1 must print FAIL on both tables
#   drop_small_four   sabotage: S2 and S4 must print FAIL on both tables
#   drop_has_value    sabotage: S3 must print FAIL on both tables
#
# Usage: bash supabase/migrations/verify/20261025120000_rig.sh
# ============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../20261025120000_incomplete_nutrients.sql"
VERIFY="$HERE/20261025120000_verify.sql"
CONTAINER="plated-rig-incomplete"
USER_A="aaaaaaaa-0000-4000-8000-00000000000a"

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

STUBS=$(cat <<SQL
create table public.meal_compositions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, name text not null
);
create table public.meal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, date date not null, logged_at timestamptz not null,
  name text not null, brand text, source text not null default 'search',
  barcode text, off_id text, serving_g numeric, meal_type text not null,
  calories numeric not null, protein numeric not null,
  carbs numeric not null, fat numeric not null,
  sat_fat numeric, salt numeric, fibre numeric, sugar numeric,
  eaten_at timestamptz not null, planned boolean not null default false,
  confirmed_at timestamptz, skipped_at timestamptz,
  image_url text, image_path text, custom_food_id uuid,
  eaten_at_estimated boolean not null default false
);
create table public.meal_composition_items (
  id uuid primary key default gen_random_uuid(),
  composition_id uuid not null references public.meal_compositions(id),
  user_id uuid not null, position integer not null default 0,
  name text not null, brand text, serving_g numeric,
  calories numeric not null, protein numeric not null,
  carbs numeric not null, fat numeric not null,
  sat_fat numeric, salt numeric, fibre numeric, sugar numeric,
  meal_type text, eaten_time time,
  barcode text, off_id text, image_url text, image_path text,
  custom_food_id uuid
);
insert into public.meal_entries
  (user_id, date, logged_at, name, meal_type, calories, protein, carbs, fat,
   sat_fat, salt, fibre, sugar, eaten_at)
values
  ('$USER_A', '2026-10-20', '2026-10-20T12:00Z', 'Seed known',   'lunch',  400, 20, 40, 10, 2, 0.5, 6, 3,    '2026-10-20T12:00Z'),
  ('$USER_A', '2026-10-20', '2026-10-20T19:00Z', 'Seed unknown', 'dinner', 600, 30, 50, 20, null, null, null, null, '2026-10-20T19:00Z'),
  ('$USER_A', '2026-10-21', '2026-10-21T08:00Z', 'Seed zero',    'breakfast', 150, 5, 20, 3, 0, 0, 0, 0, '2026-10-21T08:00Z');
insert into public.meal_compositions (id, user_id, name)
values ('cccccccc-0000-4000-8000-00000000000c', '$USER_A', 'Seed bundle');
insert into public.meal_composition_items
  (composition_id, user_id, position, name, calories, protein, carbs, fat,
   sat_fat, salt, fibre, sugar, meal_type, eaten_time)
values
  ('cccccccc-0000-4000-8000-00000000000c', '$USER_A', 0, 'Seed item 1', 200, 5, 30, 4, 1, 0.1, 3, 8, 'breakfast', '07:30'),
  ('cccccccc-0000-4000-8000-00000000000c', '$USER_A', 1, 'Seed item 2', 50, 1, 2, 0, null, null, null, null, 'breakfast', '08:15');
SQL
)

# A section of the verify file, from the line starting with $1 up to (not
# including) the line starting with $2.
section() {
  awk -v a="$1" -v b="$2" 'index($0,a)==1{on=1} index($0,b)==1{on=0} on' "$VERIFY"
}

V1=$(section "-- ── V1." "-- ── APPLY")
V2=$(section "-- ── V2." "-- ── V3.")
V3=$(section "-- ── V3." "-- ── V4.")
V5=$(section "-- ── V5." "-- ── V6." | sed "s/<YOUR USER UUID>/$USER_A/")

run_variant() {  # run_variant <name> <sabotage-sql>
  local db="rig_$1"
  echo "=================== $1 ==================="
  psql_in postgres <<<"create database $db;" >/dev/null
  psql_in "$db" <<<"$STUBS" >/dev/null
  psql_in "$db" <<<"$V1" >/dev/null
  psql_in "$db" < "$MIGRATION"
  [ -n "$2" ] && psql_in "$db" <<<"$2"
  echo "--- R1 (V2: rows/hash equal) ---"
  psql_in "$db" <<<"$V2" | grep -v "^SELECT"
  echo "--- R2 (V3: flagged rows) ---"
  psql_in "$db" <<<"$V3"
  echo "--- R3 (V5: sabotage inserts) ---"
  psql_in "$db" <<<"$V5" | grep -E "PASS|FAIL|WRONG|ERROR"
}

run_variant clean ""
run_variant drop_nonempty "
  alter table public.meal_entries drop constraint meal_entries_incomplete_nutrients_nonempty;
  alter table public.meal_composition_items drop constraint meal_composition_items_incomplete_nutrients_nonempty;"
run_variant drop_small_four "
  alter table public.meal_entries drop constraint meal_entries_incomplete_nutrients_small_four;
  alter table public.meal_composition_items drop constraint meal_composition_items_incomplete_nutrients_small_four;"
run_variant drop_has_value "
  alter table public.meal_entries drop constraint meal_entries_incomplete_nutrients_has_value;
  alter table public.meal_composition_items drop constraint meal_composition_items_incomplete_nutrients_has_value;"
