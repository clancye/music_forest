"""
In-app feedback store — local-only, self-describing, AI-readable.

The "Send feedback" button in the UI captures a note plus a snapshot of the
app's current state, the browser environment, and a best-effort screenshot,
and POSTs it here. Each submission becomes one self-contained directory under
``config.FEEDBACK_DIR`` (``data/feedback/`` by default):

    data/feedback/
      README.md                      <- the schema, written once (see below)
      index.jsonl                    <- one compact line per entry, newest last
      2026-06-15T2031Z-a1b2/         <- one entry
        entry.json                   <- the full record (message + state + env)
        screenshot.png               <- best-effort image of the view (may be absent)
        view.html                    <- standalone HTML snapshot of the view

Nothing here is a database and nothing leaves the machine. The layout is
deliberately plain files so a person *or* an AI agent can scan ``index.jsonl``,
open any ``entry.json`` for detail, and look at ``screenshot.png`` / ``view.html``
to understand what the user was seeing — then draft backlog items from it.

This module is the only thing that writes the store; the server just calls
``save()``. It never raises into the request path for a bad screenshot or a
missing git binary — those degrade to a recorded note, not a 500.
"""
import base64
import json
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from secrets import token_hex

import config

SCHEMA = "aotd-feedback/1"

# Caps so a runaway client can't fill the disk. Generous for a local tool.
MAX_MESSAGE = 8000
MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024     # 8 MiB PNG
MAX_VIEW_HTML = 4 * 1024 * 1024            # 4 MiB of serialized DOM

_README = f"""# Feedback store (`{SCHEMA}`)

Each sub-directory here is one in-app feedback submission. It is local-only and
gitignored (it lives under `data/`). The intent is that a person or an AI agent
reads these and turns them into entries in `BACKLOG.md`.

## How to consume this (for an AI agent)

1. Read `index.jsonl` — one JSON object per line, newest last:
   `{{id, created_at, message, app_version, mode, has_screenshot}}`.
2. For any entry of interest, open `<id>/entry.json` for the full record.
3. Look at `<id>/screenshot.png` (if present) and/or open `<id>/view.html`
   (a self-contained snapshot of the page) to see what the user saw.
4. Draft a backlog line under the right heading in `BACKLOG.md`, reading it
   against `VISION.md`. Quote the user's words; cite the entry id.

## `entry.json` shape

```
{{
  "schema": "{SCHEMA}",
  "id": "<timestamp>-<rand>",
  "created_at": "<ISO-8601 UTC>",
  "app_version": "<git short hash or 'unknown'>",
  "message": "<the user's note>",
  "app_state": {{ ... whatever the UI sent: mode, date, filters, open modal ... }},
  "env": {{ ... user agent, viewport, screen, language, url ... }},
  "files": {{ "screenshot": "screenshot.png"|null, "view_html": "view.html"|null }}
}}
```

`app_state` and `env` are passed through verbatim from the client, so their
exact keys can evolve without changing this store.
"""


def _git_commit():
    """Best-effort short commit hash of the running code, or 'unknown'."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=config.ROOT, capture_output=True, text=True, timeout=2)
        h = out.stdout.strip()
        return h or "unknown"
    except Exception:  # noqa: BLE001 - never block feedback on git
        return "unknown"


def _decode_png(data_url):
    """Turn a `data:image/png;base64,...` URL into raw bytes, or None. Anything
    that isn't a PNG data URL within the size cap is dropped silently."""
    if not isinstance(data_url, str):
        return None
    m = re.match(r"^data:image/png;base64,([A-Za-z0-9+/=\s]+)$", data_url)
    if not m:
        return None
    try:
        raw = base64.b64decode(m.group(1), validate=False)
    except Exception:  # noqa: BLE001
        return None
    if not raw or len(raw) > MAX_SCREENSHOT_BYTES:
        return None
    # Sanity: PNG magic bytes.
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return raw


def _entry_id(now):
    return now.strftime("%Y-%m-%dT%H%MZ") + "-" + token_hex(2)


def save(message, app_state=None, env=None, screenshot=None, view_html=None):
    """Persist one feedback entry; return ``{"id", "dir"}``.

    Only ``message`` is required. ``app_state`` and ``env`` are stored verbatim
    (they're just JSON the client assembled). ``screenshot`` is an optional PNG
    data URL; ``view_html`` an optional serialized-DOM string. A bad screenshot
    or oversized snapshot is dropped, not fatal.
    """
    message = (message or "").strip()
    if not message:
        raise ValueError("feedback message is required")
    message = message[:MAX_MESSAGE]

    base = config.feedback_dir()
    base.mkdir(parents=True, exist_ok=True)
    _ensure_readme(base)

    now = datetime.now(timezone.utc)
    eid = _entry_id(now)
    d = base / eid
    d.mkdir(parents=True, exist_ok=True)

    png = _decode_png(screenshot)
    if png:
        (d / "screenshot.png").write_bytes(png)

    has_view = isinstance(view_html, str) and 0 < len(view_html) <= MAX_VIEW_HTML
    if has_view:
        (d / "view.html").write_text(view_html, encoding="utf-8")

    record = {
        "schema": SCHEMA,
        "id": eid,
        "created_at": now.isoformat(),
        "app_version": _git_commit(),
        "message": message,
        "app_state": app_state if isinstance(app_state, dict) else {},
        "env": env if isinstance(env, dict) else {},
        "files": {
            "screenshot": "screenshot.png" if png else None,
            "view_html": "view.html" if has_view else None,
        },
    }
    (d / "entry.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")

    _append_index(base, record)
    return {"id": eid, "dir": str(d)}


def _ensure_readme(base):
    readme = base / "README.md"
    if not readme.exists():
        try:
            readme.write_text(_README, encoding="utf-8")
        except Exception:  # noqa: BLE001 - the README is a nicety, not critical
            pass


def _index_line(record):
    """The compact one-line summary shape used by index.jsonl."""
    return {
        "id": record["id"],
        "created_at": record["created_at"],
        "message": record["message"][:200],
        "app_version": record["app_version"],
        "mode": (record.get("app_state") or {}).get("mode"),
        "has_screenshot": bool(record["files"]["screenshot"]),
    }


def _append_index(base, record):
    """Append a compact one-line summary to index.jsonl for quick scanning."""
    try:
        with (base / "index.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(_index_line(record), ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 - the index is derived; entry.json is truth
        pass


def list_entries():
    """Every stored entry's record, newest first. Convenience for review tools;
    the on-disk files remain the source of truth."""
    base = config.feedback_dir()
    if not base.exists():
        return []
    out = []
    for entry in base.glob("*/entry.json"):
        try:
            out.append(json.loads(entry.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001 - skip an unreadable entry
            continue
    out.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return out


# Exactly the shape _entry_id (and the hosted client's entryId) produces —
# the prune must never touch a directory it didn't create.
_ENTRY_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{4}Z-[0-9a-f]{4}$")


def _entry_created_at(d):
    """When this entry was submitted, as an aware UTC datetime. Prefers
    entry.json's created_at; falls back to the UTC stamp baked into the
    directory name (more trustworthy than mtime, which copies/rsync reset)."""
    try:
        record = json.loads((d / "entry.json").read_text(encoding="utf-8"))
        dt = datetime.fromisoformat(record["created_at"])
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001 - fall through to the name stamp
        pass
    return datetime.strptime(d.name[:16], "%Y-%m-%dT%H%MZ").replace(
        tzinfo=timezone.utc)


def prune(days):
    """Retention sweep (Privacy Policy §6): delete every feedback entry older
    than `days`, then rewrite index.jsonl to just the survivors. Touches only
    directories matching the entry-id shape, so README.md / index.jsonl / any
    foreign file are safe. `days` <= 0 disables. Returns {"deleted", "kept"}."""
    if not days or days <= 0:
        return {"deleted": 0, "kept": 0}
    base = config.feedback_dir()
    if not base.exists():
        return {"deleted": 0, "kept": 0}
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    deleted = kept = 0
    for d in sorted(base.iterdir()):
        if not d.is_dir() or not _ENTRY_DIR_RE.match(d.name):
            continue
        if _entry_created_at(d) < cutoff:
            shutil.rmtree(d, ignore_errors=True)
            deleted += 1
        else:
            kept += 1
    if deleted:
        _rewrite_index(base)
    return {"deleted": deleted, "kept": kept}


def _rewrite_index(base):
    """Rebuild index.jsonl from the surviving entry.json files (newest last,
    matching the append order). Best-effort like _append_index."""
    records = sorted(list_entries(), key=lambda r: r.get("created_at", ""))
    try:
        with (base / "index.jsonl").open("w", encoding="utf-8") as fh:
            for record in records:
                fh.write(json.dumps(_index_line(record), ensure_ascii=False)
                         + "\n")
    except Exception:  # noqa: BLE001 - the index is derived; entry.json is truth
        pass
