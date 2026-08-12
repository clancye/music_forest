"""A2 (artist panel) + A3 (decade door) endpoints, and the heatmap removal."""


def test_browse_decade_filters_by_year(client):
    r = client.get("/api/browse?decade=1980s")
    assert r.status_code == 200
    data = r.get_json()
    assert data["decade"] == "1980s"
    years = [a["year"] for a in data["albums"]]
    assert years, "expected at least one 1980s album in the fixture"
    assert all(1980 <= y <= 1989 for y in years)
    assert 100 in {a["release_id"] for a in data["albums"]}  # Alpha, 1985


def test_browse_decade_other_decades(client):
    ids_2000s = {a["release_id"] for a in
                 client.get("/api/browse?decade=2000s").get_json()["albums"]}
    assert 104 in ids_2000s                                   # Epsilon, 2000
    assert 100 not in ids_2000s                               # 1985, excluded


def test_browse_decade_bogus_is_empty(client):
    for bad in ("", "nineties", "200s", "abc0s"):
        data = client.get(f"/api/browse?decade={bad}").get_json()
        assert data["albums"] == []


def test_artist_endpoint(client):
    data = client.get("/api/artist?name=Alpha").get_json()
    assert data["name"] == "Alpha"
    assert 100 in {a["release_id"] for a in data["albums"]}
    assert all("Alpha" in (a["artist"] or "") for a in data["albums"])
    # Newest-first.
    years = [a["year"] or 0 for a in data["albums"]]
    assert years == sorted(years, reverse=True)
    # A Discogs *artist* search link is offered.
    assert "type=artist" in data["discogs_url"]
    assert "Alpha" in data["discogs_url"]


def test_artist_endpoint_blank(client):
    data = client.get("/api/artist?name=%20").get_json()
    assert data["albums"] == [] and data["count"] == 0


def test_label_endpoint(client):
    # T2: the label panel — an exact-match catalogue for a label.
    data = client.get("/api/label?name=Acme%20Records").get_json()
    assert data["name"] == "Acme Records"
    assert 100 in {a["release_id"] for a in data["albums"]}
    assert all((a["label"] or "") == "Acme Records" for a in data["albums"])
    years = [a["year"] or 0 for a in data["albums"]]      # newest-first
    assert years == sorted(years, reverse=True)
    assert "type=label" in data["discogs_url"]            # Discogs label search


def test_label_endpoint_exact_not_prefix(client):
    # "Acme" must not bleed into "Acme Records" — the panel is exact-match.
    data = client.get("/api/label?name=Acme").get_json()
    assert data["albums"] == [] and data["count"] == 0


def test_label_endpoint_blank(client):
    data = client.get("/api/label?name=%20").get_json()
    assert data["albums"] == [] and data["count"] == 0


def test_journal_summary_has_no_activity(client):
    # The heatmap is gone: the summary no longer carries a day-by-day activity map.
    summary = client.get("/api/journal").get_json()["summary"]
    assert "activity" not in summary
    assert "top_genres" in summary           # but the rest of the summary remains
