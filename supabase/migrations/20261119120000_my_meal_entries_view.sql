-- ============================================================================
-- 20261119120000_my_meal_entries_view.sql
-- my_meal_entries: the signed-in user's own meal_entries rows, read-only
--
-- WHY: the web dashboard (plated/web, src/lib/habits.ts) read meal_entries
-- with no user_id filter, on the assumption that RLS returns only the owner's
-- rows. It doesn't, by design: meal_entries_select_follower
-- (20260823150000_share_planned.sql) also returns an accepted friend's
-- logged/confirmed rows, in either direction of the follow, so the social
-- copy feature can read them. The dashboard summed those rows into the
-- reader's own date|meal_type buckets. MEASURED 2026-11-19 on Robbie's
-- account at 90 days: 80 own breakfast-days against a panel n of 82, and 5
-- meal-size dots above 2,000 kcal against 0 such slot-days in user-scoped SQL.
-- Read directly as `authenticated`, meal_entries returned 1,486 own rows and
-- 719 friends' rows (MEASURED 2026-11-19).
--
-- meal_entries ONLY: whoop_correlation, checked the same way, returned own
-- rows only (MEASURED 2026-11-19), so the correlation path needs no view.
--
-- THE POLICY IS CORRECT AND IS NOT CHANGED HERE. Every app read already
-- filters explicitly (useStore.ts personal select: .eq("user_id", userId);
-- the three social.ts selects each filter to one followed user). The
-- dashboard was the only consumer relying on RLS alone to mean "own rows".
--
-- WHY A VIEW, NOT A CLIENT FILTER: the scoping lives in one place, and a
-- future dashboard query can't forget it.
--
-- DESIGN:
--   - `where user_id = (select auth.uid())`: scopes to the caller. The
--     subselect lets the planner evaluate auth.uid() once per query, not
--     per row (Supabase RLS performance guidance).
--   - security_invoker = on: meal_entries' own RLS still applies underneath,
--     so the view can never return more than the caller could read directly.
--     The WHERE narrows that to the caller's own rows. Neither depends on
--     the other.
--   - Explicit column list, not `*` (Postgres freezes `*` at create time
--     anyway). It is exactly what habits.ts selects plus the two eaten-gate
--     columns it filters on. Deliberately OMITTED: eaten_at, logged_at,
--     eaten_at_estimated. The dashboard's phase 2 brief (rule 3) found clock
--     times largely unusable (53% of eaten entries carry a copied or bundle
--     time), so leaving them out puts that rule in the database. Add them
--     back in a new migration only with a reason that survives that finding.
--   - User restriction ONLY. The eaten gate
--     (planned = false or confirmed_at is not null) stays in habits.ts, so it
--     lives in one place, matching whoop_cycle_nutrition.
--   - Read-only: a single-table view like this is auto-updatable, and
--     Supabase's default privileges grant new public objects to anon and
--     authenticated. `revoke all` then `grant select` to authenticated only.
--     (security_invoker would confine writes to what the base-table policies
--     allow anyway; the dashboard is read-only by rule, so the view is too.)
--
-- DEPLOY ORDER: push this BEFORE deploying the dashboard build that reads
-- my_meal_entries. In the other order the habits panels show
-- "Couldn't load meals" until the push.
--
-- Verification: supabase/migrations/verify/20261119120000_verify.sql
-- ============================================================================

create view public.my_meal_entries
with (security_invoker = on) as
select
  id,
  user_id,
  name,
  brand,
  barcode,
  off_id,
  custom_food_id,
  source,
  date,
  meal_type,
  calories,
  protein,
  carbs,
  fat,
  planned,
  confirmed_at
from public.meal_entries
where user_id = (select auth.uid());

comment on view public.my_meal_entries is
  'The caller''s OWN meal_entries rows only, read-only. meal_entries RLS also returns accepted friends'' rows (meal_entries_select_follower); this view does not. No eaten gate: callers apply planned = false OR confirmed_at IS NOT NULL themselves. Clock-time columns (eaten_at, logged_at, eaten_at_estimated) deliberately omitted. Read by the web dashboard (plated/web src/lib/habits.ts). See 20261119120000_my_meal_entries_view.sql.';

revoke all on public.my_meal_entries from anon, authenticated;
grant select on public.my_meal_entries to authenticated;
