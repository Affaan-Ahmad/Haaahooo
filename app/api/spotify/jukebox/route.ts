import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getAuthenticatedUser,
  getSpotifyAccessToken,
  requireConversationMembership,
} from "@/lib/spotify";

export const runtime = "nodejs";

type JukeboxAction = "select" | "play" | "pause";

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
  };
}

function currentPosition(row: JukeboxRow) {
  if (!row.is_playing) return row.position_ms;
  const elapsed = Date.now() - new Date(row.changed_at).getTime();
  return Math.min(row.duration_ms, row.position_ms + Math.max(0, elapsed));
}

async function getMemberIds(conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId);
  if (error) throw error;
  return (data ?? []).map((row) => row.user_id);
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

  return NextResponse.json({ state: publicState(data as JukeboxRow | null) });
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
    let nextTrackUri = existing?.track_uri ?? null;
    let nextPosition = existing ? currentPosition(existing) : 0;
    let nextPlaying = action !== "pause";
    let trackFields = {};

    if (action === "select") {
      const track = body.track;
      if (
        !track?.id ||
        !/^[A-Za-z0-9]{10,40}$/.test(track.id) ||
        track.uri !== `spotify:track:${track.id}` ||
        !track.name ||
        !track.artists ||
        !track.durationMs
      ) {
        return NextResponse.json({ error: "Invalid track." }, { status: 400 });
      }
      nextTrackUri = track.uri;
      nextPosition = 0;
      nextPlaying = true;
      trackFields = {
        track_id: track.id,
        track_uri: track.uri,
        track_name: track.name.slice(0, 300),
        artist_name: track.artists.slice(0, 300),
        album_image_url:
          track.imageUrl?.startsWith("https://i.scdn.co/") ? track.imageUrl : null,
        spotify_url:
          track.spotifyUrl?.startsWith("https://open.spotify.com/")
            ? track.spotifyUrl
            : null,
        duration_ms: track.durationMs,
      };
    }

    if (!nextTrackUri) {
      return NextResponse.json(
        { error: "Choose a song first." },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const { data: savedData, error: saveError } = await supabaseAdmin
      .from("conversation_jukebox")
      .upsert(
        {
          conversation_id: conversationId,
          ...trackFields,
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

    const memberIds = await getMemberIds(conversationId);
    const command = nextPlaying ? "play" : "pause";
    const results = await Promise.all(
      memberIds.map((memberId) =>
        controlSpotifyAccount(
          memberId,
          command,
          nextTrackUri!,
          nextPosition,
        ).catch((error) => ({
          userId: memberId,
          ok: false,
          reason: error instanceof Error ? error.message : "Spotify failed",
        })),
      ),
    );

    return NextResponse.json({
      state: publicState(savedData as JukeboxRow),
      playback: {
        connected: results.filter((result) => result.ok).length,
        total: results.length,
        failures: results.filter((result) => !result.ok),
      },
    });
  } catch (error) {
    console.error("Jukebox command failed:", error);
    return NextResponse.json(
      { error: "The jukebox command failed." },
      { status: 500 },
    );
  }
}
