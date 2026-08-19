// functions/api/dodo-portal.js  ->  POST /api/dodo-portal
//
// Called when a signed-in Pro subscriber whose subscription provider is Dodo clicks
// "Manage Subscription". Dodo's Customer Portal is where the customer themselves
// changes payment method or cancels — this function only ever creates a time-bound
// portal link for the caller's OWN Dodo customer id; it never cancels anything
// directly. The actual is_pro flip happens later, driven by the dodo-webhook
// function when Dodo confirms the cancellation server-to-server.
//
// Required Cloudflare Pages environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   DODO_API_KEY
//   DODO_MODE   — "test" (default) or "live"

import { getUserFromToken, bearerToken, getSubscription, json } from "../_utils/supabase.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const API_KEY = env.DODO_API_KEY;
  const MODE = (env.DODO_MODE || "test").toLowerCase();

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY || !API_KEY) {
    return json({ error: "Server isn't fully configured yet." }, 500);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await getUserFromToken(env, token);
  if (!user) return json({ error: "Session expired — please sign in again." }, 401);

  const sub = await getSubscription(env, user.id);
  if (!sub || !sub.dodo_customer_id) {
    return json({ error: "No Dodo subscription found for your account." }, 404);
  }

  const base = MODE === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
  const url = new URL(request.url);
  const siteUrl = url.protocol + "//" + url.host;

  try {
    const portalRes = await fetch(
      base + "/customers/" + encodeURIComponent(sub.dodo_customer_id) + "/customer-portal/session?return_url=" + encodeURIComponent(siteUrl + "/"),
      { method: "POST", headers: { Authorization: "Bearer " + API_KEY } }
    );
    const body = await portalRes.json();
    if (!portalRes.ok || !body.link) {
      console.error("dodo-portal: Dodo API error:", JSON.stringify(body));
      return json({ error: body.message || "Couldn't open the Dodo customer portal." }, 502);
    }
    return json({ link: body.link });
  } catch (e) {
    console.error("dodo-portal: unexpected error:", e.message);
    return json({ error: "Unexpected error while opening the customer portal." }, 500);
  }
}
