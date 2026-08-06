// netlify/functions/payhere-notify.js
//
// This is the "notify_url" PayHere calls (server-to-server, not from the user's
// browser) after a checkout or recurring charge. It's the ONLY thing that's allowed
// to mark a user as Pro — the browser never sets this directly.
//
// Every notification's signature is verified before anything is trusted or written.
//
// Required Netlify environment variables:
//   PAYHERE_MERCHANT_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — service role bypasses Row Level
//                                                Security, which is exactly what
//                                                lets this function (and only this
//                                                function) write is_pro.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function parseBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : (event.body || "");
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const pair of params) obj[pair[0]] = pair[1];
  return obj;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const MERCHANT_SECRET = process.env.PAYHERE_MERCHANT_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!MERCHANT_SECRET || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("payhere-notify: missing environment variables");
    return { statusCode: 500, body: "Server misconfigured" };
  }

  const data = parseBody(event);
  const merchant_id = data.merchant_id;
  const order_id = data.order_id;
  const payhere_amount = data.payhere_amount;
  const payhere_currency = data.payhere_currency;
  const status_code = data.status_code;
  const md5sig = data.md5sig;
  const userId = data.custom_1;
  const subscription_id = data.subscription_id;
  const item_rec_status = (data.item_rec_status || "").toUpperCase();
  const message_type = (data.message_type || "").toUpperCase();

  if (!merchant_id || !order_id || !status_code || !md5sig) {
    return { statusCode: 400, body: "Missing fields" };
  }

  // local_sig = UPPER(MD5(merchant_id + order_id + payhere_amount + payhere_currency + status_code + UPPER(MD5(merchant_secret))))
  const expectedSig = md5(
    merchant_id + order_id + payhere_amount + payhere_currency + status_code + md5(MERCHANT_SECRET).toUpperCase()
  ).toUpperCase();

  if (expectedSig !== md5sig) {
    console.error("payhere-notify: signature mismatch for order", order_id, "— ignoring");
    return { statusCode: 400, body: "Invalid signature" };
  }

  if (!userId) {
    // Nothing to attribute this to. Acknowledge so PayHere stops retrying.
    return { statusCode: 200, body: "OK (no user reference)" };
  }

  const isSuccess = String(status_code) === "2";
  const cancelledSignals = ["CANCEL", "STOPPED", "FAILED"];
  const isCancelled = cancelledSignals.some(function (s) {
    return item_rec_status.indexOf(s) !== -1 || message_type.indexOf(s) !== -1;
  });

  let isPro, status;
  if (isCancelled) {
    isPro = false;
    status = "cancelled";
  } else if (isSuccess) {
    isPro = true;
    status = "active";
  } else {
    console.log("payhere-notify: non-success status_code", status_code, "for order", order_id, "— no state change");
    return { statusCode: 200, body: "OK (no state change)" };
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await supabase.from("subscriptions").upsert({
    user_id: userId,
    is_pro: isPro,
    status: status,
    payhere_subscription_id: subscription_id || null,
    updated_at: new Date().toISOString()
  });

  if (error) {
    console.error("payhere-notify: supabase upsert failed:", error.message);
    return { statusCode: 500, body: "Database error" };
  }

  return { statusCode: 200, body: "OK" };
};
