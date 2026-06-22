import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseAuthClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

type StoredPushSubscription = {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: { p256dh?: string; auth?: string };
};

export async function POST(request: NextRequest) {
  const token = (request.headers.get("authorization") ?? "")
    .replace("Bearer ", "")
    .trim();
  if (!token) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const {
    data: { user },
  } = await supabaseAuthClient.auth.getUser(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as {
    subscription?: StoredPushSubscription;
  };
  const subscription = body.subscription;

  if (
    !subscription?.endpoint ||
    !subscription.keys?.p256dh ||
    !subscription.keys.auth
  ) {
    return NextResponse.json({ error: "Invalid subscription." }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: subscription.endpoint,
      subscription_json: subscription,
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
