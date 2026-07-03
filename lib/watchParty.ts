import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Shared YouTube "watch party" engine (used by the API route).
 *
 * Playback model: IN-BROWSER EMBEDDED PLAYER.
 *  - Unlike Spotify, YouTube has no remote-control API. Both listeners run an
 *    embedded IFrame player in the app. This engine owns only the SHARED CLOCK:
 *    which video, playing/paused, and the position at `changed_at`. Each client
 *    reconciles its local player against that state over Supabase realtime.
 *  - There is no server-side playback and no "broadcast" — advancing the queue
 *    is driven by whichever client is on-screen (the video only plays while a
 *    browser is watching), exactly like the jukebox's client-side advance timer.
 */

export type VideoInput = {
  videoId?: string;
  title?: string;
  channelTitle?: string | null;
  thumbnailUrl?: string | null;
  durationMs?: number;
};

export type WatchRow = {
  conversation_id: string;
  video_id: string | null;
  title: string | null;
  channel_title: string | null;
  thumbnail_url: string | null;
  duration_ms: number;
  position_ms: number;
  is_playing: boolean;
  changed_at: string;
  changed_by: string | null;
  current_queue_id: string | null;
};

export type WatchQueueRow = {
  id: string;
  conversation_id: string;
  position: number;
  played: boolean;
  played_at: string | null;
  video_id: string;
  title: string;
  channel_title: string | null;
  thumbnail_url: string | null;
  duration_ms: number;
  added_by: string | null;
  added_at: string;
};

// YouTube video ids are 11 chars of [A-Za-z0-9_-].
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function publicState(row: WatchRow | null) {
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    videoId: row.video_id,
    title: row.title,
    channelTitle: row.channel_title,
    thumbnailUrl: row.thumbnail_url,
    durationMs: row.duration_ms,
    positionMs: row.position_ms,
    isPlaying: row.is_playing,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
    currentQueueId: row.current_queue_id,
  };
}

export function publicQueueItem(row: WatchQueueRow) {
  return {
    id: row.id,
    position: row.position,
    videoId: row.video_id,
    title: row.title,
    channelTitle: row.channel_title,
    thumbnailUrl: row.thumbnail_url,
    durationMs: row.duration_ms,
    addedBy: row.added_by,
  };
}

/** Live position derived from the shared clock (position + elapsed while playing). */
export function currentPosition(row: WatchRow) {
  if (!row.is_playing) return row.position_ms;
  const elapsed = Date.now() - new Date(row.changed_at).getTime();
  const cap = row.duration_ms > 0 ? row.duration_ms : Number.MAX_SAFE_INTEGER;
  return Math.min(cap, row.position_ms + Math.max(0, elapsed));
}

export function validateVideo(
  video: VideoInput | undefined,
): video is Required<Pick<VideoInput, "videoId" | "title">> & VideoInput {
  return Boolean(
    video?.videoId && VIDEO_ID_RE.test(video.videoId) && video.title,
  );
}

export function isValidVideoId(id: string | null | undefined): id is string {
  return Boolean(id && VIDEO_ID_RE.test(id));
}

function sanitizeThumb(url: string | null | undefined) {
  return typeof url === "string" && /^https:\/\/i\.ytimg\.com\//.test(url)
    ? url
    : null;
}

export function videoFieldsFrom(video: VideoInput) {
  return {
    video_id: video.videoId!,
    title: video.title!.slice(0, 300),
    channel_title: video.channelTitle ? video.channelTitle.slice(0, 200) : null,
    thumbnail_url: sanitizeThumb(video.thumbnailUrl),
    duration_ms: Math.max(0, Math.round(video.durationMs ?? 0)),
  };
}

export async function loadQueue(conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversation_watch_queue")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as WatchQueueRow[];
}

export async function nextPosition(conversationId: string) {
  const queue = await loadQueue(conversationId);
  return (queue.length ? queue[queue.length - 1].position : 0) + 1;
}

export function queuePayload(all: WatchQueueRow[]) {
  const unplayed = all.filter((r) => !r.played);
  return {
    queue: unplayed
      .sort((a, b) => a.position - b.position)
      .map(publicQueueItem),
  };
}

export async function loadCurrent(conversationId: string) {
  const { data } = await supabaseAdmin
    .from("conversation_watch")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return data as WatchRow | null;
}

export async function pickNextUnplayed(conversationId: string) {
  const queue = await loadQueue(conversationId);
  const unplayed = queue
    .filter((r) => !r.played)
    .sort((a, b) => a.position - b.position);
  return { next: unplayed[0] ?? null, remaining: unplayed.length };
}

/** Set the shared "now playing" row to a queue item (starts at 0, playing). */
export async function setCurrent(
  conversationId: string,
  queueRow: WatchQueueRow,
  userId: string,
  positionMs = 0,
) {
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("conversation_watch_queue")
    .update({ played: true, played_at: now })
    .eq("id", queueRow.id);

  const { data: saved, error } = await supabaseAdmin
    .from("conversation_watch")
    .upsert(
      {
        conversation_id: conversationId,
        video_id: queueRow.video_id,
        title: queueRow.title,
        channel_title: queueRow.channel_title,
        thumbnail_url: queueRow.thumbnail_url,
        duration_ms: queueRow.duration_ms,
        position_ms: Math.round(positionMs),
        is_playing: true,
        changed_at: now,
        changed_by: userId,
        current_queue_id: queueRow.id,
      },
      { onConflict: "conversation_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return saved as WatchRow;
}

/**
 * Advance to the next queued video (song/clip ended, or a manual "next").
 * Returns { advanced, saved? }. If nothing is queued, pauses at the end.
 */
export async function advanceWatch(
  conversationId: string,
  userId: string,
  options: { expectedChangedAt?: string; requireEnded?: boolean } = {},
) {
  const existing = await loadCurrent(conversationId);
  if (!existing?.video_id) return { advanced: false, reason: "nothing-playing" };

  if (
    options.expectedChangedAt &&
    existing.changed_at !== options.expectedChangedAt
  ) {
    return { advanced: false, reason: "superseded" };
  }
  if (
    options.requireEnded &&
    existing.duration_ms > 0 &&
    currentPosition(existing) < existing.duration_ms - 2500
  ) {
    return { advanced: false, reason: "not-ended" };
  }

  // Mark the finished video's queue row played (if still open).
  if (existing.current_queue_id) {
    await supabaseAdmin
      .from("conversation_watch_queue")
      .update({ played: true, played_at: new Date().toISOString() })
      .eq("id", existing.current_queue_id)
      .eq("played", false);
  }

  const { next } = await pickNextUnplayed(conversationId);
  if (!next) {
    // Nothing left — park at the end, paused, so both clients stop cleanly.
    const now = new Date().toISOString();
    await supabaseAdmin
      .from("conversation_watch")
      .update({
        is_playing: false,
        position_ms: existing.duration_ms,
        changed_at: now,
        changed_by: userId,
      })
      .eq("conversation_id", conversationId);
    return { advanced: false, reason: "no-next" };
  }

  const saved = await setCurrent(conversationId, next, userId);
  return { advanced: true, saved };
}
