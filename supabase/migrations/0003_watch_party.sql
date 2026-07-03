-- ============================================================
-- Haaahooo v0.9.0 — synced YouTube watch party ("Cinema mode")
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query)
-- BEFORE deploying the watch-party code. Safe to run once.
--
-- Mirrors the jukebox tables (0002) but for an in-browser YouTube
-- watch party. There is NO remote-control API for YouTube, so both
-- listeners run an embedded player; these tables are the shared clock
-- both browsers reconcile against over realtime.
-- ============================================================

-- 1) Shared "now playing" state (one row per conversation).
create table if not exists public.conversation_watch (
  conversation_id  uuid primary key,
  video_id         text,
  title            text,
  channel_title    text,
  thumbnail_url    text,
  duration_ms      integer not null default 0,
  position_ms      integer not null default 0,
  is_playing       boolean not null default false,
  changed_at       timestamptz not null default now(),
  changed_by       uuid,
  current_queue_id uuid
);

-- 2) The ordered queue (one row per queued video).
create table if not exists public.conversation_watch_queue (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  position        bigint not null,
  played          boolean not null default false,
  played_at       timestamptz,
  video_id        text not null,
  title           text not null,
  channel_title   text,
  thumbnail_url   text,
  duration_ms     integer not null default 0,
  added_by        uuid,
  added_at        timestamptz not null default now()
);

create index if not exists conversation_watch_queue_convo_pos_idx
  on public.conversation_watch_queue (conversation_id, position);

-- 3) Row Level Security.
--    The API writes with the service-role key (bypasses RLS), so only a
--    SELECT policy is needed — for the realtime subscription to deliver
--    changes to conversation members.
alter table public.conversation_watch enable row level security;
alter table public.conversation_watch_queue enable row level security;

drop policy if exists "watch_select_members" on public.conversation_watch;
create policy "watch_select_members"
  on public.conversation_watch
  for select
  using (
    conversation_id in (
      select conversation_id
      from public.conversation_members
      where user_id = auth.uid()
    )
  );

drop policy if exists "watch_queue_select_members"
  on public.conversation_watch_queue;
create policy "watch_queue_select_members"
  on public.conversation_watch_queue
  for select
  using (
    conversation_id in (
      select conversation_id
      from public.conversation_members
      where user_id = auth.uid()
    )
  );

-- 4) Realtime: deliver inserts/updates/deletes to subscribers, and use
--    full replica identity so DELETE events carry conversation_id (needed
--    for the client-side filter).
alter table public.conversation_watch replica identity full;
alter table public.conversation_watch_queue replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.conversation_watch;
exception
  when duplicate_object then null;  -- already added; ignore
end $$;

do $$
begin
  alter publication supabase_realtime
    add table public.conversation_watch_queue;
exception
  when duplicate_object then null;  -- already added; ignore
end $$;

-- ============================================================
-- NOTE: conversation_id is stored without a hard foreign key so this
-- migration runs regardless of how your conversations table is named
-- (matches the jukebox migration). Add a cascade FK afterward if wanted.
-- ============================================================
