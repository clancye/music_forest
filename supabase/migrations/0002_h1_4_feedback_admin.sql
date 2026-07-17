-- ===========================================================================
-- Album of the Day — H1.4 feedback operator-read access
-- ===========================================================================
-- Run this once after 0001 on the same Supabase project: Dashboard -> SQL
-- Editor -> paste -> Run. It is idempotent, so a re-run is harmless.
--
-- Context: in H1.4 feedback moves off the Render disk into the readable
-- `public.feedback` table + the private `feedback` Storage bucket that 0001
-- created (BETA_PLAN.md §1). The browser, logged in via its Supabase session,
-- writes its own feedback directly: 0001's "insert own" / "upload own" RLS
-- already permits that. What's missing is a way for YOU (the operator) to read
-- *everyone's* feedback so you can triage bugs.
--
-- This migration adds that the keyless, RLS-native way — no service-role secret
-- on the app server:
--   * app_admins   — a tiny allow-list of operator UUIDs.
--   * is_app_admin() — a SECURITY DEFINER helper so a policy can check
--     membership without itself being blocked by RLS on app_admins.
--   * read-all policies on public.feedback and the feedback Storage bucket,
--     gated on is_app_admin(). RLS ORs policies for the same command, so these
--     sit alongside 0001's "read own" — admins read all, users still read their
--     own, nobody else reads anything.
--
-- AFTER running this, register yourself (find your UUID in Dashboard ->
-- Authentication -> Users, or via `select auth.uid()` while logged in):
--
--     insert into public.app_admins (user_id, note)
--     values ('<your-user-uuid>', 'operator')
--     on conflict (user_id) do nothing;
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Operator allow-list
-- ---------------------------------------------------------------------------
create table if not exists public.app_admins (
    user_id     uuid        primary key references auth.users (id) on delete cascade,
    note        text,
    created_at  timestamptz not null default now()
);

-- RLS on, with NO policies: ordinary anon/authenticated callers get no access to
-- the allow-list over the PostgREST/anon API. You manage rows from the SQL
-- editor, which runs as a privileged role that bypasses RLS.
alter table public.app_admins enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Admin-check helper (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
-- Runs as the function owner, so its read of app_admins is NOT subject to the
-- RLS we just enabled — otherwise the membership check inside a policy would see
-- zero rows for a normal authenticated user and never match. `stable` +
-- pinned search_path are the standard Supabase hardening for such helpers.
create or replace function public.is_app_admin()
    returns boolean
    language sql
    stable
    security definer
    set search_path = public
as $$
    select exists (
        select 1 from public.app_admins where user_id = auth.uid()
    );
$$;

grant execute on function public.is_app_admin() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Operator reads ALL feedback rows
-- ---------------------------------------------------------------------------
drop policy if exists "feedback: admin reads all" on public.feedback;
create policy "feedback: admin reads all" on public.feedback
    for select using (public.is_app_admin());

-- ---------------------------------------------------------------------------
-- 4. Operator reads ALL feedback blobs (screenshot.png / view.html)
-- ---------------------------------------------------------------------------
drop policy if exists "feedback bucket: admin reads all" on storage.objects;
create policy "feedback bucket: admin reads all" on storage.objects
    for select using (
        bucket_id = 'feedback' and public.is_app_admin()
    );
