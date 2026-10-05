-- ===========================================================================
-- Music Forest — allow the 'opened' row kind (Keep retired, v329)
-- ===========================================================================
-- Run once on EACH Supabase project (staging AND prod): Dashboard -> SQL Editor
-- -> paste -> Run (or `supabase db push`). Idempotent — a re-run is harmless.
--
-- Run it BEFORE the v329 client deploys. A Listen tap now writes an encrypted
-- journal row with kind = 'opened', and store.py's KINDS accepts it — but until
-- this runs, journal_rows' CHECK constraint (last set in 0006) rejects the write,
-- which surfaces as `POST /api/sync/rows 500` (exactly the 0006 incident). Running
-- it early is safe: nothing writes 'opened' until the new client ships.
--
-- The kind set here mirrors store.py KINDS =
-- ('note','choice','trail','mark','pick','opened').
-- ===========================================================================

alter table public.journal_rows
    drop constraint if exists journal_rows_kind_check;

alter table public.journal_rows
    add constraint journal_rows_kind_check
    check (kind in ('note', 'choice', 'trail', 'mark', 'pick', 'opened'));
