-- ============================================================================
-- 20260818135437_account_deletions.sql
-- public.account_deletions — retry ledger for in-app account deletion
--
-- WHY THIS TABLE EXISTS
--   Account deletion (delete-account Edge Function, added alongside this
--   migration) tears down three independent systems in sequence: a WHOOP
--   token revocation, the auth.users row itself, and a Storage sweep. Any
--   of the three can fail independently and the failure needs to be
--   retryable without the caller's session, because a failure at step 2 or
--   3 means auth.users may already be gone — there is no more JWT to retry
--   with from the client. This table is the only surviving record of what
--   happened and what is still owed to that user_id.
--
-- TWO DELIBERATELY UNUSUAL DESIGN CHOICES — DO NOT "FIX" EITHER
--
--   1. user_id has NO foreign key to auth.users. This is not an oversight.
--      ON DELETE CASCADE would destroy this row at the exact moment
--      admin.auth.admin.deleteUser() succeeds — the moment it becomes the
--      only surviving record of the deletion. ON DELETE RESTRICT would
--      block the auth.users delete outright. Either FK defeats the table's
--      entire purpose. The column is a plain uuid, intentionally
--      disconnected from referential integrity.
--
--   2. RLS is enabled with ZERO policies, and grants are revoked on top.
--      RLS-with-no-policies already denies every row to anon and
--      authenticated — service_role bypasses RLS entirely and is the only
--      writer/reader this table needs. The explicit revoke below is belt
--      and braces: Supabase's default privileges grant anon/authenticated
--      full DML on newly created public tables regardless of RLS, so if a
--      future `disable row level security` ever happens during debugging,
--      the revoke is what still stands between the anon key (inside the
--      APK) and this table. Same reasoning as whoop_tokens and
--      whoop_oauth_states in 20260711194107_whoop_connection.sql.
--
-- NO EMAIL COLUMN
--   user_id alone is a pseudonymous accountability record for an erasure
--   event — defensible under GDPR Art. 5(2) (accountability) without being
--   personal data about someone who asked to be forgotten. An email column
--   would turn this into retained personal data and would need disclosing
--   as a retention carve-out in the privacy policy. Deliberately omitted.
--
-- last_error DISCIPLINE (prose constraint, not enforceable in SQL)
--   Holds a stage label and a status code only — e.g. "whoop_revoke:503",
--   "storage_remove:timeout" — NEVER a raw response body. Same discipline
--   as scrubErrorForReport (src/lib/scrub.ts): PostgREST and third-party
--   error bodies can echo row content back, and this table is designed to
--   outlive the account it describes.
--
-- whoop_revoked IS NULLABLE ON PURPOSE
--   NULL means "not attempted" (no WHOOP connection existed to revoke).
--   false means "attempted and failed." true means "attempted and
--   succeeded." Coalescing this to false anywhere would erase the
--   distinction between "there was nothing to revoke" and "revocation
--   failed" — two different facts a retry needs to tell apart.
-- ============================================================================

create table if not exists public.account_deletions (
  id                       uuid primary key default gen_random_uuid(),

  -- No FK to auth.users — see header. Deliberately disconnected.
  user_id                  uuid not null,

  requested_at             timestamptz not null default now(),
  auth_deleted_at          timestamptz,

  whoop_revoke_attempted   boolean not null default false,
  -- NULL = not attempted, false = attempted and failed, true = succeeded.
  whoop_revoked            boolean,

  storage_objects_found    int,
  storage_objects_removed  int,
  storage_swept_at         timestamptz,

  -- Stage label + status code only (e.g. "auth_delete:500"). Never a raw
  -- response body — this row outlives the account it describes.
  last_error               text
);

create index if not exists account_deletions_user_id_idx
  on public.account_deletions (user_id);

alter table public.account_deletions enable row level security;
-- No policies: RLS-with-zero-policies denies anon and authenticated
-- entirely. service_role bypasses RLS and is the only intended writer.

-- Belt and braces — see header point 2. Supabase's default grants would
-- otherwise leave anon/authenticated with table-level DML that RLS alone
-- is then the only thing blocking.
revoke all on public.account_deletions from anon, authenticated;

comment on table public.account_deletions is
  'Retry ledger for in-app account deletion. user_id has NO foreign key to '
  'auth.users by design — see the migration header. service_role only.';

comment on column public.account_deletions.user_id is
  'Deliberately NOT a foreign key. An FK would either cascade-delete this '
  'row the moment auth.users is deleted (destroying the only surviving '
  'record of the deletion) or block the delete outright (RESTRICT).';

comment on column public.account_deletions.whoop_revoked is
  'NULL = not attempted (no WHOOP connection to revoke). false = attempted '
  'and failed. true = attempted and succeeded. Do not coalesce to false.';

comment on column public.account_deletions.last_error is
  'Stage label + status code only, e.g. "whoop_revoke:503" or '
  '"storage_remove:timeout". Never a raw response body — this table '
  'outlives the account it describes.';


-- ============================================================================
-- VERIFICATION — hard gates
-- ============================================================================

-- G1. RLS is ON.
--
-- select relrowsecurity from pg_class where relname = 'account_deletions';
-- Expect: true

-- G2. Zero policies exist.
--
-- select count(*) from pg_policies where tablename = 'account_deletions';
-- Expect: 0

-- G3. ANTI-REGRESSION GATE. No foreign key exists on user_id, ever. If a
--     future migration "tidies up" by adding one, this must fail loudly.
--
-- select count(*) from pg_constraint
-- where conrelid = 'public.account_deletions'::regclass and contype = 'f';
-- Expect: 0

-- G4. Second-account check — run from the APP's anon-key client, signed in
--     as a real (non-service-role) test user. Assert the ROW COUNT, not
--     merely "it didn't throw":
--
--   const { data, error } = await supabase.from('account_deletions').select('*');
--   // Expect: data === [] (length 0), or a permission error. Either is a pass.
--   const ins = await supabase.from('account_deletions').insert({ user_id: '...' });
--   // Expect: ins.error is set — the insert must be rejected.

-- G5. Storage convention check — belongs here because the Edge Function's
--     prefix-based sweep (commit 2) depends on this being true. A non-uuid
--     first path segment would mean something wrote outside the
--     {user_id}/{custom_food_id}/{kind}.jpg convention using the service
--     role, and prefix-based sweeping would silently miss it.
--
-- select count(*) from storage.objects
-- where bucket_id = 'custom-food-images'
--   and (storage.foldername(name))[1] !~
--     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
-- Expect: 0

-- ============================================================================
-- MANUAL TEST CHECKLIST
-- ============================================================================
-- [ ] Apply this migration.
-- [ ] Run G1 — relrowsecurity is true.
-- [ ] Run G2 — zero rows in pg_policies for this table.
-- [ ] Run G3 — zero foreign keys on this table. Re-run after any future
--     migration touches account_deletions, permanently.
-- [ ] Run G4 from the app's anon-key client, signed in as a real test
--     user — select returns zero rows (or errors), insert is rejected.
-- [ ] Run G5 — zero non-uuid first-segment objects in custom-food-images.
--     If this is non-zero, stop: fix the offending objects (or the
--     convention) before commit 2's prefix sweep ships.
-- ============================================================================
