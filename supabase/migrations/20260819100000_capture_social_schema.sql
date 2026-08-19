-- Captures profiles / follows / follow_counts, which were created directly
-- against the remote DB and have never existed in migration history. This file
-- is a faithful transcription of the live shape as read from information_schema,
-- pg_constraint and pg_policy on 2026-08-19 — not a redesign.
--
-- Idempotent by construction: `create table if not exists` no-ops against the
-- live DB (where these already exist) and produces the correct shape on a fresh
-- one. Policies are dropped and recreated so this file is authoritative for them.
--
-- ONE DELIBERATE CHANGE: follow_counts gains security_invoker = on. It was
-- created without it, so it runs as owner and bypasses RLS. That leaks nothing
-- today (profiles_select_all and follows_select_all are both USING (true)), but
-- it violates the standing invariant and would become a live leak the moment
-- follows_select_all is tightened for the friendship model.

create table if not exists public.profiles (
  user_id      uuid        not null primary key
                 references auth.users(id) on delete cascade,
  username     text        not null unique
                 constraint username_format check (username ~ '^[a-z0-9_]{3,30}$'),
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.follows (
  follower_id  uuid        not null references public.profiles(user_id) on delete cascade,
  following_id uuid        not null references public.profiles(user_id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint no_self_follow check (follower_id <> following_id)
);

alter table public.profiles enable row level security;
alter table public.follows  enable row level security;

-- profiles: public read (handle search depends on it), own-row write.
drop policy if exists profiles_select_all  on public.profiles;
drop policy if exists profiles_insert_own  on public.profiles;
drop policy if exists profiles_update_own  on public.profiles;
drop policy if exists profiles_delete_own  on public.profiles;

create policy profiles_select_all on public.profiles
  for select using (true);
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = user_id);
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = user_id);
create policy profiles_delete_own on public.profiles
  for delete using (auth.uid() = user_id);

-- follows: the whole graph is world-readable to authenticated users. That is
-- how searchUsers computes is_following / follows_you in one round trip.
-- Revisit when the accept-gate lands — a pending-request model probably wants
-- this narrowed to rows the caller is party to.
drop policy if exists follows_select_all  on public.follows;
drop policy if exists follows_insert_own  on public.follows;
drop policy if exists follows_delete_own  on public.follows;

create policy follows_select_all on public.follows
  for select using (true);
create policy follows_insert_own on public.follows
  for insert with check (auth.uid() = follower_id);
create policy follows_delete_own on public.follows
  for delete using (auth.uid() = follower_id);

create or replace view public.follow_counts
with (security_invoker = on) as
  select p.user_id,
         p.username,
         p.display_name,
         count(distinct f_in.follower_id)   as follower_count,
         count(distinct f_out.following_id) as following_count
    from public.profiles p
    left join public.follows f_in  on f_in.following_id = p.user_id
    left join public.follows f_out on f_out.follower_id = p.user_id
   group by p.user_id, p.username, p.display_name;
