begin;

-- ── 1. Drop the third user's row ───────────────────────────────────────────
-- Their chia library row was captured by the backup's deliberately wide
-- WHERE and never modified, so it carries no rollback value. It is not
-- Robbie's data to hold. Deleted on his instruction, 2026-09-20.

create temporary table _before as
  select count(*) as rows,
         count(*) filter (where left(user_id::text,8) = 'f3b49ef9') as third_party
  from public.pl028_repair_backup;

delete from public.pl028_repair_backup
where left(user_id::text,8) = 'f3b49ef9';

-- ── 2. Out of `public` entirely ────────────────────────────────────────────
-- Supabase exposes `public` through PostgREST and grants anon/authenticated
-- full DML on new tables there by default, so a repair artefact is a live
-- API endpoint from the moment it exists. `maintenance` is not in the
-- project's exposed schema list, so PostgREST will not serve it at all --
-- the table stops being addressable rather than merely being denied.

create schema if not exists maintenance;

-- No app role gets even USAGE on the schema. Without it, the table cannot be
-- named at all, whatever the table grants happen to say.
revoke all on schema maintenance from anon, authenticated;
revoke all on all tables in schema maintenance from anon, authenticated;

alter table public.pl028_repair_backup set schema maintenance;

-- RLS travels with the table, but re-stated so it is visible here rather
-- than inferred from an earlier script.
alter table maintenance.pl028_repair_backup enable row level security;
revoke all on maintenance.pl028_repair_backup from anon, authenticated;

comment on schema maintenance is
  'Operational artefacts that must never be reachable over PostgREST: '
  'repair backups, rollback paths, one-off snapshots. Not in the project''s '
  'exposed schema list. Nothing the app reads belongs here.';

select jsonb_pretty(jsonb_build_object(
  'rows_before',        (select rows from _before),
  'third_party_before', (select third_party from _before),
  'rows_after',         (select count(*) from maintenance.pl028_repair_backup),
  'by_table_after',     (select jsonb_object_agg(source_table, n) from (
      select source_table, count(*) as n
      from maintenance.pl028_repair_backup group by 1) z),
  'accounts_after',     (select jsonb_agg(to_jsonb(q)) from (
      select left(user_id::text,8) as account, count(*) as rows
      from maintenance.pl028_repair_backup group by 1 order by 1) q)
)) as results;

commit;
