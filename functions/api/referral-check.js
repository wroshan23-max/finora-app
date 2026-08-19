// functions/api/referral-check.js  ->  POST /api/referral-check
//
// Called opportunistically by the signed-in browser (at most once a day — see the
// throttle in index.html) to check "has this referral earned its reward yet?".
// There's no server cron here (this is a static site on Cloudflare Pages with no
// background process) so, same as runDueRecurringTemplates() in index.html, the
// check only ever runs when someone actually has the app open — that's an
// accepted tradeoff of this architecture, not a bug.
//
// A referral only qualifies once BOTH are true:
//   1. At least QUALIFY_MIN_AGE_DAYS have passed since signup (blocks instant farming)
//   2. The referred person has actually used the app — at least one account AND
//      one transaction saved in their Cloud Sync data (blocks empty throwaway accounts)
//
// Reward: REWARD_DAYS of bonus Finora Pro for BOTH the referrer and the referee,
// capped at ANNUAL_CAP_DAYS of bonus Pro per person per calendar year (UTC) so
// referrals can meaningfully reduce someone's bill but never fund permanent free
// Pro forever — see grantBonusDays() below.
//
// Required Cloudflare Pages environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import {
  getUserFromToken, bearerToken, json,
  getReferralByReferee, updateReferralIfStatus,
  getUserData, getSubscription, upsertSubscription
} from "../_utils/supabase.js";

const QUALIFY_MIN_AGE_DAYS = 3;
const REWARD_DAYS = 5;
const ANNUAL_CAP_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Extends one user's bonus_pro_until by up to `days`, respecting their remaining
// annual cap (resets automatically when the calendar year changes). Returns the
// number of days actually granted (0 if they'd already hit the cap this year).
async function grantBonusDays(env, userId, days) {
  const sub = await getSubscription(env, userId);
  const currentYear = new Date().getUTCFullYear();
  const sameYear = !!(sub && sub.bonus_year === currentYear);
  const usedThisYear = sameYear ? (sub.bonus_days_used_this_year || 0) : 0;
  const remainingCap = Math.max(0, ANNUAL_CAP_DAYS - usedThisYear);
  const grantDays = Math.min(days, remainingCap);
  if (grantDays <= 0) return 0;

  const currentUntil = sub && sub.bonus_pro_until ? new Date(sub.bonus_pro_until).getTime() : 0;
  const base = currentUntil > Date.now() ? currentUntil : Date.now();
  const newUntil = new Date(base + grantDays * DAY_MS).toISOString();

  await upsertSubscription(env, {
    user_id: userId,
    bonus_pro_until: newUntil,
    bonus_days_used_this_year: usedThisYear + grantDays,
    bonus_year: currentYear
  });
  return grantDays;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Server isn't fully configured yet." }, 500);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await getUserFromToken(env, token);
  if (!user) return json({ error: "Session expired — please sign in again." }, 401);

  const referral = await getReferralByReferee(env, user.id, "pending");
  if (!referral) return json({ ok: true, qualified: false, reason: "no_pending_referral" });

  const ageMs = Date.now() - new Date(referral.created_at).getTime();
  if (ageMs < QUALIFY_MIN_AGE_DAYS * DAY_MS) {
    return json({ ok: true, qualified: false, reason: "too_new" });
  }

  const data = await getUserData(env, user.id);
  const hasAccounts = !!(data && Array.isArray(data.accounts) && data.accounts.length > 0);
  const hasTransactions = !!(data && Array.isArray(data.transactions) && data.transactions.length > 0);
  if (!hasAccounts || !hasTransactions) {
    return json({ ok: true, qualified: false, reason: "not_enough_usage" });
  }

  // Atomic claim — if two requests race (e.g. two open tabs), only one of them
  // will see claimed === true and actually grant the reward.
  const claimed = await updateReferralIfStatus(env, referral.id, "pending", {
    status: "qualified",
    qualified_at: new Date().toISOString()
  });
  if (!claimed) return json({ ok: true, qualified: false, reason: "race_lost" });

  let referrerDays = 0, refereeDays = 0;
  try {
    referrerDays = await grantBonusDays(env, referral.referrer_user_id, REWARD_DAYS);
    refereeDays = await grantBonusDays(env, referral.referee_user_id, REWARD_DAYS);
  } catch (e) {
    console.error("referral-check: grant failed:", e.message);
  }

  await updateReferralIfStatus(env, referral.id, "qualified", {
    status: "rewarded",
    rewarded_at: new Date().toISOString(),
    referrer_days_granted: referrerDays,
    referee_days_granted: refereeDays
  }).catch(function (e) { console.error("referral-check: mark-rewarded failed:", e.message); });

  return json({ ok: true, qualified: true, referrerDaysGranted: referrerDays, refereeDaysGranted: refereeDays });
}
