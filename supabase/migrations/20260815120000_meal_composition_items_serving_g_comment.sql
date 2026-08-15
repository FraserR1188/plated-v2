-- ============================================================================
-- 20260815120000_meal_composition_items_serving_g_comment.sql
-- meal_composition_items.serving_g — correct a now-false column comment
--
-- THE STALE CLAIM
--   20260713120000_meal_bundles.sql (lines 89-90) documents serving_g as:
--
--     "serving_g is nullable, mirroring meal_entries. (It is typed `number`
--     in src/types — that type is wrong, and the null renders as '0g'.)"
--
--   That was true when written: serving_g was purely a display value, never
--   read back into a calculation. Apply-time quantity adjustment (Phase 1,
--   commit 250dcbe) and save-back-to-definition (Phase 2, commit c613307)
--   made it exactly the opposite — src/lib/compositions.ts's
--   scaleEntryDraftGrams uses serving_g as the RATIO DENOMINATOR for
--   rescaling an item's macros (newGrams / serving_g), and
--   updateCompositionItemQuantities persists the result back onto this same
--   column. "Display-only" is no longer accurate.
--
--   No `COMMENT ON COLUMN` was ever actually issued for serving_g — the
--   stale claim lives only as a `--` prose comment inside the original
--   CREATE TABLE statement, never as a queryable database comment (compare
--   eaten_time, which DID get a real `comment on column` in that same
--   migration, at lines 142-144). This migration is therefore adding the
--   database's first real comment on this column, not correcting one that
--   was already live — but it exists specifically to retire the claim above.
--
-- WHY A NEW MIGRATION, NOT AN EDIT TO 20260713120000_meal_bundles.sql
--   Migrations are immutable once applied — CLAUDE.md is explicit about this
--   project's convention, and every migration in this directory that
--   supersedes an earlier one (see 20260801100000's rename, or
--   20260801120000's nullability change) does it forward, via a new file,
--   never by rewriting history. The stale `--` prose in the original file
--   stays exactly as it reads; it is now simply describing a decision that a
--   later migration (this one) revisited, the same way 20260801120000's
--   header explains ITS OWN relationship to what came before it.
--
-- THE core_ingredients.sql DISCREPANCY — LEFT ALONE, NOTED HERE INSTEAD
--   20260808140000_core_ingredients.sql (lines 48-51) reads:
--
--     "Quantity -> grams. Per-100g stays canonical above; this is a
--     SEPARATE mechanism, not a rescale of it — see estimateGrams() in
--     src/lib/ingredients.ts. Don't repeat meal_entries' nullable-serving_g
--     rescale trap by conflating the two."
--
--   Note what this actually names: meal_entries.serving_g, not
--   meal_composition_items.serving_g — a DIFFERENT table's column, cited as
--   a cautionary analogy for core_ingredients.unit_grams. That claim is
--   still literally true today: meal_entries.serving_g remains display-only
--   (a MealEntry row is a terminal snapshot, never rescaled in place after
--   insert) — Phase 1/2 never touch it. So this comment is not FALSE, but
--   it is now easy to over-read as a blanket "no serving_g column is ever a
--   rescale basis" rule, which meal_composition_items.serving_g quietly
--   breaks as of Phase 1. Since the text is a `--` comment inside an
--   already-applied migration, it is left untouched rather than edited —
--   this paragraph is the correction-by-reference CLAUDE.md's
--   "migrations ship with verification SQL" discipline implies when the
--   thing needing correction is prose, not schema.
-- ============================================================================

comment on column public.meal_composition_items.serving_g is
  'The RESCALE DENOMINATOR for apply-time quantity adjustment (Phase 1) and '
  'save-back-to-definition (Phase 2, see src/lib/compositions.ts''s '
  'scaleEntryDraftGrams / updateCompositionItemQuantities). Mirrors '
  'meal_entries.serving_g in nullability and meaning. NULL or <= 0 means '
  'this item has no denominator to rescale from — scaleEntryDraftGrams '
  'refuses by returning the draft unchanged rather than guessing a default '
  'weight, and the review UI disables the quantity control for that item. '
  'No longer "display-only" — see '
  '20260815120000_meal_composition_items_serving_g_comment.sql for why.';


-- ============================================================================
-- VERIFICATION — run as `authenticated` or postgres; this is metadata only,
-- no RLS-gated table access involved.
-- ============================================================================

-- V1. The new comment is present and says what this migration intends.
--
-- select col_description('public.meal_composition_items'::regclass, ordinal_position) as comment
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'meal_composition_items'
--    and column_name = 'serving_g';
--     Expect: one row, comment starts with "The RESCALE DENOMINATOR...".

-- V2. No data or constraint changed — this migration is comment-only.
--     Expect: identical shape to before (nullable numeric, no default).
--
-- select data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'meal_composition_items'
--    and column_name = 'serving_g';
--     Expect: numeric, YES, NULL — unchanged from 20260713120000.


-- ============================================================================
-- MANUAL TEST CHECKLIST
-- ============================================================================
-- [ ] Run V1 — comment present, correct text.
-- [ ] Run V2 — column shape unchanged (nullable numeric, no default).
-- [ ] npx vitest run — full suite green (this migration touches no code path
--     any test exercises; a regression here would mean the migration did
--     more than it claims to).
