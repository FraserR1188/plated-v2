-- Converts follows from a one-way follow into a mutual friendship with an
-- accept handshake.
--
-- Why: meal_entries_select_follower currently grants read access to another
-- user's meal history the instant a follows row exists, with no consent step.
-- The Friends entry point is hidden (SOCIAL_ENABLED = false) precisely because
-- of that. This migration is what makes it safe to turn back on.
--
-- Model: one row per relationship, keyed on the existing directional pair.
-- follower_id is the REQUESTER, following_id is the ADDRESSEE. No reciprocal
-- row, no canonicalisation — the PK and both FKs are untouched.
--
-- follows was empty at migration time (verified: 0 rows), so no backfill of
-- existing relationships is needed and 'pending' is safe as the default.

alter table public.follows
  add column if not exists status text not null default 'pending';

alter table public.follows
  drop constraint if exists follows_status_valid;
alter table public.follows
  add constraint follows_status_valid check (status in ('pending', 'accepted'));

-- SELECT narrows from USING (true) to rows the caller is party to. The whole
-- graph — including who has a pending request open to whom — was previously
-- world-readable to any authenticated user. searchUsers still works: is_following
-- and follows_you are both computed from rows the caller is in.
drop policy if exists follows_select_all      on public.follows;
drop policy if exists follows_select_party    on public.follows;
create policy follows_select_party on public.follows
  for select using (auth.uid() = follower_id or auth.uid() = following_id);

-- INSERT unchanged in effect, restated for authoritativeness: you may only
-- create a request in which you are the requester. The status default does the
-- rest — a client cannot insert 'accepted' directly because with check pins it.
drop policy if exists follows_insert_own on public.follows;
create policy follows_insert_own on public.follows
  for insert with check (auth.uid() = follower_id and status = 'pending');

-- UPDATE did not exist at all, so accept would have failed closed. The addressee
-- and only the addressee may move a row, and only to 'accepted' — this is not a
-- general-purpose update policy.
drop policy if exists follows_update_addressee on public.follows;
create policy follows_update_addressee on public.follows
  for update
  using (auth.uid() = following_id)
  with check (auth.uid() = following_id and status = 'accepted');

-- DELETE widens to either party: cancel-your-own-request, decline, and unfriend
-- are all the same operation from the database's point of view.
drop policy if exists follows_delete_own   on public.follows;
drop policy if exists follows_delete_party on public.follows;
create policy follows_delete_party on public.follows
  for delete using (auth.uid() = follower_id or auth.uid() = following_id);

-- The accept gate itself. Two changes from the previous version: status must be
-- 'accepted', and the match is bidirectional — under a mutual model the
-- addressee must be able to read the requester's log too, which the old
-- follower_id-only clause did not allow.
drop policy if exists meal_entries_select_follower on public.meal_entries;
create policy meal_entries_select_follower on public.meal_entries
  for select
  using (
        (planned = false or confirmed_at is not null)
    and skipped_at is null
    and exists (
          select 1
            from public.follows f
           where f.status = 'accepted'
             and (
                   (f.follower_id  = auth.uid() and f.following_id = meal_entries.user_id)
                or (f.following_id = auth.uid() and f.follower_id  = meal_entries.user_id)
                 )
        )
  );
