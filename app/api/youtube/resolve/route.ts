import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/lib/spotify";
import {
  fetchVideoMeta,
  fetchVideoOEmbed,
  getYoutubeApiKey,
  parseVideoId,
} from "@/lib/youtube";

export const runtime = "nodejs";

/** Resolve a pasted YouTube URL (or bare id) into playable video metadata. */
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const input = request.nextUrl.searchParams.get("url")?.slice(0, 300) ?? "";
  const videoId = parseVideoId(input);
  if (!videoId) {
    return NextResponse.json(
      { error: "That doesn't look like a YouTube link." },
      { status: 400 },
    );
  }

  try {
    const apiKey = getYoutubeApiKey();
    // Prefer the Data API (gives duration); fall back to keyless oEmbed.
    const video = apiKey
      ? (await fetchVideoMeta(videoId, apiKey)) ??
        (await fetchVideoOEmbed(videoId))
      : await fetchVideoOEmbed(videoId);

    if (!video) {
      return NextResponse.json(
        { error: "Couldn't find that video (it may be private or removed)." },
        { status: 404 },
      );
    }
    return NextResponse.json({ video });
  } catch (error) {
    console.error("YouTube resolve failed:", error);
    return NextResponse.json(
      { error: "Couldn't resolve that link right now." },
      { status: 500 },
    );
  }
}
