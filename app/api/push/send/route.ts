import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { supabaseAdmin, supabaseAuthClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

type MessageType = "text" | "image" | "video" | "audio" | "call";

type StoredPushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

type PushSubscriptionRow = {
  id: string;
  user_id: string;
  subscription_json: StoredPushSubscription;
};

function getNotificationBody(messageType: MessageType) {
  if (messageType === "image") return "New photo";
  if (messageType === "video") return "New video";
  if (messageType === "audio") return "New voice note";
  if (messageType === "call") return "Incoming voice call";
  return "New message";
}

async function getUser(request: NextRequest) {
  const token = (request.headers.get("authorization") ?? "")
    .replace("Bearer ", "")
    .trim();
  if (!token) return null;
  const {
    data: { user },
  } = await supabaseAuthClient.auth.getUser(token);
  return user;
}

export async function POST(request: NextRequest) {
  const user = await getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as {
    messageType?: MessageType;
    conversationId?: string;
  };
  const conversationId = body.conversationId;
  const messageType = body.messageType ?? "text";

  if (!conversationId) {
    return NextResponse.json({ error: "Missing conversation." }, { status: 400 });
  }

  const { data: membership } = await supabaseAdmin
    .from("conversation_members")
    .select("conversation_id")
    .eq("conversation_id", conversationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const { data: recipientRows, error: recipientError } = await supabaseAdmin
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId)
    .neq("user_id", user.id);

  if (recipientError) {
    return NextResponse.json({ error: recipientError.message }, { status: 500 });
  }

  const recipientIds = (recipientRows ?? []).map((row) => row.user_id);
  if (recipientIds.length === 0) return NextResponse.json({ ok: true });

  const { data, error } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, user_id, subscription_json")
    .in("user_id", recipientIds);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:test@example.com";
  if (!publicKey || !privateKey) {
    return NextResponse.json({ error: "Missing VAPID keys." }, { status: 500 });
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  const payload = JSON.stringify({
    title: "Haaahooo",
    body: getNotificationBody(messageType),
    url: `/?conversation=${encodeURIComponent(conversationId)}`,
  });

  await Promise.all(
    ((data ?? []) as PushSubscriptionRow[]).map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription_json, payload);
      } catch (pushError) {
        const statusCode =
          pushError instanceof Error && "statusCode" in pushError
            ? Number((pushError as Error & { statusCode?: number }).statusCode)
            : undefined;
        if (statusCode === 404 || statusCode === 410) {
          await supabaseAdmin.from("push_subscriptions").delete().eq("id", row.id);
        }
      }
    }),
  );

  return NextResponse.json({ ok: true });
}
