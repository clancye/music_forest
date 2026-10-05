"""mbtags: MusicBrainz community tags -> the tags a record shows (B2).

The filter runs when serving, so its rules are the whole contract: junk and editors'
bookkeeping go; places, nationalities, decades and single-vote tags stay (owner,
2026-10-04); a tag that only respells a genre or style the record already has, or names
the record itself, goes.
"""
import mbtags


def test_keeps_the_fun_layer():
    for t in ["doom", "atmospheric", "lofi", "chillhop", "retrowave", "piano",
              "80s", "1980s", "k-pop", "drum & bass", "r&b", "post-punk", "ai"]:
        assert not mbtags.is_junk(t), t


def test_keeps_places_and_nationalities():
    for t in ["berlin", "los angeles", "brooklyn", "german", "japanese", "united kingdom"]:
        assert not mbtags.is_junk(t), t


def test_drops_junk():
    for t in ["offizielle charts", "1–4 wochen", "5+ wochen", "pop/rock", "hip-hop/rap",
              "2009", "24-44", "folker 25–04", "favorites", "seen live", "my top 10",
              "check it", "compilation", "ep", "album", "music", "genre", "isrc",
              "streaming only", "free download", "x", "ミニアルバム"]:
        assert mbtags.is_junk(t), t


def test_drops_editor_markers():
    for t in ["ph_temp_checken", "ph_3_stars", "folker.world", "jazzthing.de", "laut.de",
              "plattentests.de", "rollingstone.de [4.5/5]", "worldwide except palestine",
              "not on youtube music", "animal on cover", "character: cross",
              "parody: genshin impact", "self-titled", "#fableep",
              "private/0994201a", "added/2018/05/05"]:
        assert mbtags.is_junk(t), t


def test_clean_tags_orders_by_votes_and_keeps_single_votes():
    pairs = [["berlin", 1], ["doom", 3], ["stoner", 2]]
    assert mbtags.clean_tags(pairs) == ["doom", "stoner", "berlin"]


def test_clean_tags_drops_respellings_of_genres_and_styles():
    pairs = [["hip-hop", 4], ["boom bap", 2], ["shoegaze", 1], ["dream pop", 1]]
    out = mbtags.clean_tags(pairs, genres="Hip Hop", styles="Shoegaze")
    assert out == ["boom bap", "dream pop"]


def test_clean_tags_drops_the_records_own_names():
    pairs = [["daryl evans", 1], ["the stelliferous era", 1], ["psychedelic", 1]]
    out = mbtags.clean_tags(pairs, artist="Daryl Evans", title="The Stelliferous Era")
    assert out == ["psychedelic"]


def test_clean_tags_merges_spellings_and_strips_commas():
    pairs = [["post rock", 2], ["post-rock", 1], ["rock, roll", 1]]
    out = mbtags.clean_tags(pairs)
    assert out == ["post rock", "rock roll"]
    assert all("," not in t for t in out)


def test_clean_tags_tolerates_empty_and_bad_input():
    assert mbtags.clean_tags(None) == []
    assert mbtags.clean_tags([["", 3], [None, 1]]) == []


def test_atomic_discogs_genre_counts_as_one():
    pairs = [["folk, world, & country", 1], ["celtic", 1]]
    out = mbtags.clean_tags(pairs, genres="Folk, World, & Country")
    assert out == ["celtic"]
