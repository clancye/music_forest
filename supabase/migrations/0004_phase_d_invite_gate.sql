-- ===========================================================================
-- Album of the Day — Phase D invite-gate ENFORCEMENT (Priority 0 security fix)
-- ===========================================================================
-- Run this once after 0001/0002/0003 on the same Supabase project: Dashboard ->
-- SQL Editor -> paste -> Run. It is idempotent, so a re-run is harmless. Then
-- REGISTER THE HOOK in the Dashboard (step 6 below) — the SQL alone does nothing
-- until the hook is wired up.
--
-- ---------------------------------------------------------------------------
-- Why this exists
-- ---------------------------------------------------------------------------
-- 0003 shipped the "request access" *ask*, but nothing actually BLOCKED account
-- creation: an uninvited person could click "Continue with Google" and land a
-- fully working account (found in QA). "Invite-only" was assumed to be enforced
-- at the Supabase Auth layer ("disable public sign-ups in the Dashboard"), but
-- that toggle does not reliably cover OAuth providers.
--
-- This migration makes invite-only REAL for *every* provider (email, magic link,
-- Google, GitHub) via a Before User Created auth hook + an allow-list:
--
--   * invited_emails           — the allow-list. One row per invited email.
--   * before_user_created_hook(event jsonb) -> jsonb — runs PRE-creation; rejects
--     any signup whose email is not in invited_emails (rejects by default).
--
-- The operator stays the sole gatekeeper: review a row in `access_requests`
-- (0003) -> add the email to `invited_emails` -> that person can now sign in.
--
-- ---------------------------------------------------------------------------
-- IMPORTANT — scope & limits
-- ---------------------------------------------------------------------------
--   * The hook only gates NEW account creation. EXISTING accounts are untouched
--     — including any uninvited account created before this shipped. Remove those
--     by hand (deleting the auth.users row cascades per the operator notes).
--   * The allow-list is seeded with the OPERATOR EMAIL below so you can't lock
--     yourself out. ===> EDIT THIS if your sign-in email is not the one shown. <===
--   * Hooks run server-side in Supabase Auth and cannot be exercised by the
--     headless test suite — see SMOKE_TEST_PHASE_D_INVITE_GATE.md for the manual
--     provider sign-up QA pass that must be done after registering the hook.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The allow-list
-- ---------------------------------------------------------------------------
-- Keyed by email (lowercased) — NOT by auth.users.id, because the whole point is
-- to invite people who do not have an account yet. No FK to auth.users.
create table if not exists public.invited_emails (
    email       text        primary key,        -- store lowercased (see hook)
    note        text,                            -- optional: who/why
    invited_by  text,                            -- optional operator marker
    created_at  timestamptz not null default now()
);

-- RLS on. The anon/authenticated PostgREST API gets NO policy here, so the
-- allow-list is never readable or writable by ordinary callers. The operator
-- manages rows from the SQL editor (privileged role, bypasses RLS). The auth
-- hook reads it through the dedicated supabase_auth_admin policy added in §3.
alter table public.invited_emails enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Seed the operator so the gate can't lock you out
-- ---------------------------------------------------------------------------
-- This MUST be an email you can actually sign in with. The app uses Google
-- OAuth; this is the operator's Google address. Change it if yours differs.
-- (operator@example.com is the primary operator sign-in; operator@example.com
-- is a throwaway test account and is intentionally NOT seeded so it can serve as
-- the "uninvited, must be rejected" case in SMOKE_TEST_PHASE_D_INVITE_GATE.md §2.)
insert into public.invited_emails (email, note, invited_by)
values ('operator@example.com', 'operator (seed — do not remove)', 'migration 0004')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Let the auth hook (and only the auth hook) read the allow-list
-- ---------------------------------------------------------------------------
-- Supabase runs auth hooks as the `supabase_auth_admin` role. With RLS on, that
-- role needs an explicit grant + a SELECT policy to read invited_emails; this is
-- the canonical Supabase pattern for a hook that reads a custom table. We keep
-- the table closed to anon/authenticated/public.
grant usage on schema public to supabase_auth_admin;
grant select on table public.invited_emails to supabase_auth_admin;
revoke all on table public.invited_emails from anon, authenticated, public;

drop policy if exists "invited_emails: auth admin reads" on public.invited_emails;
create policy "invited_emails: auth admin reads"
    on public.invited_emails
    for select
    to supabase_auth_admin
    using (true);

-- ---------------------------------------------------------------------------
-- 4. The Before User Created hook
-- ---------------------------------------------------------------------------
-- Contract (Supabase Before User Created Hook): takes a single jsonb `event`,
-- returns jsonb. The candidate email is at event->'user'->>'email'. To REJECT,
-- return {"error": {"message": ..., "http_code": ...}}. To ALLOW, return '{}'.
--
-- SECURITY INVOKER (the default — NO `security definer`): Supabase explicitly
-- recommends against security definer for hooks. The function reaches
-- invited_emails through the supabase_auth_admin grant + policy from §3 instead.
--
-- Fails CLOSED: a null/blank email, or any email not on the allow-list, is
-- rejected. The message is user-facing (it surfaces in the OAuth error redirect,
-- which the client turns into the "not invited yet" screen), so keep it friendly.
create or replace function public.before_user_created_hook(event jsonb)
    returns jsonb
    language plpgsql
as $$
declare
    v_email text;
begin
    v_email := lower(trim(event -> 'user' ->> 'email'));

    if v_email is null or v_email = '' then
        return jsonb_build_object(
            'error', jsonb_build_object(
                'http_code', 403,
                'message', 'Music Forest is invite-only. Please request access with an email.'
            )
        );
    end if;

    if exists (select 1 from public.invited_emails where email = v_email) then
        return '{}'::jsonb;            -- invited -> allow creation
    end if;

    return jsonb_build_object(
        'error', jsonb_build_object(
            'http_code', 403,
            'message', 'This email isn''t invited to Music Forest yet. Request access and we''ll be in touch.'
        )
    );
end;
$$;

-- The hook is executed by supabase_auth_admin; no one else may call it.
grant execute on function public.before_user_created_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.before_user_created_hook(jsonb) from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 5. (Optional) operator helper — approve a request in one step
-- ---------------------------------------------------------------------------
-- The workflow stays manual (you decide who gets in), but this snippet does the
-- two writes together: add the email to the allow-list AND mark its access_request
-- 'invited'. Copy it into the SQL editor and set the email. Safe to run even if
-- the person never filed a request (the UPDATE simply matches no rows).
--
--     with approved as (
--         insert into public.invited_emails (email, note, invited_by)
--         values (lower(trim('SOMEONE@example.com')), 'approved from access_requests', 'operator')
--         on conflict (email) do nothing
--         returning email
--     )
--     update public.access_requests
--        set status = 'invited', updated_at = now()
--      where email = lower(trim('SOMEONE@example.com'));
--
-- To revoke a not-yet-signed-up invite, just: delete from public.invited_emails
-- where email = lower(trim('SOMEONE@example.com'));  (revoking does NOT remove an
-- account that already signed up — delete the auth.users row for that.)

-- ---------------------------------------------------------------------------
-- 6. REGISTER THE HOOK (manual, required — the SQL above is inert until you do)
-- ---------------------------------------------------------------------------
-- Dashboard -> Authentication -> Hooks (Beta) -> "Before User Created":
--   1. Choose "Postgres" as the hook type.
--   2. Select schema `public`, function `before_user_created_hook`.
--   3. Enable the hook and save.
-- Then run the manual QA in SMOKE_TEST_PHASE_D_INVITE_GATE.md:
--   - an UNINVITED Google sign-in is rejected (and the app shows the
--     "not invited yet" screen),
--   - the seeded OPERATOR email can still sign in,
--   - after adding a test email to invited_emails, that address can sign in.
-- Belt-and-suspenders: also set Dashboard -> Authentication -> "Allow new users
-- to sign up" -> off. The hook is the real enforcement; this is a second layer.
-- ===========================================================================
