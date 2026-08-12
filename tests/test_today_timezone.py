"""`today` is the READER's day (config.APP_TZ), never the server's process clock.

WHY THIS EXISTS. Render runs UTC. `date.today()` there flips at 20:00 ET, so from 8pm
an East-Coast reader was served TOMORROW's records — a day the prewarm has only
half-reached. Found 2026-07-16 minutes after the first 15 beta invites went out: the
day rolled to a barely-warmed 07-17 (228 Spotify links vs 07-16's 626), so the people
just invited got the thinnest possible version of the app, four hours early.

The bug is invisible on the owner's Mac, because the Mac IS Eastern: there
`date.today() == today_local()` and any test comparing them passes for the wrong
reason. So these tests force the process clock to UTC — reproducing the deployed box —
and assert the two DISAGREE in the right direction. Without the TZ forcing, this file
would be decoration.
"""
import importlib
import os
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


def _reload_config(**env):
    """Re-import config under a given env (APP_TZ is read at import)."""
    old = {k: os.environ.get(k) for k in env}
    os.environ.update({k: v for k, v in env.items() if v is not None})
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
    try:
        import config
        return importlib.reload(config)
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _with_process_tz(tz):
    """Force the PROCESS clock, which is what date.today() reads — this is the whole
    point: it makes a UTC box reproducible from an Eastern one."""
    os.environ["TZ"] = tz
    time.tzset()


def test_today_is_eastern_at_the_exact_instant_the_bug_bit(monkeypatch):
    """THE regression, pinned deterministically.

    Frozen at 2026-07-17 00:30 UTC — which is 2026-07-16 20:30 ET, half an hour into
    the window the invites went out in. The reader means 07-16; the old code said
    07-17. This must hold whatever time the suite happens to run: a wall-clock version
    of this test would agree with the bug for ~19 hours a day and only fail in the
    evening, which is how the bug survived to production in the first place.
    """
    import config

    instant_utc = datetime(2026, 7, 17, 0, 30, tzinfo=ZoneInfo("UTC"))

    class _FrozenDatetime:
        @staticmethod
        def now(tz=None):
            return instant_utc.astimezone(tz) if tz else instant_utc.replace(tzinfo=None)

    monkeypatch.setattr(config, "datetime", _FrozenDatetime)
    assert config.today_local() == date(2026, 7, 16), (
        "today_local() resolved the UTC day — an ET reader would be shown tomorrow's "
        "records all evening (the 2026-07-16 bug)")


def test_today_tracks_eastern_on_a_utc_box():
    """Belt-and-braces against the real clock: on a UTC process, the reader's day is
    still whatever ET says. (Only DIFFERS from the process date in the evening window —
    the deterministic test above is what actually guards the regression.)"""
    prev = os.environ.get("TZ")
    try:
        _with_process_tz("UTC")
        config = _reload_config(AOTD_TZ="America/New_York")
        assert config.today_local() == datetime.now(ZoneInfo("America/New_York")).date()
    finally:
        if prev is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = prev
        time.tzset()
        _reload_config(AOTD_TZ=None)


def test_the_evening_window_is_the_bug():
    """Pin the actual failure mode rather than only the happy path: at 21:00 ET the UTC
    date is already tomorrow, and serving THAT is what shipped a cold day to 15 people."""
    et = ZoneInfo("America/New_York")
    evening = datetime(2026, 7, 16, 21, 0, tzinfo=et)      # 9pm ET
    assert evening.astimezone(ZoneInfo("UTC")).date() == date(2026, 7, 17)
    assert evening.date() == date(2026, 7, 16)
    # The reader means 07-16. UTC would have said 07-17 — a day the prewarm had only
    # reached with its capped slice.
    assert evening.astimezone(ZoneInfo("UTC")).date() - evening.date() == timedelta(days=1)


def test_bad_timezone_never_takes_the_day_down():
    """A typo'd AOTD_TZ (or an image with no tzdata) must degrade, not 500. The fallback
    IS the old bug, so it must never raise — but it should also never be reached: tzdata
    is pinned in requirements.txt so the zone resolves on any host."""
    config = _reload_config(AOTD_TZ="Not/AZone")
    try:
        assert config.today_local() == date.today()
    finally:
        _reload_config(AOTD_TZ=None)


def test_tzdata_is_installed_so_the_fallback_stays_unreachable():
    """zoneinfo reads the SYSTEM tz database; a slim Linux image may ship none, which
    would silently restore the bug. requirements.txt pins tzdata for exactly this."""
    assert ZoneInfo("America/New_York") is not None


def test_default_zone_is_eastern():
    config = _reload_config(AOTD_TZ=None)
    assert config.APP_TZ == "America/New_York"
