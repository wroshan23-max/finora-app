// functions/api/referral-signup.js  ->  POST /api/referral-signup
//
// Called once, right after a NEW Cloud Sync account is created, if the browser
// captured a "?ref=<referrer_user_id>" link earlier (see the referral-link capture
// in index.html). This only ever creates a "pending" attribution row — no reward
// is granted here. The actual reward (bonus Pro days for both the referrer and the
// new person) only happens later, in referral-check.js, once the new account shows
// real usage. That split is deliberate: attribution can happen instantly, but
// nothing of value is granted until someone has actually started using the app,
// which is what keeps this resistant to someone farming rewards with throwaway
// accounts.
//
// Required Cloudflare Pages environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { getUserFromToken, bearerToken, getReferralByReferee, insertReferral, json } from "../_utils/supabase.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Server isn't fully configured yet." }, 500);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await getUserFromToken(env, token);
  if (!user) return json({ error: "Session expired — please sign in again." }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid request body." }, 400); }
  const referrerUserId = (body && body.referrerUserId || "").trim();

  // All of these are "quietly do nothing" cases rather than hard errors — a
  // referral link is a nice-to-have, not something that should ever block or
  // confuse someone signing up (e.g. a stale/tampered ?ref= value shouldn't
  // surface a scary error to a brand new user).
  if (!UUID_RE.test(referrerUserId)) {
    return json({ ok: false, reason: "invalid_referrer" });
  }
  if (referrerUserId.toLowerCase() === user.id.toLowerCase()) {
    return json({ ok: false, reason: "self_referral" });
  }

  const existing = await getReferralByReferee(env, user.id);
  if (existing) {
    return json({ ok: false, reason: "already_attributed" });
  }

  try {
    await insertReferral(env, {
      referrer_user_id: referrerUserId,
      referee_user_id: user.id,
      referee_email: user.email || null,
      status: "pending",
      created_at: new Date().toISOString()
    });
  } catch (e) {
    // Referrer id doesn't actually exist, or some other insert failure — still
    // not worth surfacing to the new user. Log it server-side for the app owner
    // to notice in Cloudflare's function logs if it happens a lot.
    console.error("referral-signup: insert failed:", e.message);
    return json({ ok: false, reason: "insert_failed" });
  }

  return json({ ok: true });
}
