import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getAuthenticatedUser,
  getSpotifyAccessToken,
  requireConversationMembership,
} from "@/lib/spotify";
import {
  gatherCandidates,
  getAnyMemberToken,
  type JukeboxRow,
} from "@/lib/jukeboxEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnostic for the autoplay radio. Reports how many tracks each Spotify
 * source returned for the current song, plus any non-200 statuses — so we can
 * see WHY the radio is empty without digging through server logs.
 *
 * Two ways to call it:
 *   1) Browser-friendly (uses the cron secret, auto-finds the playing jukebox):
 *        /api/spotify/jukebox/radio-debug?secret=YOUR_CRON_SECRET
 *   2) Authenticated (from the app):
 *        GET with header Authorization: Bearer <supabase token>
 *        and ?conversationId=...
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = request.nextUrl.searchParams.get("secret")?.trim() ?? "";

  let conversationId =
    request.nextUrl.searchParams.get("conversationId")?.trim() ?? "";
  let token: string | null = null;

  if (secret && provided === secret) {
    // Secret path: find a jukebox that's playing (or has a current track).
    if (!conversationId) {
      const { data: playing } = await supabaseAdmin
        .from("conversation_jukebox")
        .select("conversation_id, track_id, is_playing, changed_at")
        .not("track_id", "is", null)
        .order("is_playing", { ascending: false })
        .order("changed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      conversationId =
        (playing as { conversation_id?: string } | null)?.conversation_id ?? "";
    }
    if (!conversationId) {
      return NextResponse.json({
        ok: false,
        reason: "No jukebox with a current track found. Play a song first.",
      });
    }
    token = await getAnyMemberToken(conversationId);
  } else {
    // Authenticated path.
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (
      !conversationId ||
      !(await requireConversationMembership(user.id, conversationId))
    ) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 403 });
    }
    token = await getSpotifyAccessToken(user.id).catch(() => null);
  }

  if (!token) {
    return NextResponse.json({
      ok: false,
      reason: "No Spotify access token available for this conversation's members.",
    });
  }

  const { data } = await supabaseAdmin
    .from("conversation_jukebox")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  const current = data as JukeboxRow | null;
  if (!current?.track_id) {
    return NextResponse.json({
      ok: false,
      reason: "Play a song first — the radio is seeded from the current track.",
    });
  }

  const report = await gatherCandidates(token, current);
  const sample = [...report.candidates.values()].slice(0, 5).map((t) => ({
    name: t.name,
    artists: t.artists,
  }));

  // Control: replicate the app's WORKING song-search exactly (simple query,
  // limit 8, no market). Isolates whether search works at all for this token.
  let controlSearch: { status: number; count: number; message: string | null } = {
    status: 0,
    count: 0,
    message: null,
  };
  try {
    const u = new URL("https://api.spotify.com/v1/search");
    u.search = new URLSearchParams({ q: "love", type: "track", limit: "8" }).toString();
    const r = await fetch(u, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const j = (await r.json().catch(() => null)) as {
      tracks?: { items?: unknown[] };
      error?: { message?: string };
    } | null;
    controlSearch = {
      status: r.status,
      count: j?.tracks?.items?.length ?? 0,
      message: j?.error?.message ?? null,
    };
  } catch (e) {
    controlSearch = {
      status: 0,
      count: 0,
      message: e instanceof Error ? e.message : "fetch failed",
    };
  }

  return NextResponse.json({
    ok: true,
    seedTrack: { name: current.track_name, artist: current.artist_name },
    market: report.market,
    seedTrackOk: report.seedTrackOk,
    artistId: report.artistId,
    artistName: report.artistName,
    genres: report.genres,
    counts: report.counts,
    totalCandidates: report.candidates.size,
    controlSearch,
    notes: report.notes,
    sample,
  });
}
