"""
The H4 /admin attention panel: the BACKLOG watch-list parser (attention.py),
the pool.sqlite telemetry reads (pooldb.availability_runway /
spotify_stamp_stats), and the /api/admin/attention endpoint + operator gate.

Like test_crawl_status, no catalog DB is needed — the endpoint reads
pool.sqlite, a BACKLOG file, and the retention stamp, all pointed at tmp_path.
"""
import json
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone

import attention
import auth
import config
import pooldb
import server

SECRET = "test-jwt-signing-secret"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

TODAY = date(2026, 7, 3)

SAMPLE = """\
## Bugs

- [ ] `B21` [P1] ⏳ wait: 2026-07-01 — quota block self-lifts; run the
  **Remaining** check, then close. **Spotify on-demand resolve is dead on
  Render — no Spotify link ever surfaces live** (details follow).

- [ ] `F25` [P2] ⏳ wait: 2026-07-17 — follow up if Qobuz stays silent.
  **Qobuz creds follow-up.** More prose.

- [ ] `L1` [P1] ⏳ gated: owner + attorney **Attorney review of the four
  legal drafts** *(owner + attorney)*. Agenda here.

- [ ] `U18` [P2] **First-visit experience pass — walk the door in someone
  else's shoes.** Workable now.

- [ ] `FB#13` [P3] **Listen links should hand off to the native app on
  mobile** (in-app feedback #13).

- [P3] **`R-testsplit` — split `test_pooldb.py` (~1.48k lines) by concern.**
  Tech-debt style item, no checkbox.

- [x] (2026-07-03) `DONE1` **A finished thing** — must not appear.
"""


# --- the parser ---------------------------------------------------------------

def _by_id(items):
    return {it["id"]: it for it in items}


def test_parser_states_and_order():
    items = attention.parse_watchlist(SAMPLE, today=TODAY)
    ids = [it["id"] for it in items]
    assert "DONE1" not in ids            # done items never surface
    by = _by_id(items)
    assert by["B21"]["state"] == "due"
    assert by["B21"]["days_until"] == -2          # 07-01 was two days ago
    assert by["F25"]["state"] == "waiting"
    assert by["F25"]["days_until"] == 14
    assert by["L1"]["state"] == "gated"
    assert by["L1"]["gated_on"] == "owner + attorney"
    assert by["U18"]["state"] == "open"
    assert by["FB#13"]["state"] == "open"         # the FB#N id form parses
    assert by["R-testsplit"]["state"] == "open"   # tech-debt style, no checkbox
    # Triage order: due first, then the soonest wait, gated last.
    assert ids[0] == "B21"
    assert ids[1] == "F25"
    assert ids[-1] == "L1"


def test_parser_titles_priorities_and_why():
    by = _by_id(attention.parse_watchlist(SAMPLE, today=TODAY))
    assert by["B21"]["priority"] == 1
    assert by["FB#13"]["priority"] == 3
    # A short mid-sentence **Remaining** emphasis must not become the title —
    # the item's real bold name follows it.
    assert by["B21"]["title"].startswith("Spotify on-demand resolve is dead")
    assert by["U18"]["title"].startswith("First-visit experience pass")
    # The why capture stops at the **bold**; the sheared "run the" is trimmed
    # back to the last complete clause.
    assert by["B21"]["why"] == "quota block self-lifts"
    # The tech-debt style leads its bold with "`id` — ..." — don't repeat the id.
    assert by["R-testsplit"]["title"].startswith("split test_pooldb.py")


def test_parser_real_backlog_parses():
    """The actual BACKLOG.md must yield ids for essentially every open item —
    the grammar in the Workflow section is a commitment this test enforces."""
    import pytest
    backlog = config.ROOT / "BACKLOG.md"
    if not backlog.exists():
        pytest.skip("BACKLOG.md is private to the app repo; skipped in the public mirror")
    text = backlog.read_text(encoding="utf-8")
    items = attention.parse_watchlist(text)
    assert len(items) >= 5
    named = [it for it in items if it["id"]]
    assert len(named) == len(items), [it["title"] for it in items if not it["id"]]


# --- pooldb telemetry ----------------------------------------------------------

def _seed_pool(pool_path, *, now):
    con = sqlite3.connect(pool_path)
    con.execute(
        "CREATE TABLE pool (uid TEXT PRIMARY KEY, album_id TEXT, source TEXT, "
        "month INT, day INT, year INT, original_date TEXT, artist TEXT, "
        "title TEXT, country TEXT, n_pressings INT, variant_of TEXT, "
        "release_ids TEXT, mb_release_ids TEXT, folded_mbids TEXT)")
    con.execute(
        "CREATE TABLE availability (uid TEXT PRIMARY KEY, listenable INT, "
        "deezer_hit INT, deezer_url TEXT, resolved_at TEXT, method TEXT)")
    con.execute(pooldb._DOOR_SCHEMA)
    # Three calendar days, two albums each: 07-03 + 07-04 fully resolved
    # (warm), 07-05 untouched (cold).
    rows = [(f"d:{m}{d}{i}", m, d) for m, d in ((7, 3), (7, 4), (7, 5))
            for i in (1, 2)]
    for uid, m, d in rows:
        con.execute(
            "INSERT INTO pool (uid, month, day, artist, title) "
            "VALUES (?,?,?,?,?)", (uid, m, d, "a", "t"))
        if (m, d) != (7, 5):
            con.execute(
                "INSERT INTO availability (uid, listenable) VALUES (?, 1)",
                (uid,))
    fresh = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    old = (now - timedelta(hours=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    con.execute("INSERT INTO door_links (uid, spotify_fetched_at) VALUES (?,?)",
                ("d:731", fresh))
    con.execute("INSERT INTO door_links (uid, spotify_fetched_at) VALUES (?,?)",
                ("d:741", old))
    con.commit()
    con.close()


def test_runway_and_spotify_stats(tmp_path):
    pool_path = tmp_path / "pool.sqlite"
    now = datetime.now(timezone.utc)
    _seed_pool(pool_path, now=now)
    old_pool = config.POOL_DB_PATH
    config.POOL_DB_PATH = pool_path
    try:
        run = pooldb.availability_runway(today=TODAY)
        assert run["total_days"] == 3
        assert run["warm_days"] == 2
        assert run["runway_days"] == 2          # 07-03 and 07-04, stops at 07-05
        assert run["runway_end"] == "07-04"
        sp = pooldb.spotify_stamp_stats(now=now)
        assert sp["stamped"] == 2
        assert sp["stamped_24h"] == 1           # the 30 h stamp is outside
        assert 0.9 <= sp["newest_age_hours"] <= 1.1
    finally:
        config.POOL_DB_PATH = old_pool


def test_runway_none_without_tables(tmp_path):
    pool_path = tmp_path / "empty.sqlite"
    sqlite3.connect(pool_path).close()
    old_pool = config.POOL_DB_PATH
    config.POOL_DB_PATH = pool_path
    try:
        assert pooldb.availability_runway(today=TODAY) is None
        assert pooldb.spotify_stamp_stats() is None
    finally:
        config.POOL_DB_PATH = old_pool


# --- the endpoint ---------------------------------------------------------------

def _make_client(tmp_path, *, secret="", operators=frozenset()):
    pool_path = tmp_path / "pool.sqlite"
    _seed_pool(pool_path, now=datetime.now(timezone.utc))
    backlog = tmp_path / "BACKLOG.md"
    backlog.write_text(SAMPLE, encoding="utf-8")
    stamp = tmp_path / "retention_sweep.json"
    stamp.write_text(json.dumps({
        "ran_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feedback_deleted": 0}), encoding="utf-8")
    rwstamp = tmp_path / "refresh_watch.json"
    rwstamp.write_text(json.dumps({
        "current_vintage": "2026-06-01", "latest_vintage": "2026-07-01",
        "gz_delta_pct": 0.46, "days_since_vintage": 35, "newer_available": True,
        "threshold_crossed": False, "reason": "below threshold", "probe_ok": True,
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }), encoding="utf-8")
    app = server.create_app({
        "POOL_DB_PATH": pool_path,
        "BACKLOG_PATH": backlog,
        "RETENTION_STAMP_FILE": stamp,
        "REFRESH_WATCH_FILE": rwstamp,
        "CRAWL_STATUS_FILE": tmp_path / "crawl_status.json",
        "SYNC_DB_PATH": tmp_path / "sync.db",
        "SUPABASE_DB_URL": "",
        "SUPABASE_JWT_SECRET": secret,
        "SUPABASE_JWKS_URL": "",
        "JWT_AUDIENCE": "authenticated",
        "JWT_ISSUER": "",
        "OPERATOR_IDS": operators,
        "PREFETCH_ENABLED": False,
    })
    app.testing = True
    return app.test_client()


def _bearer(sub):
    return {"Authorization": f"Bearer {auth.make_token(sub, SECRET)}"}


def _wait_runway(client, headers=None, tries=100):
    """Poll until the background runway compute lands (instant on a 6-row
    pool); the panel is deliberately async so a slow host disk can't hang it."""
    for _ in range(tries):
        body = client.get("/api/admin/attention",
                          headers=headers or {}).get_json()
        if body["availability"].get("state") != "computing":
            return body
        time.sleep(0.05)
    raise AssertionError("runway compute never landed")


def test_attention_payload(tmp_path):
    client = _make_client(tmp_path)
    # The very first answer must be instant — the whole-pool aggregate runs in
    # the background (on the host it can take a minute+), never on the request.
    first = client.get("/api/admin/attention").get_json()
    assert first["availability"] == {"state": "computing"}
    assert first["crawl"]["health"] == "never"      # the rest answered already
    body = _wait_runway(client)
    assert body["availability"]["warm_days"] == 2
    assert body["availability"]["computed_at"]
    assert body["spotify"]["stamped"] == 2
    assert body["retention"]["age_hours"] is not None
    assert body["retention"]["age_hours"] < 1
    rw = body["refresh"]
    assert rw["threshold_crossed"] is False and rw["newer_available"] is True
    assert rw["current_vintage"] == "2026-06-01"
    assert rw["checked_age_hours"] is not None and rw["checked_age_hours"] < 1
    ids = [it["id"] for it in body["watchlist"]]
    assert ids[0] == "B21" and "L1" in ids


def test_attention_degrades_per_part(tmp_path):
    """A missing BACKLOG/stamp never blanks the panel — those parts degrade."""
    client = _make_client(tmp_path)
    _wait_runway(client)
    old = (config.BACKLOG_PATH, config.RETENTION_STAMP_FILE, config.REFRESH_WATCH_FILE)
    config.BACKLOG_PATH = tmp_path / "missing.md"
    config.RETENTION_STAMP_FILE = tmp_path / "missing.json"
    config.REFRESH_WATCH_FILE = tmp_path / "missing_rw.json"
    try:
        body = client.get("/api/admin/attention").get_json()
    finally:
        config.BACKLOG_PATH, config.RETENTION_STAMP_FILE, config.REFRESH_WATCH_FILE = old
    assert body["watchlist"] == [] and body["watchlist_error"]
    assert body["retention"] == {"ran_at": None}
    assert body["refresh"] == {"checked_at": None}   # missing stamp degrades cleanly
    assert body["availability"]["warm_days"] == 2   # cached — still answers


def test_attention_operator_gate(tmp_path):
    client = _make_client(tmp_path, secret=SECRET,
                          operators=frozenset({USER_A}))
    assert client.get("/api/admin/attention").status_code == 401
    assert client.get("/api/admin/attention",
                      headers=_bearer(USER_B)).status_code == 403
    assert client.get("/api/admin/attention",
                      headers=_bearer(USER_A)).status_code == 200
