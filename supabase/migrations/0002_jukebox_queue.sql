-- ============================================================
-- Haaahooo v0.2.0 — shared jukebox queue
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query)
-- BEFORE deploying the v0.2.0 code. Safe to run once.
-- ============================================================

-- 1) Pointer to the queue row that is currently playing.
alter table public.conversation_jukebox
  add column if not exists current_queue_id uuid;

-- 2) The ordered queue (one row per queued track).
create table if not exists public.conversation_jukebox_queue (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  position        bigint not null,
  track_id        text not null,
  track_uri       text not null,
  track_name      text not null,
  artist_name     text not null,
  album_image_url text,
  spotify_url     text,
  duration_ms     integer not null,
  added_by        uuid not null,
  added_at        timestamptz not null default now()
);

create index if not exists conversation_jukebox_queue_convo_pos_idx
  on public.conversation_jukebox_queue (conversation_id, position);

-- 3) Row Level Security.
--    The API writes with the service-role key (bypasses RLS), so only a
--    SELECT policy is needed — for the realtime subscription to deliver
--    changes to conversation members.
alter table public.conversation_jukebox_queue enable row level security;

drop policy if exists "queue_select_members"
  on public.conversation_jukebox_queue;

create policy "queue_select_members"
  on public.conversation_jukebox_queue
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
alter table public.conversation_jukebox_queue replica identity full;

do $$
begin
  alter publication supabase_realtime
    add table public.conversation_jukebox_queue;
exception
  when duplicate_object then null;  -- already added; ignore
end $$;

-- ============================================================
-- NOTE: conversation_id is stored without a hard foreign key so this
-- migration runs regardless of how your conversations table is named.
-- If you want cascade-delete cleanup, add a FK to your conversations
-- table afterwards, e.g.:
--   alter table public.conversation_jukebox_queue
--     add constraint conversation_jukebox_queue_convo_fk
--     foreign key (conversation_id)
--     references public.conversations (id) on delete cascade;
-- ============================================================
