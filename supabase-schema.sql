-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('citizen', 'authority')),
  created_at timestamptz not null default now()
);

create table if not exists complaints (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  description text not null,
  lat double precision,
  lng double precision,
  accuracy_meters double precision,
  photo_url text,
  status text not null default 'Pending' check (status in ('Pending', 'In Progress', 'Resolved')),
  is_duplicate_of uuid references complaints(id),
  submitted_by uuid references users(id),
  submitted_by_name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_complaints_category_status on complaints (category, status);

-- Enable RLS with no policies: blocks all access via the public anon key,
-- while our backend's service_role key bypasses RLS entirely and keeps working.
alter table users enable row level security;
alter table complaints enable row level security;
