-- ============================================================================
-- Verification — 20260831120000_whoop_cycle_nutrition_known_meals.sql
--
-- Run V1 BEFORE applying the migration — it cannot be recreated after. Apply
-- the migration. Run V2-V6 after. V7 (cleanup) is commented out; run it
-- yourself once you're satisfied.
-- ============================================================================

-- ── V1. PRE-SNAPSHOT — run BEFORE the push ─────────────────────────────────
-- OLD column list, explicit, effective_end OMITTED: it is now()-derived for
-- any in-progress cycle (coalesce(period_end, case when period_start >
-- now() - interval '36 hours' then now() end)) and will legitimately differ
-- between this snapshot and the moment V2 runs, on every execution,
-- independent of this migration — see 20260830180000's verify file, V1,
-- which hit exactly this and had to omit it for the same reason. NOT
-- filtered to is_in_progress = false: the stale-window row (cycle_id
-- 1663052944) is one of the rows this migration's own header calls out by
-- name, and excluding in-progress rows would hide whatever it does.
--
-- Persisted as a real table, not TEMP — a session-scoped TEMP table would
-- not survive the separate before/after psql sessions this workflow uses.

create table public._diag_wcn_pre as
select
  user_id, cycle_id, cycle_start, cycle_end,
  is_in_progress, score_state, strain, kilojoule, average_heart_rate, timezone_offset,
  meal_count, kcal, protein, carbs, fat, sat_fat, salt, fibre, sugar,
  has_estimated_times, first_meal_at, last_meal_at
from public.whoop_cycle_nutrition;

select count(*) as pre_row_count from public._diag_wcn_pre;  -- note this number


-- ── APPLY THE MIGRATION NOW ────────────────────────────────────────────────


-- ── V2. POST-SNAPSHOT — same old column list ───────────────────────────────
-- Deliberately the SAME 21-column list as V1 (not the new known_meals
-- columns) so V3's structural diff is comparing like with like. The new
-- columns are read directly off the LIVE view in V3(3) and V5 instead —
-- by the time this runs, the live view already reflects the migration, so
-- there's no need to snapshot them separately.

create table public._diag_wcn_post as
select
  user_id, cycle_id, cycle_start, cycle_end,
  is_in_progress, score_state, strain, kilojoule, average_heart_rate, timezone_offset,
  meal_count, kcal, protein, carbs, fat, sat_fat, salt, fibre, sugar,
  has_estimated_times, first_meal_at, last_meal_at
from public.whoop_cycle_nutrition;

select count(*) as post_row_count from public._diag_wcn_post;  -- note this number


-- ── V3. TARGETED DIFF — not a bare EXCEPT ──────────────────────────────────
-- A raw `select * from pre except select * from post` returns roughly one
-- row per zero-meal (and nothing-known) cycle here — every one of them
-- legitimately flips 0 -> NULL on four columns. That is the expected
-- outcome of this migration, not a failure, and a bulk diff proves nothing
-- about WHY each row changed. Three separate assertions instead.

-- V3(1). Every column OTHER than the four macros is identical, every row.
-- Any row returned here is a regression — this migration must never change
-- cycle identity, boundaries, strain/recovery passthroughs, meal_count, the
-- coalesced big-four macros, has_estimated_times, or first/last_meal_at.
select pre.user_id, pre.cycle_id, 'V3(1) MISMATCH' as check_name
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
where pre.cycle_start          is distinct from post.cycle_start
   or pre.cycle_end            is distinct from post.cycle_end
   or pre.is_in_progress       is distinct from post.is_in_progress
   or pre.score_state          is distinct from post.score_state
   or pre.strain                is distinct from post.strain
   or pre.kilojoule             is distinct from post.kilojoule
   or pre.average_heart_rate   is distinct from post.average_heart_rate
   or pre.timezone_offset      is distinct from post.timezone_offset
   or pre.meal_count            is distinct from post.meal_count
   or pre.kcal                  is distinct from post.kcal
   or pre.protein                is distinct from post.protein
   or pre.carbs                  is distinct from post.carbs
   or pre.fat                    is distinct from post.fat
   or pre.has_estimated_times   is distinct from post.has_estimated_times
   or pre.first_meal_at          is distinct from post.first_meal_at
   or pre.last_meal_at           is distinct from post.last_meal_at;
-- Expect ZERO rows.

-- V3(2). The four macros differ ONLY in the 0 -> NULL direction.
-- (a) post is non-NULL and differs from pre at all — must never happen;
--     this migration only ever removes a value (0 -> NULL), never changes
--     a known value or fabricates a new one.
select pre.user_id, pre.cycle_id, 'sat_fat' as macro, pre.sat_fat as pre_v, post.sat_fat as post_v
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where post.sat_fat is not null and post.sat_fat is distinct from pre.sat_fat
union all
select pre.user_id, pre.cycle_id, 'salt', pre.salt, post.salt
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where post.salt is not null and post.salt is distinct from pre.salt
union all
select pre.user_id, pre.cycle_id, 'fibre', pre.fibre, post.fibre
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where post.fibre is not null and post.fibre is distinct from pre.fibre
union all
select pre.user_id, pre.cycle_id, 'sugar', pre.sugar, post.sugar
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where post.sugar is not null and post.sugar is distinct from pre.sugar;
-- Expect ZERO rows.

-- (b) pre was NULL and post is 0 — the reverse flip. Should be structurally
--     impossible (the OLD view always coalesced to 0, so pre.<macro> is
--     never NULL to begin with), asserted defensively rather than assumed.
select pre.user_id, pre.cycle_id, 'sat_fat' as macro
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where pre.sat_fat is null and post.sat_fat = 0
union all
select pre.user_id, pre.cycle_id, 'salt'
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where pre.salt is null and post.salt = 0
union all
select pre.user_id, pre.cycle_id, 'fibre'
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where pre.fibre is null and post.fibre = 0
union all
select pre.user_id, pre.cycle_id, 'sugar'
from public._diag_wcn_pre pre join public._diag_wcn_post post using (user_id, cycle_id)
where pre.sugar is null and post.sugar = 0;
-- Expect ZERO rows.

-- V3(3). THE REAL ASSERTION — the set of rows that flipped on each macro is
-- EXACTLY the set where that macro's new known-count is 0. Both directions:
-- every flip has known = 0, AND every known = 0 row actually flipped. This
-- is what ties the 0 -> NULL change to the new *_known_meals columns rather
-- than merely counting how many rows changed.
select pre.user_id, pre.cycle_id, 'sat_fat: flipped but known<>0' as check_name
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where pre.sat_fat = 0 and post.sat_fat is null and live.sat_fat_known_meals <> 0
union all
select pre.user_id, pre.cycle_id, 'sat_fat: known=0 but did not flip'
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where live.sat_fat_known_meals = 0 and not (pre.sat_fat = 0 and post.sat_fat is null)
union all
select pre.user_id, pre.cycle_id, 'salt: flipped but known<>0'
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where pre.salt = 0 and post.salt is null and live.salt_known_meals <> 0
union all
select pre.user_id, pre.cycle_id, 'salt: known=0 but did not flip'
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where live.salt_known_meals = 0 and not (pre.salt = 0 and post.salt is null)
union all
select pre.user_id, pre.cycle_id, 'fibre: flipped but known<>0'
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where pre.fibre = 0 and post.fibre is null and live.fibre_known_meals <> 0
union all
select pre.user_id, pre.cycle_id, 'fibre: known=0 but did not flip'
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where live.fibre_known_meals = 0 and not (pre.fibre = 0 and post.fibre is null)
union all
select pre.user_id, pre.cycle_id, 'sugar: flipped but known<>0'
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where pre.sugar = 0 and post.sugar is null and live.sugar_known_meals <> 0
union all
select pre.user_id, pre.cycle_id, 'sugar: known=0 but did not flip'
from public._diag_wcn_pre pre
join public._diag_wcn_post post using (user_id, cycle_id)
join public.whoop_cycle_nutrition live using (user_id, cycle_id)
where live.sugar_known_meals = 0 and not (pre.sugar = 0 and post.sugar is null);
-- Expect ZERO rows.


-- ── V4. NON-VACUITY ─────────────────────────────────────────────────────────
select
  (select count(*) from public._diag_wcn_pre)  as pre_count,
  (select count(*) from public._diag_wcn_post) as post_count;
-- Expect equal. If unequal, the methodology is broken (a cycle
-- appeared/disappeared between snapshots) and V3 cannot be trusted.

select 'pre_only' as side, pre.user_id, pre.cycle_id
from public._diag_wcn_pre pre
left join public._diag_wcn_post post using (user_id, cycle_id)
where post.user_id is null
union all
select 'post_only', post.user_id, post.cycle_id
from public._diag_wcn_post post
left join public._diag_wcn_pre pre using (user_id, cycle_id)
where pre.user_id is null;
-- Expect ZERO rows (no asymmetry).


-- ── V5. THE NAMED PRODUCTION CASE ───────────────────────────────────────────
-- Fill in the cycle_id before running.
select
  cycle_id, meal_count,
  sat_fat, salt, fibre, sugar,
  sat_fat_known_meals, salt_known_meals, fibre_known_meals, sugar_known_meals
from public.whoop_cycle_nutrition
where cycle_id = '<PASTE CYCLE_ID HERE>';
-- Expect: meal_count > 0; sat_fat, salt, fibre all NULL with
-- sat_fat_known_meals = salt_known_meals = fibre_known_meals = 0; sugar
-- NON-NULL with sugar_known_meals > 0.


-- ── V6. RLS ──────────────────────────────────────────────────────────────
-- security_invoker survived the replace:
select relname, c.reloptions
from pg_class c
where c.relname = 'whoop_cycle_nutrition' and c.relnamespace = 'public'::regnamespace;
-- Expect reloptions to include security_invoker=true (or equivalent — some
-- Postgres versions report this via pg_views/pg_get_viewdef instead of
-- reloptions; if this comes back empty, cross-check with:
-- select definition from pg_views where viewname = 'whoop_cycle_nutrition';
-- and confirm `with (security_invoker = on)` appears in it).

-- Second-account check, in the begin/rollback form so nothing is left
-- behind and no superuser bypass masks a real RLS gap:
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<SOME OTHER USER''S UUID, NOT YOUR OWN>"}';
select count(*) from public.whoop_cycle_nutrition;
-- Expect: only that user's own rows (0 if they have none), never another
-- user's cycles.
rollback;


-- ── V7. CLEANUP — run yourself once satisfied ──────────────────────────────
-- drop table public._diag_wcn_pre;
-- drop table public._diag_wcn_post;
