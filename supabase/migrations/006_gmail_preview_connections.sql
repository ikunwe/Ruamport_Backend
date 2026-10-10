-- Run after 001-005. These tables only store mail connection credentials and
-- short-lived OAuth state; they do not store emails, PDFs, or portfolio data.
begin;

create table if not exists public.mail_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider = 'GOOGLE'),
  email text not null,
  refresh_token_encrypted text not null,
  scopes text not null,
  connected_at timestamptz not null default now()
);

create table if not exists public.mail_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expected_email text not null,
  verifier_encrypted text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists mail_oauth_states_expiry_idx
  on public.mail_oauth_states(expires_at);
alter table public.mail_connections enable row level security;
alter table public.mail_oauth_states enable row level security;
-- Never expose credentials/state through Supabase client-side APIs.
revoke all on public.mail_connections from anon, authenticated;
revoke all on public.mail_oauth_states from anon, authenticated;
grant select, insert, update, delete on public.mail_connections to service_role;
grant select, insert, update, delete on public.mail_oauth_states to service_role;
commit;
