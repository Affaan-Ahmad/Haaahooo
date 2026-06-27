import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getAuthenticatedUser,
  getSpotifyAccessToken,
  requireConversationMembership,
} from "@/lib/spotify";

export const runtime = "nodejs";

type JukeboxAction =
  | "select"
  | "play"
  | "pause"
  | "seek"
  | "enqueue"
  | "next"
  | "previous"
  | "remove";

type TrackInput = {
  id?: string;
  uri?: string;
  name?: string;
  artists?: string;
  imageUrl?: string | null;
  durationMs?: number;
  spotifyUrl?: string | null;
};

type JukeboxRow = {
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
};

type QueueRow = {
  id: string;
  conversation_id: string;
  position: number;
  track_id: string;
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_image_url: string | null;
  spotify_url: string | null;
  duration_ms: number;
  added_by: string;
  added_at: string;
};

type SpotifyDevices = {
  devices?: Array<{
    id?: string | null;
    is_active?: boolean;
    is_restricted?: boolean;
  }>;
};

function publicState(row: JukeboxRow | null) {
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

function publicQueueItem(row: QueueRow) {
  return {
    id: row.id,
    position: row.position,
    trackId: row.track_id,
    trackUri: row.track_uri,
    trackName: row.track_name,
    artistName: row.artist_name,
    imageUrl: row.album_image_url,
    durationMs: row.duration_ms,
    addedBy: row.added_by,
  };
}

function currentPosition(row: JukeboxRow) {
  if (!row.is_playing) return row.position_ms;
  const elapsed = Date.now() - new Date(row.changed_at).getTime();
  return Math.min(row.duration_ms, row.position_ms + Math.max(0, elapsed));
}

function validateTrack(track: TrackInput | undefined): track is Required<
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

function trackFieldsFrom(track: TrackInput) {
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

async function getMemberIds(conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId);
  if (error) throw error;
  return (data ?? []).map((row) => row.user_id);
}

async function loadQueue(conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversation_jukebox_queue")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as QueueRow[];
}

async function controlSpotifyAccount(
  userId: string,
  action: "play" | "pause",
  trackUri: string,
  positionMs: number,
) {
  const accessToken = await getSpotifyAccessToken(userId);
  if (!accessToken) {
    return { userId, ok: false, reason: "Spotify not connected" };
  }

  const devicesResponse = await fetch(
    "https://api.spotify.com/v1/me/player/devices",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  const devices = (await devicesResponse.json().catch(() => ({}))) as SpotifyDevices;
  const device = devices.devices?.find(
    (item) => item.is_active && !item.is_restricted && item.id,
  ) ?? devices.devices?.find((item) => !item.is_restricted && item.id);

  if (!devicesResponse.ok || !device?.id) {
    return {
      userId,
      ok: false,
      reason: "Open Spotify on a phone or computer first",
    };
  }

  const endpoint =
    action === "play"
      ? "https://api.spotify.com/v1/me/player/play"
      : "https://api.spotify.com/v1/me/player/pause";
  const url = new URL(endpoint);
  url.searchParams.set("device_id", device.id);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(action === "play" ? { "Content-Type": "application/json" } : {}),
    },
    ...(action === "play"
      ? {
          body: JSON.stringify({
            uris: [trackUri],
            position_ms: Math.max(0, Math.round(positionMs)),
          }),
        }
      : {}),
    cache: "no-store",
  });

  return {
    userId,
    ok: response.ok,
    reason: response.ok ? null : `Spotify returned ${response.status}`,
  };
}

async function broadcastPlayback(
  conversationId: string,
  command: "play" | "pause",
  trackUri: string,
  positionMs: number,
) {
  const memberIds = await getMemberIds(conversationId);
  const results = await Promise.all(
    memberIds.map((memberId) =>
      controlSpotifyAccount(memberId, command, trackUri, positionMs).catch(
        (error) => ({
          userId: memberId,
          ok: false,
          reason: error instanceof Error ? error.message : "Spotify failed",
        }),
      ),
    ),
  );
  return {
    connected: results.filter((r) => r.ok).length,
    total: results.length,
    failures: results.filter((r) => !r.ok),
  };
}

/** Copy a queue row into the live jukebox state and start playback. */
async function setCurrentFromQueue(
  conversationId: string,
  queueRow: QueueRow,
  userId: string,
  positionMs = 0,
) {
  const now = new Date().toISOString();
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
      },
      { onConflict: "conversation_id" },
    )
    .select("*")
    .single();
  if (error) throw error;

  const playback = await broadcastPlayback(
    conversationId,
    "play",
    queueRow.track_uri,
    positionMs,
  );
  return { saved: saved as JukeboxRow, playback };
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const conversationId =
    request.nextUrl.searchParams.get("conversationId")?.trim() ?? "";
  if (
    !conversationId ||
    !(await requireConversationMembership(user.id, conversationId))
  ) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from("conversation_jukebox")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const queue = await loadQueue(conversationId);

  return NextResponse.json({
    state: publicState(data as JukeboxRow | null),
    queue: queue.map(publicQueueItem),
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as {
    conversationId?: string;
    action?: JukeboxAction;
    track?: TrackInput;
    positionMs?: number;
    queueId?: string;
  };
  const conversationId = body.conversationId?.trim() ?? "";
  const action = body.action;

  if (
    !conversationId ||
    !action ||
    !(await requireConversationMembership(user.id, conversationId))
  ) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 403 });
  }

  try {
    const { data: existingData, error: existingError } = await supabaseAdmin
      .from("conversation_jukebox")
      .select("*")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (existingError) throw existingError;
    const existing = existingData as JukeboxRow | null;

    const respond = async (
      state: JukeboxRow | null,
      playback?: Awaited<ReturnType<typeof broadcastPlayback>>,
    ) =>
      NextResponse.json({
        state: publicState(state),
        queue: (await loadQueue(conversationId)).map(publicQueueItem),
        ...(playback ? { playback } : {}),
      });

    // ---- Add a track to the queue ---------------------------------------
    if (action === "enqueue" || action === "select") {
      if (!validateTrack(body.track)) {
        return NextResponse.json({ error: "Invalid track." }, { status: 400 });
      }
      const queue = await loadQueue(conversationId);
      const nextPosition =
        (queue.length ? queue[queue.length - 1].position : 0) + 1;

      const { data: insertedData, error: insertError } = await supabaseAdmin
        .from("conversation_jukebox_queue")
        .insert({
          conversation_id: conversationId,
          position: nextPosition,
          ...trackFieldsFrom(body.track),
          added_by: user.id,
        })
        .select("*")
        .single();
      if (insertError) throw insertError;
      const inserted = insertedData as QueueRow;

      // "select" = play now. "enqueue" = play now only if nothing is loaded.
      const shouldPlayNow = action === "select" || !existing?.track_uri;
      if (shouldPlayNow) {
        const { saved, playback } = await setCurrentFromQueue(
          conversationId,
          inserted,
          user.id,
        );
        return respond(saved, playback);
      }
      return respond(existing);
    }

    // ---- Skip to next / previous track ----------------------------------
    if (action === "next" || action === "previous") {
      if (!existing?.track_uri) {
        return NextResponse.json({ error: "Nothing is playing." }, { status: 400 });
      }
      const queue = await loadQueue(conversationId);
      const currentIndex = existing.current_queue_id
        ? queue.findIndex((row) => row.id === existing.current_queue_id)
        : -1;

      if (action === "previous") {
        // Restart the song if we're more than 3s in.
        if (currentPosition(existing) > 3000 || currentIndex <= 0) {
          const { data: saved, error: seekError } = await supabaseAdmin
            .from("conversation_jukebox")
            .update({
              position_ms: 0,
              changed_at: new Date().toISOString(),
              changed_by: user.id,
            })
            .eq("conversation_id", conversationId)
            .select("*")
            .single();
          if (seekError) throw seekError;
          const playback = existing.is_playing
            ? await broadcastPlayback(conversationId, "play", existing.track_uri, 0)
            : undefined;
          return respond(saved as JukeboxRow, playback);
        }
        const prev = queue[currentIndex - 1];
        const { saved, playback } = await setCurrentFromQueue(
          conversationId,
          prev,
          user.id,
        );
        return respond(saved, playback);
      }

      // next
      const next =
        currentIndex >= 0 ? queue[currentIndex + 1] : queue[0];
      if (!next) {
        // Already at the end of the queue — leave current track as-is.
        return respond(existing);
      }
      const { saved, playback } = await setCurrentFromQueue(
        conversationId,
        next,
        user.id,
      );
      return respond(saved, playback);
    }

    // ---- Remove a queued track ------------------------------------------
    if (action === "remove") {
      const queueId = body.queueId?.trim();
      if (!queueId) {
        return NextResponse.json({ error: "Missing queue item." }, { status: 400 });
      }
      if (existing?.current_queue_id === queueId) {
        return NextResponse.json(
          { error: "Can't remove the song that's playing." },
          { status: 400 },
        );
      }
      const { error: deleteError } = await supabaseAdmin
        .from("conversation_jukebox_queue")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("id", queueId);
      if (deleteError) throw deleteError;
      return respond(existing);
    }

    // ---- Play / pause / seek on the current track -----------------------
    if (!existing?.track_uri) {
      return NextResponse.json({ error: "Choose a song first." }, { status: 400 });
    }

    let nextPosition = currentPosition(existing);
    let nextPlaying = existing.is_playing;

    if (action === "play") nextPlaying = true;
    if (action === "pause") nextPlaying = false;
    if (action === "seek") {
      const requested = Number(body.positionMs);
      nextPosition = Math.min(
        Math.max(0, Number.isFinite(requested) ? requested : 0),
        existing.duration_ms,
      );
    }

    const now = new Date().toISOString();
    const { data: savedData, error: saveError } = await supabaseAdmin
      .from("conversation_jukebox")
      .upsert(
        {
          conversation_id: conversationId,
          position_ms: Math.round(nextPosition),
          is_playing: nextPlaying,
          changed_at: now,
          changed_by: user.id,
        },
        { onConflict: "conversation_id" },
      )
      .select("*")
      .single();
    if (saveError) throw saveError;

    const playback = await broadcastPlayback(
      conversationId,
      nextPlaying ? "play" : "pause",
      existing.track_uri,
      nextPosition,
    );

    return respond(savedData as JukeboxRow, playback);
  } catch (error) {
    console.error("Jukebox command failed:", error);
    return NextResponse.json(
      { error: "The jukebox command failed." },
      { status: 500 },
    );
  }
}
