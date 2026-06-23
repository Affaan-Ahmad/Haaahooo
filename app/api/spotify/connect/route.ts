import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  createSpotifyState,
  getAuthenticatedUser,
  getSpotifyConfig,
  hashSpotifyState,
  SPOTIFY_SCOPES,
} from "@/lib/spotify";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { clientId, redirectUri } = getSpotifyConfig();
    const state = createSpotifyState();
    const stateHash = hashSpotifyState(state);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabaseAdmin
      .from("spotify_oauth_states")
      .delete()
      .eq("user_id", user.id);

    const { error } = await supabaseAdmin.from("spotify_oauth_states").insert({
      state_hash: stateHash,
      user_id: user.id,
      expires_at: expiresAt,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const authorizeUrl = new URL("https://accounts.spotify.com/authorize");
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: SPOTIFY_SCOPES.join(" "),
      redirect_uri: redirectUri,
      state,
    }).toString();

    return NextResponse.json({ url: authorizeUrl.toString() });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Spotify is not configured.",
      },
      { status: 500 },
    );
  }
}
