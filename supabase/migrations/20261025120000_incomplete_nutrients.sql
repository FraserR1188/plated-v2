-- ============================================================================
-- 20261025120000_incomplete_nutrients.sql
-- PL-059 — batch small-four: sum the known, flag the incomplete
--
-- Adds incomplete_nutrients text[] to meal_entries and meal_composition_items.
-- Schema only: no data changes, no RLS changes, no view changes (the
-- whoop_cycle_nutrition change is its own migration, 20261025130000).
--
-- WHY: draftsFromBatch used to apply NULL-poisons-total to sat_fat, salt,
-- fibre and sugar — one ingredient with no fibre on record made the whole
-- batch's fibre NULL, and the day total then counted that batch as nothing.
-- From this release a batch sums its KNOWN ingredients and lists each
-- nutrient that had at least one unknown ingredient here. The stored number
-- for a listed nutrient is a LOWER BOUND, never a complete total.
--
-- ── THE STATES, per nutrient ────────────────────────────────────────────
--   value non-NULL, not listed   -> complete (every ingredient known)
--   value non-NULL, listed       -> lower bound (some ingredients unknown)
--   value NULL,     not listed   -> unknown (no ingredient known)
--   value NULL,     listed       -> IMPOSSIBLE, refused by the CHECK below
--
-- incomplete_nutrients NULL means "nothing incomplete". An EMPTY array is
-- refused: one spelling for complete, not two.
--
-- ── meal_composition_items TOO ─────────────────────────────────────────
-- createBundleFromEntries / appendEntriesToBundle snapshot ANY selected
-- Today entry into meal_composition_items, a source='batch' entry included.
-- Without the column there, a bundled lower bound would come back out of
-- draftsFromComposition looking like a complete total. A batch's OWN
-- ingredient rows always write NULL here (an ingredient is a per-100g rate ×
-- grams, never a partial sum).
--
-- ── NOT NULL-GUARDED WHERE A CHECK WOULD PASS ON NULL ──────────────────
-- A CHECK passes when it evaluates to NULL. Each clause below starts with
-- `incomplete_nutrients is null or ...` so the NULL case is stated, not
-- implied by three-valued logic — same reasoning as
-- meal_compositions_batch_shape.
--
-- Existing rows: every one gets NULL (no default), which satisfies all three
-- constraints, so ADD CONSTRAINT validates without touching any value.
-- Old clients never send the column, so their inserts land NULL — correct
-- for everything except a partial batch, which is exactly the pre-release
-- behaviour they already had.
--
-- RLS: unchanged. Every policy on both tables is row-level (USING / WITH
-- CHECK on user_id, plus meal_entries_select_follower), and no migration
-- issues a column-level grant on either table, so the new column is covered
-- by exactly the policies that cover every other column.
-- ============================================================================

alter table public.meal_entries
  add column incomplete_nutrients text[];

alter table public.meal_composition_items
  add column incomplete_nutrients text[];

-- ── meal_entries ────────────────────────────────────────────────────────

alter table public.meal_entries
  add constraint meal_entries_incomplete_nutrients_nonempty
  check (incomplete_nutrients is null or cardinality(incomplete_nutrients) > 0);

alter table public.meal_entries
  add constraint meal_entries_incomplete_nutrients_small_four
  check (
    incomplete_nutrients is null
    or incomplete_nutrients <@ array['sat_fat', 'salt', 'fibre', 'sugar']::text[]
  );

alter table public.meal_entries
  add constraint meal_entries_incomplete_nutrients_has_value
  check (
    incomplete_nutrients is null
    or (
          (not ('sat_fat' = any (incomplete_nutrients)) or sat_fat is not null)
      and (not ('salt'    = any (incomplete_nutrients)) or salt    is not null)
      and (not ('fibre'   = any (incomplete_nutrients)) or fibre   is not null)
      and (not ('sugar'   = any (incomplete_nutrients)) or sugar   is not null)
    )
  );

comment on column public.meal_entries.incomplete_nutrients is
  'Small-four nutrients (sat_fat, salt, fibre, sugar) whose stored value is a LOWER BOUND: the sum of the known ingredients of a batch where at least one ingredient had no value on record. NULL = nothing incomplete (never an empty array). A listed nutrient always has a non-NULL value; an all-unknown nutrient is NULL and not listed. Set at insert by the client (draftsFromBatch) and carried by every copy and bundle snapshot; never set or cleared by an edit. See 20261025120000_incomplete_nutrients.sql.';

-- ── meal_composition_items ──────────────────────────────────────────────

alter table public.meal_composition_items
  add constraint meal_composition_items_incomplete_nutrients_nonempty
  check (incomplete_nutrients is null or cardinality(incomplete_nutrients) > 0);

alter table public.meal_composition_items
  add constraint meal_composition_items_incomplete_nutrients_small_four
  check (
    incomplete_nutrients is null
    or incomplete_nutrients <@ array['sat_fat', 'salt', 'fibre', 'sugar']::text[]
  );

alter table public.meal_composition_items
  add constraint meal_composition_items_incomplete_nutrients_has_value
  check (
    incomplete_nutrients is null
    or (
          (not ('sat_fat' = any (incomplete_nutrients)) or sat_fat is not null)
      and (not ('salt'    = any (incomplete_nutrients)) or salt    is not null)
      and (not ('fibre'   = any (incomplete_nutrients)) or fibre   is not null)
      and (not ('sugar'   = any (incomplete_nutrients)) or sugar   is not null)
    )
  );

comment on column public.meal_composition_items.incomplete_nutrients is
  'Snapshot of meal_entries.incomplete_nutrients when a bundle item is copied from a logged entry (a partial batch entry keeps its lower-bound flag through the bundle). Always NULL on a batch''s own ingredient rows. Same constraints and semantics as meal_entries.incomplete_nutrients. See 20261025120000_incomplete_nutrients.sql.';
