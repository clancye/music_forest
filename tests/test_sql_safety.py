"""S7: dynamic-SQL building stays parameterized / allow-listed.

These cover the only two places the app composes SQL with string-join — the
UPDATE ... SET clauses in journal.py and the ORDER BY in db._build — to prove a
stray (potentially user-influenced) fragment is rejected before it reaches the
database, rather than relying on the surrounding code never slipping up.
"""
import pytest

import db
import journal


# --- journal UPDATE ... SET allow-list --------------------------------------

def test_set_clause_accepts_allowed_columns():
    sets = ["body=?", "updated_at=?"]
    assert journal._set_clause(sets, journal._NOTE_SET_COLS) == "body=?, updated_at=?"


def test_set_clause_rejects_unknown_column():
    with pytest.raises(ValueError):
        journal._set_clause(["evil=?"], journal._NOTE_SET_COLS)


def test_set_clause_rejects_non_placeholder_value():
    # The classic injection shape: a literal value spliced in instead of a `?`.
    with pytest.raises(ValueError):
        journal._set_clause(["body='hi'"], journal._NOTE_SET_COLS)


def test_set_clause_rejects_extra_sql():
    with pytest.raises(ValueError):
        journal._set_clause(["body=?, x=(SELECT 1)"], journal._NOTE_SET_COLS)


def test_choice_and_note_columns_are_disjoint_from_each_others_leakage():
    # A note column must not silently pass the choice allow-list and vice versa.
    assert "body" not in journal._CHOICE_SET_COLS
    assert "chosen_id" not in journal._NOTE_SET_COLS


# --- db._build ORDER BY whitelist -------------------------------------------

def test_build_accepts_whitelisted_order():
    sql = db._build("al.year > ?", order="year", limit=True)
    assert "ORDER BY al.year DESC" in sql and sql.endswith("LIMIT ?")


def test_build_rejects_unknown_order():
    with pytest.raises(ValueError):
        db._build("al.year > ?", order="year; DROP TABLE albums")


def test_build_no_order_is_fine():
    sql = db._build("al.release_id = ?")
    assert "ORDER BY" not in sql
