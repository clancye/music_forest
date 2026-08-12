"""
Contract checks for migration 0004 (Phase D invite-gate enforcement).

The Before-User-Created hook and the invited_emails allow-list live entirely in
Supabase/Postgres, so they can't be exercised by this SQLite-backed suite (the
real provider sign-up rejection is covered by the manual pass in
SMOKE_TEST_PHASE_D_INVITE_GATE.md). What we CAN guard here, cheaply and durably,
is that the migration keeps its security-critical shape: a future edit that opens
the allow-list to anon, drops RLS, makes the hook SECURITY DEFINER, or flips it to
fail-open would trip these.
"""
import re
from pathlib import Path

import pytest

_SQL_PATH = (
    Path(__file__).resolve().parents[1]
    / "supabase" / "migrations" / "0004_phase_d_invite_gate.sql"
)


@pytest.fixture(scope="module")
def sql():
    raw = _SQL_PATH.read_text(encoding="utf-8")
    # Strip `--` line comments so assertions check real SQL, not the prose in the
    # header (which legitimately discusses "security definer", anon, etc.).
    raw = re.sub(r"--[^\n]*", "", raw).lower()
    # Collapse whitespace so checks don't depend on indentation / line breaks.
    return re.sub(r"\s+", " ", raw)


def test_migration_file_exists():
    assert _SQL_PATH.is_file(), f"missing migration: {_SQL_PATH}"


def test_allow_list_table_is_created_idempotently(sql):
    assert "create table if not exists public.invited_emails" in sql


def test_rls_is_enabled_on_the_allow_list(sql):
    assert "alter table public.invited_emails enable row level security" in sql


def test_allow_list_is_closed_to_anon_and_authenticated(sql):
    # The only policy on the table must be the auth-admin read; nothing should
    # expose it to anon/authenticated over PostgREST.
    assert sql.count("create policy") == 1
    assert "for select to supabase_auth_admin using (true)" in sql
    assert "to anon" not in sql.split("create policy", 1)[1].split(";", 1)[0]
    assert "to authenticated" not in sql.split("create policy", 1)[1].split(";", 1)[0]
    assert "revoke all on table public.invited_emails from anon, authenticated, public" in sql


def test_auth_admin_can_read_the_table(sql):
    assert "grant usage on schema public to supabase_auth_admin" in sql
    assert "grant select on table public.invited_emails to supabase_auth_admin" in sql


def test_hook_function_has_the_right_contract(sql):
    assert "create or replace function public.before_user_created_hook(event jsonb)" in sql
    assert "returns jsonb" in sql
    # Email is read from the documented location and normalized for comparison.
    assert "lower(trim(event -> 'user' ->> 'email'))" in sql


def test_hook_is_not_security_definer(sql):
    # Supabase explicitly recommends against security definer for hooks.
    assert "security definer" not in sql


def test_hook_fails_closed(sql):
    # Rejects with a 4xx, and only the allow-list membership check opens the gate.
    assert "'http_code', 403" in sql
    assert "from public.invited_emails where email = v_email" in sql
    # The allow path returns an empty object (= permit creation).
    assert "return '{}'::jsonb" in sql


def test_hook_execution_is_restricted_to_auth_admin(sql):
    assert "grant execute on function public.before_user_created_hook(jsonb) to supabase_auth_admin" in sql
    assert "revoke execute on function public.before_user_created_hook(jsonb) from anon, authenticated, public" in sql


def test_operator_is_seeded_so_the_gate_cannot_lock_out(sql):
    assert "insert into public.invited_emails" in sql
    # A real-looking seed email must be present (no empty/placeholder seed).
    assert re.search(r"values \('[^']+@[^']+'", sql), "operator seed email missing"
    assert "on conflict (email) do nothing" in sql
