-- ============================================================================
-- 20260831120000_whoop_cycle_nutrition_known_meals.sql
-- Commit 2.5 — whoop_cycle_nutrition: known-meal counts, NULL-not-zero for
-- the four small macros
--
-- Follows the read-only investigation into this view's NULL-not-zero
-- leak. Two changes, one migration:
--
--   1. sat_fat/salt/fibre/sugar drop their coalesce(sum(...), 0) wrapper —
--      plain sum(). This makes a cycle NULL for one of these macros when NO
--      contributing meal had a value for it, matching src/lib/entries.ts's
--      sumBucket/addBuckets, which already skip null-per-row macros rather
--      than propagating them (a null row contributes nothing; the running
--      total only stays null if nothing ever contributed). The view and the
--      client now agree.
--
--   2. Four trailing columns: sat_fat_known_meals, salt_known_meals,
--      fibre_known_meals, sugar_known_meals — count(m.<macro>) per column,
--      i.e. how many of this cycle's meal_count actually reported a value.
--
-- OUT OF SCOPE, DELIBERATELY UNCHANGED (do not re-litigate):
--   - calories/protein/carbs/fat keep their coalesce(..., 0). They are
--     NOT NULL DEFAULT 0 on meal_entries — a zero-meal cycle reporting
--     0 kcal is TRUE, not a guess, per sumBucket's own documented reasoning.
--   - meal_count stays count(m.id), not count(*). Already correct.
--   - The confirmation gate stays in the LEFT JOIN ... ON clause. Moving it
--     to a WHERE converts the join to an inner one and silently deletes
--     every zero-meal (and every gate-filtered) cycle from the view — see
--     THE CONTRACT below and this migration's own verify file, V3(3)/F4/F5.
--   - whoop_correlation and src/types/index.ts (WhoopCorrelationRow) are
--     NOT touched here. WhoopCorrelationRow is confirmed dead code (no
--     client reads whoop_correlation or whoop_cycle_nutrition today — see
--     20260829111404's own header). Commit three rewrites whoop_correlation
--     to add the known-count passthroughs and fix the type file at the same
--     time; doing either here would be scope creep against a view nothing
--     reads yet.
--
-- CREATE OR REPLACE, NOT DROP + CREATE. This commit adds four TRAILING
-- columns only — it does not reorder or retype any existing column — so
-- CREATE OR REPLACE VIEW is legal and, critically, does not force
-- whoop_correlation (which depends on this view) to be dropped first.
--
-- MEAL_ENTRIES LIFTED INTO ITS OWN CTE ("entries"), alongside "bounded".
-- Previously read inline in the join target (public.meal_entries directly),
-- which made this view impossible to fixture-test without Docker: a fixture
-- needs to substitute a VALUES block for every real-table read, and a CTE
-- can shadow a bare name the way it cannot shadow a schema-qualified
-- reference. bounded was already a CTE; entries now is too. Output is
-- unaffected — entries selects the same columns meal_entries always
-- contributed to this view (id, user_id, eaten_at, planned, confirmed_at,
-- eaten_at_estimated, and the eight macro columns) and nothing else. Not
-- materialized: it must not force materialization of the full table when
-- the query only needs one user's slice of it.
--
-- ── THE CONTRACT ────────────────────────────────────────────────────────
-- sat_fat/salt/fibre/sugar now report a sum over KNOWN CONTRIBUTORS ONLY.
-- A non-NULL value on a cycle where e.g. salt_known_meals < meal_count is
-- NOT a cycle total — it is a partial sum that silently omits whatever the
-- unknown-salt meal(s) actually contained. Four distinguishable states,
-- meal_count as the denominator:
--
--   meal_count = 0                                  -> no meals logged at all
--   meal_count > 0, macro NULL,   known = 0          -> meals logged, nothing known
--   meal_count > 0, macro non-NULL, known < meal_count -> PARTIAL. Not a total.
--   meal_count > 0, macro non-NULL, known = meal_count -> complete total
--
-- Any consumer built against this view (there are none today — see above)
-- must read the known-count column before trusting the macro as a total.
--
-- ── KNOWN, DELIBERATELY UNFIXED: THE STALE-WINDOW CASE ─────────────────
-- When effective_end is NULL (a stale open cycle whose WHOOP row was never
-- backfilled with an end — production has exactly one at the time of this
-- migration, cycle_id 1663052944, open since 2026-07-23, per
-- 20260830170000_biometric_synthetic_cycles.sql's verify file, "FOLLOW-UP"
-- section), the LEFT JOIN's `b.effective_end is not null` guard matches
-- NOTHING for that row, on purpose (see that same follow-up note). The
-- result: calories/protein/carbs/fat all read 0, and every one of the four
-- known-count columns reads 0 too — OUTPUT-IDENTICAL to a cycle where the
-- user genuinely logged nothing. The only column that tells the two apart
-- is effective_end itself (NULL only in the stale-window case, among
-- meal_count = 0 rows). Any consumer that treats a zero-meal row as "user
-- logged nothing that day" without also checking `effective_end is null`
-- will misread a sync defect as a quiet day. Fixing this properly means
-- suppressing the WHOLE row's aggregates (not just the four small macros)
-- when the join window itself is unknown, which is a wider change than
-- this commit and is not attempted here.
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
    calories, protein, carbs, fat, sat_fat, salt, fibre, sugar
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

  -- NULL-not-zero: sum over known contributors only. See THE CONTRACT above.
  sum(m.sat_fat)                      as sat_fat,
  sum(m.salt)                         as salt,
  sum(m.fibre)                        as fibre,
  sum(m.sugar)                        as sugar,

  coalesce(bool_or(m.eaten_at_estimated), false) as has_estimated_times,
  min(m.eaten_at)                     as first_meal_at,
  max(m.eaten_at)                     as last_meal_at,

  -- How many of meal_count actually reported this macro. Read alongside the
  -- macro itself — see THE CONTRACT above. TRAILING: appended after
  -- last_meal_at on purpose, so this stays a legal CREATE OR REPLACE.
  count(m.sat_fat) as sat_fat_known_meals,
  count(m.salt)    as salt_known_meals,
  count(m.fibre)   as fibre_known_meals,
  count(m.sugar)   as sugar_known_meals

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
      -- only candidate meal fails this gate) from the view — see this
      -- migration's verify file, sabotage 3.
      and (m.planned = false or m.confirmed_at is not null)
group by
  b.user_id, b.cycle_id, b.cycle_start, b.cycle_end, b.effective_end,
  b.is_in_progress, b.score_state, b.strain, b.kilojoule,
  b.average_heart_rate, b.timezone_offset;

comment on view public.whoop_cycle_nutrition is
  'Meals aggregated per cycle by UTC INTERVAL containment of eaten_at. EXCLUDES unconfirmed planned meals: a plan is not evidence. LEFT JOIN: meal_count = 0 is a real cycle with nothing logged, not a missing cycle (EXCEPT when effective_end is null — a stale open cycle — which also reads meal_count = 0 and is output-identical; check effective_end). sat_fat/salt/fibre/sugar are sums over KNOWN CONTRIBUTORS ONLY (see the *_known_meals columns): a non-NULL value where known_meals < meal_count is a partial sum, not a cycle total. calories/protein/carbs/fat stay coalesced to 0 — meal_entries guarantees those NOT NULL, so 0 there is always a true zero, never an absent measurement. See 20260831120000_whoop_cycle_nutrition_known_meals.sql.';

-- CREATE OR REPLACE preserves this view's OID and existing ACL entries
-- (only trailing columns were added), so this grant is not strictly
-- required to restore access — kept anyway, matching every other view
-- migration in this repo, so the privilege is never left to an unstated
-- assumption about ACL-preservation semantics a future reader would have to
-- go verify.
grant select on public.whoop_cycle_nutrition to authenticated;
