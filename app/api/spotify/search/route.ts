import { NextRequest, NextResponse } from "next/server";

import {
  getAuthenticatedUser,
  getSpotifyAccessToken,
} from "@/lib/spotify";

export const runtime = "nodejs";

type SpotifySearchResponse = {
  tracks?: {
    items?: Array<{
      id: string;
      uri: string;
      name: string;
      duration_ms: number;
      external_urls?: { spotify?: string };
      artists?: Array<{ name: string }>;
      album?: {
        name?: string;
        images?: Array<{ url: string; width?: number; height?: number }>;
      };
    }>;
  };
  error?: { message?: string };
};

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, 100);
  if (!query) return NextResponse.json({ tracks: [] });

  try {
    const accessToken = await getSpotifyAccessToken(user.id);
    if (!accessToken) {
      return NextResponse.json(
        { error: "Connect Spotify in Settings first." },
        { status: 409 },
      );
    }

    const searchUrl = new URL("https://api.spotify.com/v1/search");
    searchUrl.search = new URLSearchParams({
      q: query,
      type: "track",
      limit: "8",
    }).toString();

    const response = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const result = (await response.json()) as SpotifySearchResponse;

    if (!response.ok) {
      return NextResponse.json(
        { error: result.error?.message ?? "Spotify search failed." },
        { status: response.status },
      );
    }

    const tracks = (result.tracks?.items ?? []).map((track) => ({
      id: track.id,
      uri: track.uri,
      name: track.name,
      artists: (track.artists ?? []).map((artist) => artist.name).join(", "),
      album: track.album?.name ?? "",
      imageUrl: track.album?.images?.[0]?.url ?? null,
      durationMs: track.duration_ms,
      spotifyUrl: track.external_urls?.spotify ?? null,
    }));

    return NextResponse.json({ tracks });
  } catch (error) {
    console.error("Spotify search failed:", error);
    return NextResponse.json(
      { error: "Spotify search is unavailable right now." },
      { status: 500 },
    );
  }
}
