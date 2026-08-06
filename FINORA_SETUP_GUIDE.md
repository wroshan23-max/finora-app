# Finora — Full Setup Guide (Hosting, Cloud Sync, Google Drive, Pro Subscriptions, Ads)

This replaces the earlier drag-and-drop Netlify guide. The subscription and ads features need a small amount of server-side code (so your PayHere and database secrets never sit inside the page itself), which means the deploy method changes slightly — still no command line required, just one extra free account (GitHub).

Do the parts in order. Each part unlocks the next.

## Part 0 — What's in the folder

You should have a folder called `finora-site` containing:

- `index.html` — the app itself
- `privacy-policy.html`, `terms.html` — draft policy pages (fill in the highlighted placeholders before going live)
- `netlify.toml`, `package.json` — deployment config
- `netlify/functions/` — three small server-side functions (`payhere-start.js`, `payhere-notify.js`, `payhere-cancel.js`) that handle payments securely
- `supabase-schema.sql` — database setup script

## Part 1 — Put the whole folder on GitHub (no command line needed)

1. Go to **github.com** and create a free account if you don't have one.
2. Click the **+** in the top right → **New repository**. Name it e.g. `finora-app`. Keep it **Private** if you'd like (Netlify can still deploy from a private repo). Click **Create repository**.
3. On the new repo's page, click **uploading an existing file**.
4. Drag the **entire contents** of the `finora-site` folder in (all the files and the `netlify` folder together — you can drag the whole folder in most browsers, or select all files inside it). Scroll down and click **Commit changes**.

Your code is now on GitHub. You'll come back here later to update files (just click a file → the pencil/edit icon → save — no special tools needed).

## Part 2 — Deploy it on Netlify from GitHub

1. Go to **netlify.com** and sign in (or sign up) — using **"Sign up with GitHub"** is easiest since it connects the two automatically.
2. Click **Add new site → Import an existing project → Deploy with GitHub**.
3. Pick the `finora-app` repository you just created. Netlify will detect the `netlify.toml` automatically — leave the build settings as they are and click **Deploy**.
4. Wait a minute for the first deploy. You'll get a URL like `https://random-name-123.netlify.app`. You can rename it under **Site settings → Change site name**.

From now on, any time you edit a file on GitHub and save it, Netlify automatically redeploys within a minute or two — no manual redeploy step.

## Part 3 — Create your Supabase project (Cloud Sync + subscription database)

If you already did this in an earlier round, you can skip to step 4 and just re-run the SQL (it's safe to run again).

1. Go to **supabase.com** → **Start your project** → sign in.
2. **New project** → pick a name, database password (save it), region, and create. Wait ~2 minutes.
3. Open **SQL Editor → New query**, paste in the entire contents of `supabase-schema.sql`, and click **Run**. This creates both the `user_data` table (Cloud Sync) and the `subscriptions` table (Pro status) with the right access rules.
4. Go to **Project Settings → API**. You'll need three values from here:
   - **Project URL** (`https://xxxxx.supabase.co`)
   - **anon public** key (a long string starting `eyJ...`)
   - **service_role** key (a different long string — keep this one especially private, never put it in the app itself)

## Part 4 — Create your PayHere account (start in Sandbox / test mode)

Always get everything working in **sandbox mode** first — it's PayHere's test environment where no real money moves, using fake test cards.

1. Go to **payhere.lk** → **Sign Up** as a Merchant. Fill in your business/personal details.
2. Once your dashboard is up, look for **Sandbox** in the top menu — PayHere gives every account a matching sandbox environment automatically.
3. In the sandbox dashboard, go to **Settings → Domains & Credentials** (naming may vary slightly): note your **Merchant ID** and **Merchant Secret**.
4. Go to **Settings → API Keys** → create a new key with **"Automated Charging API"** permission. This gives you an **App ID** and **App Secret** (different from the Merchant ID/Secret above — this pair is only used for cancelling subscriptions).
5. Under **Settings → Domains**, add your Netlify URL from Part 2 (PayHere may require this before checkout will work from that domain).

You'll repeat steps 3-5 for the **live** account once you're ready to accept real payments — live credentials are separate from sandbox ones.

## Part 5 — Wire it all together with Netlify environment variables

In your Netlify site, go to **Site configuration → Environment variables** and add each of these (all as plain text values — Netlify keeps them private, they're never visible in the deployed page):

| Key | Value |
|---|---|
| `SUPABASE_URL` | your Supabase Project URL |
| `SUPABASE_ANON_KEY` | your Supabase anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service_role key |
| `PAYHERE_MERCHANT_ID` | from Part 4 step 3 (sandbox for now) |
| `PAYHERE_MERCHANT_SECRET` | from Part 4 step 3 (sandbox for now) |
| `PAYHERE_APP_ID` | from Part 4 step 4 |
| `PAYHERE_APP_SECRET` | from Part 4 step 4 |
| `PAYHERE_MODE` | `sandbox` (change to `live` later) |

After adding these, trigger a redeploy (**Deploys → Trigger deploy → Deploy site**) so the functions pick them up.

## Part 6 — Turn the features on in the app

Edit `index.html` on GitHub (click the file → pencil icon to edit → save, which redeploys automatically). Near the top of the `<script>` section, find the `CONFIG` block and fill in:

```js
var CONFIG = {
  SUPABASE_URL: "https://xxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",              // the anon key ONLY — never the service_role key here
  GOOGLE_CLIENT_ID: "...",                  // if you set up Google Drive Backup earlier
  BILLING_ENABLED: true,
  SUBSCRIPTION_PRICE_LKR: "990",            // just for display — see Part 7 to actually change the price
  ADSENSE_CLIENT_ID: "",                    // fill in once AdSense approves you (Part 8)
  ADSENSE_SLOT_ID: ""
};
```

Save, wait for Netlify to redeploy, then visit your site: sign up for an account, go to Settings, and click **Subscribe**. You'll land on PayHere's sandbox checkout — use one of [PayHere's published test cards](https://support.payhere.lk/api-&-mobile-sdk/testing) to simulate a real payment. Within a few seconds of paying, Finora should show you as a Pro subscriber. Try **Cancel Subscription** too, and confirm it goes back to Free.

If something doesn't work, check **Netlify → your site → Functions** for logs from `payhere-start`, `payhere-notify`, and `payhere-cancel` — errors are logged there.

## Part 7 — Set your real price

The price a customer is actually charged lives in `netlify/functions/payhere-start.js` (search for `PRICE_LKR`), not in the app itself — that keeps the amount tamper-proof (someone can't reopen the page and change what they're charged). Edit that line on GitHub to your real price, and update `CONFIG.SUBSCRIPTION_PRICE_LKR` in `index.html` to match so the button shows the right number.

## Part 8 — Go live with PayHere

Once sandbox testing works end-to-end:

1. In your PayHere merchant dashboard, request **Live** access if you haven't already (PayHere may review your account first).
2. Replace `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET`, `PAYHERE_APP_ID`, `PAYHERE_APP_SECRET` in Netlify's environment variables with your **live** credentials.
3. Change `PAYHERE_MODE` to `live`.
4. Redeploy.

## Part 9 — Apply for Google AdSense (optional, for free-tier ads)

1. Fill in the placeholders in `privacy-policy.html` and `terms.html` (your name/business, contact email, price) — AdSense reviews these.
2. Go to **google.com/adsense** → sign up, using your live Netlify site URL.
3. Google reviews the site before approving — this can take anywhere from a few days to a few weeks, and isn't guaranteed. There's nothing to configure on our side while you wait.
4. Once approved, go to **Ads → By ad unit → Create ad unit** (a Display ad, "Responsive" size works well). You'll get:
   - Your **Publisher ID** (`ca-pub-...`) — same for your whole account
   - An **ad unit / slot ID** (a number) for the specific unit you created
5. Put both into `CONFIG.ADSENSE_CLIENT_ID` and `CONFIG.ADSENSE_SLOT_ID` in `index.html`, save, redeploy. Ads will start showing to free (non-Pro) visitors automatically — Pro subscribers never see them.

## Part 10 — Google Drive Backup (if not already set up)

If you haven't done this part yet: go to **console.cloud.google.com**, create a project, set up the **OAuth consent screen** (External, add yourself as a test user — no need to submit for verification since the app only requests the narrow "files it created" permission), then **Credentials → Create Credentials → OAuth client ID → Web application**, adding your Netlify URL under **Authorized JavaScript origins**. Put the resulting Client ID into `CONFIG.GOOGLE_CLIENT_ID`.

---

A couple of honest notes to keep in mind, not as legal advice but as practical heads-ups: the free/Pro split in the app is enforced by checking your real subscription status stored in the database, but like any app that runs entirely in a browser, someone technically determined enough could still poke at the page's own code to see Pro-only screens locally — they just can't take money from anyone or affect your database by doing that, since the only thing that ever writes "is_pro = true" is the server-side webhook after PayHere confirms a real payment. And since this is now a real business collecting money and running ads, it's worth a quick look at the draft Privacy Policy and Terms with someone who knows Sri Lankan consumer-protection rules before you promote it widely.
