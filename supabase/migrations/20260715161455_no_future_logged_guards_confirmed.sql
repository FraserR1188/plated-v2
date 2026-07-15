-- ============================================================================
-- Migration 6 — no_future_logged also guards CONFIRMED plans
-- ============================================================================
--
-- WHY
-- ---
-- meal_entries_no_future_logged() (migration 5) refuses to move a meal that has
-- been EATEN into the future — "a plan is not a fact." It decided "eaten" by
-- `planned = false`.
--
-- That was complete until confirmation shipped. A meal planned for the future is
-- born planned = true, and `freeze_planned` PINS that flag on every later update.
-- So a breakfast you planned at 06:30, then CONFIRMED you ate, keeps planned =
-- true forever — and the old guard (`planned = false`) never fires on it. You
-- could confirm a meal as eaten and then shove it into next week, re-opening the
-- exact hole migration 5 closed: a row the DB believes you ATE, dated in the
-- future, which passes the WHOOP correlation's first gate and is invisible to the
-- banner and getPendingEntries().
--
-- FIX
-- ---
-- A meal is a FACT once it is EITHER logged straight away (planned = false) OR a
-- plan the user has confirmed (confirmed_at is not null). Guard both.
--
-- This is a FUNCTION-BODY change only. The trigger binding
-- (meal_entries_no_future_logged_bu, BEFORE UPDATE) is unchanged, so nothing
-- needs to be dropped or recreated.
--
-- ⚠ The RAISE message is kept BYTE-FOR-BYTE identical to migration 5. The client
--   (useStore.updateEntry / retimeEntries) matches the friendly "copy it instead"
--   error on the substring "cannot move a logged meal into the future". Change
--   the wording here and you silently break that match. If you ever reword it,
--   reword both regexes in the same commit.
-- ============================================================================

create or replace function public.meal_entries_no_future_logged()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- Same 30-minute grace as meal_entries_derive_planned(), and the same clock
  -- (the DATABASE's). If you change PLANNING_GRACE_MINUTES, change all three.
  --
  -- (planned = false)          → logged straight away.
  -- (confirmed_at is not null) → a plan the user confirmed they ate.
  -- Either is an eaten fact and must not be dated into the future.
  if (new.planned = false or new.confirmed_at is not null)
     and new.eaten_at > now() + interval '30 minutes' then
    raise exception
      'meal_entries %: cannot move a logged meal into the future. A plan is not '
      'a fact. Log it on that day, or copy it there.',
      new.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;