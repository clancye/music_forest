"""
Background artwork prefetch (F3), extracted from server.py so it can be tested
in isolation (R6).

When the app is running we fill covers for the days you're about to view in a
background thread, newest-first, so browsing is instant. Scope is deliberately
small (today, plus PREFETCH_DAYS_AHEAD) — never the whole catalog — and it backs
off politely if the artwork API starts rate-limiting.

The worker takes its collaborators (the art fetcher, the "missing art" query, and
even ``sleep``) as injectable defaults so a test can run it synchronously with
fakes and assert on what it fetched, without real network or real waiting.
"""
import threading
import time
from datetime import date, timedelta

import config
import db
import fetch_art

_RATE_LIMIT_CODES = ("403", "429")


def run_prefetch(days_ahead=None, delay=None, *,
                 fetch_one=None, missing_art=None, sleep=time.sleep,
                 today=None, log=print):
    """Fetch covers for today (+ optionally the next few days), newest-first.

    Skips anything already cached and backs off on rate-limit (403/429). All
    collaborators default to the real ones but can be injected for tests:
        fetch_one(rid, artist, title)  -> fetches+caches one cover (may raise)
        missing_art(month, day)        -> list of album dicts lacking art
        sleep(seconds)                 -> throttle/backoff hook
    """
    days_ahead = config.PREFETCH_DAYS_AHEAD if days_ahead is None else days_ahead
    delay = config.PREFETCH_DELAY if delay is None else delay
    fetch_one = fetch_one or fetch_art.fetch_one
    missing_art = missing_art or db.albums_missing_art
    start_day = today or date.today()

    backoff = 30
    for offset in range(days_ahead + 1):
        d = start_day + timedelta(days=offset)
        todo = missing_art(d.month, d.day)
        todo.sort(key=lambda a: (a.get("year") or 0), reverse=True)
        if todo:
            log(f"[prefetch] {d.isoformat()}: {len(todo)} cover(s) to fetch")
        done = 0
        for a in todo:
            attempts = 0
            while True:
                try:
                    fetch_one(a["release_id"], a["artist"], a["title"])
                    backoff = 30  # reset after a success
                    break
                except Exception as e:  # noqa: BLE001
                    if any(code in str(e) for code in _RATE_LIMIT_CODES):
                        attempts += 1
                        if attempts > 5:
                            break  # give up on this one; retried next launch
                        log(f"[prefetch] rate-limited; backing off {backoff}s")
                        sleep(backoff)
                        backoff = min(backoff * 2, 600)
                        continue  # re-attempt THIS album after the backoff
                    break  # other error: skip, it'll be retried next launch
            done += 1
            if done % 50 == 0:
                log(f"[prefetch] {d.isoformat()}: {done}/{len(todo)} done")
            sleep(delay)
    log("[prefetch] finished")


_started = False


def start():
    """Kick off the prefetch worker once, in a daemon thread, if enabled."""
    global _started
    if _started or not config.PREFETCH_ENABLED:
        return
    _started = True
    threading.Thread(target=run_prefetch, name="art-prefetch",
                     daemon=True).start()
