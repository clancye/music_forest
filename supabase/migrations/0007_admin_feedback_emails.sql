-- ===========================================================================
-- Music Forest — operator reads submitter emails on the feedback admin page
-- ===========================================================================
-- Run once after 0002 on the same Supabase project (Dashboard -> SQL Editor ->
-- paste -> Run). Idempotent — a re-run is harmless. Apply to BOTH the staging
-- and prod Supabase projects.
--
-- Context: the /admin feedback list showed each submission's user_id (a UUID) but
-- not who that is. The email lives in auth.users, which PostgREST does NOT expose
-- to the anon/authenticated API. This adds an admin-gated SECURITY DEFINER
-- function that returns user_id -> email for feedback submitters, so /admin can
-- label each card with the person's email. Non-admins get nothing: the function
-- returns no rows unless is_app_admin() (from 0002) is true for the caller.
--
-- Privacy: email is the one personal detail held in the clear (BRAND.md), and
-- feedback is deliberately not E2EE (BETA_PLAN.md §1) with only operators able to
-- read it — so surfacing a submitter's email to an operator matches the model.
-- ===========================================================================

create or replace function public.admin_feedback_emails()
    returns table (user_id uuid, email text)
    language sql
    stable
    security definer
    set search_path = public
as $$
    -- SECURITY DEFINER lets this read auth.users; the where-clause re-gates to the
    -- operator allow-list (is_app_admin() checks auth.uid()), so a non-admin caller
    -- gets zero rows. DISTINCT: one (uid, email) per submitter, not per submission.
    select distinct f.user_id, u.email::text
    from public.feedback f
    join auth.users u on u.id = f.user_id
    where public.is_app_admin();
$$;

-- Only logged-in callers may invoke it; and it hands back rows only to admins
-- (the gate above). Remove the default PUBLIC execute, then grant to authenticated.
revoke all on function public.admin_feedback_emails() from public;
grant execute on function public.admin_feedback_emails() to authenticated;
