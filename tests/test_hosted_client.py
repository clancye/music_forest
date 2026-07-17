"""
Server surface for the H1.2 client (BETA_PLAN.md §4): the small public routes the
no-build, end-to-end-encrypted frontend leans on.

  * /api/public-config — the public Supabase URL + anon key (and a `configured`
    flag that flips the whole login/unlock flow on), with nothing secret exposed.
  * /api/albums        — batch catalog lookup, so the browser can enrich its
    decrypted rows (a choice's chosen_id) without one request per id. Public
    catalog data only.

These use the tiny fixture catalogue (release ids 100–104).
"""
import pytest

server = pytest.importorskip("server")  # needs Flask; skip the file if absent
import config  # noqa: E402


@pytest.fixture()
def catalog_client(built_db, tmp_path):
    """A client on the fixture catalogue with a fresh per-test journal."""
    config.JOURNAL_DB_PATH = tmp_path / "journal.db"
    config.JOURNAL_BACKUP_DIR = tmp_path / "backups"
    app = server.create_app({
        "DB_PATH": built_db["db"],
        "SEARCH_DB_PATH": built_db["search"],
        "JOURNAL_DB_PATH": tmp_path / "journal.db",
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    return app.test_client()


# --- /api/public-config -----------------------------------------------------

def test_public_config_unconfigured_is_local_mode(tmp_path):
    app = server.create_app({
        "SUPABASE_URL": "", "SUPABASE_ANON_KEY": "", "PREFETCH_ENABLED": False,
    })
    app.testing = True
    r = app.test_client().get("/api/public-config")
    assert r.status_code == 200
    body = r.get_json()
    assert body["configured"] is False
    assert body["supabase_url"] == ""
    assert body["anon_key"] == ""


def test_public_config_configured_exposes_only_public_values(tmp_path):
    app = server.create_app({
        "SUPABASE_URL": "https://proj.supabase.co",
        "SUPABASE_ANON_KEY": "anon-public-key",
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    body = app.test_client().get("/api/public-config").get_json()
    assert body["configured"] is True
    assert body["supabase_url"] == "https://proj.supabase.co"
    assert body["anon_key"] == "anon-public-key"
    # No secret ever leaks through this route.
    assert "jwt_secret" not in body and "service" not in body
    assert "db_url" not in body


# --- /api/albums (batch catalog) -------------------------------------------

def test_albums_batch_returns_known_releases(catalog_client):
    r = catalog_client.get("/api/albums?ids=100,101,999999")
    assert r.status_code == 200
    albums = r.get_json()["albums"]
    assert "100" in albums and "101" in albums
    assert "999999" not in albums           # unknown id simply omitted
    assert albums["100"]["release_id"] == 100


def test_albums_batch_empty_and_garbage(catalog_client):
    assert catalog_client.get("/api/albums").get_json()["albums"] == {}
    assert catalog_client.get("/api/albums?ids=").get_json()["albums"] == {}
    # Non-numeric ids are skipped, not 500.
    assert catalog_client.get("/api/albums?ids=abc,,100").get_json()["albums"].keys() == {"100"}
