// netlify/functions/payhere-cancel.js
//
// Called when a signed-in Pro subscriber clicks "Cancel Subscription". Looks up
// their stored PayHere subscription id, cancels it via PayHere's Subscription
// Manager API (OAuth2, separate credentials from the checkout hash), then updates
// Supabase so the app reflects the cancellation immediately (the notify webhook
// will also confirm this shortly after).
//
// Required Netlify environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY            — verifies who's asking
//   SUPABASE_SERVICE_ROLE_KEY                  — reads/writes the subscription row
//   PAYHERE_APP_ID, PAYHERE_APP_SECRET         — from PayHere Settings > API Keys
//                                                 ("Automated Charging API" permission)
//   PAYHERE_MODE                               — "sandbox" (default) or "live"

const { createClient } = require("@supabase/supabase-js");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const APP_ID = process.env.PAYHERE_APP_ID;
  const APP_SECRET = process.env.PAYHERE_APP_SECRET;
  const MODE = (process.env.PAYHERE_MODE || "sandbox").toLowerCase();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY || !APP_ID || !APP_SECRET) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Server isn't fully configured yet." }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not signed in." }) };
  }

  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Session expired — please sign in again." }) };
  }
  const user = userData.user;

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: sub, error: subErr } = await supabaseAdmin
    .from("subscriptions")
    .select("payhere_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (subErr || !sub || !sub.payhere_subscription_id) {
    return { statusCode: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "No active subscription found for your account." }) };
  }

  const base = MODE === "live" ? "https://www.payhere.lk" : "https://sandbox.payhere.lk";

  try {
    const authCode = Buffer.from(APP_ID + ":" + APP_SECRET).toString("base64");
    const tokenRes = await fetch(base + "/merchant/v1/oauth/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + authCode,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      console.error("payhere-cancel: couldn't get access token", tokenJson);
      return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Couldn't authenticate with PayHere." }) };
    }

    const cancelRes = await fetch(base + "/merchant/v1/subscription/cancel", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + tokenJson.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ subscription_id: sub.payhere_subscription_id })
    });

    if (!cancelRes.ok) {
      const errBody = await cancelRes.text();
      console.error("payhere-cancel: PayHere cancel call failed:", errBody);
      return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "PayHere couldn't cancel the subscription." }) };
    }

    await supabaseAdmin.from("subscriptions").update({
      is_pro: false,
      status: "cancelled",
      updated_at: new Date().toISOString()
    }).eq("user_id", user.id);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error("payhere-cancel: unexpected error:", e.message);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unexpected error while cancelling." }) };
  }
};
