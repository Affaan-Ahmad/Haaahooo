import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSpotifyAccessToken } from "@/lib/spotify";

/**
 * Shared jukebox engine (used by the API route AND the cron endpoint).
 *
 * Playback model: NATIVE PRE-QUEUE.
 *  - When a track starts, we compute the next track and push it into each
 *    listener's *Spotify* queue (POST /me/player/queue). Spotify then plays
 *    it gaplessly when the current track ends — natively, in the background,
 *    on its own clock. We buffer exactly ONE track ahead at a time.
 *  - The in-app timer / cron then just SYNC our "now playing" row to whatever
 *    Spotify advanced to (no replay command, so no hiccup) and top the buffer
 *    back up. So audio seamlessness doesn't depend on our trigger being on
 *    time — only the app's UI catch-up does.
 */

export type TrackInput = {
  id?: string;
  uri?: string;
  name?: string;
  artists?: string;
  imageUrl?: string | null;
  durationMs?: number;
  spotifyUrl?: string | null;
};

export type JukeboxRow = {
  conversation_id: string;
  track_id: string | null;
  track_uri: string | null;
  track_name: string | null;
  artist_name: string | null;
  album_image_url: string | null;
  spotify_url: string | null;
  duration_ms: number;
  position_ms: number;
  is_playing: boolean;
  changed_at: string;
  changed_by: string;
  current_queue_id: string | null;
  prequeued_queue_id: string | null;
};

export type QueueRow = {
  id: string;
  conversation_id: string;
  position: number;
  source: "user" | "auto";
  played: boolean;
  played_at: string | null;
  track_id: string;
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_image_url: string | null;
  spotify_url: string | null;
  duration_ms: number;
  added_by: string | null;
  added_at: string;
};

const AUTO_REFILL_THRESHOLD = 3;
const AUTO_BATCH = 10;

export function publicState(row: JukeboxRow | null) {
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    trackId: row.track_id,
    trackUri: row.track_uri,
    trackName: row.track_name,
    artistName: row.artist_name,
    imageUrl: row.album_image_url,
    spotifyUrl: row.spotify_url,
    durationMs: row.duration_ms,
    positionMs: row.position_ms,
    isPlaying: row.is_playing,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
    currentQueueId: row.current_queue_id,
  };
}

export function publicQueueItem(row: QueueRow) {
  return {
    id: row.id,
    position: row.position,
    source: row.source,
    trackId: row.track_id,
    trackUri: row.track_uri,
    trackName: row.track_name,
    artistName: row.artist_name,
    imageUrl: row.album_image_url,
    durationMs: row.duration_ms,
    addedBy: row.added_by,
  };
}

export function currentPosition(row: JukeboxRow) {
  if (!row.is_playing) return row.position_ms;
  const elapsed = Date.now() - new Date(row.changed_at).getTime();
  return Math.min(row.duration_ms, row.position_ms + Math.max(0, elapsed));
}

export function validateTrack(track: TrackInput | undefined): track is Required<
  Pick<TrackInput, "id" | "uri" | "name" | "artists" | "durationMs">
> &
  TrackInput {
  return Boolean(
    track?.id &&
      /^[A-Za-z0-9]{10,40}$/.test(track.id) &&
      track.uri === `spotify:track:${track.id}` &&
      track.name &&
      track.artists &&
      track.durationMs,
  );
}

export function trackFieldsFrom(track: TrackInput) {
  return {
    track_id: track.id!,
    track_uri: track.uri!,
    track_name: track.name!.slice(0, 300),
    artist_name: track.artists!.slice(0, 300),
    album_image_url: track.imageUrl?.startsWith("https://i.scdn.co/")
      ? track.imageUrl
      : null,
    spotify_url: track.spotifyUrl?.startsWith("https://open.spotify.com/")
      ? track.spotifyUrl
      : null,
    duration_ms: track.durationMs!,
  };
}

export async function getMemberIds(conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId);
  if (error) throw error;
  return (data ?? []).map((row) => row.user_id);
}

export async function getAnyMemberToken(conversationId: string) {
  const memberIds = await getMemberIds(conversationId);
  for (const memberId of memberIds) {
    const token = await getSpotifyAccessToken(memberId).catch(() => null);
    if (token) return token;
  }
  return null;
}

export async function loadQueue(conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversation_jukebox_queue")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as QueueRow[];
}

export async function nextPosition(conversationId: string) {
  const queue = await loadQueue(conversationId);
  return (queue.length ? queue[queue.length - 1].position : 0) + 1;
}

/* -------------------- homemade "radio" recommender -------------------- */

async function spotifyJson(token: string, url: string) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

type SpotifyApiTrack = {
  id?: string;
  uri?: string;
  name?: string;
  duration_ms?: number;
  artists?: Array<{ id?: string; name?: string }>;
  album?: { images?: Array<{ url?: string }> };
  external_urls?: { spotify?: string };
};

function mapApiTrack(t: SpotifyApiTrack): TrackInput | null {
  if (!t?.id || !t?.uri || !t?.name || !t?.duration_ms) return null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", "),
    imageUrl: t.album?.images?.[0]?.url ?? null,
    durationMs: t.duration_ms,
    spotifyUrl: t.external_urls?.spotify ?? null,
  };
}

export async function generateRecommendations(
  conversationId: string,
  seedRow: JukeboxRow,
  token: string,
) {
  if (!seedRow.track_id) return 0;

  const candidates = new Map<string, TrackInput>();
  const consider = (t: SpotifyApiTrack | undefined) => {
    const mapped = t ? mapApiTrack(t) : null;
    if (mapped?.id && mapped.id !== seedRow.track_id) {
      candidates.set(mapped.id, mapped);
    }
  };

  const track = (await spotifyJson(
    token,
    `https://api.spotify.com/v1/tracks/${seedRow.track_id}`,
  )) as (Record<string, unknown> & SpotifyApiTrack) | null;
  const artistId = track?.artists?.[0]?.id;

  if (artistId) {
    const top = await spotifyJson(
      token,
      `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=from_token`,
    );
    (top?.tracks as SpotifyApiTrack[] | undefined)?.forEach(consider);

    const artist = await spotifyJson(
      token,
      `https://api.spotify.com/v1/artists/${artistId}`,
    );
    const genres = ((artist?.genres as string[] | undefined) ?? []).slice(0, 2);
    for (const genre of genres) {
      const q = encodeURIComponent(`genre:"${genre}"`);
      const search = await spotifyJson(
        token,
        `https://api.spotify.com/v1/search?type=track&limit=20&market=from_token&q=${q}`,
      );
      const items = (search?.tracks as { items?: SpotifyApiTrack[] } | undefined)
        ?.items;
      items?.forEach(consider);
    }
  }

  if (candidates.size === 0) return 0;

  const existing = await loadQueue(conversationId);
  const existingIds = new Set(existing.map((r) => r.track_id));
  const pool = [...candidates.values()]
    .filter((t) => t.id && !existingIds.has(t.id))
    .sort(() => Math.random() - 0.5)
    .slice(0, AUTO_BATCH);
  if (pool.length === 0) return 0;

  const basePos = existing.length ? existing[existing.length - 1].position : 0;
  const rows = pool.map((t, index) => ({
    conversation_id: conversationId,
    position: basePos + index + 1,
    source: "auto" as const,
    played: false,
    track_id: t.id!,
    track_uri: t.uri!,
    track_name: t.name!.slice(0, 300),
    artist_name: (t.artists ?? "").slice(0, 300),
    album_image_url: t.imageUrl?.startsWith("https://i.scdn.co/")
      ? t.imageUrl
      : null,
    spotify_url: t.spotifyUrl?.startsWith("https://open.spotify.com/")
      ? t.spotifyUrl
      : null,
    duration_ms: t.durationMs!,
    added_by: null,
  }));

  const { error } = await supabaseAdmin
    .from("conversation_jukebox_queue")
    .insert(rows);
  if (error) throw error;
  return rows.length;
}

/* ------------------------------ devices ------------------------------- */

type SpotifyDevices = {
  devices?: Array<{ id?: string | null; is_active?: boolean; is_restricted?: boolean }>;
};

async function findDeviceId(token: string) {
  const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const devices = (await res.json().catch(() => ({}))) as SpotifyDevices;
  const device =
    devices.devices?.find((d) => d.is_active && !d.is_restricted && d.id) ??
    devices.devices?.find((d) => !d.is_restricted && d.id);
  return device?.id ?? null;
}

async function playOnAccount(
  userId: string,
  trackUri: string,
  positionMs: number,
) {
  const token = await getSpotifyAccessToken(userId);
  if (!token) return { userId, ok: false, reason: "Spotify not connected" };
  const deviceId = await findDeviceId(token);
  if (!deviceId) {
    return { userId, ok: false, reason: "Open Spotify on a phone or computer first" };
  }
  const url = new URL("https://api.spotify.com/v1/me/player/play");
  url.searchParams.set("device_id", deviceId);
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      uris: [trackUri],
      position_ms: Math.max(0, Math.round(positionMs)),
    }),
    cache: "no-store",
  });
  return { userId, ok: res.ok, reason: res.ok ? null : `Spotify ${res.status}` };
}

async function pauseAccount(userId: string) {
  const token = await getSpotifyAccessToken(userId);
  if (!token) return { userId, ok: false, reason: "Spotify not connected" };
  const deviceId = await findDeviceId(token);
  if (!deviceId) return { userId, ok: false, reason: "No device" };
  const url = new URL("https://api.spotify.com/v1/me/player/pause");
  url.searchParams.set("device_id", deviceId);
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return { userId, ok: res.ok, reason: res.ok ? null : `Spotify ${res.status}` };
}

/** Add a track to each listener's native Spotify queue (best-effort). */
async function queueOnAccount(userId: string, trackUri: string) {
  const token = await getSpotifyAccessToken(userId);
  if (!token) return { userId, ok: false };
  const deviceId = await findDeviceId(token);
  if (!deviceId) return { userId, ok: false };
  const url = new URL("https://api.spotify.com/v1/me/player/queue");
  url.searchParams.set("uri", trackUri);
  url.searchParams.set("device_id", deviceId);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return { userId, ok: res.ok };
}

export async function broadcastPlayback(
  conversationId: string,
  command: "play" | "pause",
  trackUri: string,
  positionMs: number,
) {
  const memberIds = await getMemberIds(conversationId);
  const results = await Promise.all(
    memberIds.map((memberId) =>
      (command === "play"
        ? playOnAccount(memberId, trackUri, positionMs)
        : pauseAccount(memberId)
      ).catch((error) => ({
        userId: memberId,
        ok: false,
        reason: error instanceof Error ? error.message : "Spotify failed",
      })),
    ),
  );
  return {
    connected: results.filter((r) => r.ok).length,
    total: results.length,
    failures: results.filter((r) => !r.ok),
  };
}

async function broadcastQueue(conversationId: string, trackUri: string) {
  const memberIds = await getMemberIds(conversationId);
  await Promise.all(
    memberIds.map((memberId) => queueOnAccount(memberId, trackUri).catch(() => null)),
  );
}

/* -------------------------- queue / advancing -------------------------- */

export async function pickNextUnplayed(conversationId: string) {
  const queue = await loadQueue(conversationId);
  const unplayed = queue.filter((r) => !r.played);
  const user = unplayed
    .filter((r) => r.source === "user")
    .sort((a, b) => a.position - b.position);
  if (user.length) return { next: user[0], userRemaining: user.length };
  const auto = unplayed
    .filter((r) => r.source === "auto")
    .sort((a, b) => a.position - b.position);
  return { next: auto[0] ?? null, userRemaining: 0 };
}

/** Set the "now playing" row. play=true sends an interrupt play command and
 *  clears the pre-queue buffer; play=false just syncs (Spotify already moved). */
async function setCurrent(
  conversationId: string,
  queueRow: QueueRow,
  userId: string,
  play: boolean,
  positionMs = 0,
) {
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("conversation_jukebox_queue")
    .update({ played: true, played_at: now })
    .eq("id", queueRow.id);

  const { data: saved, error } = await supabaseAdmin
    .from("conversation_jukebox")
    .upsert(
      {
        conversation_id: conversationId,
        track_id: queueRow.track_id,
        track_uri: queueRow.track_uri,
        track_name: queueRow.track_name,
        artist_name: queueRow.artist_name,
        album_image_url: queueRow.album_image_url,
        spotify_url: queueRow.spotify_url,
        duration_ms: queueRow.duration_ms,
        position_ms: Math.round(positionMs),
        is_playing: true,
        changed_at: now,
        changed_by: userId,
        current_queue_id: queueRow.id,
        prequeued_queue_id: null,
      },
      { onConflict: "conversation_id" },
    )
    .select("*")
    .single();
  if (error) throw error;

  let playback;
  if (play) {
    playback = await broadcastPlayback(
      conversationId,
      "play",
      queueRow.track_uri,
      positionMs,
    );
  }
  return { saved: saved as JukeboxRow, playback };
}

/** Ensure exactly one upcoming track is pre-loaded into each Spotify queue. */
export async function prequeueNext(conversationId: string) {
  const { data } = await supabaseAdmin
    .from("conversation_jukebox")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  const current = data as JukeboxRow | null;
  if (!current?.track_uri) return null;

  // Already have an outstanding (unplayed) buffered track? Leave it.
  if (current.prequeued_queue_id) {
    const { data: buffered } = await supabaseAdmin
      .from("conversation_jukebox_queue")
      .select("id, played")
      .eq("id", current.prequeued_queue_id)
      .maybeSingle();
    if (buffered && !(buffered as { played: boolean }).played) return null;
  }

  let { next } = await pickNextUnplayed(conversationId);
  if (!next) {
    const token = await getAnyMemberToken(conversationId);
    if (token) await generateRecommendations(conversationId, current, token);
    next = (await pickNextUnplayed(conversationId)).next;
  }
  if (!next) return null;

  await broadcastQueue(conversationId, next.track_uri);
  await supabaseAdmin
    .from("conversation_jukebox")
    .update({ prequeued_queue_id: next.id })
    .eq("conversation_id", conversationId);
  return next;
}

/** Start a chosen track now (user action): interrupt-play + buffer the next. */
export async function playTrackNow(
  conversationId: string,
  queueRow: QueueRow,
  userId: string,
  positionMs = 0,
) {
  const result = await setCurrent(conversationId, queueRow, userId, true, positionMs);
  await prequeueNext(conversationId).catch(() => null);
  await maybeRefill(conversationId, result.saved);
  return result;
}

async function maybeRefill(conversationId: string, seed: JukeboxRow) {
  const after = await pickNextUnplayed(conversationId);
  const autoLeft = (await loadQueue(conversationId)).filter(
    (r) => r.source === "auto" && !r.played,
  ).length;
  if (after.userRemaining === 0 && autoLeft < AUTO_REFILL_THRESHOLD) {
    const token = await getAnyMemberToken(conversationId);
    if (token) await generateRecommendations(conversationId, seed, token).catch(() => 0);
  }
}

/**
 * Auto-advance (song ended). Syncs our row to the track Spotify already moved
 * to via the pre-queue (no replay), then tops the buffer back up. Falls back
 * to an interrupt-play if nothing was pre-queued.
 */
export async function advanceJukebox(
  conversationId: string,
  userId: string,
  options: { expectedChangedAt?: string; requireEnded?: boolean } = {},
) {
  const { data } = await supabaseAdmin
    .from("conversation_jukebox")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  const existing = data as JukeboxRow | null;
  if (!existing?.track_uri) return { advanced: false, reason: "nothing-playing" };

  if (options.expectedChangedAt && existing.changed_at !== options.expectedChangedAt) {
    return { advanced: false, reason: "superseded" };
  }
  if (
    options.requireEnded &&
    currentPosition(existing) < existing.duration_ms - 5000
  ) {
    return { advanced: false, reason: "not-ended" };
  }

  if (existing.current_queue_id) {
    await supabaseAdmin
      .from("conversation_jukebox_queue")
      .update({ played: true, played_at: new Date().toISOString() })
      .eq("id", existing.current_queue_id)
      .eq("played", false);
  }

  // The track Spotify gaplessly advanced to is the one we pre-queued.
  let buffered: QueueRow | null = null;
  if (existing.prequeued_queue_id) {
    const { data: bufRow } = await supabaseAdmin
      .from("conversation_jukebox_queue")
      .select("*")
      .eq("id", existing.prequeued_queue_id)
      .maybeSingle();
    const row = bufRow as QueueRow | null;
    if (row && !row.played) buffered = row;
  }

  let result;
  if (buffered) {
    // Spotify is already playing it — just sync our row (no replay).
    result = await setCurrent(conversationId, buffered, userId, false);
  } else {
    // Nothing was buffered — pick next and interrupt-play (may not be gapless).
    let { next } = await pickNextUnplayed(conversationId);
    if (!next) {
      const token = await getAnyMemberToken(conversationId);
      if (token) await generateRecommendations(conversationId, existing, token);
      next = (await pickNextUnplayed(conversationId)).next;
    }
    if (!next) return { advanced: false, reason: "no-next" };
    result = await setCurrent(conversationId, next, userId, true);
  }

  await prequeueNext(conversationId).catch(() => null);
  await maybeRefill(conversationId, result.saved);
  return { advanced: true, saved: result.saved, playback: result.playback };
}

export function queuePayload(all: QueueRow[]) {
  const unplayed = all.filter((r) => !r.played);
  return {
    queue: unplayed
      .filter((r) => r.source === "user")
      .sort((a, b) => a.position - b.position)
      .map(publicQueueItem),
    autoQueue: unplayed
      .filter((r) => r.source === "auto")
      .sort((a, b) => a.position - b.position)
      .map(publicQueueItem),
  };
}
