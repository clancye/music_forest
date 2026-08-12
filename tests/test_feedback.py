"""In-app feedback capture: the store module (feedback.py) + the API route."""
import json

import config
import feedback

# A 1x1 transparent PNG as a data URL (valid magic bytes, tiny).
_PNG_1x1 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def test_save_writes_self_describing_entry(tmp_path):
    config.FEEDBACK_DIR = tmp_path / "feedback"
    res = feedback.save(
        message="cover art looks wrong here",
        app_state={"mode": "browse", "date": "2026-03-10"},
        env={"user_agent": "pytest"},
    )
    d = tmp_path / "feedback" / res["id"]
    rec = json.loads((d / "entry.json").read_text(encoding="utf-8"))
    assert rec["schema"] == feedback.SCHEMA
    assert rec["message"].startswith("cover art")
    assert rec["app_state"]["mode"] == "browse"
    assert rec["files"]["screenshot"] is None
    # The store is self-describing + scannable.
    assert (tmp_path / "feedback" / "README.md").exists()
    assert (tmp_path / "feedback" / "index.jsonl").exists()
    assert any(e["id"] == res["id"] for e in feedback.list_entries())


def test_save_requires_a_message(tmp_path):
    config.FEEDBACK_DIR = tmp_path / "feedback"
    try:
        feedback.save(message="   ")
    except ValueError:
        return
    assert False, "expected a ValueError for an empty message"


def test_save_decodes_screenshot_and_view(tmp_path):
    config.FEEDBACK_DIR = tmp_path / "feedback"
    res = feedback.save(message="with a snapshot", screenshot=_PNG_1x1,
                        view_html="<!doctype html><body>hi</body>")
    d = tmp_path / "feedback" / res["id"]
    assert (d / "screenshot.png").read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert (d / "view.html").read_text(encoding="utf-8").endswith("</body>")
    rec = json.loads((d / "entry.json").read_text(encoding="utf-8"))
    assert rec["files"] == {"screenshot": "screenshot.png", "view_html": "view.html"}


def test_save_drops_a_non_png_screenshot(tmp_path):
    config.FEEDBACK_DIR = tmp_path / "feedback"
    res = feedback.save(message="bad shot",
                        screenshot="data:image/png;base64,not-base64!!")
    d = tmp_path / "feedback" / res["id"]
    assert not (d / "screenshot.png").exists()
    rec = json.loads((d / "entry.json").read_text(encoding="utf-8"))
    assert rec["files"]["screenshot"] is None


def test_feedback_endpoint(client, tmp_path):
    config.FEEDBACK_DIR = tmp_path / "feedback"
    ok = client.post("/api/feedback", json={"message": "hello from the api"})
    assert ok.status_code == 200 and ok.get_json()["ok"] is True
    bad = client.post("/api/feedback", json={"message": "   "})
    assert bad.status_code == 400


# --- retention prune (Privacy Policy §6) ------------------------------------

def _age_entry(tmp_path, entry_id, days):
    """Rewrite a stored entry's created_at to `days` ago."""
    from datetime import datetime, timedelta, timezone
    p = tmp_path / "feedback" / entry_id / "entry.json"
    rec = json.loads(p.read_text(encoding="utf-8"))
    rec["created_at"] = (datetime.now(timezone.utc)
                         - timedelta(days=days)).isoformat()
    p.write_text(json.dumps(rec), encoding="utf-8")


def test_prune_deletes_only_entries_past_the_window(tmp_path):
    config.FEEDBACK_DIR = tmp_path / "feedback"
    old = feedback.save(message="stale report", screenshot=_PNG_1x1)
    fresh = feedback.save(message="fresh report")
    _age_entry(tmp_path, old["id"], 200)

    res = feedback.prune(days=180)
    assert res == {"deleted": 1, "kept": 1}
    assert not (tmp_path / "feedback" / old["id"]).exists()
    assert (tmp_path / "feedback" / fresh["id"] / "entry.json").exists()
    # The index is rewritten to just the survivors; README survives untouched.
    lines = (tmp_path / "feedback" / "index.jsonl").read_text(
        encoding="utf-8").strip().splitlines()
    assert [json.loads(l)["id"] for l in lines] == [fresh["id"]]
    assert (tmp_path / "feedback" / "README.md").exists()


def test_prune_falls_back_to_the_dir_name_stamp(tmp_path):
    """An entry whose entry.json is unreadable still ages out — the UTC stamp
    in the directory name is enough."""
    config.FEEDBACK_DIR = tmp_path / "feedback"
    d = tmp_path / "feedback" / "2019-01-05T1200Z-ab12"
    d.mkdir(parents=True)
    (d / "entry.json").write_text("not json", encoding="utf-8")

    assert feedback.prune(days=180)["deleted"] == 1
    assert not d.exists()


def test_prune_never_touches_foreign_dirs_and_zero_disables(tmp_path):
    config.FEEDBACK_DIR = tmp_path / "feedback"
    entry = feedback.save(message="will be kept")
    _age_entry(tmp_path, entry["id"], 999)
    foreign = tmp_path / "feedback" / "not-an-entry"
    foreign.mkdir()

    assert feedback.prune(days=0) == {"deleted": 0, "kept": 0}
    assert (tmp_path / "feedback" / entry["id"]).exists()
    feedback.prune(days=30)
    assert foreign.exists()                       # shape-gated: never deleted
    assert not (tmp_path / "feedback" / entry["id"]).exists()
