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


-- ================= Shared Household Access (Finora Pro feature) =================
-- Lets a Pro subscriber ("owner") invite other people ("members") by email to get
-- full view + edit access to the owner's household data. A member doesn't need
-- their own Pro subscription — they're working inside the owner's Pro household.
-- Membership only ever becomes "active" through the claim_shared_invite() function
-- below, which checks the invite's email against the actual signed-in user — so
-- nobody can grant themselves access by guessing a row's contents.

-- owner_email is denormalized (copied in by the owner when they create the invite,
-- from their own signed-in session — never trusted for security) purely so the
-- invitee's browser can show "X invited you" without needing admin access to look up
-- another user's email from their id. It plays no part in any RLS check below.
create table if not exists public.shared_access (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid references auth.users(id) on delete cascade not null,
  owner_email    text not null,
  member_email   text not null,
  member_user_id uuid references auth.users(id) on delete cascade,
  status         text not null default 'pending',   -- 'pending' | 'active' | 'revoked'
  created_at     timestamptz not null default now(),
  unique (owner_user_id, member_email)
);

create index if not exists shared_access_member_email_idx on public.shared_access (lower(member_email));

alter table public.shared_access enable row level security;

-- Owners manage their own invite list — but can only CREATE a new invite while
-- their own subscription is active (Pro-gated at the database level, not just in
-- the app's UI).
create policy "Owners can view their own invites"
  on public.shared_access for select
  using (auth.uid() = owner_user_id);

create policy "Pro owners can create invites"
  on public.shared_access for insert
  with check (
    auth.uid() = owner_user_id
    and exists (
      select 1 from public.subscriptions s
      where s.user_id = auth.uid() and s.is_pro = true
    )
  );

create policy "Owners can revoke/update their invites"
  on public.shared_access for update
  using (auth.uid() = owner_user_id);

create policy "Owners can delete their invites"
  on public.shared_access for delete
  using (auth.uid() = owner_user_id);

-- Invitees can see (only) pending invites addressed to their own signed-in email —
-- this is how the app shows "X invited you" before they've accepted anything.
create policy "Invitees can view invites addressed to them"
  on public.shared_access for select
  using (lower(member_email) = lower(coalesce(auth.jwt() ->> 'email', '__none__')));

-- Accepting an invite goes through this function rather than a raw UPDATE, so the
-- email match is enforced server-side in one place instead of relying on RLS policy
-- combination rules for UPDATE (which get subtle once more than one policy could
-- apply to the same row).
create or replace function public.claim_shared_invite(invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  my_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  matched boolean;
begin
  update public.shared_access
    set member_user_id = auth.uid(), status = 'active'
    where id = invite_id
      and status = 'pending'
      and member_user_id is null
      and lower(member_email) = my_email
      and my_email <> '';
  get diagnostics matched = row_count;
  return matched > 0;
end;
$$;

-- Now extend user_data so an active member can view AND edit the household they've
-- been added to, on top of the existing "own row" policies further up this file.
create policy "Members can view shared household data"
  on public.user_data for select
  using (
    exists (
      select 1 from public.shared_access sa
      where sa.owner_user_id = user_data.user_id
        and sa.member_user_id = auth.uid()
        and sa.status = 'active'
    )
  );

create policy "Members can update shared household data"
  on public.user_data for update
  using (
    exists (
      select 1 from public.shared_access sa
      where sa.owner_user_id = user_data.user_id
        and sa.member_user_id = auth.uid()
        and sa.status = 'active'
    )
  );

-- And let a member see the owner's Pro status too, so the app knows to unlock
-- Pro-gated features (like editing entries) while working inside that household.
create policy "Members can view the household owner's subscription"
  on public.subscriptions for select
  using (
    exists (
      select 1 from public.shared_access sa
      where sa.owner_user_id = subscriptions.user_id
        and sa.member_user_id = auth.uid()
        and sa.status = 'active'
    )
  );
