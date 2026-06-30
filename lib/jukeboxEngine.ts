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
// Only commit the next track to Spotify's queue within this window before the
// current song ends. Spotify can't reorder its queue, so buffering late lets a
// song you add (higher priority than radio) still take the next slot. Must be
// comfortably larger than the cron interval (60s) so the buffer lands in time.
const PREQUEUE_WINDOW_MS = 90_000;

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

/** Read one account's real Spotify playback state. */
async function getPlaybackSnapshot(token: string) {
  try {
    const res = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    // 204 = no active device / nothing playing.
    if (res.status !== 200) return { playing: false, trackId: null as string | null };
    const j = (await res.json().catch(() => null)) as {
      is_playing?: boolean;
      item?: { id?: string } | null;
    } | null;
    return { playing: Boolean(j?.is_playing), trackId: j?.item?.id ?? null };
  } catch {
    return { playing: false, trackId: null as string | null };
  }
}

/** True if at least one member's Spotify is actually playing right now. Used to
 *  stop the cron from "resurrecting" a session the listeners actually stopped. */
export async function anyMemberPlaying(conversationId: string) {
  const memberIds = await getMemberIds(conversationId);
  for (const memberId of memberIds) {
    const token = await getSpotifyAccessToken(memberId).catch(() => null);
    if (!token) continue;
    const snap = await getPlaybackSnapshot(token);
    if (snap.playing) return true;
  }
  return false;
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

async function spotifyFetch(token: string, url: string) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const err = json?.error as { message?: string } | string | undefined;
    const message =
      typeof err === "string" ? err : err?.message ?? null;
    return { status: res.status, json, message };
  } catch (e) {
    return {
      status: 0,
      json: null,
      message: e instanceof Error ? e.message : "fetch failed",
    };
  }
}

/** ISO country code for market params. Falls back to US if unavailable. */
async function getMarket(token: string) {
  const { json } = await spotifyFetch(token, "https://api.spotify.com/v1/me");
  const c = json?.country;
  return typeof c === "string" && c.length === 2 ? c : "US";
}

/** Track search URL WITHOUT a market param (matches the app's working search).
 *  limit must stay small — this app's Spotify access rejects limit=20
 *  ("Invalid limit"); 8 is proven to work. */
function trackSearchUrl(q: string, limit = 8) {
  const u = new URL("https://api.spotify.com/v1/search");
  u.search = new URLSearchParams({
    q,
    type: "track",
    limit: String(limit),
  }).toString();
  return u.toString();
}

/* ----------------------- Last.fm similarity source ----------------------- */

async function lastfmGet(params: Record<string, string>) {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return null;
  try {
    const u = new URL("https://ws.audioscrobbler.com/2.0/");
    u.search = new URLSearchParams({
      ...params,
      api_key: key,
      format: "json",
    }).toString();
    const res = await fetch(u.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

type NamePair = { name: string; artist: string };

/** Ask Last.fm for songs similar to the seed; fall back to similar artists'
 *  top tracks. Returns plain {name, artist} pairs to resolve on Spotify. */
async function lastfmSimilarNames(
  trackName: string,
  artistName: string,
): Promise<NamePair[]> {
  const out: NamePair[] = [];
  const push = (name?: unknown, artist?: unknown) => {
    if (typeof name === "string" && typeof artist === "string" && name && artist) {
      out.push({ name, artist });
    }
  };

  const sim = await lastfmGet({
    method: "track.getsimilar",
    track: trackName,
    artist: artistName,
    autocorrect: "1",
    limit: "50",
  });
  const simTracks =
    ((sim?.similartracks as { track?: unknown[] } | undefined)?.track as
      | Array<{ name?: string; artist?: { name?: string } }>
      | undefined) ?? [];
  simTracks.forEach((t) => push(t.name, t.artist?.name));

  if (out.length < 5) {
    // Fallback: similar artists -> their top tracks (plus the seed artist's).
    const sa = await lastfmGet({
      method: "artist.getsimilar",
      artist: artistName,
      autocorrect: "1",
      limit: "8",
    });
    const artists =
      ((sa?.similarartists as { artist?: unknown[] } | undefined)?.artist as
        | Array<{ name?: string }>
        | undefined) ?? [];
    const names = [artistName, ...artists.map((a) => a.name ?? "")]
      .filter(Boolean)
      .slice(0, 6);
    for (const a of names) {
      const tt = await lastfmGet({
        method: "artist.gettoptracks",
        artist: a,
        autocorrect: "1",
        limit: "8",
      });
      const top =
        ((tt?.toptracks as { track?: unknown[] } | undefined)?.track as
          | Array<{ name?: string; artist?: { name?: string } }>
          | undefined) ?? [];
      top.forEach((t) => push(t.name, t.artist?.name ?? a));
    }
  }

  return out;
}

/** Resolve a {name, artist} to a real Spotify track via search (limit 1). */
async function resolveSpotifyTrack(
  token: string,
  pair: NamePair,
): Promise<TrackInput | null> {
  const { json } = await spotifyFetch(
    token,
    trackSearchUrl(`${pair.name} ${pair.artist}`, 1),
  );
  const item = (json?.tracks as { items?: SpotifyApiTrack[] } | undefined)
    ?.items?.[0];
  return item ? mapApiTrack(item) : null;
}

export type RadioReport = {
  source: "lastfm" | "spotify-artist" | "none";
  market: string;
  seedTrackOk: boolean;
  artistId: string | null;
  artistName: string | null;
  genres: string[];
  counts: {
    lastfmNames: number;
    lastfmResolved: number;
    topTracks: number;
    genreSearch: number;
    artistSearch: number;
  };
  notes: string[];
  candidates: Map<string, TrackInput>;
};

/**
 * Gather candidate tracks for the autoplay radio from endpoints that still
 * work post-2024: the seed's artist top-tracks, plain-keyword genre search,
 * and an artist-name search fallback. Returns a report (for debugging) plus
 * the deduped candidate map.
 */
export async function gatherCandidates(
  token: string,
  seedRow: JukeboxRow,
): Promise<RadioReport> {
  const market = await getMarket(token);
  const notes: string[] = [];
  const candidates = new Map<string, TrackInput>();
  const consider = (t: SpotifyApiTrack | undefined) => {
    const mapped = t ? mapApiTrack(t) : null;
    if (mapped?.id && mapped.id !== seedRow.track_id) {
      candidates.set(mapped.id, mapped);
    }
  };

  const counts = {
    lastfmNames: 0,
    lastfmResolved: 0,
    topTracks: 0,
    genreSearch: 0,
    artistSearch: 0,
  };
  let source: RadioReport["source"] = "none";
  let artistId: string | null = null;
  let artistName: string | null = null;
  let genres: string[] = [];

  const noteFail = (
    label: string,
    res: { status: number; message?: string | null },
  ) => {
    if (res.status !== 200) {
      notes.push(`${label} -> ${res.status}${res.message ? `: ${res.message}` : ""}`);
    }
  };

  if (!seedRow.track_id) {
    notes.push("no seed track id");
    return {
      source, market, seedTrackOk: false, artistId, artistName, genres, counts, notes, candidates,
    };
  }

  const trackRes = await spotifyFetch(
    token,
    `https://api.spotify.com/v1/tracks/${seedRow.track_id}?market=${market}`,
  );
  noteFail("tracks/{id}", trackRes);
  const track = trackRes.json as SpotifyApiTrack | null;
  const trackArtists = (track?.artists ?? []).filter((a) => a?.name);
  artistId = trackArtists[0]?.id ?? null;
  artistName = trackArtists[0]?.name ?? seedRow.artist_name ?? null;
  const seedName = track?.name ?? seedRow.track_name ?? "";

  // ---- Primary source: Last.fm similarity, resolved on Spotify ----------
  if (process.env.LASTFM_API_KEY && artistName && seedName) {
    const pairs = await lastfmSimilarNames(seedName, artistName);
    counts.lastfmNames = pairs.length;
    if (pairs.length === 0) notes.push("lastfm returned no similar tracks");
    // Resolve until we have a healthy batch (cap attempts to limit API calls).
    const shuffled = pairs.sort(() => Math.random() - 0.5);
    let attempts = 0;
    for (const pair of shuffled) {
      if (candidates.size >= AUTO_BATCH || attempts >= 24) break;
      attempts++;
      const resolved = await resolveSpotifyTrack(token, pair);
      if (resolved?.id && resolved.id !== seedRow.track_id) {
        candidates.set(resolved.id, resolved);
      }
    }
    counts.lastfmResolved = candidates.size;
    if (candidates.size > 0) source = "lastfm";
  } else if (!process.env.LASTFM_API_KEY) {
    notes.push("LASTFM_API_KEY not set — using same-artist fallback");
  }

  // ---- Fallback: same-artist Spotify search (only if Last.fm gave nothing)
  if (candidates.size === 0) {
    if (artistId) {
      const top = await spotifyFetch(
        token,
        `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=${market}`,
      );
      noteFail("top-tracks", top);
      const topTracks = (top.json?.tracks as SpotifyApiTrack[] | undefined) ?? [];
      topTracks.forEach(consider);
      counts.topTracks = topTracks.length;

      const artistRes = await spotifyFetch(
        token,
        `https://api.spotify.com/v1/artists/${artistId}`,
      );
      noteFail("artists/{id}", artistRes);
      genres = ((artistRes.json?.genres as string[] | undefined) ?? []).slice(0, 2);
    }

    for (const genre of genres) {
      const search = await spotifyFetch(token, trackSearchUrl(genre));
      noteFail("search(genre)", search);
      const items =
        (search.json?.tracks as { items?: SpotifyApiTrack[] } | undefined)?.items ?? [];
      items.forEach(consider);
      counts.genreSearch += items.length;
    }

    const namesToSearch = [
      ...new Set(trackArtists.map((a) => a.name!).filter(Boolean)),
    ].slice(0, 3);
    for (const name of namesToSearch) {
      const search = await spotifyFetch(token, trackSearchUrl(name));
      if (search.status !== 200) {
        noteFail(`search(${name})`, search);
        continue;
      }
      const items =
        (search.json?.tracks as { items?: SpotifyApiTrack[] } | undefined)?.items ?? [];
      items.forEach(consider);
      counts.artistSearch += items.length;
    }
    if (candidates.size > 0) source = "spotify-artist";
  }

  return {
    source,
    market,
    seedTrackOk: trackRes.status === 200,
    artistId,
    artistName,
    genres,
    counts,
    notes,
    candidates,
  };
}

export async function generateRecommendations(
  conversationId: string,
  seedRow: JukeboxRow,
  token: string,
) {
  if (!seedRow.track_id) return 0;

  const { candidates } = await gatherCandidates(token, seedRow);
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

/** Ensure exactly one upcoming track is pre-loaded into each Spotify queue.
 *  By default this only acts within PREQUEUE_WINDOW_MS of the current song's
 *  end, so a song added earlier (which has queue priority) still gets the next
 *  slot. Pass force:true to buffer immediately regardless of timing. */
export async function prequeueNext(
  conversationId: string,
  opts: { force?: boolean } = {},
) {
  const { data } = await supabaseAdmin
    .from("conversation_jukebox")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  const current = data as JukeboxRow | null;
  if (!current?.track_uri) return null;

  // Too early: don't lock in the buffer yet (lets later, higher-priority adds
  // take the slot). Short songs fall inside the window immediately.
  if (!opts.force) {
    const remaining = current.duration_ms - currentPosition(current);
    if (remaining > PREQUEUE_WINDOW_MS) return null;
  }

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

/** Drop the unplayed auto/radio picks (e.g. after a manual song change) so the
 *  radio re-seeds from the new current song. Leaves user-added songs alone. */
export async function clearAutoQueue(conversationId: string) {
  await supabaseAdmin
    .from("conversation_jukebox_queue")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("source", "auto")
    .eq("played", false);
}

/** Start a chosen track now (user action): interrupt-play + buffer the next.
 *  A manual pick re-seeds the radio from the new song. */
export async function playTrackNow(
  conversationId: string,
  queueRow: QueueRow,
  userId: string,
  positionMs = 0,
) {
  const result = await setCurrent(conversationId, queueRow, userId, true, positionMs);
  await clearAutoQueue(conversationId);
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
  options: {
    expectedChangedAt?: string;
    requireEnded?: boolean;
    forcePlay?: boolean;
  } = {},
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
    // On a natural song-end, Spotify already advanced to this via the
    // pre-queue, so we sync without replaying. On a MANUAL skip the current
    // song is still playing, so we must actually start the buffered track.
    result = await setCurrent(
      conversationId,
      buffered,
      userId,
      options.forcePlay ?? false,
    );
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

  // A manual skip re-seeds the radio from the new song (auto-advance doesn't).
  if (options.forcePlay) await clearAutoQueue(conversationId);

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
