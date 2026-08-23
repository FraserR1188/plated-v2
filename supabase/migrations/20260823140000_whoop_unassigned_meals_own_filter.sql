-- ============================================================
-- whoop_unassigned_meals: make the own-user guarantee explicit.
--
-- Defined in 20260712180000_meal_planning.sql. Its `placed` CTE reads
-- `from public.meal_entries m` with no filter of its own — the single-user
-- guarantee came ENTIRELY from RLS on meal_entries (own-row policies OR
-- meal_entries_select_follower) plus an INCIDENTAL side effect of
-- `join span s on s.user_id = p.user_id`: span is derived from
-- whoop_cycles, itself RLS'd to auth.uid(), so span can only ever contain
-- the caller's own user_id — which forces every row that survives the join
-- to have p.user_id = auth.uid() too, without anything saying so.
--
-- That held (verified: a friend's meal_entries row can never reach this
-- view's output, traced through the join, before this migration too) —
-- but only as long as nobody touches that join or how span is built. This
-- migration doesn't change the result for anyone; it changes WHY the
-- result is correct, from "an inner join happens to enforce this" to
-- "this CTE says what it means." Defence in depth, not a replacement for
-- RLS or security_invoker — both stay exactly as they were.
--
-- CREATE OR REPLACE, not DROP + CREATE: the column list is unchanged (only
-- WHERE clauses are added inside two CTEs; the final SELECT's shape is
-- untouched), so REPLACE is valid here by the same rule the original
-- migration's own comment states for when DROP + CREATE was needed instead
-- ("the column list changes"). REPLACE also preserves
-- `grant select ... to authenticated` — a DROP would silently discard it,
-- and there is currently no client reader of this view to notice a broken
-- grant before someone went looking for one.
--
-- Idempotent: CREATE OR REPLACE VIEW is safe to re-run.
-- ============================================================

create or replace view public.whoop_unassigned_meals
with (security_invoker = on) as
with span as (
  select user_id, min(start) as first_cycle_start
    from public.whoop_cycles
   where user_id = auth.uid()
   group by user_id
),
placed as (
  select
    m.id,
    m.user_id,
    m.eaten_at,
    m.name,
    m.calories,
    m.planned,
    m.confirmed_at,
    m.skipped_at,
    exists (
      select 1
        from public.whoop_cycles c
       where c.user_id  = m.user_id
         and m.eaten_at >= c.start
         and m.eaten_at <  coalesce(
               c."end",
               case when c.start > now() - interval '36 hours' then now() end
             )
    ) as has_cycle
  from public.meal_entries m
 where m.user_id = auth.uid()
)
select
  p.id,
  p.user_id,
  p.eaten_at,
  p.name,
  p.calories,
  p.planned,
  case
    when p.planned and p.confirmed_at is null then 'unconfirmed'
    else 'no_cycle'
  end as reason
from placed p
-- ⚠ KEEP THIS JOIN, even though both sides are now filtered to
-- auth.uid() and it looks like it does nothing. It IS doing nothing,
-- today, on purpose: with both filters in place, `s` contains at most one
-- row (the caller's), so this join can only narrow `p` to rows that
-- already satisfy p.user_id = auth.uid() — a fact the two WHERE clauses
-- above already guarantee independently. That triple redundancy is the
-- point. If either filter is ever lost — the `placed` CTE's WHERE deleted
-- in a refactor, or `span`'s WHERE with it — THIS join is what still
-- narrows the result to one user, because span is still built from
-- whoop_cycles' own RLS-restricted rows. Removing it as "dead weight"
-- would delete the one guarantee that survives losing either explicit
-- filter on its own. Do not remove it to "simplify" this query.
join span s on s.user_id = p.user_id
where p.skipped_at is null                      -- answered "no". Not a gap.
  and p.eaten_at <= now()                       -- hasn't happened yet /= unassigned
  and p.eaten_at >= s.first_cycle_start         -- predates the WHOOP connection /= a gap
  and (
        (p.planned and p.confirmed_at is null)  -- pending: a real hole, cycle or not
        or not p.has_cycle                      -- strap off / gap / stale open cycle
      );

comment on view public.whoop_unassigned_meals is
  'Meals absent from the correlation, and why. reason = ''unconfirmed'' is a plan the user never answered (one tap fixes it). reason = ''no_cycle'' is missing WHOOP data. Future plans and skipped meals are NOT reported: neither is a gap.';

grant select on public.whoop_unassigned_meals to authenticated;

-- ============================================================================
-- VERIFICATION
--
-- No client currently reads this view, so there is no user-facing
-- behaviour to check — this is a structural no-op proof plus confirmation
-- that CREATE OR REPLACE did what it claimed (preserved the grant and
-- security_invoker, not silently dropped and recreated bare).
--
-- Row-count checks: run as `authenticated`, impersonating each user (Studio's
-- role/JWT switcher, or via psql:
--   set local role authenticated;
--   set local request.jwt.claims to '{"sub":"<uuid>","role":"authenticated"}';
-- ). Capture BOTH before applying this migration and again after; each pair
-- must match exactly.
-- ============================================================================

-- V0/V1. Account A — a8435663-72e9-4d33-9c3f-803c4cbda393.
--   set local role authenticated;
--   set local request.jwt.claims to '{"sub":"a8435663-72e9-4d33-9c3f-803c4cbda393","role":"authenticated"}';
--   select count(*) from public.whoop_unassigned_meals;
-- Expect: identical count before and after applying this migration.

-- V0/V1. Account B (accepted friend of A) — 03f2f56a-d923-4acc-8a21-044deec280f7.
--   set local role authenticated;
--   set local request.jwt.claims to '{"sub":"03f2f56a-d923-4acc-8a21-044deec280f7","role":"authenticated"}';
--   select count(*) from public.whoop_unassigned_meals;
-- Expect: identical count before and after — B's own unassigned meals,
-- never A's, whether or not this migration has run.

-- V2. The grant survived CREATE OR REPLACE (would read false after a bare
--     DROP + CREATE that forgot to re-grant).
--
-- select has_table_privilege('authenticated', 'public.whoop_unassigned_meals', 'select');
-- Expect: true.

-- V3. security_invoker is still on.
--
-- select reloptions from pg_class
-- where oid = 'public.whoop_unassigned_meals'::regclass;
-- Expect: {security_invoker=on} (or equivalent — the option must be present).
