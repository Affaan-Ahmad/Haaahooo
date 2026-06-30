import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  advanceJukebox,
  anyMemberPlaying,
  currentPosition,
  prequeueNext,
  type JukeboxRow,
} from "@/lib/jukeboxEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Background jukebox keeper. Ping this every minute from a free external
 * scheduler (e.g. cron-job.org). It does two things for each conversation
 * whose jukebox is "playing":
 *   1. If the current song has ended, sync the now-playing row to the track
 *      Spotify already advanced to (via the pre-queue) and top the buffer up.
 *   2. Otherwise, make sure exactly one upcoming track is pre-loaded into each
 *      listener's Spotify queue, so the next transition stays gapless.
 *
 * Auth: send header  Authorization: Bearer <CRON_SECRET>
 *       or query     ?secret=<CRON_SECRET>
 */
async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ??
    request.nextUrl.searchParams.get("secret") ??
    "";
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("conversation_jukebox")
    .select("*")
    .eq("is_playing", true);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as JukeboxRow[];
  let checked = 0;
  let advanced = 0;
  let buffered = 0;
  let reconciled = 0;

  for (const row of rows) {
    if (!row.track_uri || !row.duration_ms) continue;
    checked++;
    try {
      // Don't resurrect a session the listeners actually stopped. If nobody's
      // Spotify is playing, mark it paused and leave it alone.
      const live = await anyMemberPlaying(row.conversation_id);
      if (!live) {
        const pos = Math.min(currentPosition(row), row.duration_ms);
        await supabaseAdmin
          .from("conversation_jukebox")
          .update({
            is_playing: false,
            position_ms: Math.round(pos),
            changed_at: new Date().toISOString(),
          })
          .eq("conversation_id", row.conversation_id);
        reconciled++;
        continue;
      }

      const ended = currentPosition(row) >= row.duration_ms - 1500;
      if (ended) {
        const result = await advanceJukebox(row.conversation_id, row.changed_by, {
          requireEnded: true,
        });
        if (result.advanced) advanced++;
      } else {
        // prequeueNext only acts within the pre-queue window, so this is a
        // no-op until the song is near its end.
        const next = await prequeueNext(row.conversation_id);
        if (next) buffered++;
      }
    } catch {
      // best-effort; keep going with the other conversations
    }
  }

  return NextResponse.json({ ok: true, checked, advanced, buffered, reconciled });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
