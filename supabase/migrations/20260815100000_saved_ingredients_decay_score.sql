-- ============================================================================
-- 20260815100000_saved_ingredients_decay_score.sql
-- public.saved_ingredients_scored — recency-decayed frequency for My Library
--
-- WHY THIS EXISTS
--   The My Library tab (AddIngredientScreen) sorts saved_ingredients by a
--   plain use_count integer, bumped via a client read-modify-write
--   (useStore.saveIngredient) with no timestamp trail at all — no
--   last_used_at, nothing. A frequent-but-abandoned item and a newly-hot one
--   are indistinguishable once their counts happen to match. This view
--   replaces the sort key with a recency-decayed score, computed FROM
--   meal_entries (which does carry a real eaten_at per use) rather than
--   from the vestigial counter.
--
-- IDENTITY KEY — barcode, then off_id, then name+brand
--   saved_ingredients has no FK back to meal_entries (the legacy schema's
--   meal_entries.saved_ingredient_id was dropped/never carried forward — no
--   current migration or type references it). This view re-derives the
--   relationship by matching on whichever identifier is most specific:
--     1. barcode, when the saved_ingredients row has one
--     2. off_id, when it has no barcode but has this
--     3. lower(name) + brand, as a last resort
--   This mirrors (does not fix) the same identity fallback useStore.
--   saveIngredient already uses for its own dedup match. It inherits that
--   match's known fragility — two rows for the same real-world product with
--   drifted name/brand text still won't merge here — but it does NOT use
--   name+brand as the FIRST key the way saveIngredient's current dedup
--   does, so it at least stops making that specific problem worse for any
--   row that does carry a barcode or off_id.
--
-- ZERO-MATCH FALLBACK IS 0, NOT use_count
--   decay_score and use_count are different units — a decay score for a
--   genuinely frequent item lands around 1-8, so an old use_count of 11
--   sitting in the same column would silently outrank everything real. A
--   saved_ingredients row with zero matching meal_entries is (almost
--   certainly) a save that was never actually logged; it belongs at the
--   bottom, not propped up by a stale counter. Hence coalesce(..., 0), not
--   coalesce(..., si.use_count).
--
-- THE DECAY FORMULA IS A DURATION, NOT A CALENDAR DATE
--   decay_score sums exp(-days_since_use / 21) per matching meal_entries
--   row, where days_since_use = extract(epoch from (now() - m.eaten_at)) /
--   86400.0 — an elapsed-seconds duration between two timestamptz instants.
--   This is NOT subject to the dateKey() / "never toISOString().split('T')
--   [0]" rule elsewhere in this codebase. That rule exists to stop UTC
--   vs. local CALENDAR-DAY boundary bugs under BST (e.g. deciding which
--   day a meal belongs to). There is no calendar-day boundary anywhere in
--   this computation — it is a continuous elapsed-time quantity feeding an
--   exponential, not a date bucket. Do not "fix" this into a local-date
--   subtraction; that would quantise a smooth decay into calendar-day steps
--   for no reason and reintroduce exactly the class of bug dateKey() exists
--   to prevent, in a place that was never at risk of it.
--
-- RLS: security_invoker = on, same as biometric_periods/biometric_workouts
--   (see 20260808150000_biometric_spine_views.sql). Without it this view
--   would run as its owner/definer and hand every user's saved_ingredients
--   and meal_entries rows to every other user — a straight RLS bypass, not
--   a hypothetical one. No new policies are added; the view inherits
--   saved_ingredients' and meal_entries' existing per-user RLS as the
--   querying user.
--
-- WHAT'S DELIBERATELY NOT TOUCHED
--   saved_ingredients.use_count and its client read-modify-write bump
--   (useStore.saveIngredient) are UNCHANGED. Once the screen's sort comes
--   from this view, use_count becomes vestigial for ranking purposes and
--   its known cross-device race only affects a number nothing depends on
--   anymore. An atomic bump_saved_ingredient_use() RPC (matching
--   bump_composition_use/bump_bundle_use) would be the correct eventual
--   fix for that number's own accuracy, but it is unrelated to this
--   migration and is deliberately not included here.
-- ============================================================================

create or replace view public.saved_ingredients_scored
with (security_invoker = on) as
select
  si.*,

  coalesce(
    sum(
      exp(
        - (extract(epoch from (now() - m.eaten_at)) / 86400.0) / 21
      )
    ),
    0
  ) as decay_score,

  max(m.eaten_at) as last_used_at

from public.saved_ingredients si
left join public.meal_entries m
  on m.user_id = si.user_id
 and (
      (si.barcode is not null and m.barcode = si.barcode)
   or (si.barcode is null and si.off_id is not null and m.off_id = si.off_id)
   or (
        si.barcode is null and si.off_id is null
        and lower(m.name) = lower(si.name)
        and coalesce(m.brand, '') = coalesce(si.brand, '')
      )
    )
group by si.id;

comment on view public.saved_ingredients_scored is
  'saved_ingredients + a recency-decayed use score computed from meal_entries. '
  'security_invoker = on — see 20260815100000_saved_ingredients_decay_score.sql. '
  'decay_score is 0 (not use_count) for rows with no matching meal_entries.';

comment on column public.saved_ingredients_scored.decay_score is
  'sum(exp(-days_since_use / 21)) over matching meal_entries.eaten_at. A '
  'timestamptz duration, not a calendar-date computation — not subject to '
  'the dateKey() rule. 0 (never use_count) when nothing matches.';

comment on column public.saved_ingredients_scored.last_used_at is
  'max(meal_entries.eaten_at) over the same match. NULL if never logged.';

grant select on public.saved_ingredients_scored to authenticated;


-- ============================================================================
-- VERIFICATION
--
-- The before AND after snapshots (V0, V2) must be run as the SAME role.
-- Running either one in the SQL editor as `postgres` bypasses RLS — that
-- role sees every user's rows, so a postgres "after" compared against an
-- authenticated "before" (or vice versa) is not apples-to-apples and can
-- hide a real regression. Run everything below as `authenticated` (signed
-- in as your test user), not as `postgres`.
-- ============================================================================

-- V0. BASELINE — run BEFORE applying this migration.
--
-- select count(*) as n, md5(string_agg(id::text, ',' order by id::text)) as sig
-- from saved_ingredients;

-- V1. RLS fails closed. Sign in as a SECOND account that has zero rows of
--     its own in saved_ingredients, then:
--
-- select count(*) from public.saved_ingredients_scored;
-- Expect 0. Non-zero means security_invoker didn't take and this view is
-- leaking every user's library — stop and fix before anything else.

-- V2. Row-count parity, run as your real test user. The view is a 1:1
--     aggregate over saved_ingredients (LEFT JOIN + group by si.id), so it
--     must not fan out or drop rows:
--
-- select count(*) from public.saved_ingredients;
-- select count(*) from public.saved_ingredients_scored;
-- Expect the same number both times.

-- V3. Zero-match fallback is 0, not use_count. Find (or make) a saved_ingredients
--     row with no corresponding meal_entries (e.g. one you've never actually
--     logged, only saved) — pick its id from V2's table, or:
--
-- select si.id, si.name, si.use_count
-- from public.saved_ingredients si
-- where not exists (
--   select 1 from public.meal_entries m
--   where m.user_id = si.user_id
--     and (
--          (si.barcode is not null and m.barcode = si.barcode)
--       or (si.barcode is null and si.off_id is not null and m.off_id = si.off_id)
--       or (si.barcode is null and si.off_id is null
--           and lower(m.name) = lower(si.name)
--           and coalesce(m.brand, '') = coalesce(si.brand, ''))
--     )
-- )
-- limit 5;
--
-- select id, name, use_count, decay_score, last_used_at
-- from public.saved_ingredients_scored
-- where id in (/* an id from above */);
-- Expect decay_score = 0 and last_used_at IS NULL, regardless of use_count.

-- V4. Known multi-use item — hand-check the decay math. Pick an item you've
--     logged several times:
--
-- select eaten_at from public.meal_entries
-- where user_id = auth.uid() and barcode = (/* that item's barcode */)
-- order by eaten_at;
-- Manually sum exp(-days_since_use/21) for those timestamps (days_since_use
-- = (now - eaten_at) in days) and compare against:
--
-- select name, decay_score from public.saved_ingredients_scored
-- where barcode = (/* same barcode */);
-- Expect them to match within float rounding.

-- V5. last_used_at tracks the most recent use for that same item:
--
-- select max(eaten_at) from public.meal_entries
-- where user_id = auth.uid() and barcode = (/* same barcode */);
-- select last_used_at from public.saved_ingredients_scored
-- where barcode = (/* same barcode */);
-- Expect identical values.

-- V6. Fallback-path items (no barcode, no off_id) don't error and still
--     resolve via name+brand:
--
-- select id, name, brand, decay_score, last_used_at
-- from public.saved_ingredients_scored
-- where barcode is null and off_id is null
-- limit 5;
-- Expect no error; decay_score/last_used_at populated for any of these
-- whose name+brand also appears in meal_entries, 0/NULL otherwise.

-- ============================================================================
-- MANUAL TEST CHECKLIST
-- ============================================================================
-- [ ] Run V0 before applying, save the count/sig.
-- [ ] Apply this migration.
-- [ ] Run V1 signed in as a SECOND account with no saved_ingredients rows —
--     confirm 0 rows back from saved_ingredients_scored.
-- [ ] Run V2 as your real test user — row counts match between the base
--     table and the view.
-- [ ] Run V3 — a never-logged saved item shows decay_score = 0, NOT its
--     use_count.
-- [ ] Run V4 — hand-computed decay for a real multi-use item matches the
--     view's decay_score.
-- [ ] Run V5 — last_used_at matches max(eaten_at) for that same item.
-- [ ] Run V6 — fallback (no barcode/off_id) rows resolve without error.
-- ============================================================================

-- ============================================================
-- NOT in this migration (deliberately deferred)
--
-- The screen swap (fetchSavedIngredients -> saved_ingredients_scored,
-- decay_score as the sort key, the recency-label badge, and the in-memory
-- library search box) is its own commit, so a schema-only change can be
-- reviewed and verified independently of any UI behaviour change.
--
-- bump_saved_ingredient_use() RPC to make the use_count write atomic — see
-- "WHAT'S DELIBERATELY NOT TOUCHED" above. Unrelated to this migration.
--
-- Merging/deduplicating existing saved_ingredients rows that already split
-- across drifted name/brand text for the same real product — a data-repair
-- migration, not a schema change, and needs its own decision on how to
-- reconcile two different use_count values before it can be written.
-- ============================================================
