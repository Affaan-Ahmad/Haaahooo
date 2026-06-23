import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

import { supabaseAuthClient } from "@/lib/supabaseAdmin";

export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",
];

export function createSpotifyState() {
  return randomBytes(32).toString("base64url");
}

export function hashSpotifyState(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

export function getSpotifyConfig() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Spotify environment variables are missing.");
  }

  return { clientId, clientSecret, redirectUri };
}

export async function getAuthenticatedUser(request: NextRequest) {
  const token = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return null;

  const {
    data: { user },
  } = await supabaseAuthClient.auth.getUser(token);

  return user;
}

export function spotifyResultUrl(
  requestUrl: string,
  result: "connected" | "denied" | "error",
) {
  const url = new URL("/", requestUrl);
  url.searchParams.set("spotify", result);
  return url;
}
