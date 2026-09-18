alter table public.verified_users
  add column if not exists custom_title_detected text,
  add column if not exists title_lost_at timestamptz;
