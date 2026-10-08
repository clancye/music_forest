"""covercache.py — the host's own copy of today's and tomorrow's Cover Art Archive thumbnails.

WHY. The first card on Today is the one someone is waiting on. Measured on staging
2026-10-05 (fresh visit, five runs): the day's list lands at ~1.9 s, then the first
cover takes another ~1.3-2 s, all of it the archive (coverartarchive.org 307 ->
archive.org 302 -> a storage node). From the Mac, 2 of 12 thumbnails failed outright
(a 503 after 16 s, a 500 after 22 s). A copy on our own disk makes it one same-origin
GET.

WHAT IT HOLDS, and the guardrails it lives inside (owner-approved 2026-10-05):
  * Cover Art Archive images ONLY, at the archive's own 500px thumbnail. Never Discogs
    (its API terms bar caching) and never Apple artwork. The fetch is pinned to the two
    CAA hosts, so nothing else can land here.
  * A ROLLING window: the records of today and tomorrow, in the reader's day
    (config.today_local()). A thumbnail older than one cycle (COVER_CACHE_MAX_AGE_H) is
    re-fetched, one the archive no longer serves (404/410) is deleted on that pass, and
    anything outside the window is deleted. So whatever CAA removes leaves our copy
    within a cycle.
  * Small and in context: served only at /covers/<kind>/<mbid>-500.jpg, for the card it
    belongs to. No gallery, no download, no share image (the share card keeps CAA's own
    address).
  * A takedown blocklist keyed by MusicBrainz id (COVER_BLOCKLIST). A listed cover is
    never fetched, 404s here at once, is deleted on the next pass, and is withheld from
    what the app serves, so its card shows the placeholder.

HOW IT WARMS. A background thread on each host, not the Mac and not lazily:
  * the Mac sleeps most of the day, and the window turns over at midnight Eastern;
  * shipping ~180 MB a day to two hosts through Render's shared SSH gateway is the
    wrong shape for a throwaway cache, so each host fetches its own straight from CAA;
  * a lazy fill on a miss would almost never hit: a fresh visit's first card is dealt
    at random from ~190 ready records, and with a few dozen readers each would be the
    first to ask for theirs.
gunicorn runs two workers, so a non-blocking flock elects one warmer. The other keeps
trying each interval, so a recycled worker hands over within a pass.

ORDER. Today's READY records first (cover + Spotify + YouTube already in the day's
list: the client's readyFirst() deals one of them as a fresh visit's first card), then
tomorrow's ready ones, then the rest of today, then the rest of tomorrow.

DISK. Never grows past COVER_CACHE_MAX_MB, and never writes while the disk has less
than COVER_CACHE_MIN_FREE_MB free (the 07-08 disk-full crash-loop). It's a cache:
`rm -rf` the directory at any time and it refills.

NEVER FAILS A REQUEST. The serve-side helpers swallow their errors. An unreadable
directory just means "nothing cached", which is the behaviour before this existed.
"""
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone

import requests

import config
import safefetch

log = logging.getLogger("aotd.covercache")

SIZE = 500
KINDS = ("release", "release-group")
_HOSTS = ("coverartarchive.org", "archive.org")   # CAA + the IA nodes it redirects to
_MAX_BYTES = 2 * 1024 * 1024                       # a 500px thumbnail is ~25-150 KB
_UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_CAA = re.compile(r"^https?://coverartarchive\.org/(release|release-group)/"
                  rf"({_UUID_RE})/front(?:-\d+)?$", re.I)
_FILE = re.compile(rf"^({_UUID_RE})-{SIZE}\.jpg$")
_UUID = re.compile(_UUID_RE, re.I)
_JPEG = b"\xff\xd8\xff"


def caa_key(url):
    """(kind, mbid) for a Cover Art Archive front-image address, else None."""
    m = _CAA.match(url or "")
    return (m.group(1).lower(), m.group(2).lower()) if m else None


def thumb_source(kind, mbid):
    """The archive's own 500px thumbnail for this front image."""
    return f"https://coverartarchive.org/{kind}/{mbid}/front-{SIZE}"


def public_url(kind, mbid):
    """Where this host serves its copy (what the client's caaThumb() asks for)."""
    return f"/covers/{kind}/{mbid}-{SIZE}.jpg"


def _path(kind, mbid):
    return config.COVER_CACHE_DIR / kind / f"{mbid}-{SIZE}.jpg"


# --- the takedown blocklist ---------------------------------------------------
_block = {"sig": None, "ids": frozenset()}
_block_lock = threading.Lock()


def blocked():
    """Every MusicBrainz id named in COVER_BLOCKLIST. One per line; anything after a
    `#` is a note, and any id on the line counts, so a pasted CAA or MusicBrainz address
    works too. Re-read when the file changes; a missing file is an empty list."""
    p = config.COVER_BLOCKLIST
    try:
        s = p.stat()
    except OSError:
        return frozenset()
    sig = (str(p), s.st_mtime_ns, s.st_size)
    with _block_lock:
        if _block["sig"] == sig:
            return _block["ids"]
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return frozenset()
    ids = set()
    for line in text.splitlines():
        ids.update(u.lower() for u in _UUID.findall(line.split("#", 1)[0]))
    ids = frozenset(ids)
    with _block_lock:
        _block.update(sig=sig, ids=ids)
    return ids


def scrub_url(url):
    """The address, or None when it's a Cover Art Archive cover on the blocklist."""
    try:
        k = caa_key(url)
        return None if (k and k[1] in blocked()) else url
    except Exception:  # noqa: BLE001 - a bad blocklist must never break a response
        return url


# --- what this host holds -----------------------------------------------------
_INDEX_TTL = 60.0
_index = {"at": 0.0, "dir": None, "keys": frozenset()}
_index_lock = threading.Lock()


def cached_keys(*, fresh=False):
    """{(kind, mbid)} on disk now: one directory scan per minute per process at most
    (~5 ms for two days of covers). A file removed inside that minute is asked for,
    404s, and the client falls back to the archive, so a stale index costs a hop."""
    d = config.COVER_CACHE_DIR
    now = time.monotonic()
    with _index_lock:
        if not fresh and _index["dir"] == d and now - _index["at"] < _INDEX_TTL:
            return _index["keys"]
    keys = set()
    for kind in KINDS:
        try:
            with os.scandir(d / kind) as it:
                for e in it:
                    m = _FILE.match(e.name)
                    if m:
                        keys.add((kind, m.group(1)))
        except OSError:
            continue
    keys = frozenset(keys)
    with _index_lock:
        _index.update(at=now, dir=d, keys=keys)
    return keys


def annotate(albums):
    """Mark `cover_cached` on each album whose cover this host holds, and withhold a
    blocklisted cover (the card shows its placeholder). Mutates and returns `albums`,
    which must be the caller's own fresh dicts. Never raises."""
    try:
        block = blocked()
        have = cached_keys() if config.COVER_CACHE_ENABLED else frozenset()
        if not block and not have:
            return albums
        for a in albums:
            k = caa_key(a.get("cover"))
            if not k:
                continue
            if k[1] in block:
                a["cover"] = None
                a.pop("cover_cached", None)
            elif k in have:
                a["cover_cached"] = True
    except Exception:  # noqa: BLE001 - the day must load whatever the cache is doing
        log.exception("cover cache annotate failed")
    return albums


def serve_path(kind, name):
    """The file behind /covers/<kind>/<name>, or None: cache off, a malformed name, a
    blocklisted id, or not held."""
    if not config.COVER_CACHE_ENABLED or kind not in KINDS:
        return None
    m = _FILE.match(name or "")
    if not m or m.group(1) in blocked():
        return None
    p = _path(kind, m.group(1))
    return p if p.is_file() else None


# --- the warm pass ------------------------------------------------------------
def _ready(a):
    """The client's readyFirst() test (static/app.js doorNeeded): cover and Listen
    links already in the day's list, so the card needs no lookup."""
    have = a.get("platforms") or {}
    return bool(a.get("cover") and have.get("spotify") and have.get("youtube"))


def _day_rows(month, day):
    import pooldb   # lazy: the server imports this module before the pool is wired
    if pooldb.day_in_window(month, day):
        return pooldb.held_day(month, day)     # the held copy, not another full build
    return pooldb.pool_day(month, day, available_only=True)


def _fetch(url):
    """The thumbnail's bytes, through the shared SSRF guard pinned to CAA's own hosts
    (every redirect hop is re-checked). Raises requests.HTTPError on an HTTP failure,
    ValueError on a policy or format rejection."""
    content, _ctype = safefetch.safe_get(url, _HOSTS, max_bytes=_MAX_BYTES,
                                         max_redirects=config.ART_MAX_REDIRECTS,
                                         timeout=20)
    if not content.startswith(_JPEG):
        raise ValueError("not a JPEG")
    return content


def _unlink(p):
    try:
        p.unlink()
        return True
    except OSError:
        return False


def _write_atomic(p, body):
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        os.replace(tmp, p)
    except BaseException:
        _unlink_path(tmp)
        raise


def _unlink_path(s):
    try:
        os.unlink(s)
    except OSError:
        pass


def _files(d):
    """[(kind, name, path, stat)] for everything in the cache's kind folders."""
    out = []
    for kind in KINDS:
        try:
            with os.scandir(d / kind) as it:
                for e in it:
                    try:
                        out.append((kind, e.name, e.path, e.stat()))
                    except OSError:
                        continue
        except OSError:
            continue
    return out


def _room(d, size):
    """None when there's room for one more thumbnail, else why not."""
    if size >= config.COVER_CACHE_MAX_MB * 1024 * 1024:
        return "cap"
    try:
        free = shutil.disk_usage(d).free
    except OSError:
        return "disk"
    if free < config.COVER_CACHE_MIN_FREE_MB * 1024 * 1024:
        return "free"
    return None


def warm_once(*, today=None, rows_for=None, fetch=None, sleep=time.sleep, now=None):
    """One pass over the window. Returns the tally (also written to status.json)."""
    today = today or config.today_local()
    rows_for = rows_for or _day_rows
    fetch = fetch or _fetch
    now = time.time() if now is None else now
    d = config.COVER_CACHE_DIR
    max_age = config.COVER_CACHE_MAX_AGE_H * 3600
    days = [today, today + timedelta(days=1)]
    st = {"window": [x.strftime("%m-%d") for x in days], "wanted": 0, "fetched": 0,
          "kept": 0, "gone": 0, "errors": 0, "blocked": 0, "deleted": 0, "bytes": 0,
          "stopped": None}
    block = blocked()

    # The window, in warm order. A day that can't be read (or reads empty) leaves the
    # window UNKNOWN, and an unknown window never sweeps: an empty answer from a pool
    # mid-re-seed must not read as "delete every cover".
    ready, rest, known = [], [], True
    for day in days:
        try:
            rows = rows_for(day.month, day.day) or []
        except Exception:  # noqa: BLE001 - one bad day mustn't stop the other
            log.exception("cover cache: couldn't read %s", day)
            rows = []
        if not rows:
            known = False
        r, o = [], []
        for a in rows:
            k = caa_key(a.get("cover"))
            if k:
                (r if _ready(a) else o).append(k)
        ready.append(r)
        rest.append(o)
    order, seen = [], set()
    for k in ready[0] + ready[1] + rest[0] + rest[1]:
        if k not in seen:
            seen.add(k)
            order.append(k)
    st["wanted"] = len(order)

    for kind in KINDS:
        (d / kind).mkdir(parents=True, exist_ok=True)
    size = sum(s.st_size for *_x, s in _files(d))
    run_of_errors = 0
    for kind, mbid in order:
        p = _path(kind, mbid)
        if mbid in block:
            st["blocked"] += 1
            if _unlink(p):
                st["deleted"] += 1
            continue
        try:
            old = p.stat()
        except OSError:
            old = None
        if old is not None and now - old.st_mtime < max_age:
            st["kept"] += 1
            continue
        why = _room(d, size)
        if why:
            st["stopped"] = why
            break
        try:
            body = fetch(thumb_source(kind, mbid))
        except requests.HTTPError as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):
                # The archive no longer has it: neither do we.
                st["gone"] += 1
                run_of_errors = 0
                if _unlink(p):
                    st["deleted"] += 1
                    size -= old.st_size if old else 0
            else:
                st["errors"] += 1
                run_of_errors += 1
        except Exception:  # noqa: BLE001 - a timeout or a rejected payload: keep going
            st["errors"] += 1
            run_of_errors += 1
        else:
            _write_atomic(p, body)
            size += len(body) - (old.st_size if old else 0)
            st["fetched"] += 1
            st["bytes"] += len(body)
            run_of_errors = 0
        if st["errors"] >= 100:
            st["stopped"] = "errors"
            break
        if run_of_errors >= 5:
            sleep(30)          # the archive is struggling: give it a moment
            run_of_errors = 0
        sleep(config.COVER_CACHE_DELAY)

    # Sweep. Out of the window -> gone (only when the window is known). Older than two
    # cycles -> gone regardless: anything still wanted is refreshed every cycle, so a
    # file that old is one the archive stopped answering for. Temp debris -> gone.
    keep = {k for k in order if k[1] not in block}
    for kind, name, path, s in _files(d):
        m = _FILE.match(name)
        stale = now - s.st_mtime > 2 * max_age
        if m is None:
            if name.endswith(".tmp") and now - s.st_mtime > 3600:
                _unlink_path(path)
            continue
        if stale or m.group(1) in block or (known and (kind, m.group(1)) not in keep):
            _unlink_path(path)
            st["deleted"] += 1
    files = _files(d)
    st["files"] = sum(1 for _k, n, *_r in files if _FILE.match(n))
    st["size_mb"] = round(sum(s.st_size for *_x, s in files) / 1048576, 1)
    try:
        st["free_mb"] = round(shutil.disk_usage(d).free / 1048576)
    except OSError:
        st["free_mb"] = None
    st["at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        _write_atomic(d / "status.json", json.dumps(st).encode())
    except OSError:
        pass
    cached_keys(fresh=True)
    return st


def status():
    """The last pass's tally (status.json), or None before the first one."""
    try:
        return json.loads((config.COVER_CACHE_DIR / "status.json").read_text())
    except (OSError, ValueError):
        return None


# --- the warmer thread --------------------------------------------------------
_started = False
_start_lock = threading.Lock()


def _try_lock():
    """Become the one warmer on this disk, or None if another process already is. The
    lock file stays open (held) for the life of the process; a dead holder releases it."""
    try:
        import fcntl
    except ImportError:          # no flock (not Linux/macOS): assume a single process
        return True
    d = config.COVER_CACHE_DIR
    d.mkdir(parents=True, exist_ok=True)
    f = open(d / ".warm.lock", "w")  # noqa: SIM115 - held open on purpose
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def _warm_loop(interval, first_delay):
    time.sleep(first_delay)      # let the worker start serving (and the pool warm) first
    held = None
    while True:
        try:
            if held is None:
                held = _try_lock()
                if held is not None:
                    log.info("cover cache warmer started", extra={
                        "event": "cover_warm_start", "pid": os.getpid(),
                        "dir": str(config.COVER_CACHE_DIR)})
            if held is not None:
                t0 = time.time()
                st = warm_once()
                log.info("cover cache pass", extra={
                    "event": "cover_warm", "secs": round(time.time() - t0), **st})
        except Exception:  # noqa: BLE001 - the warmer must outlive any one bad pass
            log.exception("cover cache pass failed")
        time.sleep(interval)


def start_warmer(*, interval=600, first_delay=20):
    """Start this process's warmer thread (once). It warms only if it wins the lock."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_warm_loop, args=(interval, first_delay),
                     name="cover-warm", daemon=True).start()
