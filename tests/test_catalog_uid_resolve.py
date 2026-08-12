"""Regression: fold-aware journal uid resolution (catalogdb.canonical_pool_uid).

An MB-only album has ONE release-group pool uid (`m:mb:<rg>`) but folds several
release mbids. A journal entry keyed on a RELEASE mbid (or a since-merged group)
must still resolve to the album instead of showing "unknown album" — the
journal-links-carry-forward guarantee (UC1). Reproduces the 2026-07-10 report of
"A Heart Full of Ghosts" going missing from a user's choices while its notes
survived as an unknown album.
"""
import sqlite3

import pytest

import catalogdb


@pytest.fixture()
def catalog(tmp_path, monkeypatch):
    """A tiny catalog.sqlite: one MB entity whose members are its release-group AND
    two folded release mbids, all pointing at the same alb_id."""
    path = tmp_path / "catalog.sqlite"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE entities (alb_id TEXT PRIMARY KEY, pool_uid TEXT, source TEXT,
          created_at TEXT, updated_at TEXT);
        CREATE TABLE entity_members (source_ref TEXT PRIMARY KEY, alb_id TEXT,
          source TEXT, role TEXT);
        INSERT INTO entities VALUES
          ('ALB1', 'm:mb:GROUP', 'mb_only', 't', 't'),
          ('ALB2', 'd:42', 'discogs', 't', 't');
        INSERT INTO entity_members VALUES
          ('mb:group:GROUP',   'ALB1', 'musicbrainz', 'release-group'),
          ('mb:release:RELA',  'ALB1', 'musicbrainz', 'release'),
          ('mb:release:RELB',  'ALB1', 'musicbrainz', 'release'),
          ('discogs:release:42','ALB2', 'discogs', 'release');
        """
    )
    con.commit()
    con.close()
    monkeypatch.setattr(catalogdb.config, "CATALOG_DB_PATH", str(path), raising=False)
    return path


def test_group_uid_resolves_to_itself(catalog):
    assert catalogdb.canonical_pool_uid("m:mb:GROUP") == "m:mb:GROUP"


def test_release_level_uid_heals_to_group(catalog):
    # The orphan case: a journal entry keyed on a folded RELEASE mbid.
    assert catalogdb.canonical_pool_uid("m:mb:RELA") == "m:mb:GROUP"
    assert catalogdb.canonical_pool_uid("m:mb:RELB") == "m:mb:GROUP"


def test_discogs_uid_resolves(catalog):
    assert catalogdb.canonical_pool_uid("d:42") == "d:42"


def test_unknown_uid_is_none(catalog):
    assert catalogdb.canonical_pool_uid("m:mb:NOPE") is None
    assert catalogdb.canonical_pool_uid("d:999") is None
    assert catalogdb.canonical_pool_uid("") is None
    assert catalogdb.canonical_pool_uid(None) is None
