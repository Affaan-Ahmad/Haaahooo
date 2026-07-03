import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/lib/spotify";
import { getYoutubeApiKey, searchVideos } from "@/lib/youtube";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, 100);
  if (!query) return NextResponse.json({ videos: [] });

  const apiKey = getYoutubeApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Search is off — paste a YouTube link instead." },
      { status: 409 },
    );
  }

  try {
    const result = await searchVideos(query, apiKey);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "YouTube search failed." },
        { status: result.status || 500 },
      );
    }
    return NextResponse.json({ videos: result.videos });
  } catch (error) {
    console.error("YouTube search failed:", error);
    return NextResponse.json(
      { error: "YouTube search is unavailable right now." },
      { status: 500 },
    );
  }
}
