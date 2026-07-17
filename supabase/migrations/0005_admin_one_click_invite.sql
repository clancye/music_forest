-- ===========================================================================
-- Album of the Day — one-click Approve & invite / Decline from /admin
-- ===========================================================================
-- Run once after 0001–0004: Dashboard -> SQL Editor -> paste -> Run. Idempotent;
-- a re-run is harmless. Requires is_app_admin() from 0002 (the policies below
-- are skipped with a NOTICE if it's missing — run 0002, then re-run this).
--
-- ---------------------------------------------------------------------------
-- What this changes (a deliberate posture change — owner-approved 2026-07-02)
-- ---------------------------------------------------------------------------
-- 0004 §5 kept approving/declining a privileged SQL-editor action and gave the
-- PostgREST API ZERO write path to the invite gate ("this page never gains a
-- write path to the gate"). That made the *mechanics* of approving as guarded
-- as the *decision*. In practice the copy-SQL hop is pure friction: the
-- decision is still the operator's either way, and /admin already trusts
-- is_app_admin() for reading everyone's feedback (0002) and access requests
-- (0003).
--
-- This migration opens exactly two narrow, admin-gated writes so the /admin
-- page can do the same two statements with one click:
--
--   * INSERT into invited_emails            — gated WITH CHECK is_app_admin()
--   * UPDATE access_requests status         — gated USING/WITH CHECK is_app_admin()
--
-- What does NOT change: anon has no access of any kind; a signed-in NON-admin
-- hits the policy wall (42501); the allow-list stays unreadable over PostgREST
-- (no select grant — the page writes blind: plain INSERT, duplicate = already
-- invited; see §1); the auth hook (0004) remains the actual enforcement at
-- sign-up time.
--
-- Threat-model note, stated honestly: after this, a compromised OPERATOR
-- session can invite an attacker's email with one click (before, it could
-- read all feedback but not touch the gate without the Supabase dashboard).
-- The operator's own account security is the perimeter — same as the
-- dashboard itself.
--
-- ---------------------------------------------------------------------------
-- Revert (restores the 0004 posture; the /admin page then falls back to its
-- copy-the-SQL flow automatically on the 42501):
--
--     drop policy if exists "invited_emails: admin invites" on public.invited_emails;
--     drop policy if exists "access_requests: admin updates status" on public.access_requests;
--     revoke insert on table public.invited_emails from authenticated;
--     revoke update (status, updated_at) on table public.access_requests from authenticated;
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Grants — the narrowest that work
-- ---------------------------------------------------------------------------
-- invited_emails: 0004 revoked ALL from anon/authenticated/public. Re-grant
-- INSERT only, to authenticated only (RLS does the admin gating). No SELECT of
-- any kind: the page never reads the allow-list. Client contract (learned the
-- hard way in live QA, 2026-07-02): the page must use a PLAIN insert and treat
-- 23505 duplicate-key as "already invited" — INSERT ... ON CONFLICT DO NOTHING
-- is NOT equivalent under RLS (the arbiter check consults SELECT policies and
-- needs SELECT on the conflict-target column, both deliberately absent here;
-- plain INSERT passed while the upsert form 42501'd, proved by rolled-back
-- simulation as the operator's own role).
grant insert on table public.invited_emails to authenticated;

-- access_requests: SELECT already flows through the 0003 admin-read policy
-- (Supabase default privileges supply the SQL-level grant). Add a
-- column-limited UPDATE grant so the page can flip status; RLS gates who.
grant update (status, updated_at) on table public.access_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The two admin-gated policies (skipped with a NOTICE if 0002 isn't in)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_app_admin'
  ) then
    drop policy if exists "invited_emails: admin invites" on public.invited_emails;
    create policy "invited_emails: admin invites" on public.invited_emails
        for insert to authenticated
        with check (public.is_app_admin());

    drop policy if exists "access_requests: admin updates status" on public.access_requests;
    create policy "access_requests: admin updates status" on public.access_requests
        for update to authenticated
        using (public.is_app_admin())
        with check (public.is_app_admin());
  else
    raise notice 'is_app_admin() not found (run migration 0002 first, then re-run this file). Without the policies the grants above open nothing — RLS still denies every API write.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. QA after running (manual — hooks/policies aren't reachable by the suite)
-- ---------------------------------------------------------------------------
--   1. Reload /admin as the operator. Each "new" access request now shows
--      "✓ Approve & invite" / "Decline" buttons.
--   2. Approve a throwaway address you control: the row flips to "invited",
--      a "✉ Tell <email>" mail link appears, and
--        select * from public.invited_emails where email = '<it>';
--      shows the allow-list row.
--   3. That address can now create an account (the 0004 hook admits it);
--      an unrelated address still cannot.
--   4. Decline another test request: status flips to "declined"; no
--      invited_emails row appears.
--   5. (Posture check) In an incognito window, sign in as a NON-admin user,
--      open /admin, and confirm the request list doesn't load and any write
--      attempt fails (42501) — the page shows its copy-SQL fallback message.
-- ===========================================================================
