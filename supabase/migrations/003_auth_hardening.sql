-- Keep username credentials and profile identity consistent with Backend rules.

update public.profiles
set username = lower(trim(username))
where username is not null
  and username <> lower(trim(username));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_username_format'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_username_format check (
        username is null
        or username ~ '^[a-z0-9][a-z0-9._]{2,29}$'
      );
  end if;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

create or replace function public.sync_auth_user_email()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.profiles
  set email = new.email
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute procedure public.sync_auth_user_email();

-- Profile credential fields are managed by the Backend service role. Authenticated
-- browser clients may read their own row but cannot update it directly.
drop policy if exists "Users can update their own profile" on public.profiles;
