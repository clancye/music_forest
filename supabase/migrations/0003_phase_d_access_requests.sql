-- ===========================================================================
-- Album of the Day — Phase D access requests (invite-gate "request access")
-- ===========================================================================
-- Run this once after 0001/0002 on the same Supabase project: Dashboard -> SQL
-- Editor -> paste -> Run. It is idempotent, so a re-run is harmless.
--
-- Context: the app is invite-only (sign-ups disabled in Auth). A logged-out
-- guest who's sold but uninvited needs a way to ASK rather than hit a wall
-- (onboarding plan, locked decision 8). The Flask route POST /api/access-request
-- records the ask here, server-side, over the trusted DB-role connection (the
-- same one store.py uses for journal_rows) — so the public anon Supabase key
-- never gets an open write policy, and the route is rate-limited.
--
-- What this creates:
--   * access_requests — one row per email (repeat asks collapse), holding the
--     optional note, the submitting user-agent, and a review status the operator
--     flips by hand (new -> invited | declined).
--
-- The operator reviews these and invites people manually, staying the sole
-- gatekeeper. RLS is ON with NO anon/authenticated policies (same shape as
-- app_admins): ordinary callers get nothing over the PostgREST/anon API. Two
-- ways to read them: the SQL editor (privileged role, bypasses RLS), or — for
-- the logged-in operator via PostgREST — the optional admin read policy below.
--
-- This migration stands alone: it does NOT require 0002. The server writes with
-- the DB role and you read via the SQL editor, both of which bypass RLS, so the
-- table is fully functional without any policy. The admin read policy is a
-- nicety for a future logged-in /admin view; it reuses 0002's is_app_admin()
-- helper and is therefore added only if that helper already exists (run 0002 to
-- get it). Either order is fine — re-run this after 0002 to pick the policy up.
-- ===========================================================================

create table if not exists public.access_requests (
    email       text        primary key,        -- one row per email
    note        text,                            -- optional "why" from the guest
    user_agent  text,                            -- best-effort submitting client
    status      text        not null default 'new'
                            check (status in ('new', 'invited', 'declined')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists idx_access_requests_created
    on public.access_requests (created_at);

-- RLS on, no anon/authenticated insert/select policies: the Flask server writes
-- with the DB role (not subject to RLS), and no one reaches this table over the
-- anon/PostgREST API. The operator reads via the SQL editor or the admin policy.
alter table public.access_requests enable row level security;

-- The logged-in operator may read every request over PostgREST (e.g. a future
-- /admin view), mirroring 0002's "feedback: admin reads all". This reuses the
-- SECURITY DEFINER is_app_admin() helper from 0002, so it's added ONLY when that
-- helper exists — otherwise this migration would fail on a project that hasn't
-- run 0002 yet (CREATE POLICY resolves the function at creation time). Without
-- it, the table still works: server writes (DB role) and SQL-editor reads both
-- bypass RLS. Run 0002, then re-run this file, to enable operator PostgREST reads.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_app_admin'
  ) then
    drop policy if exists "access_requests: admin reads all" on public.access_requests;
    create policy "access_requests: admin reads all" on public.access_requests
        for select using (public.is_app_admin());
  else
    raise notice 'is_app_admin() not found (run migration 0002); skipping the admin read policy. The access_requests table is fully functional without it.';
  end if;
end $$;
