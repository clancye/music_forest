"""Emergent subjects — the layer that replaced structured connections.

(File name kept because the test runner can't rename it here; the structured
connection layer was retired in favor of subjects that emerge from note text.)
"""
ALBUM = {
    "release_id": 100, "artist": "Bell X1", "title": "Tour de Flock",
    "released": "2014-01-01",
    "discogs_url": "https://www.discogs.com/release/6236290",
}


def test_recurring_term_surfaces(fresh_journal):
    j = fresh_journal
    j.add_note(100, ALBUM, "The animation here is gorgeous.")
    j.add_note(100, ALBUM, "More animation talk — I keep coming back to it.")
    terms = {s["term"].lower(): s["count"] for s in j.subjects(min_notes=2)}
    assert terms.get("animation") == 2


def test_single_occurrence_below_threshold(fresh_journal):
    j = fresh_journal
    j.add_note(100, ALBUM, "a wholly unique singular phrasing")
    assert j.subjects(min_notes=2) == []


def test_stopwords_excluded(fresh_journal):
    j = fresh_journal
    j.add_note(100, ALBUM, "the and with from this that")
    j.add_note(100, ALBUM, "the and with from this that")
    assert j.subjects(min_notes=2) == []


def test_phrase_subsumes_subphrases(fresh_journal):
    j = fresh_journal
    j.add_note(100, ALBUM, "Saw the Irish Cancer Society short film.")
    j.add_note(100, ALBUM, "Irish Cancer Society came up again today.")
    terms = [s["term"] for s in j.subjects(min_notes=2)]
    assert "Irish Cancer Society" in terms
    # the redundant sub-phrases/word don't also appear
    assert "Irish Cancer" not in terms
    assert "Cancer Society" not in terms


def test_markdown_link_target_not_indexed(fresh_journal):
    j = fresh_journal
    # the word "animation" only appears as link *text*; the URL host must not
    # become a subject
    j.add_note(100, ALBUM, "[animation](https://example.com/spacewalk)")
    j.add_note(100, ALBUM, "animation again")
    terms = {s["term"].lower() for s in j.subjects(min_notes=2)}
    assert "animation" in terms
    assert "example" not in terms and "spacewalk" not in terms


def test_deleted_notes_excluded(fresh_journal):
    j = fresh_journal
    j.add_note(100, ALBUM, "ambient ambient")
    nid = j.add_note(100, ALBUM, "ambient mostly")
    j.delete_note(nid)
    # only one live note mentions "ambient" now -> below threshold
    assert all(s["term"].lower() != "ambient" for s in j.subjects(min_notes=2))


def test_subject_is_retrievable_via_search(fresh_journal):
    j = fresh_journal
    j.add_note(100, ALBUM, "the animation is wonderful")
    j.add_note(100, ALBUM, "animation again")
    # clicking a subject = searching the journal for it
    assert len(j.feed("animation")["notes"]) == 2


# --- C1: the subjects as a place to wander (clearings + co-occurrence trails) -

def test_subject_graph_clearings_and_notes(fresh_journal):
    j = fresh_journal
    n1 = j.add_note(100, ALBUM, "Donegal, the rain and the sea.")
    n2 = j.add_note(100, ALBUM, "More Donegal, rain again.")
    g = j.subject_graph(min_notes=2)
    nodes = {s["term"].lower(): s for s in g["subjects"]}
    # each surfaced subject is a clearing carrying the notes it came from
    assert nodes["donegal"]["count"] == 2
    assert set(nodes["donegal"]["note_ids"]) == {n1, n2}
    assert set(nodes["rain"]["note_ids"]) == {n1, n2}
    # the referenced notes are returned once each, with their bodies
    assert set(g["notes"].keys()) == {n1, n2}
    assert "Donegal" in g["notes"][n1]["body"]


def test_subject_graph_trails_are_cooccurrence(fresh_journal):
    j = fresh_journal
    # every subject must recur (>= 2 notes). "rain" shares both of Donegal's
    # notes; "sea" shares only one — a fainter trail.
    j.add_note(100, ALBUM, "Donegal, the rain and the sea.")
    j.add_note(100, ALBUM, "More Donegal, rain again.")
    j.add_note(100, ALBUM, "Calm by the sea, only the sea.")
    g = j.subject_graph(min_notes=2)
    nodes = {s["term"].lower(): s for s in g["subjects"]}
    trails = {t["term"].lower(): t["shared"] for t in nodes["donegal"]["trails"]}
    assert trails["rain"] == 2          # busiest trail: together in both notes
    assert trails.get("sea") == 1       # a fainter trail: one shared note
    # trails are sorted busiest-first
    shared = [t["shared"] for t in nodes["donegal"]["trails"]]
    assert shared == sorted(shared, reverse=True)


def test_subject_graph_empty_below_threshold(fresh_journal):
    j = fresh_journal
    j.add_note(100, ALBUM, "a wholly singular line")
    g = j.subject_graph(min_notes=2)
    assert g["subjects"] == [] and g["notes"] == {}
    assert g["notes_total"] == 1
