import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseAuthClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

type StoredPushSubscription = {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
};

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
  const subscription = body.subscription as StoredPushSubscription;

  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return NextResponse.json({ error: "Invalid push subscription." }, { status: 400 });
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

  const { error } = await supabaseAdmin.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: subscription.endpoint,
      subscription_json: subscription,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "endpoint",
    }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}