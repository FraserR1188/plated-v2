-- ============================================================================
-- 20260713120000_meal_bundles.sql
-- D4 — Bundles & copy-a-day
--
-- ADDS
--   1. public.meal_bundles              a named, reusable set of foods
--   2. public.meal_bundle_items         SNAPSHOT rows — not references to foods
--   3. public.bump_bundle_use(uuid)     atomic use_count / last_used_at
--   4. RLS + grants
--   5. meal_entries_no_future_logged_bu closes the plan-laundering hole in the
--                                       EDIT path. See §5 — it is standalone and
--                                       can be dropped if you'd rather fix it
--                                       client-side.
--
-- DELIBERATELY ABSENT
--   • updated_at on meal_bundles.
--     This database has TWO competing touch functions (handle_updated_at and
--     set_updated_at) and no trigger on meal_entries using either. A column
--     nothing maintains is a column that lies. last_used_at earns its place;
--     updated_at does not.
--
--   • revoke insert, update, delete.
--     Unlike the WHOOP tables (written only by the Edge Function), the client
--     legitimately writes both of these. RLS is the entire enforcement surface,
--     so it has to be right — see the parent-ownership check in §4.
--
--   • a check constraint on meal_type.
--     meal_entries has none. A bundle item's meal_type is copied verbatim into
--     meal_entries, so a constraint HERE that isn't THERE means a value can be
--     legal in one table and illegal in the other. Consistency wins.
--
-- WHY SNAPSHOTS AND NOT FOREIGN KEYS
--   Same reason meal_entries is a snapshot table. An Open Food Facts product's
--   values change under you; a custom food gets edited or deleted. A reference
--   rots. A snapshot cannot. Accepted cost: editing your "usual porridge"
--   custom food does NOT update the bundle that contains it.
-- ============================================================================


-- ─── 1. meal_bundles ────────────────────────────────────────────────────────

create table if not exists public.meal_bundles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,

  -- Ordering the list. use_count alone ossifies — January's bundle sits at the
  -- top forever. last_used_at is the one that actually earns its place; the
  -- pair sorts as: recently used first, then most used, then alphabetical.
  use_count    integer     not null default 0,
  last_used_at timestamptz,

  created_at   timestamptz not null default now(),

  constraint meal_bundles_name_not_blank check (length(btrim(name)) > 0)
);

comment on table public.meal_bundles is
  'A named, reusable set of foods. Applied to a (day) — each item carries its '
  'own meal_type and time. Snapshot semantics: items do not reference foods.';

create index if not exists meal_bundles_user_idx
  on public.meal_bundles (user_id, last_used_at desc nulls last);


-- ─── 2. meal_bundle_items ───────────────────────────────────────────────────

create table if not exists public.meal_bundle_items (
  id        uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.meal_bundles (id) on delete cascade,

  -- Denormalised so RLS can be a simple predicate rather than a subquery on
  -- every read. The insert policy in §4 checks it agrees with the parent.
  user_id   uuid not null references auth.users (id) on delete cascade,

  position  integer not null default 0,

  -- ── Snapshot. Column-for-column with meal_entries, INCLUDING nullability. ──
  --
  -- calories/protein/carbs/fat are NOT NULL default 0.
  -- sat_fat/salt/fibre/sugar are NULLABLE default 0.
  --
  -- That asymmetry is not sloppiness, it is the meaning:
  --   NULL = we do not know how much fibre this had.
  --   0    = we know, and it had none.
  -- Coalescing on the way IN destroys that distinction permanently. Coalesce
  -- on the way out (`e.fibre ?? 0`) when summing; never on the way in.
  --
  -- serving_g is nullable, mirroring meal_entries. (It is typed `number` in
  -- src/types — that type is wrong, and the null renders as "0g".)
  name      text not null,
  brand     text,
  serving_g numeric,

  calories  numeric not null default 0,
  protein   numeric not null default 0,
  carbs     numeric not null default 0,
  fat       numeric not null default 0,

  sat_fat   numeric default 0,
  salt      numeric default 0,
  fibre     numeric default 0,
  sugar     numeric default 0,

  meal_type text not null default 'breakfast',

  -- LOCAL WALL CLOCK. 07:30, not a timestamp.
  --
  -- This is what makes bundles DST-correct by construction. Storing an instant
  -- or an offset would mean applying "07:30 porridge" across a clock change
  -- produces 06:30 or 08:30. A `time` has no such opinion: the client rebuilds
  -- the instant on the target day via resolveEatenAt(h, m, parseDateKey(day)),
  -- which goes through the local Date constructor and gets DST right for free.
  --
  -- No default. A bundle item without a time is a bundle item nobody thought
  -- about; make the caller say it.
  eaten_time time not null,

  -- ── Provenance ──
  barcode        text,
  off_id         text,

  -- image_url  = directly renderable (Open Food Facts). Public.
  -- image_path = an object path in the PRIVATE custom-food-images bucket.
  --
  -- BOTH are kept here, unlike in copyEntriesToMyLog, which drops image_path.
  -- The reason is storage RLS, not taste: a bundle is YOUR food, so the path is
  -- under YOUR folder and getSignedImageUrl() will sign it. A friend's custom
  -- food lives under THEIR folder and cannot be signed by you — which is why
  -- the social copy path drops it. Same column names, two different correct
  -- answers. Read the comment in src/lib/social.ts before "unifying" them.
  image_url      text,
  image_path     text,

  -- ON DELETE SET NULL, mirroring meal_entries.custom_food_id (verified against
  -- pg_constraint). The snapshot must survive the food's death while dropping a
  -- link it can no longer honour. A CASCADE here would delete bundle items when
  -- you tidy up a custom food — which is exactly the trap meal_entries avoided.
  custom_food_id uuid references public.custom_foods (id) on delete set null
);

comment on column public.meal_bundle_items.eaten_time is
  'LOCAL wall clock (07:30), not an instant. Rebuilt on the target day by the '
  'client so DST changes cannot shift a bundle.';

create index if not exists meal_bundle_items_bundle_idx
  on public.meal_bundle_items (bundle_id, position);

create index if not exists meal_bundle_items_user_idx
  on public.meal_bundle_items (user_id);


-- ─── 3. bump_bundle_use ─────────────────────────────────────────────────────
--
-- An RPC, not a read-modify-write, because saved_ingredients does it the other
-- way (useStore.saveIngredient reads use_count from LOCAL state, adds one, and
-- writes it back) and that pattern silently loses increments across two devices.
-- Don't repeat it. This is one statement and it cannot race.
--
-- security invoker + the auth.uid() predicate: you cannot bump someone else's
-- bundle even if you guess its uuid.

create or replace function public.bump_bundle_use(p_bundle_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.meal_bundles
     set use_count    = use_count + 1,
         last_used_at = now()
   where id = p_bundle_id
     and user_id = auth.uid();
$$;

comment on function public.bump_bundle_use(uuid) is
  'Atomically record a bundle application. Call AFTER applyEntries succeeds — '
  'a bundle you failed to apply is not a bundle you used.';


-- ─── 4. RLS ─────────────────────────────────────────────────────────────────

alter table public.meal_bundles      enable row level security;
alter table public.meal_bundle_items enable row level security;

-- meal_bundles: own rows, all four verbs.

create policy meal_bundles_select_own on public.meal_bundles
  for select using (user_id = auth.uid());

create policy meal_bundles_insert_own on public.meal_bundles
  for insert with check (user_id = auth.uid());

create policy meal_bundles_update_own on public.meal_bundles
  for update using (user_id = auth.uid())
           with check (user_id = auth.uid());

create policy meal_bundles_delete_own on public.meal_bundles
  for delete using (user_id = auth.uid());


-- meal_bundle_items.
--
-- ⚠ The INSERT policy checks the PARENT, not just the row.
--
-- `with check (user_id = auth.uid())` alone would let you insert an item
-- carrying YOUR user_id but SOMEONE ELSE'S bundle_id. They'd never see it
-- (their select filters on their own user_id), and it's low severity because
-- the uuid is unguessable — but it is an orphan row in their table, written by
-- you, and it costs two lines to make impossible.
--
-- The same check is on UPDATE, so you can't reparent an item into a bundle that
-- isn't yours either.

create policy meal_bundle_items_select_own on public.meal_bundle_items
  for select using (user_id = auth.uid());

create policy meal_bundle_items_insert_own on public.meal_bundle_items
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.meal_bundles b
       where b.id = bundle_id
         and b.user_id = auth.uid()
    )
  );

create policy meal_bundle_items_update_own on public.meal_bundle_items
  for update using (user_id = auth.uid())
           with check (
             user_id = auth.uid()
             and exists (
               select 1 from public.meal_bundles b
                where b.id = bundle_id
                  and b.user_id = auth.uid()
             )
           );

create policy meal_bundle_items_delete_own on public.meal_bundle_items
  for delete using (user_id = auth.uid());


grant select, insert, update, delete
  on public.meal_bundles, public.meal_bundle_items
  to authenticated;

grant execute on function public.bump_bundle_use(uuid) to authenticated;


-- ============================================================================
-- 5. THE PLAN-LAUNDERING HOLE IN THE EDIT PATH
--
-- This section is independent of bundles. Delete it if you'd rather fix this
-- client-side — but read it first, because it is live TODAY, and it is silent.
--
-- THE HOLE
--   1. Log breakfast this morning.  Trigger: planned = false. Correct.
--   2. Tap the row on TodayScreen  → handleEdit → ProductScreen with
--      editEntryId AND initialEatenAt.
--   3. Tap the date chip. Move it to next Thursday.
--   4. updateEntry passes eaten_at through (MealEntryPatch permits it) and
--      derives date from it.
--   5. meal_entries_freeze_planned_bu pins planned := old.planned → FALSE.
--   6. You now hold a row the database believes you ATE, dated in the future.
--
-- WHY IT'S INVISIBLE
--   whoop_cycle_nutrition gates on (planned = false or confirmed_at is not
--   null). This row passes on the FIRST clause. It never becomes Pending, so:
--     • getPendingEntries()      won't see it   (keys on planned = true)
--     • the confirm banner       won't ask      (same)
--     • whoop_unassigned_meals   won't report it (it isn't a gap — it's IN
--                                                 the correlation)
--   When WHOOP eventually produces a cycle containing that Thursday, the meal
--   is counted as food you ate. Every safety net you built keys on planned =
--   true, and this row is planned = false.
--
--   It is the exact failure the freeze trigger exists to prevent, arrived at
--   from the opposite direction. The freeze stops time from laundering a PLAN
--   into a FACT. It does nothing to stop an edit laundering a FACT into the
--   FUTURE.
--
-- WHY NOT JUST RE-DERIVE ON UPDATE
--   Because that undoes the freeze, and the freeze is right: moving tomorrow's
--   dinner to today must produce Pending, not Logged. The rule stays "set once,
--   never re-derived." What changes is that the ILLEGAL STATE becomes
--   unrepresentable rather than merely unlikely. A refusal, not a re-derivation.
--
-- WHY A SECOND TRIGGER RATHER THAN EDITING THE FIRST
--   Triggers of the same type fire in NAME order. 'f' < 'n', so
--   meal_entries_freeze_planned_bu still runs first and pins new.planned; this
--   one then inspects the pinned value. Nothing about migration 3 is touched,
--   and if you want this gone it is one drop trigger.
--
-- WHY NOT A CHECK CONSTRAINT
--   now() is not immutable. Postgres will not have it.
-- ============================================================================

create or replace function public.meal_entries_no_future_logged()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Same 30-minute grace as meal_entries_derive_planned(), and the same clock
  -- (the DATABASE's). If you change PLANNING_GRACE_MINUTES, change all three.
  if new.planned = false
     and new.eaten_at > now() + interval '30 minutes' then
    raise exception
      'meal_entries %: cannot move a logged meal into the future. A plan is not '
      'a fact. Log it on that day, or copy it there.',
      new.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists meal_entries_no_future_logged_bu on public.meal_entries;

create trigger meal_entries_no_future_logged_bu
  before update on public.meal_entries
  for each row
  execute function public.meal_entries_no_future_logged();


-- ============================================================================
-- VERIFICATION — run as `authenticated`, NOT in the SQL editor as postgres.
-- The postgres role bypasses RLS and will cheerfully tell you everything is fine.
-- ============================================================================

-- V1. Columns landed, nullability matches meal_entries where it should.
--     Expect: calories/protein/carbs/fat NO; sat_fat/salt/fibre/sugar YES;
--             serving_g YES; eaten_time NO, no default.
--
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'meal_bundle_items'
--  order by ordinal_position;

-- V2. The FK on-delete rules. Expect custom_food_id → SET NULL,
--     bundle_id → CASCADE, both user_id → CASCADE.
--
-- select conrelid::regclass as child, pg_get_constraintdef(oid) as def
--   from pg_constraint
--  where contype = 'f'
--    and conrelid::regclass::text in ('meal_bundles','meal_bundle_items');

-- V3. RLS is ON and the policies exist. Expect 4 + 4.
--
-- select tablename, policyname, cmd
--   from pg_policies
--  where tablename in ('meal_bundles','meal_bundle_items')
--  order by tablename, cmd;

-- V4. Both triggers on meal_entries, in the right ORDER.
--     Expect freeze_planned_bu BEFORE no_future_logged_bu alphabetically.
--
-- select tgname from pg_trigger
--  where tgrelid = 'public.meal_entries'::regclass and not tgisinternal
--  order by tgname;

-- V5. The hole is closed. As `authenticated`, on one of YOUR logged rows:
--
-- update public.meal_entries
--    set eaten_at = now() + interval '3 days'
--  where id = '<a row where planned = false>';
--
--     Expect: ERROR ... cannot move a logged meal into the future.
--     Before this migration: silently succeeds, planned stays false.

-- V6. The freeze still works (this migration must not have broken it).
--     On a PLANNED row, move it into the past:
--
-- update public.meal_entries
--    set eaten_at = now() - interval '1 hour'
--  where id = '<a row where planned = true>';
--
--     Expect: SUCCEEDS, planned stays TRUE → the row becomes Pending and the
--     banner asks about it. It must NOT become Logged.

-- V7. RLS actually bites. As `authenticated`, try to insert an item into a
--     bundle you don't own:
--
-- insert into public.meal_bundle_items
--   (bundle_id, user_id, name, eaten_time)
-- values
--   ('<someone else''s bundle id>', auth.uid(), 'test', '07:30');
--
--     Expect: ERROR — new row violates row-level security policy.

-- V8. bump_bundle_use is scoped.
--
-- select public.bump_bundle_use('<someone else''s bundle id>');
--     Expect: no error, but 0 rows updated. Their count does not move.


-- ============================================================================
-- ON-DEVICE TEST CHECKLIST (after the client lands)
-- ============================================================================
--   □ Save 4 items from today as a bundle → 1 meal_bundles row, 4 items,
--     positions 0..3, each with the item's own meal_type and eaten_time.
--   □ Apply that bundle to a FUTURE day → 4 meal_entries, all planned = true,
--     at the bundle's times on that day, eaten_at_estimated = true.
--   □ Apply the same bundle to TODAY, in the evening, where some items' times
--     have already passed → the sheet must SHOW which items will be Logged and
--     which Planned before you commit. (willBePlanned() per item.)
--   □ Copy Monday's lunch to Tuesday → same wall-clock time, planned = true.
--   □ Copy across a DST boundary → still the same wall-clock time. Not ±1h.
--   □ Copy a PENDING row (past, unconfirmed) → the NEW row derives its own
--     planned from its own eaten_at. The source's unanswered state does not
--     propagate.
--   □ Delete a custom food that a bundle item references → the item SURVIVES
--     with custom_food_id = null. Its macros and name are unchanged.
--   □ Delete a bundle → its items go with it. No meal_entries are touched.
--   □ Apply a bundle, then edit one of the resulting entries → normal entry.
--   □ Try to move a LOGGED entry to a future date in ProductScreen → the app
--     must surface the DB's refusal, not swallow it into a console.warn.