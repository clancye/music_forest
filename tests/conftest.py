"""
Shared pytest fixtures.

`built_db` builds the tiny fixture dump (see fixtures.py) into a throwaway
albums.db + search.db once per test session and repoints `config` at them, so
the data-access and API tests run against a real (but tiny) database with no
network and no touching the user's real data. `client` wraps the app factory
(R3) around those same throwaway paths.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
from tests.fixtures import write_dump  # noqa: E402


@pytest.fixture(autouse=True)
def _local_mode_env():
    """Make every test hermetic against any AOTD_SUPABASE_* the developer has
    exported in their shell. The suite is written for local single-user mode
    (auth bypassed, sqlite store); a developer who also runs the hosted app has
    those vars set, which would otherwise flip auth on (401s) and point the store
    at real Postgres. Reset them to local defaults before each test and restore
    after. Tests that exercise hosted mode (e.g. test_sync) override these per-app
    via create_app, which runs inside the test, after this fixture."""
    keys = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET",
            "SUPABASE_JWKS_URL", "SUPABASE_DB_URL", "RATE_LIMIT_ENABLED")
    saved = {k: getattr(config, k) for k in keys}
    for k in keys[:-1]:
        setattr(config, k, "")
    config.RATE_LIMIT_ENABLED = False
    try:
        yield
    finally:
        for k, v in saved.items():
            setattr(config, k, v)


@pytest.fixture(scope="session")
def built_db(tmp_path_factory):
    """Build albums.db + search.db from the fixture dump; return their paths and
    point config at them for the whole session."""
    os.environ["AOTD_BUILD_WORKERS"] = "1"   # keep the test build snappy
    data = tmp_path_factory.mktemp("data")
    db_path = data / "albums.db"
    search_path = data / "search.db"
    journal_path = data / "journal.db"

    config.DB_PATH = db_path
    config.SEARCH_DB_PATH = search_path
    config.JOURNAL_DB_PATH = journal_path
    config.JOURNAL_BACKUP_DIR = data / "backups"
    config.ART_DIR = data / "art"
    config.DATA_DIR = data

    import build_db  # imported here so config is already repointed
    dump = write_dump(data / "fixture_releases.xml.gz")
    build_db.build(Path(dump), db_path)
    return {"db": db_path, "search": search_path, "journal": journal_path}


@pytest.fixture()
def fresh_journal(tmp_path):
    """A throwaway journal.db per test, with config repointed at it."""
    config.JOURNAL_DB_PATH = tmp_path / "journal.db"
    config.JOURNAL_BACKUP_DIR = tmp_path / "backups"
    import journal
    return journal


@pytest.fixture()
def client(built_db):
    """A Flask test client from the app factory, pointed at the fixture DBs and
    with the background prefetch disabled."""
    flask = pytest.importorskip("flask")  # noqa: F841
    import server
    app = server.create_app({
        "DB_PATH": built_db["db"],
        "SEARCH_DB_PATH": built_db["search"],
        "JOURNAL_DB_PATH": built_db["journal"],
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    return app.test_client()
