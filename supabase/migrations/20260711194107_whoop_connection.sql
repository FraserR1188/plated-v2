-- ============================================================
-- WHOOP integration — migration 1 of 2
--
-- Three tables:
--   whoop_connections  — non-secret status. User CAN read their own row.
--   whoop_tokens       — OAuth credentials. NOBODY reads but service_role.
--   whoop_oauth_states — short-lived CSRF nonces, bound to a user.
--
-- The split exists so that "can the client see this?" is answered by the
-- table name, not by remembering which columns to omit from a select.
-- ============================================================


-- ─── whoop_connections ───────────────────────────────────────
-- Everything Settings needs to render, and nothing sensitive.

create table if not exists public.whoop_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique
                   references auth.users (id) on delete cascade,

  -- WHOOP's own user id (int64). Null until the first profile fetch.
  whoop_user_id  bigint,

  -- Space-separated, exactly as returned by the token endpoint. Stored so
  -- that a future scope addition can detect "connected, but under the old
  -- scopes" and prompt a re-consent rather than 403ing forever.
  scopes         text,

  -- 'connected' — tokens are live.
  -- 'revoked'   — a refresh failed, or the user disconnected at WHOOP's end.
  --               Tokens have been deleted. Settings shows "Reconnect".
  status         text not null default 'connected'
                   check (status in ('connected', 'revoked')),

  connected_at   timestamptz not null default now(),
  last_sync_at   timestamptz
);

alter table public.whoop_connections enable row level security;

-- Read-only, own row. Every write goes through an Edge Function on the
-- service role — the client must never be able to mark itself connected.
create policy whoop_connections_select_own
  on public.whoop_connections
  for select
  to authenticated
  using (auth.uid() = user_id);


-- ─── whoop_tokens ────────────────────────────────────────────
-- The actual credentials. A leaked WHOOP access token reads far more of a
-- person's health data than plated ever displays, and the refresh token is
-- effectively long-lived. This table is service_role-only, twice over.

create table if not exists public.whoop_tokens (
  user_id        uuid primary key
                   references auth.users (id) on delete cascade,

  access_token   text not null,
  refresh_token  text not null,

  -- Absolute expiry, computed on write as now() + expires_in.
  expires_at     timestamptz not null,

  -- Refresh tokens ROTATE: WHOOP invalidates the old one the moment a new
  -- one is issued. This column is the "when did we last successfully
  -- rotate" breadcrumb you will want when a connection mysteriously dies.
  updated_at     timestamptz not null default now()
);

alter table public.whoop_tokens enable row level security;
-- No policies. Intentional: RLS with zero policies denies everything to
-- anon and authenticated, while service_role bypasses RLS entirely.

-- Belt AND braces. Supabase grants anon/authenticated full DML on new
-- public tables by default, so RLS is the only thing standing between the
-- anon key (which is inside the APK) and these rows. One stray
-- `disable row level security` during debugging would expose them.
-- With the grants revoked, RLS is no longer a single point of failure.
revoke all on public.whoop_tokens from anon, authenticated;


-- ─── whoop_oauth_states ──────────────────────────────────────
-- The CSRF nonce for the authorize round-trip. Written by whoop-auth-start,
-- consumed and deleted by whoop-auth-callback.
--
-- The user_id column is the point of the whole table: it binds a returning
-- `code` to the plated user who started the flow. Without it, a state
-- parameter proves only that SOMEBODY started an OAuth flow — not that it
-- was this person. That is how WHOOP accounts get attached to the wrong row.

create table if not exists public.whoop_oauth_states (
  state       text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

alter table public.whoop_oauth_states enable row level security;
-- No policies: service_role only, same reasoning as whoop_tokens.
revoke all on public.whoop_oauth_states from anon, authenticated;

-- Supports the opportunistic sweep of expired nonces in whoop-auth-start.
create index if not exists whoop_oauth_states_expires_at_idx
  on public.whoop_oauth_states (expires_at);