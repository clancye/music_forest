-- ===========================================================================
-- Album of the Day — allow the 'choice' row kind (picks -> choices rename)
-- ===========================================================================
-- Run once on the Supabase project: Dashboard -> SQL Editor -> paste -> Run
-- (or `supabase db push`). Idempotent — a re-run is harmless.
--
-- Why: the picks -> choices vocabulary rename (sw v106) switched the client to
-- write journal rows with kind = 'choice', and store.py's KINDS tuple was updated
-- to match. But journal_rows' CHECK constraint (0001) still only allowed
-- ('note','pick','trail','mark'), so every choice write — and the client's
-- pick -> choice re-key migration (journal-store.js::_migrateChoiceKind) — was
-- rejected by Postgres. That surfaced as `POST /api/sync/rows 500` and, because
-- recordChoice() swallows the failure, as "my choice isn't in the Choices tab"
-- and a silent "Save note" button. 'pick' stays allowed so a migrating client can
-- still tombstone its old pick-kind rows after re-keying them. The kind set here
-- mirrors store.py KINDS = ('note','choice','trail','mark','pick').
-- ===========================================================================

alter table public.journal_rows
    drop constraint if exists journal_rows_kind_check;

alter table public.journal_rows
    add constraint journal_rows_kind_check
    check (kind in ('note', 'choice', 'trail', 'mark', 'pick'));
