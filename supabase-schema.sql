-- Finora — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL Editor → New query).
-- Creates two tables: one holding each signed-in user's app data (Cloud Sync), and one
-- holding their Pro subscription status (only ever written by the payhere-notify /
-- payhere-cancel Netlify Functions using the service-role key — never by the browser).

create table if not exists public.user_data (
  user_id    uuid references auth.users(id) on delete cascade primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

-- A user can read only their own row.
create policy "Users can view their own data"
  on public.user_data for select
  using (auth.uid() = user_id);

-- A user can create only their own row.
create policy "Users can insert their own data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

-- A user can update only their own row.
create policy "Users can update their own data"
  on public.user_data for update
  using (auth.uid() = user_id);

-- (No delete policy — the app never deletes cloud rows. Users delete their account
-- from Supabase Auth directly if they ever want their data removed, which cascades
-- via the foreign key above.)


-- ================= Finora Pro subscriptions =================

create table if not exists public.subscriptions (
  user_id                 uuid references auth.users(id) on delete cascade primary key,
  is_pro                  boolean not null default false,
  status                  text,   -- e.g. "active", "cancelled"
  payhere_subscription_id text,
  updated_at              timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- A user can read their own subscription status (so the app can show it) —
-- but there is deliberately NO insert/update/delete policy for regular users here.
-- Only server-side code using the service-role key (which bypasses RLS entirely)
-- can write to this table. That's what makes the Pro flag trustworthy: nobody can
-- flip themselves to Pro by tampering with client-side requests.
create policy "Users can view their own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- Optional but recommended, same as above: turn off "Confirm email" under
-- Authentication → Providers → Email if you want people to use the app immediately
-- after creating an account.
