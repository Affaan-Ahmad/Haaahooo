-- ============================================================
-- Keep-alive heartbeat table
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
-- Safe to run once.
--
-- Supabase pauses a free-tier project after 7 consecutive days with
-- no API activity. Registered or logged-in users do NOT count on their
-- own — only actual requests to the project do. A scheduled job pings
-- this table on an interval so the project always has recent activity.
--
-- This table is deliberately public-readable (anon select) so the
-- heartbeat can run with the publishable/anon key alone, with no user
-- session. It holds a single dummy row and no sensitive data.
-- ============================================================

create table if not exists public.keepalive (
  id          smallint primary key default 1,
  pinged_at   timestamptz not null default now(),
  constraint keepalive_singleton check (id = 1)
);

insert into public.keepalive (id)
  values (1)
  on conflict (id) do nothing;

alter table public.keepalive enable row level security;

-- Anyone (including the anonymous role) may read the single heartbeat row.
drop policy if exists "keepalive_anon_read" on public.keepalive;
create policy "keepalive_anon_read"
  on public.keepalive
  for select
  to anon, authenticated
  using (true);
