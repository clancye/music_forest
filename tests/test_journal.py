"""Journal tests: editing (D4), soft-delete + undo (D3), integrity (D5).

Notes are keyed on the source-agnostic uid (P3 M2); a Discogs album's uid is
'd:'+release_id, and that release_id rides along as denormalized provenance."""
import pytest

UID = "d:100"
ALBUM = {
    "uid": UID, "release_id": 100, "artist": "Alpha", "title": "First Pressing",
    "released": "1985-03-10",
    "discogs_url": "https://www.discogs.com/release/100",
}


def _add(journal, body="great record"):
    return journal.add_note(UID, ALBUM, body)


def test_add_and_read(fresh_journal):
    j = fresh_journal
    nid = _add(j)
    notes = j.for_album(UID)["notes"]
    assert [n["id"] for n in notes] == [nid]
    # provenance: the Discogs release_id is denormalized onto the note.
    assert notes[0]["uid"] == UID and notes[0]["release_id"] == 100
    assert j.counts()["notes"] == 1


NOT_CHOSEN = {"uid": "d:102", "release_id": 102, "artist": "Beta",
              "title": "Runner-up"}


def test_for_album_folds_in_choice_reasons(fresh_journal):
    # N1 §4.1: for_album returns your notes AND the reasons you gave when you chose
    # this record (one body of writing per album). A choice with no reason doesn't.
    j = fresh_journal
    j.add_note(UID, ALBUM, "the horns on side B")
    j.add_choice(ALBUM, NOT_CHOSEN, reasons=["the mood"], note="calmer tonight")
    j.add_choice(ALBUM, NOT_CHOSEN)                 # no reason -> excluded
    data = j.for_album(UID)
    assert [n["body"] for n in data["notes"]] == ["the horns on side B"]
    assert len(data["choices"]) == 1
    ch = data["choices"][0]
    assert ch["note"] == "calmer tonight" and ch["reasons"] == ["the mood"]
    assert ch["not_chosen_artist"] == "Beta"


def test_notes_for_artist_is_exact_match(fresh_journal):
    # N1 §4.4: the artist echo is EXACT (case-insensitive) match — never a partial
    # or fuzzy one (the honesty rule on your own words).
    j = fresh_journal
    j.add_note(UID, ALBUM, "note on alpha")                 # ALBUM artist = "Alpha"
    other = {"uid": "d:200", "release_id": 200, "artist": "Alphabeta", "title": "X"}
    j.add_note("d:200", other, "note on alphabeta")
    res = j.notes_for_artist("alpha")                       # case-insensitive
    assert [n["body"] for n in res["notes"]] == ["note on alpha"]
    assert j.notes_for_artist("Alph")["notes"] == []        # partial matches nothing


def test_notes_for_person_full_match_is_fuzzy(fresh_journal):
    # 3a: a full-name match is case/punctuation/accent-insensitive and tagged 'full'
    # (a typed name needn't be byte-exact — the honesty comes from being catalog-
    # anchored, not string-exact; NOTES_UX §4.4). Nobody unnamed surfaces.
    j = fresh_journal
    j.add_note(UID, ALBUM, "loved what rick rubin did with the drums")
    res = j.notes_for_person("Rick Rubin (2)")              # case + Discogs "(2)"
    assert [n["match_kind"] for n in res["notes"]] == ["full"]
    assert j.notes_for_person("Beyoncé")["notes"] == []     # named nobody here


def test_notes_for_person_partial_is_tagged_for_client_anchoring(fresh_journal):
    # A single distinctive token is tagged 'partial' (the CLIENT keeps it only for a
    # credited album). A common word that happens to be a name ("Will") never anchors.
    j = fresh_journal
    j.add_note(UID, ALBUM, "that rubin low end again")      # surname only -> partial
    res = j.notes_for_person("Rick Rubin")
    assert [n["match_kind"] for n in res["notes"]] == ["partial"]
    other = {"uid": "d:200", "release_id": 200, "artist": "X", "title": "Y"}
    j.add_note("d:200", other, "i will play this on repeat")   # 'will' is a stopword
    assert j.notes_for_person("Will Smith")["notes"] == []


def test_notes_for_person_respects_word_boundaries(fresh_journal):
    # A name token buried inside a larger word is never a match (greenhouse != Green).
    j = fresh_journal
    j.add_note(UID, ALBUM, "the greenhouse humidity of this mix")
    assert j.notes_for_person("Green")["notes"] == []


# test_note_threads_surfaces_only_recurring_terms and
# test_notes_with_term_is_exact_and_verbatim were removed on 2026-08-06 with the
# feature they covered — the in-note word pull, which mined your notes for
# recurring words (VISION.md P2: what you write is "not mined, not tagged").


def test_update_note_edits_body(fresh_journal):
    j = fresh_journal
    nid = _add(j, "frist take")
    assert j.update_note(nid, body="first take") is True
    assert j.for_album(UID)["notes"][0]["body"] == "first take"


def test_update_note_rejects_empty_body(fresh_journal):
    j = fresh_journal
    nid = _add(j)
    with pytest.raises(ValueError):
        j.update_note(nid, body="   ")


def test_update_note_track_and_timestamp(fresh_journal):
    j = fresh_journal
    nid = _add(j)
    j.update_note(nid, track="A1", timestamp="1:45")
    n = j.for_album(UID)["notes"][0]
    assert n["track"] == "A1" and n["timestamp"] == "1:45"
    # clearing an optional field
    j.update_note(nid, track="")
    assert j.for_album(UID)["notes"][0]["track"] is None


def test_soft_delete_hides_then_restore_brings_back(fresh_journal):
    j = fresh_journal
    nid = _add(j)
    assert j.delete_note(nid) is True
    # gone from every read...
    assert j.for_album(UID)["notes"] == []
    assert j.counts()["notes"] == 0
    assert j.feed()["notes"] == []
    # ...but recoverable
    assert j.restore_note(nid) is True
    assert [n["id"] for n in j.for_album(UID)["notes"]] == [nid]
    assert j.counts()["notes"] == 1


def test_delete_is_idempotent(fresh_journal):
    j = fresh_journal
    nid = _add(j)
    assert j.delete_note(nid) is True
    assert j.delete_note(nid) is False        # already deleted
    assert j.restore_note(nid) is True
    assert j.restore_note(nid) is False        # already live


def test_mb_only_note_has_null_release_id(fresh_journal):
    # An MB-only album has an 'm:' uid and no Discogs release_id; the note is
    # keyed on the uid and its release_id provenance is simply NULL (full parity,
    # not graceful degradation).
    j = fresh_journal
    mb_album = {"uid": "m:abc123", "artist": "Theta", "title": "Field Recording"}
    nid = j.add_note("m:abc123", mb_album, "haunting")
    notes = j.for_album("m:abc123")["notes"]
    assert [n["id"] for n in notes] == [nid]
    assert notes[0]["uid"] == "m:abc123" and notes[0]["release_id"] is None
    # it does NOT leak into a Discogs album's notes
    assert j.for_album(UID)["notes"] == []


def test_export_excludes_deleted(fresh_journal):
    j = fresh_journal
    keep = _add(j, "keep me")
    drop = _add(j, "drop me")
    j.delete_note(drop)
    bodies = {n["body"] for n in j.export_data()["notes"]}
    assert bodies == {"keep me"}


def test_listens_survive_export_import_round_trip(fresh_journal):
    """Legacy listens are unsurfaced and nothing writes them via the API
    anymore, but export_data() promises a lossless round-trip. Seed one
    directly, then export -> replace-import and confirm it comes back (not
    silently dropped), and that re-importing is idempotent."""
    j = fresh_journal
    with j._conn() as c:
        c.execute(
            "INSERT INTO listens (uid, release_id, artist, title, released, "
            "discogs_url, listened_at) VALUES (?,?,?,?,?,?,?)",
            ("d:100", 100, "Alpha", "First Pressing", "1985-03-10",
             "https://www.discogs.com/release/100", "2024-01-02T03:04:05Z"))
    payload = j.export_data()
    assert len(payload["listens"]) == 1

    # A replace-mode restore must bring the listen back, not drop it.
    res = j.import_data(payload, mode="replace")
    assert res["listens_added"] == 1
    with j._conn() as c:
        rows = list(c.execute("SELECT uid, listened_at FROM listens"))
    assert len(rows) == 1
    assert rows[0]["uid"] == "d:100"
    assert rows[0]["listened_at"] == "2024-01-02T03:04:05Z"

    # Idempotent: re-importing (merge) dedups on (uid, listened_at).
    res2 = j.import_data(payload, mode="merge")
    assert res2["listens_added"] == 0 and res2["listens_skipped"] == 1


def test_integrity_check_ok(fresh_journal):
    j = fresh_journal
    _add(j)
    ok, problems = j.integrity_check()
    assert ok is True and problems == []


def test_integrity_check_missing_db_is_ok(fresh_journal):
    # no notes added, file may not exist yet -> treated as healthy
    ok, problems = fresh_journal.integrity_check()
    assert ok is True and problems == []
