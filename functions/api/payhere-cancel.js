// functions/api/payhere-cancel.js  ->  POST /api/payhere-cancel
//
// Called when a signed-in Pro subscriber clicks "Cancel Subscription" and their
// subscription's provider is PayHere. Looks up their stored PayHere subscription id,
// cancels it via PayHere's Subscription Manager API (OAuth2, separate credentials from
// the checkout hash), then updates Supabase so the app reflects the cancellation
// immediately (the notify webhook will also confirm this shortly after).
//
// Required Cloudflare Pages environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   PAYHERE_APP_ID, PAYHERE_APP_SECRET   — from PayHere Settings > API Keys
//                                          ("Automated Charging API" permission)
//   PAYHERE_MODE                         — "sandbox" (default) or "live"

import { getUserFromToken, bearerToken, getSubscription, upsertSubscription, json } from "../_utils/supabase.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const APP_ID = env.PAYHERE_APP_ID;
  const APP_SECRET = env.PAYHERE_APP_SECRET;
  const MODE = (env.PAYHERE_MODE || "sandbox").toLowerCase();

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY || !APP_ID || !APP_SECRET) {
    return json({ error: "Server isn't fully configured yet." }, 500);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await getUserFromToken(env, token);
  if (!user) return json({ error: "Session expired — please sign in again." }, 401);

  const sub = await getSubscription(env, user.id);
  if (!sub || !sub.payhere_subscription_id) {
    return json({ error: "No active PayHere subscription found for your account." }, 404);
  }

  const base = MODE === "live" ? "https://www.payhere.lk" : "https://sandbox.payhere.lk";

  try {
    const authCode = btoa(APP_ID + ":" + APP_SECRET);
    const tokenRes = await fetch(base + "/merchant/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + authCode,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      console.error("payhere-cancel: couldn't get access token", JSON.stringify(tokenJson));
      return json({ error: "Couldn't authenticate with PayHere." }, 502);
    }

    const cancelRes = await fetch(base + "/merchant/v1/subscription/cancel", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tokenJson.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ subscription_id: sub.payhere_subscription_id })
    });

    if (!cancelRes.ok) {
      const errBody = await cancelRes.text();
      console.error("payhere-cancel: PayHere cancel call failed:", errBody);
      return json({ error: "PayHere couldn't cancel the subscription." }, 502);
    }

    await upsertSubscription(env, {
      user_id: user.id,
      is_pro: false,
      status: "cancelled",
      updated_at: new Date().toISOString()
    });

    return json({ ok: true });
  } catch (e) {
    console.error("payhere-cancel: unexpected error:", e.message);
    return json({ error: "Unexpected error while cancelling." }, 500);
  }
}
