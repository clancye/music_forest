"""BE2b — cross-artifact vintage coherence + the ship-gate CLI.

Proves the second acceptance criterion: a mixed-vintage set is caught by BOTH surfaces.
The /healthz half is in test_observability.py (test_healthz_vintage_*); this covers the
vintage module directly and the rsync-gate CLI (`python vintage.py` exit code).
"""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import config  # noqa: E402
import vintage  # noqa: E402


def _stamp_pool(path, vid):
    con = sqlite3.connect(path)
    vintage.stamp_pool(con, counts={"total": 5}, vintage_id=vid)
    con.commit()
    con.close()


def _stamp_derived(path, pool_vid, *, table="meta"):
    con = sqlite3.connect(path)
    vintage.stamp_derived(con, pool_vid, table=table)
    con.commit()
    con.close()


def _wire(monkeypatch, d):
    """Point config's four artifact paths at temp files in dir `d`."""
    paths = {"pool": d / "pool.sqlite", "catalog": d / "catalog.sqlite",
             "poolsearch": d / "poolsearch.sqlite", "albums": d / "albums.db"}
    monkeypatch.setattr(config, "POOL_DB_PATH", paths["pool"])
    monkeypatch.setattr(config, "CATALOG_DB_PATH", paths["catalog"])
    monkeypatch.setattr(config, "POOL_SEARCH_DB_PATH", paths["poolsearch"])
    monkeypatch.setattr(config, "DB_PATH", paths["albums"])
    return paths


def test_mint_is_unique_and_sortable():
    ids = {vintage.mint() for _ in range(50)}
    assert len(ids) == 50                              # collision-proof
    assert all(i.startswith("v") for i in ids)


def test_stamp_read_roundtrip(tmp_path):
    p = tmp_path / "pool.sqlite"
    _stamp_pool(str(p), "vABC")
    assert vintage.read_meta_value(str(p), vintage.VINTAGE_KEY, table="meta") == "vABC"
    # a missing file / key / table -> None, never raises
    assert vintage.read_meta_value(str(tmp_path / "nope.sqlite"), "x") is None
    assert vintage.read_meta_value(str(p), "no_such_key", table="meta") is None


def test_coherent_set(tmp_path, monkeypatch):
    paths = _wire(monkeypatch, tmp_path)
    _stamp_pool(str(paths["pool"]), "vNEW")
    _stamp_derived(str(paths["catalog"]), "vNEW", table="catalog_meta")
    _stamp_derived(str(paths["poolsearch"]), "vNEW")
    _stamp_derived(str(paths["albums"]), "vNEW")
    c = vintage.coherence()
    assert c["coherent"] is True
    assert c["pool_vintage"] == "vNEW"
    assert all(a["status"] == "ok" for a in c["artifacts"].values())
    assert vintage.mismatches() == []


def test_mismatch_is_caught(tmp_path, monkeypatch):
    paths = _wire(monkeypatch, tmp_path)
    _stamp_pool(str(paths["pool"]), "vNEW")
    _stamp_derived(str(paths["catalog"]), "vOLD", table="catalog_meta")   # stale!
    _stamp_derived(str(paths["poolsearch"]), "vNEW")
    # albums.db (mb_release_map) absent entirely -> 'absent', must NOT itself flag
    c = vintage.coherence()
    assert c["coherent"] is False
    assert c["artifacts"]["catalog"]["status"] == "mismatch"
    assert c["artifacts"]["poolsearch"]["status"] == "ok"
    assert c["artifacts"]["mb_release_map"]["status"] == "absent"
    assert vintage.mismatches() == ["catalog"]


def test_unstamped_derived_is_unknown_not_mismatch(tmp_path, monkeypatch):
    paths = _wire(monkeypatch, tmp_path)
    _stamp_pool(str(paths["pool"]), "vNEW")
    # catalog exists but is NOT vintage-stamped (a pre-BE2b build)
    sqlite3.connect(str(paths["catalog"])).close()
    c = vintage.coherence()
    assert c["artifacts"]["catalog"]["status"] == "unknown"
    assert c["coherent"] is True                       # unknown never makes it incoherent
    assert vintage.mismatches() == []


def test_unstamped_pool_degrades_to_unknown(tmp_path, monkeypatch):
    paths = _wire(monkeypatch, tmp_path)
    sqlite3.connect(str(paths["pool"])).close()        # pool exists but unstamped
    _stamp_derived(str(paths["catalog"]), "vX", table="catalog_meta")
    c = vintage.coherence()
    assert c["pool_vintage"] is None
    assert c["coherent"] is None                        # can't judge without a pool vintage
    assert vintage.mismatches() == []                   # and the gate does NOT block


def test_catalog_fallback_counter(tmp_path, monkeypatch):
    """BE2b fallback visibility: the ops counter records each silent catalog degrade,
    and pooldb logs it ONCE per process while counting every time."""
    import importlib
    monkeypatch.setattr(config, "OPS_DB_PATH", tmp_path / "ops.sqlite")
    import opsdb
    importlib.reload(opsdb)
    assert opsdb.catalog_fallback_today() == {}          # clean to start
    opsdb.record_catalog_fallback("fields")
    opsdb.record_catalog_fallback("fields")
    opsdb.record_catalog_fallback("clusters")
    today = opsdb.catalog_fallback_today()
    assert today["fields"]["n"] == 2 and today["clusters"]["n"] == 1
    assert today["fields"]["last_at"]                     # stamped
    assert len(opsdb.catalog_fallback_recent(days=7)) == 2   # two (day,kind) rows
    # an unknown kind folds into 'fields' rather than creating a junk row
    opsdb.record_catalog_fallback("bogus")
    assert opsdb.catalog_fallback_today()["fields"]["n"] == 3


def test_pooldb_fallback_logs_once_counts_every(tmp_path, monkeypatch, capsys):
    import importlib
    monkeypatch.setattr(config, "OPS_DB_PATH", tmp_path / "ops.sqlite")
    import opsdb
    importlib.reload(opsdb)
    import pooldb
    importlib.reload(pooldb)
    monkeypatch.setattr(pooldb, "opsdb", opsdb)
    pooldb._logged_fallback.clear()
    pooldb._note_catalog_fallback("fields", RuntimeError("catalog gone"))
    pooldb._note_catalog_fallback("fields", RuntimeError("catalog gone"))
    err = capsys.readouterr().err
    assert err.count("catalog fields overlay unavailable") == 1   # logged ONCE
    assert opsdb.catalog_fallback_today()["fields"]["n"] == 2      # counted BOTH


def test_rsync_gate_cli_exit_codes(tmp_path):
    """The exact call tools/rsync_pool.sh makes: `python vintage.py --quiet` — exit 2 on a
    definite mismatch (ship refused), 0 when coherent or unknown."""
    def run():
        env = dict(os.environ,
                   AOTD_POOL_DB=str(tmp_path / "pool.sqlite"),
                   AOTD_CATALOG_DB=str(tmp_path / "catalog.sqlite"),
                   AOTD_POOL_SEARCH_DB=str(tmp_path / "poolsearch.sqlite"),
                   AOTD_DB_PATH=str(tmp_path / "albums.db"))
        return subprocess.run([sys.executable, str(ROOT / "vintage.py"), "--quiet"],
                              cwd=str(ROOT), env=env, capture_output=True, text=True)

    # coherent -> exit 0
    _stamp_pool(str(tmp_path / "pool.sqlite"), "vNEW")
    _stamp_derived(str(tmp_path / "catalog.sqlite"), "vNEW", table="catalog_meta")
    assert run().returncode == 0
    # introduce a mismatch -> exit 2 (the gate aborts the push)
    _stamp_derived(str(tmp_path / "poolsearch.sqlite"), "vOLD")
    r = run()
    assert r.returncode == 2
    assert "MISMATCH" in (r.stdout + r.stderr)
