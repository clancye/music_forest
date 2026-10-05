"""v334 — the shell's same-origin scripts and stylesheet are named `?v=<build>`.

The service worker serves navigations network-first but assets cache-first, so the
first open after a deploy used to pair the NEW page with the PREVIOUS build's cached
app.js; when a build removed an element the old script wired at startup, Today came
up blank (prod, v332). The server now stamps those URLs with BUILD_VERSION, so a new
page names URLs no older cache holds. These pin the server half; the worker half
(precache + cache miss) is tests/js/sw-versioned-assets.test.mjs.
"""
import re
from pathlib import Path

import pytest
import server

ROOT = Path(server.__file__).resolve().parent
ASSET = re.compile(r'(?:src|href)="(/static/[^"#]+\.(?:js|css)(?:\?[^"]*)?)"')


def _assets(body):
    return ASSET.findall(body)


@pytest.mark.parametrize("path", ["/", "/admin", "/?album=m:mb:no-such-record"])
def test_every_shell_script_and_stylesheet_is_stamped(client, path):
    body = client.get(path).get_data(as_text=True)
    urls = _assets(body)
    assert "/static/app.js?v=" + server.BUILD_VERSION in urls
    assert "/static/style.css?v=" + server.BUILD_VERSION in urls
    unstamped = [u for u in urls if not u.endswith("?v=" + server.BUILD_VERSION)]
    assert not unstamped, f"{path} still names unversioned assets: {unstamped}"


def test_record_share_shell_is_stamped_too(client, monkeypatch):
    monkeypatch.setattr(server, "_album_for_uid", lambda uid: {
        "artist": "A", "title": "T", "released": "1985-03-10", "cover": None})
    body = client.get("/?album=d:100").get_data(as_text=True)
    assert 'content="A — T"' in body
    assert "/static/app.js?v=" + server.BUILD_VERSION in _assets(body)


def test_stamp_is_the_sw_version(client):
    sw = (ROOT / "static" / "sw.js").read_text("utf-8")
    assert re.search(r"VERSION\s*=\s*'([^']+)'", sw).group(1) == server.BUILD_VERSION


def test_icons_and_manifest_stay_unversioned(client):
    body = client.get("/").get_data(as_text=True)
    assert 'href="/static/manifest.webmanifest"' in body
    assert 'href="/static/icons/icon-192.png"' in body


def test_every_stamped_asset_is_in_the_sw_precache(client):
    """The page and the worker must agree on the URL list, or the offline shell
    loads a page whose scripts were never precached."""
    body = client.get("/").get_data(as_text=True)
    paths = {u.split("?", 1)[0] for u in _assets(body)}
    sw = (ROOT / "static" / "sw.js").read_text("utf-8")
    precached = set(re.findall(r"versioned\('([^']+)'\)", sw))
    assert paths == precached


def test_shell_revalidates(client):
    r = client.get("/")
    assert r.headers["Cache-Control"] == "no-cache"
    etag = r.headers["ETag"]
    again = client.get("/", headers={"If-None-Match": etag})
    assert again.status_code == 304
