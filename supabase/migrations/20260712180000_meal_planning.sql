-- ============================================================
-- Meal planning — migration 3
--
-- Adds:
--   meal_entries.planned / confirmed_at / skipped_at
--   eaten_at NOT NULL (it was silently nullable; see below)
--   the derive-on-insert + freeze-on-update triggers
--   the confirmation gate on whoop_cycle_nutrition
--   whoop_unassigned_meals, restructured — it can no longer be a
--   "no cycle" view, because pending meals fall out of the correlation
--   WITH a perfectly good cycle
--
-- whoop_correlation is UNCHANGED. Every nutrition column it reads comes
-- through whoop_cycle_nutrition, so the gate propagates for free.
--
-- THE INVARIANT THIS MIGRATION EXISTS TO PROTECT:
--   A plan is not evidence. A planned meal counts toward the day's GOALS
--   (dropping it makes planning useless) but must not enter the CORRELATION
--   until the user says they ate it. A plan-not-eaten is not noise — it is
--   BIAS, and it always points the same way: you plan the healthy dinner and
--   abandon it for the takeaway. The correlation then learns that a virtuous
--   Tuesday produced a terrible Wednesday recovery. That is the precise
--   failure the whole WHOOP pipeline was built to prevent.
--
--   And it cannot be retrofitted. Ship planning without these columns and
--   every planned meal is permanently indistinguishable from an eaten one.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. eaten_at: close the null hole while it is still free
--
-- eaten_at was `timestamptz NULL default now()`. A DEFAULT only fires when
-- the column is OMITTED — an explicit NULL is stored as NULL. The client's
-- addEntry passed `entry.eaten_at ?? null`, so any caller that forgot the
-- timestamp wrote a null, and a null eaten_at is contained by no cycle
-- interval: that meal is invisible to the correlation forever, silently.
--
-- `select count(*) from meal_entries where eaten_at is null` = 0 today, so
-- this costs nothing and can never be cheaper. A single null row and the
-- SET NOT NULL fails.
-- ════════════════════════════════════════════════════════════

alter table public.meal_entries
  alter column eaten_at set default now(),
  alter column eaten_at set not null;

comment on column public.meal_entries.eaten_at is
  'REAL eating time. The correlation joins on this, by UTC interval containment. NOT NULL: omit the column to get now(); an explicit NULL is an error, not a shrug.';


-- ════════════════════════════════════════════════════════════
-- 2. The planning columns
--
--  planned | eaten_at | confirmed_at | state      | goals | correlation
--  --------+----------+--------------+------------+-------+------------
--  false   |    —     |      —       | Logged     |   ✓   |     ✓
--  true    |  future  |     null     | Planned    |   ✓   |     ✗
--  true    |  past    |     null     | Pending    |   ✓   |     ✗
--  true    |  past    |     set      | Confirmed  |   ✓   |     ✓
--  true    |  past    |  (skipped)   | Skipped    |   ✗   |     ✗
--
-- skipped_at is NOT a delete. "I didn't eat it" keeps the row as evidence of
-- an abandoned plan — which is what makes "you skip your planned dinner 40%
-- of Thursdays" possible later. It counts toward nothing.
-- ════════════════════════════════════════════════════════════

alter table public.meal_entries
  add column if not exists planned      boolean not null default false,
  add column if not exists confirmed_at timestamptz,
  add column if not exists skipped_at   timestamptz;

comment on column public.meal_entries.planned is
  'DERIVED, never toggled. Set once by the BEFORE INSERT trigger from eaten_at, using the DATABASE clock. Frozen on UPDATE. The client never writes this.';
comment on column public.meal_entries.confirmed_at is
  'The user said "yes, I ate it". The ONLY thing that admits a planned meal to the correlation.';
comment on column public.meal_entries.skipped_at is
  'The user said "no, I didn''t". Evidence of an abandoned plan. Counts toward nothing.';

alter table public.meal_entries
  add constraint meal_entries_resolution_ck check (
        (confirmed_at is null or skipped_at is null)                       -- never both
    and (planned or (confirmed_at is null and skipped_at is null))         -- only a plan can be resolved
  );


-- ════════════════════════════════════════════════════════════
-- 3. Derivation — in the DATABASE, not the client
--
-- The client does not send `planned`, and must never start. Reasons:
--
--   1. The DB clock is trustworthy. A phone with a skewed clock cannot
--      mislabel a meal.
--   2. There is exactly ONE implementation of the rule. Two — one here, one
--      in TypeScript — would drift the day someone changes the grace window
--      in one place.
--   3. Every insert path is correct for free: copy, social, barcode, AI, and
--      whatever gets written in six months by someone who has never heard of
--      this column.
--
-- The 30-minute grace exists so that logging a 12:30 lunch at 12:29 is just
-- LOGGING, not a plan that will nag you at 14:00. Anything genuinely in the
-- future is a prediction, regardless of which side of midnight it lands on —
-- which matters, because Sunday meal prep produces four meals on future days
-- and one on Sunday itself, and a calendar-day rule would call that fifth
-- chilli a fact.
--
-- NOTE ON `date`: it is NOT derived here and must never be. `date` is the
-- user's LOCAL calendar day; Postgres has no idea what timezone the phone is
-- in. Deriving it here is a two-line change that looks obviously correct and
-- silently reintroduces the D2 bug for every BST evening meal.
-- ════════════════════════════════════════════════════════════

create or replace function public.meal_entries_derive_planned()
returns trigger
language plpgsql
as $$
begin
  -- Belt and braces with the NOT NULL above, but this error names the actual
  -- mistake instead of making the caller decode a constraint violation.
  if new.eaten_at is null then
    raise exception 'meal_entries.eaten_at must not be null. Omit the column to default to now(); an explicit NULL would make this meal invisible to the WHOOP correlation forever.';
  end if;

  new.planned      := new.eaten_at > now() + interval '30 minutes';
  new.confirmed_at := null;   -- nothing is born confirmed
  new.skipped_at   := null;   -- or skipped

  return new;
end;
$$;

drop trigger if exists meal_entries_derive_planned_bi on public.meal_entries;
create trigger meal_entries_derive_planned_bi
  before insert on public.meal_entries
  for each row execute function public.meal_entries_derive_planned();


-- `planned` is set ONCE and never re-derived. Moving a meal from tomorrow to
-- today is not the same as saying you ate it — it becomes Pending and joins
-- the confirmation banner, which is one tap. Re-deriving on UPDATE would
-- silently launder a plan into a fact just because time passed, which is
-- exactly the bias this migration exists to prevent.
--
-- So: monotonic. false never follows true. confirmed_at is the only transition.
create or replace function public.meal_entries_freeze_planned()
returns trigger
language plpgsql
as $$
begin
  new.planned := old.planned;

  if new.eaten_at is null then
    raise exception 'meal_entries.eaten_at must not be null.';
  end if;

  return new;
end;
$$;

drop trigger if exists meal_entries_freeze_planned_bu on public.meal_entries;
create trigger meal_entries_freeze_planned_bu
  before update on public.meal_entries
  for each row execute function public.meal_entries_freeze_planned();


-- The banner's query: every plan awaiting an answer. Partial, because the
-- pending set is tiny and permanently so — it is a working set, not a log.
create index if not exists meal_entries_pending_idx
  on public.meal_entries (user_id, eaten_at)
  where planned and confirmed_at is null and skipped_at is null;


-- ════════════════════════════════════════════════════════════
-- 4. The confirmation gate
--
-- ONE predicate covers all three exclusions:
--   planned + future            -> unconfirmed  -> out
--   planned + past  + pending   -> unconfirmed  -> out
--   planned + past  + skipped   -> unconfirmed  -> out   (confirmed_at is null)
--   planned + past  + confirmed ->              -> IN
--   not planned                 ->              -> IN
--
-- It sits in the ON clause, not a WHERE. In the WHERE it would silently
-- convert the LEFT JOIN into an inner one and delete every zero-meal cycle
-- from the view — which is a real cycle with nothing logged, not a missing
-- cycle, and the difference is the whole point of the LEFT JOIN.
--
-- Retroactive joins are free. A meal with eaten_at in the FUTURE has no
-- owning cycle because tomorrow's cycle does not exist yet — the interval
-- join simply does not place it. When whoop-sync pulls that cycle tomorrow
-- and the user confirms, the meal joins by itself. No state machine, no
-- midnight job.
--
-- Column list is unchanged, so CREATE OR REPLACE is safe (whoop_correlation
-- depends on this view and must not be dropped).
-- ════════════════════════════════════════════════════════════

create or replace view public.whoop_cycle_nutrition
with (security_invoker = on) as
with bounded as (
  select
    c.user_id,
    c.id                     as cycle_id,
    c.start                  as cycle_start,
    c."end"                  as cycle_end,
    (c."end" is null)        as is_in_progress,
    c.score_state,
    c.strain,
    c.kilojoule,
    c.average_heart_rate,
    c.timezone_offset,
    coalesce(
      c."end",
      case when c.start > now() - interval '36 hours' then now() end
    ) as effective_end
  from public.whoop_cycles c
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
  coalesce(sum(m.sat_fat),  0)        as sat_fat,
  coalesce(sum(m.salt),     0)        as salt,
  coalesce(sum(m.fibre),    0)        as fibre,
  coalesce(sum(m.sugar),    0)        as sugar,

  coalesce(bool_or(m.eaten_at_estimated), false) as has_estimated_times,
  min(m.eaten_at)                     as first_meal_at,
  max(m.eaten_at)                     as last_meal_at

from bounded b
left join public.meal_entries m
       on m.user_id  = b.user_id
      and b.effective_end is not null
      and m.eaten_at >= b.cycle_start
      and m.eaten_at <  b.effective_end
      -- ── THE GATE ──────────────────────────────────────────
      -- A plan is not evidence. Only meals that actually happened.
      and (m.planned = false or m.confirmed_at is not null)
group by
  b.user_id, b.cycle_id, b.cycle_start, b.cycle_end, b.effective_end,
  b.is_in_progress, b.score_state, b.strain, b.kilojoule,
  b.average_heart_rate, b.timezone_offset;

comment on view public.whoop_cycle_nutrition is
  'Meals aggregated per WHOOP cycle by UTC INTERVAL containment of eaten_at. EXCLUDES unconfirmed planned meals: a plan is not evidence. LEFT JOIN: meal_count = 0 is a real cycle with nothing logged, not a missing cycle.';


-- ════════════════════════════════════════════════════════════
-- 5. whoop_unassigned_meals — restructured
--
-- The old view asked "did any cycle contain this meal?" and reported the
-- ones where the answer was no. That was sound while a missing cycle was the
-- ONLY way to fall out of the correlation.
--
-- It no longer is. A PENDING meal (planned, past, unanswered) is excluded by
-- the gate above while sitting squarely inside a perfectly good cycle. Under
-- the old shape it would be invisible: gone from the correlation, absent from
-- the honesty column. That is the same failure this view exists to prevent,
-- reached from the other side.
--
-- So the question changes to "is this meal absent from the correlation, and
-- WHY?" — which needs EXISTS rather than an anti-join, because a pending meal
-- must be reported even though its cycle is right there.
--
--   'unconfirmed' — you planned it, the day came and went, you never said.
--                   ONE TAP fixes this. Actionable.
--   'no_cycle'    — strap off, gap in WHOOP data, or a stale open cycle.
--                   Not actionable; it is a fact about the data.
--
-- Excluded outright:
--   future planned — it has not HAPPENED. Reporting it as unassigned is a lie,
--                    and an honesty column that cries wolf gets ignored, which
--                    costs more than not having one.
--   skipped        — the user answered. A known non-event is not a gap.
--
-- 'no_eaten_at' is gone: eaten_at is NOT NULL as of section 1.
--
-- DROP + CREATE, not REPLACE: the column list changes. Nothing depends on
-- this view (whoop_correlation reads whoop_cycle_nutrition), so this is safe.
-- ════════════════════════════════════════════════════════════

drop view if exists public.whoop_unassigned_meals;

create view public.whoop_unassigned_meals
with (security_invoker = on) as
with span as (
  select user_id, min(start) as first_cycle_start
    from public.whoop_cycles
   group by user_id
),
placed as (
  select
    m.id,
    m.user_id,
    m.eaten_at,
    m.name,
    m.calories,
    m.planned,
    m.confirmed_at,
    m.skipped_at,
    exists (
      select 1
        from public.whoop_cycles c
       where c.user_id  = m.user_id
         and m.eaten_at >= c.start
         and m.eaten_at <  coalesce(
               c."end",
               case when c.start > now() - interval '36 hours' then now() end
             )
    ) as has_cycle
  from public.meal_entries m
)
select
  p.id,
  p.user_id,
  p.eaten_at,
  p.name,
  p.calories,
  p.planned,
  case
    when p.planned and p.confirmed_at is null then 'unconfirmed'
    else 'no_cycle'
  end as reason
from placed p
join span s on s.user_id = p.user_id
where p.skipped_at is null                      -- answered "no". Not a gap.
  and p.eaten_at <= now()                       -- hasn't happened yet /= unassigned
  and p.eaten_at >= s.first_cycle_start         -- predates the WHOOP connection /= a gap
  and (
        (p.planned and p.confirmed_at is null)  -- pending: a real hole, cycle or not
        or not p.has_cycle                      -- strap off / gap / stale open cycle
      );

comment on view public.whoop_unassigned_meals is
  'Meals absent from the correlation, and why. reason = ''unconfirmed'' is a plan the user never answered (one tap fixes it). reason = ''no_cycle'' is missing WHOOP data. Future plans and skipped meals are NOT reported: neither is a gap.';

grant select on public.whoop_unassigned_meals to authenticated;


-- ════════════════════════════════════════════════════════════
-- 6. OPTIONAL — meal_type NOT NULL
--
-- Out of scope for planning. Included because it will never be cheaper: all
-- null counts are currently ZERO, and one null row makes SET NOT NULL fail.
--
-- The bug: a null meal_type renders in NONE of the four sections but DOES
-- count in the correlation. The dashboard total silently disagrees with the
-- visible meals, and nothing in the UI can tell you why.
--
-- DELETE THIS ENTIRE BLOCK if you'd rather not carry it in this migration.
-- Verify first:  select count(*) from meal_entries where meal_type is null;
-- ════════════════════════════════════════════════════════════

alter table public.meal_entries
  alter column meal_type set default 'breakfast',
  alter column meal_type set not null;