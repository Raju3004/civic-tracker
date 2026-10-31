-- Run ONCE in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run
-- Needed by the upgraded backend (title, address, multiple photos, Rejected status, authority remark).
-- Safe to re-run. Do this BEFORE deploying the new backend, or complaint submission will fail.

alter table users add column if not exists mobile text;

alter table complaints add column if not exists title text;
alter table complaints add column if not exists address text;
alter table complaints add column if not exists photo_urls jsonb not null default '[]'::jsonb;
alter table complaints add column if not exists authority_remark text;

-- Backfill photo_urls for existing single-photo rows
update complaints
   set photo_urls = jsonb_build_array(photo_url)
 where photo_url is not null and photo_urls = '[]'::jsonb;

-- Allow the new 'Rejected' status
alter table complaints drop constraint if exists complaints_status_check;
alter table complaints
  add constraint complaints_status_check
  check (status in ('Pending', 'In Progress', 'Resolved', 'Rejected'));
