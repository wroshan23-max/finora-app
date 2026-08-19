// functions/api/payhere-start.js  ->  POST /api/payhere-start
//
// Called by the app when a signed-in user clicks "Subscribe with PayHere". Builds a
// PayHere recurring-checkout form (with a server-generated hash) and hands it back to
// the browser, which auto-submits it to PayHere's hosted checkout page.
//
// The PayHere merchant secret NEVER reaches the browser — the hash is computed here,
// server-side, using Cloudflare Pages environment variables/secrets.
//
// Required Cloudflare Pages environment variables (Settings -> Environment variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY   — used only to verify the caller's session
//   PAYHERE_MERCHANT_ID, PAYHERE_MERCHANT_SECRET   (set MERCHANT_SECRET as a "secret")
//   PAYHERE_MODE                      — "sandbox" (default) or "live"

import { md5Hex } from "../_utils/md5.js";
import { getUserFromToken, bearerToken, json } from "../_utils/supabase.js";

// ---- Change your subscription price here. Keep two decimal places. ----
// This is the value that's actually charged — it must match
// CONFIG.SUBSCRIPTION_PRICE_LKR in index.html, which is only used for display.
const PRICE_LKR = "500.00";
const CURRENCY = "LKR";
const ITEM_NAME = "Finora Pro — Monthly Subscription";

export async function onRequestPost(context) {
  const { request, env } = context;

  const MERCHANT_ID = env.PAYHERE_MERCHANT_ID;
  const MERCHANT_SECRET = env.PAYHERE_MERCHANT_SECRET;
  const MODE = (env.PAYHERE_MODE || "sandbox").toLowerCase();

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !MERCHANT_ID || !MERCHANT_SECRET) {
    return json({ error: "Server isn't fully configured yet — missing environment variables." }, 500);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await getUserFromToken(env, token);
  if (!user) return json({ error: "Session expired — please sign in again." }, 401);

  const url = new URL(request.url);
  const siteUrl = url.protocol + "//" + url.host;
  const orderId = "finora-" + user.id.replace(/-/g, "").slice(0, 20) + "-" + Date.now();
  const amount = PRICE_LKR;

  // hash = UPPER(MD5(merchant_id + order_id + amount + currency + UPPER(MD5(merchant_secret))))
  const hash = md5Hex(MERCHANT_ID + orderId + amount + CURRENCY + md5Hex(MERCHANT_SECRET).toUpperCase()).toUpperCase();

  const displayName = (user.user_metadata && user.user_metadata.full_name) || (user.email || "Finora User").split("@")[0];

  const params = {
    merchant_id: MERCHANT_ID,
    return_url: siteUrl + "/?billing=success",
    cancel_url: siteUrl + "/?billing=cancelled",
    notify_url: siteUrl + "/api/payhere-notify",
    order_id: orderId,
    items: ITEM_NAME,
    currency: CURRENCY,
    amount: amount,
    first_name: displayName,
    last_name: "",
    email: user.email || "",
    phone: "0000000000",
    address: "N/A",
    city: "Colombo",
    country: "Sri Lanka",
    recurrence: "1 Month",
    duration: "Forever",
    custom_1: user.id,
    hash: hash
  };

  const checkoutUrl = MODE === "live" ? "https://www.payhere.lk/pay/checkout" : "https://sandbox.payhere.lk/pay/checkout";

  return json({ checkoutUrl: checkoutUrl, params: params });
}
