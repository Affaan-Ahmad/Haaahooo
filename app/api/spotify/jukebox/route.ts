import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getAuthenticatedUser,
  requireConversationMembership,
} from "@/lib/spotify";
import {
  advanceJukebox,
  broadcastPlayback,
  currentPosition,
  loadQueue,
  nextPosition,
  playTrackNow,
  prequeueNext,
  publicState,
  queuePayload,
  trackFieldsFrom,
  validateTrack,
  type JukeboxRow,
  type QueueRow,
  type TrackInput,
} from "@/lib/jukeboxEngine";

export const runtime = "nodejs";

type JukeboxAction =
  | "select"
  | "play"
  | "pause"
  | "seek"
  | "enqueue"
  | "next"
  | "previous"
  | "remove"
  | "advance";

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

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
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    state: publicState(data as JukeboxRow | null),
    ...queuePayload(await loadQueue(conversationId)),
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await request.json()) as {
    conversationId?: string;
    action?: JukeboxAction;
    track?: TrackInput;
    positionMs?: number;
    queueId?: string;
    expectedChangedAt?: string;
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
    const respond = async (
      playback?: Awaited<ReturnType<typeof broadcastPlayback>>,
    ) => {
      const { data } = await supabaseAdmin
        .from("conversation_jukebox")
        .select("*")
        .eq("conversation_id", conversationId)
        .maybeSingle();
      return NextResponse.json({
        state: publicState(data as JukeboxRow | null),
        ...queuePayload(await loadQueue(conversationId)),
        ...(playback ? { playback } : {}),
      });
    };

    const loadCurrent = async () => {
      const { data } = await supabaseAdmin
        .from("conversation_jukebox")
        .select("*")
        .eq("conversation_id", conversationId)
        .maybeSingle();
      return data as JukeboxRow | null;
    };

    const existing = await loadCurrent();

    // ---- Add to the user queue (play now or just queue) -----------------
    if (action === "enqueue" || action === "select") {
      if (!validateTrack(body.track)) {
        return NextResponse.json({ error: "Invalid track." }, { status: 400 });
      }
      const pos = await nextPosition(conversationId);
      const { data: insertedData, error: insertError } = await supabaseAdmin
        .from("conversation_jukebox_queue")
        .insert({
          conversation_id: conversationId,
          position: pos,
          source: "user",
          played: false,
          ...trackFieldsFrom(body.track),
          added_by: user.id,
        })
        .select("*")
        .single();
      if (insertError) throw insertError;

      if (action === "select" || !existing?.track_uri) {
        const { playback } = await playTrackNow(
          conversationId,
          insertedData as QueueRow,
          user.id,
        );
        return respond(playback);
      }
      // Just queued while something plays — make sure the buffer is current.
      await prequeueNext(conversationId).catch(() => null);
      return respond();
    }

    // ---- Auto-advance (song ended) --------------------------------------
    if (action === "advance") {
      const result = await advanceJukebox(conversationId, user.id, {
        expectedChangedAt: body.expectedChangedAt,
        requireEnded: true,
      });
      return respond(result.advanced ? result.playback : undefined);
    }

    // ---- Manual next: interrupt-play the true next ----------------------
    if (action === "next") {
      if (!existing?.track_uri) {
        return NextResponse.json({ error: "Nothing is playing." }, { status: 400 });
      }
      const result = await advanceJukebox(conversationId, user.id, {
        forcePlay: true,
      });
      return respond(result.advanced ? result.playback : undefined);
    }

    // ---- Previous: restart if >3s in, else previously played track ------
    if (action === "previous") {
      if (!existing?.track_uri) {
        return NextResponse.json({ error: "Nothing is playing." }, { status: 400 });
      }
      if (currentPosition(existing) > 3000) {
        await supabaseAdmin
          .from("conversation_jukebox")
          .update({
            position_ms: 0,
            changed_at: new Date().toISOString(),
            changed_by: user.id,
          })
          .eq("conversation_id", conversationId);
        const playback = await broadcastPlayback(
          conversationId,
          "play",
          existing.track_uri,
          0,
        );
        return respond(playback);
      }
      const { data: prevData } = await supabaseAdmin
        .from("conversation_jukebox_queue")
        .select("*")
        .eq("conversation_id", conversationId)
        .eq("played", true)
        .neq("id", existing.current_queue_id ?? "")
        .order("played_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prevData) {
        const { playback } = await playTrackNow(
          conversationId,
          prevData as QueueRow,
          user.id,
        );
        return respond(playback);
      }
      await supabaseAdmin
        .from("conversation_jukebox")
        .update({
          position_ms: 0,
          changed_at: new Date().toISOString(),
          changed_by: user.id,
        })
        .eq("conversation_id", conversationId);
      const playback = await broadcastPlayback(
        conversationId,
        "play",
        existing.track_uri,
        0,
      );
      return respond(playback);
    }

    // ---- Remove a queued (unplayed) track -------------------------------
    if (action === "remove") {
      const queueId = body.queueId?.trim();
      if (!queueId) {
        return NextResponse.json({ error: "Missing queue item." }, { status: 400 });
      }
      if (existing?.current_queue_id === queueId) {
        return NextResponse.json(
          { error: "Can't remove the song that's playing." },
          { status: 400 },
        );
      }
      const { error: deleteError } = await supabaseAdmin
        .from("conversation_jukebox_queue")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("id", queueId);
      if (deleteError) throw deleteError;
      return respond();
    }

    // ---- Play / pause / seek on the current track -----------------------
    if (!existing?.track_uri) {
      return NextResponse.json({ error: "Choose a song first." }, { status: 400 });
    }

    let nextPos = currentPosition(existing);
    let nextPlaying = existing.is_playing;
    if (action === "play") nextPlaying = true;
    if (action === "pause") nextPlaying = false;
    if (action === "seek") {
      const requested = Number(body.positionMs);
      nextPos = Math.min(
        Math.max(0, Number.isFinite(requested) ? requested : 0),
        existing.duration_ms,
      );
    }

    await supabaseAdmin
      .from("conversation_jukebox")
      .update({
        position_ms: Math.round(nextPos),
        is_playing: nextPlaying,
        changed_at: new Date().toISOString(),
        changed_by: user.id,
      })
      .eq("conversation_id", conversationId);

    const playback = await broadcastPlayback(
      conversationId,
      nextPlaying ? "play" : "pause",
      existing.track_uri,
      nextPos,
    );
    if (nextPlaying) await prequeueNext(conversationId).catch(() => null);
    return respond(playback);
  } catch (error) {
    console.error("Jukebox command failed:", error);
    return NextResponse.json(
      { error: "The jukebox command failed." },
      { status: 500 },
    );
  }
}
