-- ===========================================================================
-- Music Forest — journal_rows.created_at (Usage tab's notebook-over-time chart)
-- ===========================================================================
-- Run once after 0001 on the same Supabase project (Dashboard -> SQL Editor ->
-- paste -> Run). Idempotent — a re-run is harmless. Apply to BOTH the staging
-- and prod Supabase projects (staging first — vet the panel there).
--
-- Context: the /admin Usage tab now draws new notebook entries per day (owner
-- ask 2026-07-19). journal_rows only carried updated_at, so an edited note
-- would migrate to the day of its last edit. This adds created_at:
--   * existing rows are backfilled from updated_at — best available truth; rows
--     from before this migration are dated by their last edit, and the panel's
--     hint says so rather than hiding it;
--   * new rows default to now() at insert, and the sync upsert's ON CONFLICT
--     UPDATE never touches created_at, so an edit keeps the original day.
--
-- Privacy: metadata only. Nothing here reads or changes ciphertext; the chart
-- this feeds is counts of encrypted rows by kind and day, never content. The
-- real write moment lives inside the E2EE payload and stays unreadable — this
-- column is server-arrival time.
-- ===========================================================================

alter table public.journal_rows
    add column if not exists created_at timestamptz;

update public.journal_rows set created_at = updated_at where created_at is null;

alter table public.journal_rows alter column created_at set default now();
alter table public.journal_rows alter column created_at set not null;
