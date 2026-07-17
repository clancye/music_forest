"""
Request query-param helpers (R-server-params) — extracted from server.py.

The small cohesive "parse the request's query string" cluster shared by the
legacy day/choice routes and the P3 pool routes: the MM-DD date arg (with
today as the default) and the opt-in surface-only-my-platforms filter.

Unlike uidmap (pure of Flask), these are deliberately request-COUPLED — they
read ``flask.request`` directly, so they can only be called inside a request
context. server.py re-imports the names, so its call sites are unchanged.
"""
from datetime import date

from flask import request


def _parse_md(arg):
    """Parse a MM-DD query arg, defaulting to today."""
    if not arg:
        t = date.today()
        return t.month, t.day
    month, day = (int(x) for x in arg.split("-"))
    return month, day


def _md_or_today():
    if request.args.get("date"):
        return _parse_md(request.args.get("date"))
    t = date.today()
    return t.month, t.day


# The confirmed platform keys the pool can filter on (matches db.confirmed_platforms).
# Any other token in ?platforms= is ignored, so a stale client can't smuggle an
# arbitrary key into the SQL seam.
_FILTER_PLATFORM_KEYS = {"spotify", "apple", "youtube", "deezer", "tidal",
                         "amazon", "pandora", "bandcamp"}


def _platforms_param(dig):
    """Parse the opt-in surface-only-my-platforms filter from ?platforms=a,b,c into a
    list of known platform keys, or None when absent/empty. It's a device UI pref
    (not E2EE data), so sending it as a query param is fine. DIG MODE IS ALWAYS
    UNFILTERED — the escape hatch — so we return None whenever dig is on, no matter
    what was sent."""
    if dig:
        return None
    raw = request.args.get("platforms")
    if not raw:
        return None
    keys = [k.strip() for k in raw.split(",") if k.strip() in _FILTER_PLATFORM_KEYS]
    return keys or None
