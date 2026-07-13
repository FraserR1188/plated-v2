-- ============================================================
-- Social: plans are not food — migration 4
--
-- meal_entries_select_follower grants followers SELECT on every row of
-- meal_entries. Until migration 3 that was fine: every row was a meal you ate.
--
-- It is no longer true. Your followers can now see:
--   • PLANNED meals you have not eaten — rendered in their feed exactly like
--     food you did eat, and copyable into their own log as fact
--   • PENDING meals you never answered for
--   • SKIPPED meals you explicitly said you did NOT eat, still counting toward
--     the calorie total on their friends list
--
-- The fix goes in the POLICY, not in the queries. A filter in social.ts is one
-- forgotten .or() away from leaking again, and it would leak silently — nobody
-- looks at a slightly-too-high calorie count and thinks "ah, row-level security".
-- Put it here and the feed, the friends list, the copy path, and every feature
-- not yet written are all correct by default.
--
-- Same predicate as the correlation gate, for the same reason: a plan is not
-- evidence. What you INTEND to eat is nobody else's business until you've eaten it.
-- ============================================================

drop policy if exists meal_entries_select_follower on public.meal_entries;

create policy meal_entries_select_follower on public.meal_entries
  for select
  using (
        (planned = false or confirmed_at is not null)   -- logged, or a plan you confirmed
    and skipped_at is null                              -- you told us you didn't eat it
    and exists (
          select 1
            from public.follows f
           where f.follower_id  = auth.uid()
             and f.following_id = meal_entries.user_id
        )
  );

-- Your OWN rows are untouched: meal_entries_select_own still returns everything,
-- so you keep seeing your own plans. This narrows what OTHER people can see.

-- ── Verify ───────────────────────────────────────────────────
-- As a follower, a planned meal must be invisible:
--
--   select count(*) from public.meal_entries
--    where user_id = '<someone you follow>' and planned = true;
--   -- expect: 0, even though the rows exist
--
-- And as yourself, unchanged:
--
--   select count(*) from public.meal_entries where planned = true;
--   -- expect: your plans, all of them
--
-- Run these as `authenticated`, NOT as `postgres` — the postgres role bypasses
-- RLS entirely and will happily tell you everything is fine.