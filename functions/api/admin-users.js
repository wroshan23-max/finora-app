// functions/api/admin-users.js  ->  POST /api/admin-users
//
// Read-only admin user-directory support for Settings → Admin panel: lets an admin
// (see ADMIN_EMAILS) search registered accounts by email for the autocomplete dropdown
// on the Grant Pro form, see aggregate counts (registered / active / Pro), and view the
// full user list. This endpoint never grants or revokes anything — that's admin-pro.js.
// Same trust model: the caller must be signed in AND their own email must be in
// ADMIN_EMAILS, checked server-side on every request.
//
// Actions (all POST, JSON body):
//   { action: "stats" }           -> { totalUsers, activeUsers, proUsers }
//   { action: "search", query }   -> up to 15 users whose email contains query (case-insensitive)
//   { action: "list" }            -> up to 500 users, newest signup first
//
// "Active" = has synced app data (Cloud Sync) in the last 30 days. Finora works offline
// and doesn't require frequent sign-ins, so a recent Cloud Sync write is a much better
// signal of real, ongoing use than Supabase Auth's last_sign_in_at.
//
// Required Cloudflare Pages environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAILS

import { getUserFromToken, bearerToken, json } from "../_utils/supabase.js";

const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 20; // 20 x 1000 rows = up to 20,000 — a runaway guard, far beyond current scale

function isAdminEmail(env, email) {
  const list = (env.ADMIN_EMAILS || "").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return !!email && list.indexOf(email.toLowerCase()) !== -1;
}

// Paginates through Supabase Auth's admin list-users endpoint. Handles both response
// shapes Supabase has used across versions (bare array vs. { users: [...] }) — same
// defensive handling as getUserByEmail() in _utils/supabase.js.
async function listAllAuthUsers(env) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = env.SUPABASE_URL + "/auth/v1/admin/users?page=" + page + "&per_page=1000";
    const res = await fetch(url, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!res.ok) break;
    const body = await res.json().catch(function () { return null; });
    const list = Array.isArray(body) ? body : (body && body.users) || [];
    all.push.apply(all, list);
    if (list.length < 1000) break;
  }
  return all;
}

// Paginates through a PostgREST table (Range header) returning the chosen columns for
// every row. Used for the subscriptions and user_data tables — both currently small,
// this is future-proofing rather than something today's scale requires.
async function listAllRows(env, table, select) {
  const all = [];
  const pageSize = 1000;
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * pageSize, to = from + pageSize - 1;
    const url = env.SUPABASE_URL + "/rest/v1/" + table + "?select=" + encodeURIComponent(select);
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
        Range: from + "-" + to
      }
    });
    if (!res.ok && res.status !== 206) break;
    const rows = await res.json().catch(function () { return []; });
    all.push.apply(all, rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

// Pro = a real active grant (is_pro) OR an unexpired bonus/admin period grant —
// same rule hasBonusPro()/is_pro are combined with everywhere else in the app.
function isProSub(sub) {
  if (!sub) return false;
  if (sub.is_pro) return true;
  return !!(sub.bonus_pro_until && new Date(sub.bonus_pro_until).getTime() > Date.now());
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
    payload = {};
  }
  const action = payload && payload.action;

  let authUsers;
  try {
    authUsers = await listAllAuthUsers(env);
  } catch (e) {
    console.error("admin-users: listAllAuthUsers failed:", e.message);
    return json({ error: "Couldn't load the user list — try again." }, 500);
  }

  if (action === "search") {
    const query = ((payload && payload.query) || "").trim().toLowerCase();
    if (!query) return json({ ok: true, results: [] });
    const subs = await listAllRows(env, "subscriptions", "user_id,is_pro,bonus_pro_until").catch(function () { return []; });
    const subByUser = {};
    subs.forEach(function (s) { subByUser[s.user_id] = s; });
    const matches = authUsers
      .filter(function (u) { return u && u.email && u.email.toLowerCase().indexOf(query) !== -1; })
      .slice(0, 15)
      .map(function (u) { return { email: u.email, isPro: isProSub(subByUser[u.id]) }; });
    return json({ ok: true, results: matches });
  }

  if (action === "stats" || action === "list") {
    const results = await Promise.all([
      listAllRows(env, "subscriptions", "user_id,is_pro,bonus_pro_until").catch(function () { return []; }),
      listAllRows(env, "user_data", "user_id,updated_at").catch(function () { return []; })
    ]);
    const subs = results[0], dataRows = results[1];
    const subByUser = {};
    subs.forEach(function (s) { subByUser[s.user_id] = s; });
    const dataByUser = {};
    dataRows.forEach(function (d) { dataByUser[d.user_id] = d.updated_at; });
    const now = Date.now();

    if (action === "stats") {
      let activeCount = 0, proCount = 0;
      authUsers.forEach(function (u) {
        const lastSync = dataByUser[u.id];
        if (lastSync && (now - new Date(lastSync).getTime()) <= ACTIVE_WINDOW_MS) activeCount++;
        if (isProSub(subByUser[u.id])) proCount++;
      });
      return json({ ok: true, totalUsers: authUsers.length, activeUsers: activeCount, proUsers: proCount });
    }

    // action === "list"
    const list = authUsers
      .slice()
      .sort(function (a, b) { return (b.created_at || "").localeCompare(a.created_at || ""); })
      .slice(0, 500)
      .map(function (u) {
        const lastSync = dataByUser[u.id];
        return {
          email: u.email,
          createdAt: u.created_at || null,
          lastSignInAt: u.last_sign_in_at || null,
          isPro: isProSub(subByUser[u.id]),
          isActive: !!(lastSync && (now - new Date(lastSync).getTime()) <= ACTIVE_WINDOW_MS)
        };
      });
    return json({ ok: true, totalUsers: authUsers.length, users: list });
  }

  return json({ error: "Unknown action." }, 400);
}
