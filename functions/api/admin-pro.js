// functions/api/admin-pro.js  ->  POST /api/admin-pro
//
// Lets a Finora admin (see ADMIN_EMAILS below) look up any user by email, grant them
// Finora Pro for a fixed period (week/month/year) or permanently ("lifetime"), or
// revoke a previously-granted period/lifetime grant — all without that user ever
// paying through PayHere or Dodo. This is the ONLY endpoint that can do this; it's
// still subject to the same trust model as the rest of billing (see supabase-schema.sql):
// the caller must be signed in AND their own email must be in ADMIN_EMAILS, checked
// server-side on every request — a client can't fake this by editing local state.
//
// Actions (all POST, JSON body):
//   { action: "lookup", email }                       -> current Pro status for that email
//   { action: "grant",  email, duration }              -> duration: "week" | "month" | "year" | "lifetime"
//   { action: "revoke", email }                        -> clears any admin/bonus grant (never
//                                                          touches a real PayHere/Dodo subscription)
//
// How a grant is represented (reuses existing subscriptions columns, no new billing path):
//   - week/month/year: extends bonus_pro_until (the same field referral rewards use —
//     hasBonusPro() in index.html already treats this as Pro regardless of is_pro/provider).
//     Stacks on top of any existing unexpired bonus rather than shortening it.
//   - lifetime: sets is_pro = true, status = "active", provider = "admin" permanently,
//     and clears bonus_pro_until (no longer needed once is_pro is permanently true).
//   - revoke: if the current grant came from this endpoint (provider === "admin"), turns
//     is_pro back off. Either way, always clears bonus_pro_until. A real paid subscription
//     (provider "payhere"/"dodo") is never touched by revoke — this only ever removes
//     admin- or referral-granted bonus access, never a real payment.
//
// Required Cloudflare Pages environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_EMAILS   — comma-separated list of emails allowed to call this endpoint

import { getUserFromToken, bearerToken, json, getSubscription, upsertSubscription, getUserByEmail } from "../_utils/supabase.js";

const VALID_DURATIONS = ["week", "month", "year"];

function isAdminEmail(env, email) {
  const list = (env.ADMIN_EMAILS || "").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return !!email && list.indexOf(email.toLowerCase()) !== -1;
}

// Adds a week/month/year to `fromDate`, calendar-accurate (handles month length,
// leap years) rather than a fixed day count.
function addDuration(fromDate, duration) {
  const d = new Date(fromDate.getTime());
  if (duration === "week") d.setUTCDate(d.getUTCDate() + 7);
  else if (duration === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (duration === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

function summarize(email, sub) {
  const now = Date.now();
  const bonusActive = !!(sub && sub.bonus_pro_until && new Date(sub.bonus_pro_until).getTime() > now);
  return {
    email: email,
    found: !!sub,
    isPro: !!(sub && (sub.is_pro || bonusActive)),
    is_pro: !!(sub && sub.is_pro),
    status: (sub && sub.status) || null,
    provider: (sub && sub.provider) || null,
    bonusProUntil: (sub && sub.bonus_pro_until) || null,
    bonusActive: bonusActive,
    adminNote: (sub && sub.admin_note) || null,
    adminGrantedAt: (sub && sub.admin_granted_at) || null
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Server isn't fully configured yet." }, 500);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Not signed in." }, 401);

  const caller = await getUserFromToken(env, token);
  if (!caller) return json({ error: "Session expired — please sign in again." }, 401);
  if (!isAdminEmail(env, caller.email)) return json({ error: "Not authorized." }, 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: "Invalid request body." }, 400);
  }

  const action = payload && payload.action;
  const targetEmail = payload && typeof payload.email === "string" ? payload.email.trim() : "";
  if (!targetEmail) return json({ error: "Missing target email." }, 400);

  const targetUser = await getUserByEmail(env, targetEmail);
  if (!targetUser) return json({ error: "No Finora account found with that email." }, 404);

  if (action === "lookup") {
    const sub = await getSubscription(env, targetUser.id);
    return json({ ok: true, result: summarize(targetEmail, sub) });
  }

  if (action === "grant") {
    const duration = payload && payload.duration;
    if (duration !== "lifetime" && VALID_DURATIONS.indexOf(duration) === -1) {
      return json({ error: "Invalid duration. Use week, month, year, or lifetime." }, 400);
    }

    const nowIso = new Date().toISOString();
    const adminNote = (duration === "lifetime" ? "Lifetime" : duration.charAt(0).toUpperCase() + duration.slice(1))
      + " Pro granted by " + caller.email + " on " + nowIso;

    let row;
    if (duration === "lifetime") {
      row = {
        user_id: targetUser.id,
        is_pro: true,
        status: "active",
        provider: "admin",
        bonus_pro_until: null,
        admin_note: adminNote,
        admin_granted_at: nowIso
      };
    } else {
      const existing = await getSubscription(env, targetUser.id);
      const currentUntil = existing && existing.bonus_pro_until ? new Date(existing.bonus_pro_until) : null;
      const base = currentUntil && currentUntil.getTime() > Date.now() ? currentUntil : new Date();
      const newUntil = addDuration(base, duration);
      row = {
        user_id: targetUser.id,
        bonus_pro_until: newUntil.toISOString(),
        admin_note: adminNote,
        admin_granted_at: nowIso
      };
    }

    try {
      await upsertSubscription(env, row);
    } catch (e) {
      console.error("admin-pro: grant upsert failed:", e.message);
      return json({ error: "Couldn't save the grant — try again." }, 500);
    }

    const sub = await getSubscription(env, targetUser.id);
    return json({ ok: true, result: summarize(targetEmail, sub) });
  }

  if (action === "revoke") {
    const existing = await getSubscription(env, targetUser.id);
    if (!existing) return json({ ok: true, result: summarize(targetEmail, null) });

    const nowIso = new Date().toISOString();
    const wasAdminLifetime = existing.provider === "admin";
    const row = {
      user_id: targetUser.id,
      bonus_pro_until: null,
      admin_note: (wasAdminLifetime ? "Lifetime grant" : "Bonus Pro") + " revoked by " + caller.email + " on " + nowIso,
      admin_granted_at: nowIso
    };
    if (wasAdminLifetime) {
      row.is_pro = false;
      row.status = "revoked";
      row.provider = null;
    }

    try {
      await upsertSubscription(env, row);
    } catch (e) {
      console.error("admin-pro: revoke upsert failed:", e.message);
      return json({ error: "Couldn't save the revoke — try again." }, 500);
    }

    const sub = await getSubscription(env, targetUser.id);
    return json({ ok: true, result: summarize(targetEmail, sub) });
  }

  return json({ error: "Unknown action." }, 400);
}
