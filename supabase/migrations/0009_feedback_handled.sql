-- ===========================================================================
-- Music Forest — operator marks a feedback report handled
-- ===========================================================================
-- Run once after 0002 on the same Supabase project (Dashboard -> SQL Editor ->
-- paste -> Run). Idempotent — a re-run is harmless. Apply to BOTH the staging
-- and prod Supabase projects.
--
-- Context: the operator console's Feedback tab can select reports into a
-- download bundle, but had no way to retire one. "Done" was the retired /admin
-- page's third triage state, and there it lived in localStorage — per-browser,
-- so the same reports came back on another device and the marks had to be
-- re-done. This makes the mark durable and shared: one nullable timestamp on
-- the row, written by an operator.
--
-- Done is a MARK, not a delete. The row and its blobs stay exactly as they were
-- (the 180-day retention sweep still owns deletion); handled_at only decides
-- which side of the Open/Done filter a report sits on, and clearing it puts the
-- report back. handled_by records which operator did it — there is one today,
-- but a second one shouldn't be a mystery later.
--
-- Privacy note: this writes no new personal data. handled_by is an operator's
-- own uuid, already known to the system.
-- ===========================================================================

alter table public.feedback add column if not exists handled_at timestamptz;
alter table public.feedback add column if not exists handled_by uuid references auth.users (id) on delete set null;

-- The Open view reads `handled_at is null` ordered by created_at, so index the
-- open ones only — the partial index stays small as Done accumulates.
create index if not exists idx_feedback_open
    on public.feedback (created_at desc) where handled_at is null;

-- ---------------------------------------------------------------------------
-- Operator updates ANY feedback row
-- ---------------------------------------------------------------------------
-- 0001 gave ordinary users insert-own + read-own and NO update policy at all, so
-- a reader still cannot edit a report — theirs or anyone's. This grants update
-- only to the 0002 allow-list. USING gates which rows an operator may touch (all
-- of them); WITH CHECK gates what the row may become — re-asserting is_app_admin()
-- so an operator cannot hand a row to a non-admin identity.
drop policy if exists "feedback: admin updates all" on public.feedback;
create policy "feedback: admin updates all" on public.feedback
    for update using (public.is_app_admin()) with check (public.is_app_admin());

-- ---------------------------------------------------------------------------
-- Counts for the Open / Done filter chips
-- ---------------------------------------------------------------------------
-- The console needs both totals to label its filter chips, and PostgREST would
-- charge two head-count round-trips per redraw for it. One admin-gated call
-- instead; a non-admin caller gets zeros, not an error, so the UI degrades to a
-- chip with no number rather than a failure.
create or replace function public.admin_feedback_counts()
    returns table (open_count bigint, done_count bigint)
    language sql
    stable
    security definer
    set search_path = public
as $$
    select
        count(*) filter (where f.handled_at is null),
        count(*) filter (where f.handled_at is not null)
    from public.feedback f
    where public.is_app_admin();
$$;

-- Same shape as 0007: drop the default PUBLIC execute, then grant to logged-in
-- callers only — the is_app_admin() gate above is what actually returns rows.
revoke all on function public.admin_feedback_counts() from public;
grant execute on function public.admin_feedback_counts() to authenticated;
