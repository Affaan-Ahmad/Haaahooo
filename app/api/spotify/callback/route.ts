import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getSpotifyConfig,
  hashSpotifyState,
  spotifyResultUrl,
} from "@/lib/spotify";

export const runtime = "nodejs";

type SpotifyTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

type SpotifyProfile = {
  id: string;
  display_name?: string | null;
  email?: string | null;
  product?: string | null;
};

export async function GET(request: NextRequest) {
  const spotifyError = request.nextUrl.searchParams.get("error");
  if (spotifyError) {
    return NextResponse.redirect(spotifyResultUrl(request.url, "denied"));
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(spotifyResultUrl(request.url, "error"));
  }

  try {
    const stateHash = hashSpotifyState(state);
    const { data: storedState, error: stateError } = await supabaseAdmin
      .from("spotify_oauth_states")
      .delete()
      .eq("state_hash", stateHash)
      .select("user_id, expires_at")
      .maybeSingle();

    if (
      stateError ||
      !storedState ||
      new Date(storedState.expires_at).getTime() < Date.now()
    ) {
      return NextResponse.redirect(spotifyResultUrl(request.url, "error"));
    }

    const { clientId, clientSecret, redirectUri } = getSpotifyConfig();
    const basicCredentials = Buffer.from(
      `${clientId}:${clientSecret}`,
    ).toString("base64");

    const tokenResponse = await fetch(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicCredentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
        cache: "no-store",
      },
    );
    const tokens = (await tokenResponse.json()) as SpotifyTokenResponse;

    if (
      !tokenResponse.ok ||
      !tokens.access_token ||
      !tokens.refresh_token ||
      !tokens.expires_in
    ) {
      console.error(
        "Spotify token exchange failed:",
        tokens.error_description ?? tokens.error,
      );
      return NextResponse.redirect(spotifyResultUrl(request.url, "error"));
    }

    const profileResponse = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      cache: "no-store",
    });
    const spotifyProfile = (await profileResponse.json()) as SpotifyProfile;

    if (!profileResponse.ok || !spotifyProfile.id) {
      console.error(
        "Spotify profile request failed:",
        profileResponse.status,
        spotifyProfile,
      );
      return NextResponse.redirect(spotifyResultUrl(request.url, "error"));
    }

    const expiresAt = new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString();

    const { error: saveError } = await supabaseAdmin
      .from("spotify_connections")
      .upsert(
        {
          user_id: storedState.user_id,
          spotify_user_id: spotifyProfile.id,
          spotify_display_name:
            spotifyProfile.display_name || spotifyProfile.id,
          spotify_email: spotifyProfile.email ?? null,
          spotify_product: spotifyProfile.product ?? null,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type ?? "Bearer",
          scope: tokens.scope ?? "",
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    if (saveError) {
      console.error("Spotify connection save failed:", saveError.message);
      return NextResponse.redirect(spotifyResultUrl(request.url, "error"));
    }

    return NextResponse.redirect(spotifyResultUrl(request.url, "connected"));
  } catch (error) {
    console.error("Spotify callback failed:", error);
    return NextResponse.redirect(spotifyResultUrl(request.url, "error"));
  }
}
