create table if not exists public.verified_member_tag_reviews (
  group_id bigint not null,
  user_id bigint not null,
  username text,
  display_name text,
  observed_tag text,
  status text not null check (status in (
    'pending',
    'approving',
    'approved',
    'rejected',
    'matched',
    'tag_absent',
    'missing_tag',
    'revoked_tag',
    'uncertain'
  )),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by bigint,
  review_claim_token uuid,
  review_claim_expires_at timestamptz,
  review_claim_previous_status text check (
    review_claim_previous_status in ('pending', 'revoked_tag')
  ),
  primary key (group_id, user_id)
);

create index if not exists verified_member_tag_reviews_group_status_idx
  on public.verified_member_tag_reviews (group_id, status, last_seen_at desc);

alter table public.verified_member_tag_reviews enable row level security;
revoke all on public.verified_member_tag_reviews from anon, authenticated;
grant all on public.verified_member_tag_reviews to service_role;

create table if not exists public.verified_member_tag_audit (
  event_key text primary key,
  group_id bigint not null,
  user_id bigint not null,
  event_type text not null check (event_type in (
    'OBSERVED',
    'APPROVED',
    'REJECTED',
    'CHECK_FAILED'
  )),
  previous_status text,
  current_status text not null,
  observed_tag text,
  failure_code text,
  actor_user_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists verified_member_tag_audit_group_created_idx
  on public.verified_member_tag_audit (group_id, created_at desc);

alter table public.verified_member_tag_audit enable row level security;
revoke all on public.verified_member_tag_audit from anon, authenticated;
grant all on public.verified_member_tag_audit to service_role;
