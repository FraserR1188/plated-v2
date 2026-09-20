begin;

-- The PL-028 rollback table is a repair artefact in `public`, so PostgREST
-- exposes it at /rest/v1/pl028_repair_backup. Supabase's default privileges
-- had granted anon and authenticated full DML on it, with no RLS -- meaning
-- anyone holding the shipped anon key could read every backed-up row, or
-- TRUNCATE the rollback path away. It also holds one row belonging to a
-- third-party user, captured by the backup's deliberately wide WHERE.
--
-- Recovery only ever runs as service_role or postgres, so no app role needs
-- any access at all.

revoke all on public.pl028_repair_backup from anon, authenticated;
alter table public.pl028_repair_backup enable row level security;

-- No policies, deliberately: with RLS on and no policy, every non-owner
-- role is denied. service_role bypasses RLS, which is the recovery path.

comment on table public.pl028_repair_backup is
  'PL-028 data repair rollback path, taken 2026-09-20 before the chia / '
  'cucumber / Fibre & Protein Bar repair. 41 rows: 35 meal_entries, 4 '
  'saved_ingredients, 2 meal_composition_items, each with its pre-repair '
  'values. Do not drop -- this is the only record of the old values. '
  'RLS on with no policies: service_role only.';

commit;
