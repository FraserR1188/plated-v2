-- ============================================================================
-- 20260930130000_update_receipt.sql
-- Receipt scanner v1, commit 1b — docs/2026-09-25-receipt-scanner-findings.md §5
--
-- ADDS
--   public.update_receipt(uuid, jsonb, jsonb)   replace a saved receipt's
--                                               header and lines in one
--                                               transaction
--
-- Needs 20260930120000_receipts.sql (1a). The two are pushed together.
--
-- REPLACE, NOT PATCH
--   The edit screen sends the whole receipt back: every header field and the
--   full line list. Lines are deleted and re-inserted, so the saved set is
--   exactly the payload — a line removed on screen is gone, a line added is
--   there, and positions are whatever the screen sent.
--
-- ONE TRANSACTION, OR NOTHING
--   One function call is one statement inside PostgREST's per-request
--   transaction. If the insert fails (a CHECK on any line), the header update
--   AND the delete roll back with it, and the receipt is exactly as it was.
--   Two things would break that, and the rig's sabotages 7a/7b prove V9
--   catches both:
--     • an exception handler around the insert that "recovers" — the delete
--       has already happened, so the receipt is left with no lines;
--     • splitting delete and insert into two RPC calls from the client — two
--       requests are two transactions.
--
-- 0 ROWS IS AN ERROR
--   Someone else's id (hidden by RLS), a receipt deleted on another device, a
--   typo: never a silent success. P0002, the same as delete_receipt, so the
--   client maps both to "this receipt no longer exists" once.
--
-- user_id IS NEVER READ FROM THE PAYLOAD
--   The header's user_id is not in the SET list and lines take auth.uid().
--
-- purchased_on_estimated IS NEVER READ FROM THE PAYLOAD EITHER (PL-048)
--   Meaning, fixed in 1a: true iff the date was not read from the receipt and
--   the user did not set it. An edit that CHANGES purchased_on is the user
--   setting it → false. An edit that leaves it alone keeps the flag as it was.
--   The server derives this; the client cannot get it wrong.
--
-- currency: a missing key keeps the saved value. Every other header field is
--   replaced as sent, so a JSON null total stays NULL, never 0.
--
-- updated_at moves by 1a's BEFORE UPDATE trigger. The header row is always
--   updated, so a lines-only edit moves it too.
-- ============================================================================

create function public.update_receipt(p_id uuid, p_receipt jsonb, p_lines jsonb)
returns public.receipts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.receipts;
begin
  update public.receipts t
     set store                  = p_receipt->>'store',
         purchased_on           = (p_receipt->>'purchased_on')::date,
         -- PL-048: a changed date is a user-set date. Unchanged → keep the flag.
         purchased_on_estimated = case
           when (p_receipt->>'purchased_on')::date is distinct from t.purchased_on then false
           else t.purchased_on_estimated
         end,
         printed_total_pence    = (p_receipt->>'printed_total_pence')::integer,
         currency               = coalesce(p_receipt->>'currency', t.currency)
   where t.id = p_id
     and t.user_id = auth.uid()          -- belt and braces; RLS already hides others' rows
  returning t.* into r;

  if not found then
    raise exception 'update_receipt: no receipt % for this user', p_id
      using errcode = 'P0002';          -- no_data_found; the client maps it to "no longer exists"
  end if;

  delete from public.receipt_lines where receipt_id = p_id;

  insert into public.receipt_lines
    (receipt_id, user_id, position, raw_text, qty, qty_unit,
     unit_price_pence, line_total_pence, is_discount)
  select p_id, auth.uid(), x.position, x.raw_text, x.qty, x.qty_unit,
         x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(
      position integer, raw_text text, qty numeric, qty_unit text,
      unit_price_pence integer, line_total_pence integer, is_discount boolean);

  return r;
end
$$;

comment on function public.update_receipt(uuid, jsonb, jsonb) is
  'Replace a receipt''s header and lines in one transaction. 0 rows raises '
  'P0002. user_id and purchased_on_estimated are never read from the payload; '
  'changing purchased_on sets purchased_on_estimated false.';

revoke all on function public.update_receipt(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.update_receipt(uuid, jsonb, jsonb) to authenticated;


-- ============================================================================
-- VERIFICATION + MANUAL TEST CHECKLIST
--
-- supabase/migrations/verify/20260930120000_verify.sql (1a and 1b together)
-- Container rig: supabase/migrations/verify/20260930120000_rig.sh applies
-- both migrations and runs V7–V11 for 1b, plus sabotages 6, 7a, 7b and 8.
-- ============================================================================
