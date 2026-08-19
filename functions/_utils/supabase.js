/*
 * Minimal Supabase REST helpers for Cloudflare Pages Functions.
 * Deliberately avoids the @supabase/supabase-js SDK — plain fetch() calls against
 * Supabase's Auth and PostgREST HTTP APIs keep these Functions dependency-free and
 * guaranteed to run in the Workers runtime with no bundling surprises.
 */

/** Verifies a user's access token against Supabase Auth and returns the user object, or null. */
export async function getUserFromToken(env, token) {
  if (!token) return null;
  const res = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: {
      Authorization: "Bearer " + token,
      apikey: env.SUPABASE_ANON_KEY
    }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

/** Reads a Bearer token out of a Request's Authorization header. */
export function bearerToken(request) {
  const auth = request.headers.get("Authorization") || request.headers.get("authorization") || "";
  return auth.replace(/^Bearer\s+/i, "");
}

/** Looks up one user's row in public.subscriptions using the service-role key (bypasses RLS). */
export async function getSubscription(env, userId) {
  const url = env.SUPABASE_URL + "/rest/v1/subscriptions?user_id=eq." + encodeURIComponent(userId) + "&select=*";
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

/** Upserts (insert-or-update) one row in public.subscriptions using the service-role key. */
export async function upsertSubscription(env, row) {
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/subscriptions", {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const text = await res.text().catch(function () { return ""; });
    throw new Error("Supabase upsert failed (" + res.status + "): " + text);
  }
}

export function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

/** Reads one user's saved app data (the JSONB blob Cloud Sync stores) using the
 *  service-role key. Used by referral-check.js to tell whether a referred person
 *  has actually started using the app (>=1 account, >=1 transaction) before any
 *  reward is granted — never trusted from the client itself. */
export async function getUserData(env, userId) {
  const url = env.SUPABASE_URL + "/rest/v1/user_data?user_id=eq." + encodeURIComponent(userId) + "&select=data";
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0].data : null;
}

/** Looks up one referral row by referee (the person who was referred), using the
 *  service-role key (bypasses RLS — regular users can only ever read their own
 *  referrals, never write any). Pass a status to narrow (e.g. "pending"). */
export async function getReferralByReferee(env, refereeUserId, status) {
  var url = env.SUPABASE_URL + "/rest/v1/referrals?referee_user_id=eq." + encodeURIComponent(refereeUserId) + "&select=*&limit=1";
  if (status) url += "&status=eq." + encodeURIComponent(status);
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

/** Inserts a new referral row using the service-role key. */
export async function insertReferral(env, row) {
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/referrals", {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const text = await res.text().catch(function () { return ""; });
    throw new Error("Supabase referrals insert failed (" + res.status + "): " + text);
  }
}

/** Updates a referral row ONLY IF it's still in the expected current status —
 *  an atomic compare-and-swap via PostgREST's row filter, so two concurrent
 *  referral-check calls for the same row can't both apply the reward twice.
 *  Returns true if the update actually matched (and applied) a row. */
export async function updateReferralIfStatus(env, id, expectedStatus, patch) {
  const url = env.SUPABASE_URL + "/rest/v1/referrals?id=eq." + encodeURIComponent(id) + "&status=eq." + encodeURIComponent(expectedStatus);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) {
    const text = await res.text().catch(function () { return ""; });
    throw new Error("Supabase referrals update failed (" + res.status + "): " + text);
  }
  const rows = await res.json();
  return !!(rows && rows.length);
}
