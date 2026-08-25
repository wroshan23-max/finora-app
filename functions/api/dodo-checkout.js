// functions/api/dodo-checkout.js  ->  POST /api/dodo-checkout
//
// Called by the app when a signed-in user clicks "Subscribe — International". Creates
// a Dodo Payments hosted checkout session (Dodo is a Merchant of Record — it handles
// global cards, Apple Pay/Google Pay, currency conversion and tax/VAT compliance for
// customers outside Sri Lanka) and hands back the checkout_url for the browser to open.
//
// The Dodo API key never reaches the browser — this call is made server-side only.
//
// Required Cloudflare Pages environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY   — used only to verify the caller's session
//   DODO_API_KEY                      — Developer -> API Keys in the Dodo dashboard
//   DODO_PRODUCT_ID                   — the recurring "Finora Pro — Monthly" product's id
//   DODO_PRODUCT_ID_ANNUAL            — the recurring "Finora Pro — Annual" product's id
//                                        (optional — if unset, annual checkout for
//                                        international payers is disabled gracefully)
//   DODO_MODE                         — "test" (default) or "live"

import { getUserFromToken, bearerToken, json } from "../_utils/supabase.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const API_KEY = env.DODO_API_KEY;
  const PRODUCT_ID_MONTHLY = env.DODO_PRODUCT_ID;
  const PRODUCT_ID_ANNUAL = env.DODO_PRODUCT_ID_ANNUAL;
  const MODE = (env.DODO_MODE || "test").toLowerCase();

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !API_KEY || !PRODUCT_ID_MONTHLY) {
    return json({ error: "Server isn't fully configured yet — missing environment variables." }, 500);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await getUserFromToken(env, token);
  if (!user) return json({ error: "Session expired — please sign in again." }, 401);
  if (!user.email) return json({ error: "Your account needs a verified email to subscribe." }, 400);

  let plan = "monthly";
  try {
    const reqBody = await request.json();
    if (reqBody && reqBody.plan === "annual") plan = "annual";
  } catch (e) {
    // No/invalid JSON body — default to monthly for backwards compatibility.
  }

  let PRODUCT_ID = PRODUCT_ID_MONTHLY;
  if (plan === "annual") {
    if (!PRODUCT_ID_ANNUAL) {
      return json({ error: "Annual billing for card payments isn't available yet — please choose Monthly, or use PayHere." }, 400);
    }
    PRODUCT_ID = PRODUCT_ID_ANNUAL;
  }

  const url = new URL(request.url);
  const siteUrl = url.protocol + "//" + url.host;
  const displayName = (user.user_metadata && user.user_metadata.full_name) || user.email.split("@")[0];
  const base = MODE === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";

  try {
    const dodoRes = await fetch(base + "/checkouts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        product_cart: [{ product_id: PRODUCT_ID, quantity: 1 }],
        customer: { email: user.email, name: displayName },
        return_url: siteUrl + "/?billing=success",
        metadata: { user_id: user.id }
      })
    });

    const body = await dodoRes.json();
    if (!dodoRes.ok || !body.checkout_url) {
      console.error("dodo-checkout: Dodo API error:", JSON.stringify(body));
      return json({ error: body.message || "Dodo couldn't start checkout." }, 502);
    }

    return json({ checkoutUrl: body.checkout_url });
  } catch (e) {
    console.error("dodo-checkout: unexpected error:", e.message);
    return json({ error: "Unexpected error while starting checkout." }, 500);
  }
}
