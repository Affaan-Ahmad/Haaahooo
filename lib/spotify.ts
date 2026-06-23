import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

import { supabaseAdmin, supabaseAuthClient } from "@/lib/supabaseAdmin";

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

type SpotifyConnectionRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

type SpotifyRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export async function getSpotifyAccessToken(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("spotify_connections")
    .select("user_id, access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const connection = data as SpotifyConnectionRow;
  const expiresAt = new Date(connection.expires_at).getTime();
  if (expiresAt > Date.now() + 60_000) return connection.access_token;

  const { clientId, clientSecret } = getSpotifyConfig();
  const basicCredentials = Buffer.from(
    `${clientId}:${clientSecret}`,
  ).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
    }),
    cache: "no-store",
  });
  const refreshed = (await response.json()) as SpotifyRefreshResponse;

  if (!response.ok || !refreshed.access_token || !refreshed.expires_in) {
    throw new Error(
      refreshed.error_description ??
        refreshed.error ??
        "Spotify token refresh failed.",
    );
  }

  const nextRefreshToken =
    refreshed.refresh_token ?? connection.refresh_token;
  const nextExpiresAt = new Date(
    Date.now() + refreshed.expires_in * 1000,
  ).toISOString();

  const { error: updateError } = await supabaseAdmin
    .from("spotify_connections")
    .update({
      access_token: refreshed.access_token,
      refresh_token: nextRefreshToken,
      expires_at: nextExpiresAt,
      token_type: refreshed.token_type ?? "Bearer",
      ...(refreshed.scope ? { scope: refreshed.scope } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) throw updateError;
  return refreshed.access_token;
}

export async function requireConversationMembership(
  userId: string,
  conversationId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("conversation_members")
    .select("conversation_id")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}
