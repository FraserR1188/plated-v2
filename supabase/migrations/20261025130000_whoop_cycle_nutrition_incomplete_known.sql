-- ============================================================================
-- 20261025130000_whoop_cycle_nutrition_incomplete_known.sql
-- PL-059 — *_known_meals stops counting a lower bound as known
--
-- Depends on 20261025120000_incomplete_nutrients.sql (the column it reads).
--
-- ONE CHANGE: each of sat_fat_known_meals / salt_known_meals /
-- fibre_known_meals / sugar_known_meals counts a meal only when its value is
-- non-NULL AND that nutrient is not listed in meal_entries.incomplete_nutrients.
--
-- WHY THIS MUST SHIP WITH THE CLIENT CHANGE, NOT AFTER IT: until this
-- release, a batch with one unknown-fibre ingredient was logged with fibre
-- NULL, so count(m.fibre) left it out and fibre_known_meals < meal_count told
-- the reader the cycle's fibre was partial. From this release that batch logs
-- the known ingredients' sum and lists 'fibre' as incomplete. count(m.fibre)
-- would count it as known, and the same cycle would read
-- fibre_known_meals = meal_count — "complete" — while still missing the
-- unknown ingredient's fibre. That is a regression the client change would
-- introduce on its own; this migration closes it.
--
-- UNCHANGED, DELIBERATELY:
--   - sat_fat / salt / fibre / sugar sums. A lower bound still contributes
--     its known part to the partial sum, exactly as THE CONTRACT in
--     20260831120000 already describes: a non-NULL value with
--     known_meals < meal_count is a partial sum, not a cycle total.
--   - Everything else: meal_count, the coalesced big four, the confirmation
--     gate in the LEFT JOIN ... ON clause (NOT a WHERE — see
--     20260831120000's verify file, sabotage 3), the stale-window guard,
--     has_estimated_times, first/last_meal_at.
--   - whoop_correlation. It reads the four *_known_meals columns BY NAME from
--     this view and lags/passes them through; same names, same type
--     (bigint), so it picks up the new counts with no change of its own.
--     MEASURED in 20261025130000_rig.sh with the real whoop_correlation
--     definition (20260901130000) built on top.
--
-- CREATE OR REPLACE, NOT DROP + CREATE: the column list, order and types are
-- identical, so the replace is legal with whoop_correlation still depending
-- on this view, and the view keeps its OID and ACL. security_invoker = on is
-- restated, and MUST be: a CREATE OR REPLACE without it drops the option —
-- MEASURED in the rig's no_invoker variant, where reloptions came back empty
-- and user A read user B's cycles through both views.
--
-- The meal_entries read stays its own top-level CTE ("entries"), now with
-- incomplete_nutrients added, so the fixture rig can swap it for VALUES.
--
-- Old rows: incomplete_nutrients is NULL on every row the moment this
-- applies (20261025120000 has no default and no backfill), so
-- `'x' = any (NULL)` is NULL, coalesce(..., false) is false, and every
-- count equals what count(m.x) returned before. The view's output does not
-- change until the first flagged entry is logged — see the verify file, V2.
-- ============================================================================

create or replace view public.whoop_cycle_nutrition
with (security_invoker = on) as
with bounded as (
  select
    p.user_id,
    p.source_period_id           as cycle_id,   -- text, per 20260829111404
    p.period_start                as cycle_start,
    p.period_end                  as cycle_end,
    (p.period_end is null)        as is_in_progress,
    p.strain_score_state          as score_state,
    p.strain                      as strain,
    p.cycle_energy_kilojoule      as kilojoule,
    p.cycle_average_heart_rate    as average_heart_rate,
    p.timezone_offset             as timezone_offset,
    coalesce(
      p.period_end,
      case when p.period_start > now() - interval '36 hours' then now() end
    ) as effective_end
  from public.biometric_periods_resolved p
),
entries as (
  select
    id, user_id, eaten_at, planned, confirmed_at, eaten_at_estimated,
    calories, protein, carbs, fat, sat_fat, salt, fibre, sugar,
    incomplete_nutrients
  from public.meal_entries
)
select
  b.user_id,
  b.cycle_id,
  b.cycle_start,
  b.cycle_end,
  b.effective_end,
  b.is_in_progress,
  b.score_state,
  b.strain,
  b.kilojoule,
  b.average_heart_rate,
  b.timezone_offset,

  count(m.id)                         as meal_count,
  coalesce(sum(m.calories), 0)        as kcal,
  coalesce(sum(m.protein),  0)        as protein,
  coalesce(sum(m.carbs),    0)        as carbs,
  coalesce(sum(m.fat),      0)        as fat,

  -- NULL-not-zero: sum over known contributors only, a lower bound's known
  -- part included. Unchanged by this migration.
  sum(m.sat_fat)                      as sat_fat,
  sum(m.salt)                         as salt,
  sum(m.fibre)                        as fibre,
  sum(m.sugar)                        as sugar,

  coalesce(bool_or(m.eaten_at_estimated), false) as has_estimated_times,
  min(m.eaten_at)                     as first_meal_at,
  max(m.eaten_at)                     as last_meal_at,

  -- How many of meal_count reported a COMPLETE value for this macro: non-NULL
  -- (count() skips NULL) and not listed as a lower bound. coalesce(..., false)
  -- because `'x' = any (NULL)` is NULL, and a NULL filter drops the row —
  -- which would stop counting every unflagged row.
  count(m.sat_fat) filter (where not coalesce('sat_fat' = any (m.incomplete_nutrients), false)) as sat_fat_known_meals,
  count(m.salt)    filter (where not coalesce('salt'    = any (m.incomplete_nutrients), false)) as salt_known_meals,
  count(m.fibre)   filter (where not coalesce('fibre'   = any (m.incomplete_nutrients), false)) as fibre_known_meals,
  count(m.sugar)   filter (where not coalesce('sugar'   = any (m.incomplete_nutrients), false)) as sugar_known_meals

from bounded b
left join entries m
       on m.user_id  = b.user_id
      and b.effective_end is not null
      and m.eaten_at >= b.cycle_start
      and m.eaten_at <  b.effective_end
      -- ── THE GATE ──────────────────────────────────────────
      -- A plan is not evidence. Only meals that actually happened. Stays in
      -- ON: in a WHERE it would silently convert the LEFT JOIN into an
      -- inner one and delete every zero-meal cycle (and every cycle whose
      -- only candidate meal fails this gate) from the view — see
      -- 20260831120000's verify file, sabotage 3.
      and (m.planned = false or m.confirmed_at is not null)
group by
  b.user_id, b.cycle_id, b.cycle_start, b.cycle_end, b.effective_end,
  b.is_in_progress, b.score_state, b.strain, b.kilojoule,
  b.average_heart_rate, b.timezone_offset;

comment on view public.whoop_cycle_nutrition is
  'Meals aggregated per cycle by UTC INTERVAL containment of eaten_at. EXCLUDES unconfirmed planned meals: a plan is not evidence. LEFT JOIN: meal_count = 0 is a real cycle with nothing logged, not a missing cycle (EXCEPT when effective_end is null — a stale open cycle — which also reads meal_count = 0 and is output-identical; check effective_end). sat_fat/salt/fibre/sugar are sums over KNOWN CONTRIBUTORS ONLY, including the known part of a lower-bound entry (meal_entries.incomplete_nutrients). *_known_meals counts only meals with a COMPLETE value for that macro (non-NULL and not listed in incomplete_nutrients): a non-NULL value where known_meals < meal_count is a partial sum, not a cycle total. calories/protein/carbs/fat stay coalesced to 0 — meal_entries guarantees those NOT NULL, so 0 there is always a true zero, never an absent measurement. See 20260831120000_whoop_cycle_nutrition_known_meals.sql and 20261025130000_whoop_cycle_nutrition_incomplete_known.sql.';

-- Not strictly required (CREATE OR REPLACE keeps the ACL) — kept, matching
-- every other view migration in this repo.
grant select on public.whoop_cycle_nutrition to authenticated;
