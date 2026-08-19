-- Root cause of the Friends "Could not follow user" failure: follows FKs point
-- at profiles(user_id), and profile creation was client-side only. Two of three
-- existing accounts had no profile row at all, so the insert died with 23503
-- (verified: follows_follower_id_fkey, "Key is not present in table profiles").
-- Search still worked because it only proves the TARGET has a profile.
--
-- Making the profile a structural consequence of having an account fixes the
-- whole class: without it, an affected user is also unsearchable by every other
-- user, which would silently break social testing across the closed track.
--
-- Provisional handle is deliberately neutral rather than email-derived:
-- profiles_select_all is USING (true), so the handle is world-readable the
-- instant it exists, and an email local part is frequently firstname_lastname.
-- The user picks a real handle later via upsertProfile.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  attempts  int := 0;
begin
  -- Retry on username collision rather than pre-checking: a pre-check is racy
  -- under concurrent signup, and a raised unique_violation here would abort the
  -- entire auth transaction and fail the signup.
  loop
    attempts  := attempts + 1;
    candidate := 'user_' || substr(md5(gen_random_uuid()::text), 1, 6);

    begin
      insert into public.profiles (user_id, username)
      values (new.id, candidate)
      on conflict (user_id) do nothing;   -- idempotent alongside client upsertProfile
      return new;
    exception when unique_violation then
      if attempts >= 5 then raise; end if;
    end;
  end loop;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill accounts that predate the trigger.
do $$
declare
  u         record;
  candidate text;
begin
  for u in
    select au.id
      from auth.users au
      left join public.profiles p on p.user_id = au.id
     where p.user_id is null
  loop
    loop
      candidate := 'user_' || substr(md5(gen_random_uuid()::text), 1, 6);
      exit when not exists (select 1 from public.profiles where username = candidate);
    end loop;

    insert into public.profiles (user_id, username)
    values (u.id, candidate)
    on conflict (user_id) do nothing;
  end loop;
end $$;
