// functions/api/payhere-notify.js  ->  POST /api/payhere-notify
//
// This is the "notify_url" PayHere calls (server-to-server, not from the user's
// browser) after a checkout or recurring charge. It's the ONLY thing that's allowed
// to mark a user as Pro — the browser never sets this directly.
//
// Every notification's signature is verified before anything is trusted or written.
//
// Required Cloudflare Pages environment variables:
//   PAYHERE_MERCHANT_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — service role bypasses Row Level
//                                                Security, which is exactly what
//                                                lets this function (and only this
//                                                function) write is_pro.

import { md5Hex } from "../_utils/md5.js";
import { upsertSubscription } from "../_utils/supabase.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const MERCHANT_SECRET = env.PAYHERE_MERCHANT_SECRET;
  if (!MERCHANT_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("payhere-notify: missing environment variables");
    return new Response("Server misconfigured", { status: 500 });
  }

  const raw = await request.text();
  const params = new URLSearchParams(raw);
  const data = {};
  for (const [k, v] of params) data[k] = v;

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
    return new Response("Missing fields", { status: 400 });
  }

  // local_sig = UPPER(MD5(merchant_id + order_id + payhere_amount + payhere_currency + status_code + UPPER(MD5(merchant_secret))))
  const expectedSig = md5Hex(
    merchant_id + order_id + payhere_amount + payhere_currency + status_code + md5Hex(MERCHANT_SECRET).toUpperCase()
  ).toUpperCase();

  if (expectedSig !== md5sig) {
    console.error("payhere-notify: signature mismatch for order", order_id, "— ignoring");
    return new Response("Invalid signature", { status: 400 });
  }

  if (!userId) {
    // Nothing to attribute this to. Acknowledge so PayHere stops retrying.
    return new Response("OK (no user reference)", { status: 200 });
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
    return new Response("OK (no state change)", { status: 200 });
  }

  try {
    await upsertSubscription(env, {
      user_id: userId,
      is_pro: isPro,
      status: status,
      provider: "payhere",
      payhere_subscription_id: subscription_id || null,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error("payhere-notify: supabase upsert failed:", e.message);
    return new Response("Database error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
