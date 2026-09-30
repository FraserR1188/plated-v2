-- ============================================================================
-- 20260930120000_receipts.sql
-- Receipt scanner v1, commit 1a — docs/2026-09-25-receipt-scanner-findings.md §5
--
-- ADDS
--   1. public.receipts                     one saved till receipt (header)
--   2. public.receipt_lines                its printed lines, in order
--   3. receipts_touch_updated_at           BEFORE UPDATE trigger on receipts
--   4. RLS + grants
--   5. public.save_receipt(jsonb, jsonb)   header + lines in one transaction
--   6. public.delete_receipt(uuid)         loud delete: 0 rows is an error
--
-- NOT HERE (commit 1b, 20260930130000)
--   update_receipt. Its transaction semantics get their own file and their own
--   revert point.
--
-- WHY AN RPC FOR EVERY WRITE
--   The precedent for a parent + children write is two inserts and a
--   compensating delete (src/lib/compositions.ts). For a receipt, a failed
--   compensating delete leaves a header with a printed total and no lines —
--   and that header COUNTS toward spending. One function call is one statement
--   inside PostgREST's per-request transaction, so a CHECK failure on any line
--   rolls the header back with it.
--
--   All RPCs are SECURITY INVOKER with search_path = '': RLS still applies to
--   every statement they run, and user_id comes from auth.uid(), NEVER from
--   the payload. A payload carrying "user_id" is ignored because the column
--   lists are explicit.
--
-- DIRECT DML STAYS GRANTED — deliberately
--   A SECURITY INVOKER function runs as the caller, so `authenticated` must
--   keep insert/update/delete on both tables or the RPCs themselves fail. So a
--   user can still write THEIR OWN rows directly through PostgREST; RLS stops
--   them touching anyone else's. "Only through the RPCs" is enforced on the
--   client by the write-site guard (findings §8), not here. The alternative —
--   SECURITY DEFINER, explicit auth.uid() checks, DML revoked — moves the RLS
--   logic into function bodies. Not taken for v1; recorded so the trade-off is
--   on file.
--
-- NULL, NEVER 0
--   printed_total_pence and line_total_pence are nullable with NO default. An
--   unreadable figure is NULL; 0 is only ever a printed "0.00". `->>` on a
--   missing key and on a JSON null both give NULL, so an omitted total cannot
--   become 0.
--
-- updated_at IS A TRIGGER, NOT RPC CODE
--   So it is true for any update path, including a direct PostgREST update the
--   client guard can't see. Its own function, not handle_updated_at or
--   set_updated_at: this database has two competing touch functions
--   (20260713120000_meal_bundles.sql header) and this adds no dependency on
--   either.
--
-- purchased_on_estimated — MEANING FIXED BEFORE ANY CODE WRITES IT (PL-048)
--   true  iff the date was NOT read from the receipt AND the user did not set
--         it on the review screen (the review defaulted it to today's dateKey()).
--   update_receipt (1b) enforces the edit half: changing purchased_on sets it
--   false; otherwise it is left as it was.
--
-- NOTHING FOR MULTI-IMAGE
--   Neither a line's photo `part` nor the seam flag is stored (findings §3).
--
-- NO VIEW
--   The Spending segment computes client-side from receipts alone, so there is
--   no security_invoker surface to get wrong.
-- ============================================================================


-- ─── 1. receipts ────────────────────────────────────────────────────────────

create table public.receipts (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,

  -- Chain or brand only, never address/branch/phone (the function strips
  -- postcodes before this is ever written).
  store                  text,

  -- A calendar date on the receipt, not an instant. The client sends a
  -- dateKey() string; it never goes through toISOString().
  purchased_on           date not null,

  -- No default: the caller must say whether the date was read or assumed.
  purchased_on_estimated boolean not null,

  printed_total_pence    integer,

  currency               char(3) not null default 'GBP',

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint receipts_store_len    check (store is null or length(btrim(store)) between 1 and 60),
  constraint receipts_total_nonneg check (printed_total_pence is null or printed_total_pence >= 0),
  constraint receipts_currency_iso check (currency ~ '^[A-Z]{3}$')
);

comment on table public.receipts is
  'A saved till receipt (header). Grocery spending only: nothing here is ever '
  'written to meal_entries. Written only through save_receipt / update_receipt '
  '/ delete_receipt.';
comment on column public.receipts.printed_total_pence is
  'The amount due for goods after all savings, in minor units. NULL = unreadable '
  'or not printed; never coalesced to 0.';
comment on column public.receipts.purchased_on_estimated is
  'true iff the date was not read from the receipt and the user did not set it '
  'on the review screen. Changing purchased_on in update_receipt sets it false.';
comment on column public.receipts.currency is
  'ISO 4217. Defaults to GBP because the review screen shows it and the user '
  'confirms it. Amounts in different currencies are never summed.';

create index receipts_user_date_idx
  on public.receipts (user_id, purchased_on desc, id desc);


-- ─── 2. updated_at ──────────────────────────────────────────────────────────

create function public.receipts_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger receipts_touch_updated_at
  before update on public.receipts
  for each row
  execute function public.receipts_touch_updated_at();


-- ─── 3. receipt_lines ───────────────────────────────────────────────────────

create table public.receipt_lines (
  id               uuid primary key default gen_random_uuid(),
  receipt_id       uuid not null references public.receipts (id) on delete cascade,

  -- Denormalised so RLS is a simple predicate on reads. The insert/update
  -- policies check it agrees with the parent (§4).
  user_id          uuid not null references auth.users (id) on delete cascade,

  position         integer not null check (position >= 0),

  -- One physical printed line, as printed. Kept so a later version can match
  -- lines to foods retroactively.
  raw_text         text not null check (length(btrim(raw_text)) between 1 and 120),

  -- numeric, not integer: weighed items print "0.512 kg".
  qty              numeric(10,3) check (qty is null or qty > 0),
  qty_unit         text check (qty_unit is null or qty_unit in ('each', 'kg')),
  unit_price_pence integer check (unit_price_pence is null or unit_price_pence >= 0),
  line_total_pence integer,

  -- Discounts, multibuy savings and a void's cancel line (findings §3).
  is_discount      boolean not null default false,

  constraint receipt_lines_sign check (
    line_total_pence is null
    or (is_discount and line_total_pence <= 0)
    or (not is_discount and line_total_pence >= 0)),

  unique (receipt_id, position)
);

comment on column public.receipt_lines.line_total_pence is
  'As printed, in minor units; a discount is <= 0. NULL = unreadable, never 0.';

-- (receipt_id, position) is already indexed by the unique constraint.
create index receipt_lines_user_idx on public.receipt_lines (user_id);


-- ─── 4. RLS ─────────────────────────────────────────────────────────────────

alter table public.receipts      enable row level security;
alter table public.receipt_lines enable row level security;

create policy receipts_select_own on public.receipts
  for select using (user_id = auth.uid());

create policy receipts_insert_own on public.receipts
  for insert with check (user_id = auth.uid());

create policy receipts_update_own on public.receipts
  for update using (user_id = auth.uid())
           with check (user_id = auth.uid());

create policy receipts_delete_own on public.receipts
  for delete using (user_id = auth.uid());

-- ⚠ Lines INSERT and UPDATE check the PARENT, not just the row — copied from
-- meal_bundle_items. `user_id = auth.uid()` alone would let a user attach a
-- line carrying their own user_id to someone else's receipt_id.

create policy receipt_lines_select_own on public.receipt_lines
  for select using (user_id = auth.uid());

create policy receipt_lines_insert_own on public.receipt_lines
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.receipts r
       where r.id = receipt_id
         and r.user_id = auth.uid()
    )
  );

create policy receipt_lines_update_own on public.receipt_lines
  for update using (user_id = auth.uid())
           with check (
             user_id = auth.uid()
             and exists (
               select 1 from public.receipts r
                where r.id = receipt_id
                  and r.user_id = auth.uid()
             )
           );

create policy receipt_lines_delete_own on public.receipt_lines
  for delete using (user_id = auth.uid());

-- New public objects are not auto-exposed (supabase/config.toml), so grant
-- explicitly. The revoke is belt and braces in case a default privilege
-- still hands anon something: nothing here is for anon.
revoke all on public.receipts, public.receipt_lines from anon;

grant select, insert, update, delete
  on public.receipts, public.receipt_lines
  to authenticated;


-- ─── 5. save_receipt ────────────────────────────────────────────────────────
--
-- p_receipt: { store, purchased_on, purchased_on_estimated,
--              printed_total_pence, currency }
-- p_lines:   [{ position, raw_text, qty, qty_unit, unit_price_pence,
--               line_total_pence, is_discount }, ...]
--
-- Any other key (user_id, id, created_at, ...) is ignored: every column list
-- is explicit. A missing currency takes the column's default; a missing
-- purchased_on_estimated fails NOT NULL — the caller must say.

create function public.save_receipt(p_receipt jsonb, p_lines jsonb)
returns public.receipts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.receipts;
begin
  insert into public.receipts
    (user_id, store, purchased_on, purchased_on_estimated,
     printed_total_pence, currency)
  values
    (auth.uid(),
     p_receipt->>'store',
     (p_receipt->>'purchased_on')::date,
     (p_receipt->>'purchased_on_estimated')::boolean,
     (p_receipt->>'printed_total_pence')::integer,
     coalesce(p_receipt->>'currency', 'GBP'))
  returning * into r;

  insert into public.receipt_lines
    (receipt_id, user_id, position, raw_text, qty, qty_unit,
     unit_price_pence, line_total_pence, is_discount)
  select r.id, auth.uid(), x.position, x.raw_text, x.qty, x.qty_unit,
         x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(
      position integer, raw_text text, qty numeric, qty_unit text,
      unit_price_pence integer, line_total_pence integer, is_discount boolean);

  return r;
end
$$;

comment on function public.save_receipt(jsonb, jsonb) is
  'Insert a receipt and its lines in one transaction; user_id is auth.uid(), '
  'never the payload. Returns the saved header row.';


-- ─── 6. delete_receipt ──────────────────────────────────────────────────────
--
-- An RPC rather than .from("receipts").delete(): a PostgREST delete that
-- matches nothing returns success — someone else's id (hidden by RLS), an
-- already-deleted id, a stale edit screen. Here 0 rows is P0002, the same
-- error update_receipt raises, so the client handles "this receipt no longer
-- exists" once for both.

create function public.delete_receipt(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.receipts
   where id = p_id
     and user_id = auth.uid();          -- belt and braces; RLS already hides others' rows
  -- lines go by ON DELETE CASCADE

  if not found then
    raise exception 'delete_receipt: no receipt % for this user', p_id
      using errcode = 'P0002';          -- no_data_found
  end if;
end
$$;


revoke all on function public.save_receipt(jsonb, jsonb),
                       public.delete_receipt(uuid)
  from public, anon;

grant execute on function public.save_receipt(jsonb, jsonb),
                          public.delete_receipt(uuid)
  to authenticated;

-- The trigger function is not an API: nobody calls it directly.
revoke all on function public.receipts_touch_updated_at() from public, anon, authenticated;


-- ============================================================================
-- VERIFICATION + MANUAL TEST CHECKLIST
--
-- supabase/migrations/verify/20260930120000_verify.sql
-- Container rig (V2–V6, V10, V11 executed for real, plus sabotages):
-- supabase/migrations/verify/20260930120000_rig.sh
-- ============================================================================
