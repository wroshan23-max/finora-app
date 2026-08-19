// functions/api/dodo-webhook.js  ->  POST /api/dodo-webhook
//
// This is the webhook endpoint Dodo Payments calls (server-to-server) whenever a
// subscription's status changes. It's the ONLY thing that's allowed to mark a Dodo
// subscriber as Pro — the browser never sets this directly.
//
// Dodo follows the open "Standard Webhooks" spec (same scheme as Svix): every request
// carries webhook-id / webhook-timestamp / webhook-signature headers, and the
// signature is an HMAC-SHA256 of "{id}.{timestamp}.{raw body}" using a secret shaped
// like "whsec_<base64>". It's verified here before anything is trusted or written.
//
// Required Cloudflare Pages environment variables:
//   DODO_WEBHOOK_SECRET                       — Developer -> Webhooks in the Dodo dashboard
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — service role bypasses Row Level
//                                                Security, which is exactly what lets
//                                                this function (and only this
//                                                function) write is_pro.

import { upsertSubscription } from "../_utils/supabase.js";

const ACTIVE_EVENTS = ["subscription.active", "subscription.renewed", "subscription.unpaused"];
const INACTIVE_EVENTS = ["subscription.cancelled", "subscription.expired", "subscription.failed", "subscription.on_hold", "subscription.paused"];
// subscription.updated / subscription.plan_changed / subscription.update_payment_method
// carry a "status" field instead of being unambiguous by event name alone — handled below.

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function verifySignature(secret, id, timestamp, rawBody, signatureHeader) {
  const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signedContent = id + "." + timestamp + "." + rawBody;
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(new Uint8Array(sigBytes));

  // Header may contain multiple space-separated "v1,<base64sig>" entries.
  const candidates = signatureHeader.split(" ").map(function (s) { return s.split(",")[1] || s; });
  return candidates.some(function (c) { return c === expected; });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const SECRET = env.DODO_WEBHOOK_SECRET;
  if (!SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("dodo-webhook: missing environment variables");
    return new Response("Server misconfigured", { status: 500 });
  }

  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const webhookSignature = request.headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return new Response("Missing signature headers", { status: 400 });
  }

  // Reject anything more than 5 minutes old or from the future — basic replay protection.
  const tsSeconds = parseInt(webhookTimestamp, 10);
  if (!tsSeconds || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    return new Response("Timestamp out of tolerance", { status: 400 });
  }

  const rawBody = await request.text();

  let verified;
  try {
    verified = await verifySignature(SECRET, webhookId, webhookTimestamp, rawBody, webhookSignature);
  } catch (e) {
    console.error("dodo-webhook: signature check errored:", e.message);
    return new Response("Invalid signature", { status: 400 });
  }
  if (!verified) {
    console.error("dodo-webhook: signature mismatch");
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const type = event.type || "";
  const data = event.data || {};
  const userId = data.metadata && data.metadata.user_id;
  const subscriptionId = data.subscription_id || data.id;
  const customerId = data.customer && data.customer.customer_id;

  if (!userId) {
    // Nothing to attribute this to (e.g. a non-subscription event). Acknowledge so
    // Dodo stops retrying.
    return new Response("OK (no user reference)", { status: 200 });
  }

  let isPro = null, status = null;
  if (ACTIVE_EVENTS.indexOf(type) !== -1) {
    isPro = true; status = "active";
  } else if (INACTIVE_EVENTS.indexOf(type) !== -1) {
    isPro = false; status = type.replace("subscription.", "");
  } else if (type === "subscription.updated" || type === "subscription.plan_changed") {
    // Fall back to the status field Dodo includes on these events.
    const s = (data.status || "").toLowerCase();
    if (s === "active") { isPro = true; status = "active"; }
    else if (s) { isPro = false; status = s; }
  }

  if (isPro === null) {
    // An event we don't need to act on (e.g. update_payment_method) — acknowledge only.
    return new Response("OK (no state change)", { status: 200 });
  }

  try {
    var row = {
      user_id: userId,
      is_pro: isPro,
      status: status,
      provider: "dodo",
      dodo_subscription_id: subscriptionId || null,
      updated_at: new Date().toISOString()
    };
    if (customerId) row.dodo_customer_id = customerId;
    await upsertSubscription(env, row);
  } catch (e) {
    console.error("dodo-webhook: supabase upsert failed:", e.message);
    return new Response("Database error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
