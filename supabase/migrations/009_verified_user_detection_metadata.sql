alter table public.verified_users
  add column if not exists verification_method text
    not null default 'manual',
  add column if not exists detected_at timestamptz;

update public.verified_users
set verification_method = 'manual'
where verification_method is null;

alter table public.verified_users
  drop constraint if exists verified_users_verification_method_check;

alter table public.verified_users
  add constraint verified_users_verification_method_check
  check (verification_method in ('manual', 'detected_custom_title'));
