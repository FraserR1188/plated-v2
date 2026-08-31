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

select count(*) as pre_row_count from public._diag_wcn_pre;
-- CONFIRMED on the actual push: 231.


-- ── APPLY THE MIGRATION NOW ────────────────────────────────────────────────


-- ── V2. POST-SNAPSHOT — same old column list ───────────────────────────────
-- Deliberately the SAME 22-column list as V1 (not the new known_meals
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

select count(*) as post_row_count from public._diag_wcn_post;
-- CONFIRMED on the actual push: 231 — matches pre_row_count exactly (see V4).


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
-- Expect ZERO rows. CONFIRMED on the actual push: 0 rows (T5(1)).

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
-- Expect ZERO rows. CONFIRMED on the actual push: 0 rows (T5(2a)).

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
-- Expect ZERO rows. CONFIRMED on the actual push: 0 rows (T5(2b)).

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
-- Expect ZERO rows. CONFIRMED on the actual push: 0 rows (T5(3)) — every
-- flip corresponded to that macro's known-count going to 0, and vice versa.


-- ── V4. NON-VACUITY ─────────────────────────────────────────────────────────
select
  (select count(*) from public._diag_wcn_pre)  as pre_count,
  (select count(*) from public._diag_wcn_post) as post_count;
-- Expect equal. If unequal, the methodology is broken (a cycle
-- appeared/disappeared between snapshots) and V3 cannot be trusted.
-- CONFIRMED on the actual push: 231/231 (T4).

select 'pre_only' as side, pre.user_id, pre.cycle_id
from public._diag_wcn_pre pre
left join public._diag_wcn_post post using (user_id, cycle_id)
where post.user_id is null
union all
select 'post_only', post.user_id, post.cycle_id
from public._diag_wcn_post post
left join public._diag_wcn_pre pre using (user_id, cycle_id)
where pre.user_id is null;
-- Expect ZERO rows (no asymmetry). CONFIRMED on the actual push: 0 rows,
-- with no asymmetry (T4).


-- ── V5. THE NAMED PRODUCTION CASE ───────────────────────────────────────────
-- cycle_id 1757740302, user_id 4dbf04ae-7b46-4511-8122-f17284c622d9 — the
-- only cycle in the 231-row dataset (see V4) with at least one logged meal
-- where sat_fat/salt/fibre are ALL unknown but sugar is known. user_id is
-- pinned deliberately, not just cycle_id: this cycle_id exists under a
-- SECOND account too (the same physical WHOOP device syncs into both), and
-- the dashboard connects as superuser, so RLS will not filter the other
-- account's row out on its own — an unqualified cycle_id filter here could
-- silently match the wrong account's row instead of (or in addition to)
-- this one.
--
-- ONE-SHOT ASSERTION, NOT A STABLE REGRESSION CHECK. This cycle was
-- IN PROGRESS at verification time: cycle_end was NULL and effective_end
-- was falling back to now() under the view's 36-hour window, which itself
-- closed at 2026-09-01 09:42:20 UTC. Once this cycle closes (or simply ages
-- past that 36h window without closing), effective_end goes NULL, the
-- join's `b.effective_end is not null` guard matches nothing, and this row
-- will read meal_count = 0 with all four known-counts at 0 — output-
-- identical to the stale-window case this migration's header already
-- documents for cycle 1663052944. A future reader re-running this query and
-- seeing that shape is NOT evidence the migration regressed; it is this
-- same cycle aging into the stale-window state, which is expected. The
-- census behind V4/V6's row counts (T6: 191/191/191/190 of 231 known-count-
-- zero per macro — 189 genuinely empty cycles + 1 stale-window cycle
-- (1663052944) + this one, and sugar reads 190 rather than 191 precisely
-- because THIS cycle's sugar is known) found no other wholly-unknown-for-
-- three-macros cycle in the dataset to replace this assertion with if it
-- ages out. If that happens, find a new candidate via the same T6-style
-- census rather than leaving this query pinned to a cycle that has silently
-- become the stale-window case instead of the partial-know case it was
-- written to prove.
select
  cycle_id, meal_count,
  sat_fat, salt, fibre, sugar,
  sat_fat_known_meals, salt_known_meals, fibre_known_meals, sugar_known_meals
from public.whoop_cycle_nutrition
where cycle_id = '1757740302'
  and user_id = '4dbf04ae-7b46-4511-8122-f17284c622d9';
-- Expect: meal_count > 0; sat_fat, salt, fibre all NULL with
-- sat_fat_known_meals = salt_known_meals = fibre_known_meals = 0; sugar
-- NON-NULL with sugar_known_meals > 0.
-- CONFIRMED on the actual push (T7): meal_count = 1; sat_fat/salt/fibre
-- NULL, all three known-counts 0; sugar = 0 (a real recorded zero, not an
-- absent measurement) with sugar_known_meals = 1.


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
-- CONFIRMED on the actual push (T8): reloptions = ["security_invoker=on"].

-- Second-account check, in the begin/rollback form so nothing is left
-- behind and no superuser bypass masks a real RLS gap:
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<SOME OTHER USER''S UUID, NOT YOUR OWN>"}';
select count(*) from public.whoop_cycle_nutrition;
-- Expect: only that user's own rows (0 if they have none), never another
-- user's cycles.
-- CONFIRMED on the actual push (T8): impersonating a8435663 returned
-- exactly one distinct user_id (a8435663's own), 50 rows — never
-- 4dbf04ae's, despite the shared-device cycle_id collision noted in V5.
rollback;


-- ── V7. CLEANUP — run yourself once satisfied ──────────────────────────────
-- drop table public._diag_wcn_pre;
-- drop table public._diag_wcn_post;
