-- ============================================================================
-- 20260801120000_batch_capability_meal_compositions.sql
-- Migration 2 of 2 for the Batches feature — SCHEMA ONLY.
--
-- Adds the capability for meal_compositions to hold a BATCH (a recipe: N
-- ingredients + a yield + a portion size → ONE merged meal_entries row at
-- apply) alongside what it already holds today — a BUNDLE (N independently
-- loggable items). No UI, no draftsFromBatch, no null-poisons-total macro
-- math — those land with the Batches tab in a follow-up change. This
-- migration only makes the shape representable and enforces it.
--
--   1. meal_compositions.kind                    'bundle' | 'batch', default
--                                                 'bundle', CHECK-validated.
--   2. meal_compositions.{yield_g,portion_g,      batch-only. NULL for every
--      portion_label}                             bundle, by CHECK.
--   3. meal_composition_items.{meal_type,         now NULLABLE — required for
--      eaten_time}                                a bundle item, forbidden
--                                                  for a batch item, enforced
--                                                  by a new BEFORE INSERT/
--                                                  UPDATE trigger (a CHECK
--                                                  constraint can't do this:
--                                                  it needs the PARENT's
--                                                  kind, which lives in a
--                                                  different table).
--
-- WHY THIS IS SAFE ON A TABLE THAT ALREADY HAS ROWS
--
--   kind: added NOT NULL with a literal DEFAULT ('bundle'). Postgres (11+)
--   backfills a constant default as a metadata-only operation — no table
--   rewrite, and critically, no row is ever left without a value to check.
--   Every existing row becomes kind = 'bundle' as part of the ADD COLUMN
--   itself, before the CHECK constraint two statements later is added. This
--   is the confirmation the task asks for, not a separate step: ADD
--   CONSTRAINT validates against every existing row as part of the ALTER,
--   and if even one row failed, that statement — and the whole transaction —
--   would abort right there, before COMMIT. There is no path to a landed
--   migration with an unchecked row.
--
--   yield_g / portion_g / portion_label: added NULLABLE with no default, so
--   every existing row gets NULL — exactly the bundle shape the CHECK added
--   after them requires. Same reasoning: the CHECK's validation-on-add IS
--   the proof, for the same reason as above.
--
--   meal_type / eaten_time going nullable: DROPPING a NOT NULL constraint
--   can never be violated by existing data — there is no way for a row that
--   satisfied NOT NULL a moment ago to suddenly not satisfy nullable. No
--   data check is needed or possible here, only for the OPPOSITE direction
--   (adding a NOT NULL to a column that might already hold nulls), which
--   this migration never does. The new trigger doesn't retroactively touch
--   existing rows either — it only fires on FUTURE inserts/updates. Existing
--   bundle items, already 100% NOT NULL by the constraint that's existed
--   since the table was created, trivially satisfy the trigger's bundle
--   branch; they just never get asked. V9 in the verification block below
--   confirms this with a live count rather than taking it on faith.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT (for meal_type/eaten_time)
--
--   A CHECK constraint only sees the ROW being written — it has no way to
--   join out to meal_compositions and ask "is my parent a bundle or a
--   batch?". That question is exactly what needs answering here, so it has
--   to be a trigger (same reason migration 3's meal_entries_no_future_logged
--   is a trigger and not a CHECK — "now() is not immutable" there, "no
--   cross-table read" here; different reasons, same conclusion).
--
-- RLS IS UNTOUCHED
--   Every policy from migration 1 (rename) still applies verbatim — none of
--   them reference kind, yield_g, portion_g, portion_label, meal_type or
--   eaten_time in a way this migration changes. No RLS statements below.
-- ============================================================================

begin;

-- ─── 1. meal_compositions.kind ───────────────────────────────────────────────

alter table public.meal_compositions
  add column kind text not null default 'bundle';

alter table public.meal_compositions
  add constraint meal_compositions_kind_valid
  check (kind in ('bundle', 'batch'));

comment on column public.meal_compositions.kind is
  'bundle: N independently loggable items (today''s only shape). '
  'batch: N ingredients + yield_g/portion_g → ONE merged output at apply. '
  'Default ''bundle'' so every pre-migration-2 row is one, unambiguously.';

-- ─── 2. Batch-only columns + the kind-conditional shape ──────────────────────

alter table public.meal_compositions
  add column yield_g       numeric,
  add column portion_g     numeric,
  add column portion_label text;

-- NULL-SAFE BY CONSTRUCTION: each branch explicitly checks IS NOT NULL before
-- comparing with `>`/`<=`. Without that, a batch row with yield_g = NULL would
-- make `yield_g > 0` evaluate to NULL (not FALSE) — and Postgres CHECK
-- constraints PASS on NULL, not just TRUE. That would let a batch through
-- with no yield at all. The explicit IS NOT NULL closes that hole.
alter table public.meal_compositions
  add constraint meal_compositions_batch_shape
  check (
    (
      kind = 'batch'
      and yield_g   is not null and yield_g   > 0
      and portion_g is not null and portion_g > 0
      and portion_g <= yield_g
      -- portion_label is NOT constrained here, batch or bundle — it's a
      -- display-only convenience ("1 pancake"), optional even for a batch.
    )
    or
    (
      kind = 'bundle'
      and yield_g       is null
      and portion_g     is null
      and portion_label is null
    )
  );

comment on column public.meal_compositions.yield_g is
  'BATCH ONLY. Total finished weight of the batch, grams. NULL for a bundle '
  '— enforced by meal_compositions_batch_shape, not just convention.';
comment on column public.meal_compositions.portion_g is
  'BATCH ONLY. Average single-portion weight, grams. Always <= yield_g. '
  'per-portion macro = (sum of ingredient macros) * portion_g / yield_g, '
  'computed fresh at apply time — never stored, never round-tripped. See '
  'draftsFromBatch when it lands.';
comment on column public.meal_compositions.portion_label is
  'BATCH ONLY, and optional even then. Display convenience, e.g. "1 pancake". '
  'Never used in the macro math.';

-- ─── 3. meal_composition_items: meal_type / eaten_time go nullable ───────────

alter table public.meal_composition_items
  alter column meal_type  drop not null,
  alter column eaten_time drop not null;

-- meal_type keeps its `default 'breakfast'` from migration 5 (D4) — untouched,
-- not asked for, and still a useful backstop: existing bundle-item insert code
-- (compositions.ts) always sets it explicitly, so the default has never been
-- relied on. Leaving it in place means a FUTURE batch-item insert that forgets
-- to explicitly null it out gets 'breakfast' — which the new trigger below
-- then REJECTS (a batch item must be NULL), turning a silent slip into a
-- loud one instead of quietly leaving it. eaten_time has no default, before
-- or after this migration — "make the caller say it" (or, for a batch item,
-- say nothing).

comment on column public.meal_composition_items.meal_type is
  'REQUIRED for a bundle item (each independently loggable), FORBIDDEN for a '
  'batch item (only the merged output gets a section, chosen at apply) — '
  'enforced by meal_composition_items_validate_kind_biu, not a CHECK, because '
  'the rule depends on the PARENT composition''s kind.';

comment on column public.meal_composition_items.eaten_time is
  'LOCAL wall clock (07:30), not an instant. Rebuilt on the target day by the '
  'client so DST changes cannot shift a bundle. REQUIRED for a bundle item, '
  'FORBIDDEN for a batch item — same trigger as meal_type, same reason.';

-- ─── 4. The kind-aware validation trigger ────────────────────────────────────
--
-- security invoker (explicit, matching bump_composition_use's style): this
-- only needs to read a row the caller can already see under
-- meal_compositions_select_own. If composition_id points at nothing the
-- caller can see — someone else's row, or a genuinely orphaned id — v_kind
-- comes back NULL and falls into the ELSE branch below. Same error either
-- way, so this can't be used to probe whether a composition_id exists.

create or replace function public.meal_composition_items_validate_kind()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind text;
begin
  select kind into v_kind
    from public.meal_compositions
   where id = new.composition_id;

  if v_kind = 'bundle' then
    if new.meal_type is null or new.eaten_time is null then
      raise exception
        'meal_composition_items %: a BUNDLE item requires both meal_type and '
        'eaten_time — each item is independently loggable.',
        coalesce(new.id::text, '(new)')
        using errcode = 'check_violation';
    end if;

  elsif v_kind = 'batch' then
    if new.meal_type is not null or new.eaten_time is not null then
      raise exception
        'meal_composition_items %: a BATCH item must have NULL meal_type and '
        'NULL eaten_time — an ingredient has no independent section or time; '
        'only the merged output does, chosen at apply.',
        coalesce(new.id::text, '(new)')
        using errcode = 'check_violation';
    end if;

  else
    -- No matching composition (v_kind is null): either composition_id is an
    -- orphan the FK is about to reject anyway, or it belongs to someone else
    -- and RLS is correctly hiding it from this SELECT. Fail loud here too
    -- rather than let either slip past this trigger silently.
    raise exception
      'meal_composition_items %: composition_id % does not resolve to a '
      'visible composition with a known kind.',
      coalesce(new.id::text, '(new)'), new.composition_id
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

comment on function public.meal_composition_items_validate_kind() is
  'BEFORE INSERT/UPDATE on meal_composition_items. Bundle item: meal_type + '
  'eaten_time both required. Batch item: both forbidden. A CHECK constraint '
  'cannot express this — it needs the PARENT composition''s kind.';

drop trigger if exists meal_composition_items_validate_kind_biu on public.meal_composition_items;

create trigger meal_composition_items_validate_kind_biu
  before insert or update on public.meal_composition_items
  for each row
  execute function public.meal_composition_items_validate_kind();

commit;


-- ============================================================================
-- VERIFICATION — run as `authenticated`, NOT in the SQL editor as postgres.
-- postgres bypasses RLS, so a policy-dependent step (the trigger's SELECT on
-- meal_compositions) would look fine under postgres even if RLS had a hole.
--
-- Several of these are INSERT attempts EXPECTED TO FAIL. Run each one
-- INDIVIDUALLY, not pasted as one block — most SQL editors run a pasted
-- block as a single transaction, and the first expected failure would abort
-- everything after it, including the ones meant to succeed.
-- ============================================================================

-- V1. kind backfilled correctly: every pre-existing row is 'bundle', and the
--     column is NOT NULL (no row could be anything else).
--
-- select count(*) as non_bundle_rows
--   from public.meal_compositions
--  where kind is distinct from 'bundle';
--     Expect: 0.

-- V2. The batch CHECK rejects a batch with NULL yield.
--
-- insert into public.meal_compositions (user_id, name, kind, portion_g)
-- values (auth.uid(), 'test batch — null yield', 'batch', 50);
--     Expect: ERROR — new row violates check constraint
--     "meal_compositions_batch_shape".

-- V3. The batch CHECK rejects portion_g > yield_g.
--
-- insert into public.meal_compositions
--   (user_id, name, kind, yield_g, portion_g)
-- values
--   (auth.uid(), 'test batch — portion > yield', 'batch', 100, 150);
--     Expect: ERROR — same constraint.

-- V4. The batch CHECK accepts a genuinely valid batch (control case — proves
--     V2/V3 are testing the constraint, not just breaking the insert some
--     other way). Note the id for V6/V8.
--
-- insert into public.meal_compositions
--   (user_id, name, kind, yield_g, portion_g, portion_label)
-- values
--   (auth.uid(), 'test batch — valid', 'batch', 900, 75, '1 pancake')
-- returning id;
--     Expect: SUCCEEDS, 1 row.

-- V5. The bundle CHECK rejects a bundle with non-NULL yield_g. (kind defaults
--     to 'bundle', so it's omitted here on purpose.)
--
-- insert into public.meal_compositions (user_id, name, yield_g)
-- values (auth.uid(), 'test bundle — has yield_g', 500);
--     Expect: ERROR — new row violates check constraint
--     "meal_compositions_batch_shape".

-- V6. The item trigger rejects a BUNDLE item with NULL meal_type. Use any
--     composition id you own with kind = 'bundle' (any pre-existing one
--     qualifies, since V1 confirms they all are).
--
-- insert into public.meal_composition_items
--   (composition_id, user_id, name, eaten_time, meal_type)
-- values
--   ('<a bundle composition id you own>', auth.uid(), 'test item', '07:30', null);
--     Expect: ERROR — "a BUNDLE item requires both meal_type and eaten_time".

-- V7. The item trigger rejects a BUNDLE item with NULL eaten_time (the other
--     half of V6 — meal_type present, eaten_time missing).
--
-- insert into public.meal_composition_items
--   (composition_id, user_id, name, meal_type)
-- values
--   ('<a bundle composition id you own>', auth.uid(), 'test item', 'breakfast');
--     Expect: same ERROR as V6 (eaten_time omitted → NULL, no default).

-- V8. The item trigger rejects a BATCH item with a non-NULL meal_type. Use
--     the id returned by V4.
--
-- insert into public.meal_composition_items
--   (composition_id, user_id, name, meal_type)
-- values
--   ('<the id from V4>', auth.uid(), 'test ingredient', 'breakfast');
--     Expect: ERROR — "a BATCH item must have NULL meal_type and NULL
--     eaten_time".

-- V8b. ...and accepts the same ingredient with both left NULL (control case).
--
-- insert into public.meal_composition_items
--   (composition_id, user_id, name, serving_g, calories)
-- values
--   ('<the id from V4>', auth.uid(), 'test ingredient', 150, 300);
--     Expect: SUCCEEDS.

-- V9. Existing item rows already 100% satisfy the trigger's bundle branch —
--     confirms the "no data check needed" reasoning above with a live count,
--     not just an argument.
--
-- select count(*) as would_fail_bundle_check
--   from public.meal_composition_items i
--   join public.meal_compositions c on c.id = i.composition_id
--  where c.kind = 'bundle'
--    and (i.meal_type is null or i.eaten_time is null);
--     Expect: 0.

-- V10. Clean up the test rows from V2–V8b (V2/V3/V5/V6/V7 never inserted
--      anything — they errored). Delete the item from V8b first (FK), then
--      the composition from V4.
--
-- delete from public.meal_composition_items
--  where composition_id = '<the id from V4>';
-- delete from public.meal_compositions
--  where id = '<the id from V4>';


-- ============================================================================
-- ON-DEVICE / APP CHECKLIST — existing bundles must read and apply exactly as
-- before (no UI ships in this migration, so this is about the EXISTING
-- bundle sheets, not anything new).
-- ============================================================================
--   □ npx vitest run — full suite green, including mealEntriesInsertSites
--     (untouched — this migration doesn't touch meal_entries or either of
--     its two insert sites).
--   □ TodayScreen's "Bundles" sheet still lists every existing bundle.
--   □ Apply an existing bundle to today → same meal_entries rows as before
--     this migration (proves SELECT * against meal_compositions/
--     meal_composition_items tolerates the new columns fine — Supabase
--     returns them, the TS types just don't declare them yet, which is
--     harmless for a type assertion).
--   □ Save a new bundle from selected entries, add an item to an existing
--     bundle, rename one, delete an item, delete a whole bundle — each still
--     works (proves the new trigger's bundle branch passes real app traffic,
--     not just the hand-written V6/V7 cases above).


-- ============================================================================
-- ROLLBACK — reverse of every statement above, in reverse order. Run
-- manually; NOT meant to be committed as a new forward migration file.
--
-- ⚠ ONLY SAFE IF NO BATCH ROWS OR NULL-meal_type/eaten_time ITEM ROWS EXIST.
-- This migration ships schema-only, with no UI to create a batch, so that
-- should hold — but if anything reached in via the SQL editor (e.g. the V4/
-- V8b test rows, if V10 wasn't run) or a future step created real batches
-- before you decided to roll back, step 3 (re-adding NOT NULL) will fail
-- loudly rather than silently truncate data. That failure is doing its job —
-- resolve it (delete the offending rows, or don't roll back) rather than
-- forcing it through.
-- ============================================================================

-- begin;
--
-- drop trigger if exists meal_composition_items_validate_kind_biu on public.meal_composition_items;
-- drop function if exists public.meal_composition_items_validate_kind();
--
-- alter table public.meal_composition_items
--   alter column meal_type  set not null,
--   alter column eaten_time set not null;
--
-- comment on column public.meal_composition_items.meal_type is null;
-- comment on column public.meal_composition_items.eaten_time is
--   'LOCAL wall clock (07:30), not an instant. Rebuilt on the target day by the '
--   'client so DST changes cannot shift a bundle.';
--
-- alter table public.meal_compositions
--   drop constraint if exists meal_compositions_batch_shape;
--
-- alter table public.meal_compositions
--   drop column if exists yield_g,
--   drop column if exists portion_g,
--   drop column if exists portion_label;
--
-- alter table public.meal_compositions
--   drop constraint if exists meal_compositions_kind_valid;
--
-- alter table public.meal_compositions
--   drop column if exists kind;
--
-- commit;
