-- ===========================================================================
-- Album of the Day — H1.1 crypto + sync core
-- ===========================================================================
-- Run this once on a fresh Supabase project: Dashboard -> SQL Editor -> paste
-- -> Run (or `supabase db push` if you use the CLI). It is idempotent, so a
-- re-run is harmless.
--
-- What it creates:
--   * journal_rows — end-to-end-encrypted per-user rows (opaque ciphertext;
--     the server can never read them). One generic table keyed by user + kind +
--     a client-generated id, because the contents are opaque so per-type tables
--     would buy nothing (BETA_PLAN.md §3–4).
--   * user_keys    — each user's wrapped data-encryption keys (the passphrase
--     copy and the mandatory recovery-code copy). Also opaque to the server: it
--     holds neither secret and no master key.
--   * feedback     — the deliberately READABLE, consensual bug-report store
--     (BETA_PLAN.md §1), plus a private Storage bucket for screenshot/view blobs.
--
-- Row-Level Security is enabled on every table with `user_id = auth.uid()`
-- policies. The Flask sync layer connects with the Postgres DB role and enforces
-- user scoping itself; RLS is the backstop for any access over the PostgREST/
-- anon API. NOTE: this migration does not touch Auth settings — you still
-- disable public sign-ups in Dashboard -> Authentication -> Providers.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Encrypted per-user journal rows
-- ---------------------------------------------------------------------------
create table if not exists public.journal_rows (
    user_id     uuid        not null references auth.users (id) on delete cascade,
    kind        text        not null check (kind in ('note', 'pick', 'trail', 'mark')),
    client_id   text        not null,           -- client-generated row uuid
    ciphertext  bytea,                           -- AES-GCM ciphertext; NULL when tombstoned
    nonce       bytea,                           -- per-row AES-GCM nonce
    updated_at  timestamptz not null default now(),
    deleted_at  timestamptz,                     -- tombstone marker (soft delete)
    primary key (user_id, kind, client_id)
);

create index if not exists idx_journal_rows_user_updated
    on public.journal_rows (user_id, updated_at);

alter table public.journal_rows enable row level security;

drop policy if exists "journal_rows: select own" on public.journal_rows;
create policy "journal_rows: select own" on public.journal_rows
    for select using (auth.uid() = user_id);

drop policy if exists "journal_rows: insert own" on public.journal_rows;
create policy "journal_rows: insert own" on public.journal_rows
    for insert with check (auth.uid() = user_id);

drop policy if exists "journal_rows: update own" on public.journal_rows;
create policy "journal_rows: update own" on public.journal_rows
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "journal_rows: delete own" on public.journal_rows;
create policy "journal_rows: delete own" on public.journal_rows
    for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Wrapped data-encryption keys (envelope model)
-- ---------------------------------------------------------------------------
-- One row per user. `key_material` is an opaque JSON object written by the
-- browser: KDF parameters + salts, and BOTH wrapped copies of the DEK (one under
-- the passphrase-derived KEK, one under the recovery-code-derived KEK). The
-- server stores it verbatim and never inspects it, so the exact crypto shape can
-- evolve in H1.2 without a schema change.
create table if not exists public.user_keys (
    user_id       uuid        primary key references auth.users (id) on delete cascade,
    key_material  jsonb       not null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

alter table public.user_keys enable row level security;

drop policy if exists "user_keys: select own" on public.user_keys;
create policy "user_keys: select own" on public.user_keys
    for select using (auth.uid() = user_id);

drop policy if exists "user_keys: insert own" on public.user_keys;
create policy "user_keys: insert own" on public.user_keys
    for insert with check (auth.uid() = user_id);

drop policy if exists "user_keys: update own" on public.user_keys;
create policy "user_keys: update own" on public.user_keys
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No delete policy: a user re-wraps (updates) their keys; they don't delete them.

-- ---------------------------------------------------------------------------
-- 3. Feedback (readable by design — NOT end-to-end encrypted)
-- ---------------------------------------------------------------------------
-- The "Send feedback" button is something the user chooses to share so the
-- operator can triage bugs, so it is stored readable (still encrypted at rest by
-- Supabase + TLS). Metadata here; screenshot/view.html blobs in the Storage
-- bucket below. Wired up in H1.4; the schema lands now so it exists from day one.
create table if not exists public.feedback (
    id               bigint generated always as identity primary key,
    user_id          uuid references auth.users (id) on delete set null,
    message          text not null,
    app_state        jsonb,
    env              jsonb,
    screenshot_path  text,          -- object path in the 'feedback' bucket
    view_path        text,          -- object path in the 'feedback' bucket
    created_at       timestamptz not null default now()
);

create index if not exists idx_feedback_created on public.feedback (created_at);

alter table public.feedback enable row level security;

-- Users may file feedback and read back their own. The operator reads everything
-- out of band via the service role (which bypasses RLS) — no broad read policy
-- is granted to ordinary users.
drop policy if exists "feedback: insert own" on public.feedback;
create policy "feedback: insert own" on public.feedback
    for insert with check (auth.uid() = user_id);

drop policy if exists "feedback: read own" on public.feedback;
create policy "feedback: read own" on public.feedback
    for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4. Private Storage bucket for feedback blobs
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('feedback', 'feedback', false)
on conflict (id) do nothing;

-- Object key convention: "<user-uuid>/<something>" — the first path segment is
-- the owner, so a user can only write/read under their own folder.
drop policy if exists "feedback bucket: upload own" on storage.objects;
create policy "feedback bucket: upload own" on storage.objects
    for insert with check (
        bucket_id = 'feedback'
        and auth.uid()::text = (storage.foldername(name))[1]
    );

drop policy if exists "feedback bucket: read own" on storage.objects;
create policy "feedback bucket: read own" on storage.objects
    for select using (
        bucket_id = 'feedback'
        and auth.uid()::text = (storage.foldername(name))[1]
    );
