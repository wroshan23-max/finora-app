// netlify/functions/payhere-start.js
//
// Called by the app when a signed-in user clicks "Subscribe". Builds a PayHere
// recurring-checkout form (with a server-generated hash) and hands it back to the
// browser, which auto-submits it to PayHere's hosted checkout page.
//
// The PayHere merchant secret NEVER reaches the browser — the hash is computed
// here, server-side, using environment variables set in the Netlify dashboard.
//
// Required Netlify environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY   — used only to verify the caller's session
//   PAYHERE_MERCHANT_ID, PAYHERE_MERCHANT_SECRET
//   PAYHERE_MODE                      — "sandbox" (default) or "live"

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// ---- Change your subscription price here. Keep two decimal places. ----
// This is the value that's actually charged — it must match
// CONFIG.SUBSCRIPTION_PRICE_LKR in index.html, which is only used for display.
const PRICE_LKR = "990.00";
const CURRENCY = "LKR";
const ITEM_NAME = "Finora Pro — Monthly Subscription";

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
  const MERCHANT_SECRET = process.env.PAYHERE_MERCHANT_SECRET;
  const MODE = (process.env.PAYHERE_MODE || "sandbox").toLowerCase();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !MERCHANT_ID || !MERCHANT_SECRET) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server isn't fully configured yet — missing environment variables." })
    };
  }

  // Verify who's actually asking, using their Supabase session token — never trust
  // a user id supplied directly by the client.
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not signed in." }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Session expired — please sign in again." }) };
  }
  const user = userData.user;

  const siteUrl = "https://" + event.headers.host;
  const orderId = "finora-" + user.id.replace(/-/g, "").slice(0, 20) + "-" + Date.now();
  const amount = PRICE_LKR;

  // hash = UPPER(MD5(merchant_id + order_id + amount + currency + UPPER(MD5(merchant_secret))))
  const hash = md5(MERCHANT_ID + orderId + amount + CURRENCY + md5(MERCHANT_SECRET).toUpperCase()).toUpperCase();

  const displayName = (user.user_metadata && user.user_metadata.full_name) || (user.email || "Finora User").split("@")[0];

  const params = {
    merchant_id: MERCHANT_ID,
    return_url: siteUrl + "/?billing=success",
    cancel_url: siteUrl + "/?billing=cancelled",
    notify_url: siteUrl + "/.netlify/functions/payhere-notify",
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

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkoutUrl: checkoutUrl, params: params })
  };
};
