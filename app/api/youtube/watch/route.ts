import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getAuthenticatedUser,
  requireConversationMembership,
} from "@/lib/spotify";
import {
  advanceWatch,
  currentPosition,
  loadCurrent,
  loadQueue,
  nextPosition,
  publicState,
  queuePayload,
  setCurrent,
  validateVideo,
  videoFieldsFrom,
  type VideoInput,
  type WatchQueueRow,
} from "@/lib/watchParty";

export const runtime = "nodejs";

type WatchAction =
  | "select"
  | "enqueue"
  | "play"
  | "pause"
  | "seek"
  | "next"
  | "previous"
  | "remove"
  | "advance"
  | "setduration";

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

  return NextResponse.json({
    state: publicState(await loadCurrent(conversationId)),
    ...queuePayload(await loadQueue(conversationId)),
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await request.json()) as {
    conversationId?: string;
    action?: WatchAction;
    video?: VideoInput;
    positionMs?: number;
    durationMs?: number;
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
    const respond = async () => {
      return NextResponse.json({
        state: publicState(await loadCurrent(conversationId)),
        ...queuePayload(await loadQueue(conversationId)),
      });
    };

    const existing = await loadCurrent(conversationId);

    // ---- Add to the queue (play now or just queue) ----------------------
    if (action === "enqueue" || action === "select") {
      if (!validateVideo(body.video)) {
        return NextResponse.json({ error: "Invalid video." }, { status: 400 });
      }
      const pos = await nextPosition(conversationId);
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from("conversation_watch_queue")
        .insert({
          conversation_id: conversationId,
          position: pos,
          played: false,
          ...videoFieldsFrom(body.video),
          added_by: user.id,
        })
        .select("*")
        .single();
      if (insertError) throw insertError;

      if (action === "select" || !existing?.video_id) {
        await setCurrent(conversationId, inserted as WatchQueueRow, user.id);
      }
      return respond();
    }

    // ---- Auto-advance (video ended) -------------------------------------
    if (action === "advance") {
      await advanceWatch(conversationId, user.id, {
        expectedChangedAt: body.expectedChangedAt,
        requireEnded: true,
      });
      return respond();
    }

    // ---- Manual next ----------------------------------------------------
    if (action === "next") {
      if (!existing?.video_id) {
        return NextResponse.json({ error: "Nothing is playing." }, { status: 400 });
      }
      await advanceWatch(conversationId, user.id);
      return respond();
    }

    // ---- Previous: restart if >3s in, else the previously played video --
    if (action === "previous") {
      if (!existing?.video_id) {
        return NextResponse.json({ error: "Nothing is playing." }, { status: 400 });
      }
      if (currentPosition(existing) > 3000) {
        await supabaseAdmin
          .from("conversation_watch")
          .update({
            position_ms: 0,
            is_playing: true,
            changed_at: new Date().toISOString(),
            changed_by: user.id,
          })
          .eq("conversation_id", conversationId);
        return respond();
      }
      const { data: prev } = await supabaseAdmin
        .from("conversation_watch_queue")
        .select("*")
        .eq("conversation_id", conversationId)
        .eq("played", true)
        .neq("id", existing.current_queue_id ?? "")
        .order("played_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prev) {
        await setCurrent(conversationId, prev as WatchQueueRow, user.id);
      } else {
        await supabaseAdmin
          .from("conversation_watch")
          .update({
            position_ms: 0,
            is_playing: true,
            changed_at: new Date().toISOString(),
            changed_by: user.id,
          })
          .eq("conversation_id", conversationId);
      }
      return respond();
    }

    // ---- Remove a queued (unplayed) video -------------------------------
    if (action === "remove") {
      const queueId = body.queueId?.trim();
      if (!queueId) {
        return NextResponse.json({ error: "Missing queue item." }, { status: 400 });
      }
      if (existing?.current_queue_id === queueId) {
        return NextResponse.json(
          { error: "Can't remove the video that's playing." },
          { status: 400 },
        );
      }
      const { error: deleteError } = await supabaseAdmin
        .from("conversation_watch_queue")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("id", queueId);
      if (deleteError) throw deleteError;
      return respond();
    }

    // Everything below needs a current video.
    if (!existing?.video_id) {
      return NextResponse.json({ error: "Choose a video first." }, { status: 400 });
    }

    // ---- Backfill the true duration once a client learns it -------------
    if (action === "setduration") {
      const dur = Math.max(0, Math.round(Number(body.durationMs) || 0));
      // Only set it if we don't already have a real duration (avoids churn).
      if (dur > 0 && existing.duration_ms <= 0) {
        await supabaseAdmin
          .from("conversation_watch")
          .update({ duration_ms: dur })
          .eq("conversation_id", conversationId);
        if (existing.current_queue_id) {
          await supabaseAdmin
            .from("conversation_watch_queue")
            .update({ duration_ms: dur })
            .eq("id", existing.current_queue_id);
        }
      }
      return respond();
    }

    // ---- Play / pause / seek on the current video -----------------------
    let nextPos = currentPosition(existing);
    let nextPlaying = existing.is_playing;
    if (action === "play") nextPlaying = true;
    if (action === "pause") nextPlaying = false;
    if (action === "seek") {
      const requested = Number(body.positionMs);
      const cap =
        existing.duration_ms > 0 ? existing.duration_ms : Number.MAX_SAFE_INTEGER;
      nextPos = Math.min(Math.max(0, Number.isFinite(requested) ? requested : 0), cap);
    }

    await supabaseAdmin
      .from("conversation_watch")
      .update({
        position_ms: Math.round(nextPos),
        is_playing: nextPlaying,
        changed_at: new Date().toISOString(),
        changed_by: user.id,
      })
      .eq("conversation_id", conversationId);

    return respond();
  } catch (error) {
    console.error("Watch command failed:", error);
    return NextResponse.json(
      { error: "The watch command failed." },
      { status: 500 },
    );
  }
}
