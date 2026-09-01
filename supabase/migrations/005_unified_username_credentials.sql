-- Every social-login profile receives a display/login username immediately.
-- Password login remains disabled until the user sets a password in the app.

alter table public.profiles
  add column if not exists password_enabled boolean not null default false;

-- In the previous flow a non-null username was only created together with a
-- password, so preserve username login for those existing users.
update public.profiles
set password_enabled = true
where username is not null
  and password_enabled = false;

alter table public.profiles
  drop constraint if exists profiles_username_format;

do $$
declare
  profile_row record;
  base_username text;
  candidate text;
begin
  for profile_row in
    select id, email, full_name
    from public.profiles
    where username is null
  loop
    base_username := lower(trim(coalesce(
      nullif(profile_row.full_name, ''),
      split_part(profile_row.email, '@', 1),
      'user'
    )));
    base_username := left(regexp_replace(base_username, '\s+', ' ', 'g'), 50);

    if char_length(base_username) < 3 or position('@' in base_username) > 0 then
      base_username := 'user';
    end if;

    candidate := base_username;
    if exists (
      select 1 from public.profiles
      where lower(username) = lower(candidate)
    ) then
      candidate := left(base_username, 41) || '-' || left(profile_row.id::text, 8);
    end if;

    update public.profiles
    set username = candidate
    where id = profile_row.id;
  end loop;
end;
$$;

alter table public.profiles
  alter column username set not null;

alter table public.profiles
  add constraint profiles_username_format check (
    char_length(username) between 3 and 50
    and username = lower(trim(username))
    and position('@' in username) = 0
  );

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  base_username text;
  candidate text;
begin
  base_username := lower(trim(coalesce(
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    split_part(new.email, '@', 1),
    'user'
  )));
  base_username := left(regexp_replace(base_username, '\s+', ' ', 'g'), 50);

  if char_length(base_username) < 3 or position('@' in base_username) > 0 then
    base_username := 'user';
  end if;

  candidate := base_username;
  if exists (
    select 1 from public.profiles
    where lower(username) = lower(candidate)
  ) then
    candidate := left(base_username, 41) || '-' || left(new.id::text, 8);
  end if;

  insert into public.profiles (
    id,
    email,
    username,
    full_name,
    avatar_url,
    password_enabled
  )
  values (
    new.id,
    new.email,
    candidate,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
