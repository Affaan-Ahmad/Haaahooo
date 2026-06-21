import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { supabaseAdmin, supabaseAuthClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

type MessageType = "text" | "image" | "video" | "audio";

type StoredPushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type PushSubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  subscription_json: StoredPushSubscription;
};

function getNotificationBody(messageType: MessageType) {
  if (messageType === "image") return "📷 New photo";
  if (messageType === "video") return "🎥 New video";
  if (messageType === "audio") return "🎙️ New voice note";
  return "💬 New message";
}

async function getUserFromRequest(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return null;
  }

  const {
    data: { user },
    error,
  } = await supabaseAuthClient.auth.getUser(token);

  if (error || !user) {
    return null;
  }

  return user;
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await request.json();
  const messageType = (body.messageType ?? "text") as MessageType;

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:test@example.com";

  if (!publicKey || !privateKey) {
    return NextResponse.json(
      { error: "Missing VAPID keys." },
      { status: 500 }
    );
  }

  const { data: allowedUser } = await supabaseAdmin
    .from("allowed_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!allowedUser) {
    return NextResponse.json(
      { error: "This user is not allowed to use this chat." },
      { status: 403 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, subscription_json")
    .neq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const subscriptions = (data ?? []) as PushSubscriptionRow[];

  webpush.setVapidDetails(subject, publicKey, privateKey);

  const payload = JSON.stringify({
    title: "Private Chat",
    body: getNotificationBody(messageType),
    url: "/",
  });

  await Promise.all(
    subscriptions.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription_json, payload);
      } catch (error) {
        const statusCode =
          error instanceof Error && "statusCode" in error
            ? Number((error as Error & { statusCode?: number }).statusCode)
            : undefined;

        if (statusCode === 404 || statusCode === 410) {
          await supabaseAdmin
            .from("push_subscriptions")
            .delete()
            .eq("id", row.id);
        }
      }
    })
  );

  return NextResponse.json({ ok: true });
}