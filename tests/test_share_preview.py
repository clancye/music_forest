"""H6 — a shared record link unfurls as the record, not the app icon.

The ↗ Share door sends `/?album=<uid>`. In a group chat the unfurl IS the share, so
the shell swaps its generic og:/twitter: block for the record's own cover and title.

These pin the four properties that make that safe to serve on the app's front door:
it falls back to the generic tags on anything unexpected, it escapes catalog text
into the attributes, it emits absolute https URLs behind Render's TLS-terminating
proxy, and it never cloaks (bots and people get the same HTML).
"""
import re

import pytest
import server


HTTPS = {"X-Forwarded-Proto": "https", "Host": "musicforest.lol"}
GENERIC_TITLE = "Music Forest — Find music, write notes."


def _meta(body, prop):
    m = re.search(rf'<meta (?:property|name)="{re.escape(prop)}" content="([^"]*)">', body)
    return m.group(1) if m else None


def _get(client, path, **kw):
    r = client.get(path, headers=HTTPS, **kw)
    assert r.status_code == 200
    return r


# --- falls back to generic ----------------------------------------------------

def test_plain_shell_is_untouched(client):
    body = _get(client, "/").get_data(as_text=True)
    assert _meta(body, "og:title") == GENERIC_TITLE
    # The markers must survive: they're the contract the injection depends on.
    assert "<!--og:start-->" in body and "<!--og:end-->" in body


def test_unknown_uid_serves_generic_tags(client):
    body = _get(client, "/?album=m:mb:no-such-record").get_data(as_text=True)
    assert _meta(body, "og:title") == GENERIC_TITLE


@pytest.mark.parametrize("bad", [
    "", "../../etc/passwd", '"><script>alert(1)</script>', "d:not-a-number",
    "d:", "m:", "%00", "d:-1",
])
def test_hostile_uid_never_injects_and_never_500s(client, bad):
    body = _get(client, "/?album=" + bad).get_data(as_text=True)
    assert _meta(body, "og:title") == GENERIC_TITLE


def test_missing_markers_degrade_to_the_file(client, monkeypatch):
    """If index.html ever loses its markers, serve it exactly as written."""
    monkeypatch.setattr(server, "_shell_html", lambda: "<html><head></head></html>")
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert _meta(body, "og:title") == GENERIC_TITLE


def test_resolver_failure_degrades_to_generic(client, monkeypatch):
    def boom(uid):
        raise RuntimeError("catalog exploded")
    monkeypatch.setattr(server, "_album_for_uid", boom)
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert _meta(body, "og:title") == GENERIC_TITLE


# --- the injected card --------------------------------------------------------

def _album(**kw):
    base = {"artist": "Alpha", "title": "First Pressing", "released": "1985-03-10",
            "cover": "https://art.example/500.jpg"}
    base.update(kw)
    return base


@pytest.fixture()
def one_record(monkeypatch):
    """Serve a known record for any uid, so these assert on the TAGS rather than on
    whatever the fixture catalog happens to hold."""
    def _set(album):
        monkeypatch.setattr(server, "_album_for_uid", lambda uid: album)
    return _set


def test_record_tags_carry_artist_title_and_cover(client, one_record):
    one_record(_album())
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert _meta(body, "og:title") == "Alpha — First Pressing"
    assert _meta(body, "twitter:title") == "Alpha — First Pressing"
    assert _meta(body, "og:image") == "https://art.example/500.jpg"
    assert "1985-03-10" in _meta(body, "og:description")
    # The canonical tagline stands verbatim as its own sentence (BRAND.md).
    assert _meta(body, "og:description").endswith("Find music, write notes.")
    # Square art belongs in a square card, not a cropped wide one.
    assert _meta(body, "twitter:card") == "summary"


def test_only_one_og_block_is_emitted(client, one_record):
    """Duplicate og:title would let each crawler pick a different one."""
    one_record(_album())
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert body.count('property="og:title"') == 1
    assert body.count('name="twitter:title"') == 1


def test_og_url_points_back_at_the_shared_record(client, one_record):
    one_record(_album())
    body = _get(client, "/?album=m:mb:abc").get_data(as_text=True)
    url = _meta(body, "og:url")
    assert url.startswith("https://musicforest.lol/?album=")
    assert "m%3Amb%3Aabc" in url


def test_a_record_with_no_cover_falls_back_to_the_icon(client, one_record):
    one_record(_album(cover=None))
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert _meta(body, "og:image") == "https://musicforest.lol/static/icons/icon-512.png"


def test_missing_date_omits_it_rather_than_inventing_one(client, one_record):
    one_record(_album(released=None))
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert _meta(body, "og:description") == "Find music, write notes."


# --- escaping + absolute URLs -------------------------------------------------

def test_catalog_text_is_escaped_into_the_attribute(client, one_record):
    one_record(_album(artist='"><script>alert(1)</script>', title="A & B <b>x</b>"))
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert "<script>alert(1)</script>" not in body
    assert "&quot;&gt;&lt;script&gt;" in _meta(body, "og:title")


def test_a_title_cannot_break_out_of_the_marker_block(client, one_record):
    """The end marker inside catalog text must not truncate the injected block."""
    one_record(_album(title="<!--og:end--> pwned"))
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert body.count("<!--og:end-->") == 0        # the real one was consumed
    assert "&lt;!--og:end--&gt;" in _meta(body, "og:title")


def test_a_backslash_in_the_title_is_literal(client, one_record):
    r"""re.sub processes escapes like \1 in a STRING replacement; this path uses a
    function replacement so catalog text stays literal. Pins that choice."""
    one_record(_album(title=r"Back\1slash \g<0>"))
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert r"Back\1slash \g<0>".replace("<", "&lt;").replace(">", "&gt;") \
        in _meta(body, "og:title")


def test_relative_cover_is_absolutized(client, one_record):
    one_record(_album(cover="/static/art/500.jpg"))
    body = _get(client, "/?album=d:100").get_data(as_text=True)
    assert _meta(body, "og:image") == "https://musicforest.lol/static/art/500.jpg"


def test_scheme_comes_from_x_forwarded_proto(client, one_record):
    """Render terminates TLS at its proxy and there's no ProxyFix, so request.scheme
    is http here — an http og:image is rejected or downgraded by some unfurlers."""
    one_record(_album(cover="/static/art/500.jpg"))
    r = client.get("/?album=d:100",
                   headers={"X-Forwarded-Proto": "https", "Host": "example.org"})
    body = r.get_data(as_text=True)
    assert _meta(body, "og:image") == "https://example.org/static/art/500.jpg"
    assert _meta(body, "og:url").startswith("https://example.org/")


def test_host_is_not_hard_coded_to_prod(client, one_record):
    """Staging must unfurl as staging, not as musicforest.lol."""
    one_record(_album(cover="/static/art/500.jpg"))
    body = client.get("/?album=d:100",
                      headers={"X-Forwarded-Proto": "https",
                               "Host": "music-forest-staging.onrender.com"}
                      ).get_data(as_text=True)
    assert "music-forest-staging.onrender.com" in _meta(body, "og:image")
    assert "musicforest.lol" not in _meta(body, "og:url")


# --- no cloaking --------------------------------------------------------------

def test_bots_and_people_get_the_same_html(client, one_record):
    """The page body must not vary by user-agent — only the <head> tags change, and
    they change for everyone. Serving crawlers something different is cloaking."""
    one_record(_album())
    plain = _get(client, "/?album=d:100").get_data(as_text=True)
    bot = client.get("/?album=d:100",
                     headers={**HTTPS, "User-Agent": "Twitterbot/1.0"}
                     ).get_data(as_text=True)
    assert plain == bot


def test_security_headers_still_apply_to_the_injected_response(client, one_record):
    one_record(_album())
    r = client.get("/?album=d:100", headers=HTTPS)
    assert r.headers.get("Content-Security-Policy")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.mimetype == "text/html"
