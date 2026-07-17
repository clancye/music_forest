import json, os, sqlite3, sys, tempfile
from pathlib import Path
# Repo root = two levels up from tests/js/, regardless of the invoking cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
tmp = Path(tempfile.mkdtemp())
import config
config.JOURNAL_DB_PATH = tmp / "journal.db"
config.JOURNAL_BACKUP_DIR = tmp / "backups"
import journal

# Insert notes with controlled, distinct created_at so ordering is deterministic.
notes_input = [
  # body crafted to exercise unigrams, bigrams, capitalized phrases, contained-term dedup
  (1, 101, "Nina Simone", "Pastel Blues", "The Irish Cancer Society came to mind, grief and grief again."),
  (2, 101, "Nina Simone", "Pastel Blues", "More grief here, the Irish Cancer Society once more."),
  (3, 202, "Miles Davis", "Kind of Blue", "Blue trumpet, late night, the blue hour. grief too."),
  (4, 303, "Burial", "Untrue", "rain rain rain, the blue hour returns, night bus home."),
  (5, 303, "Burial", "Untrue", "night bus again, rain on glass."),
]
conn = sqlite3.connect(config.JOURNAL_DB_PATH)
conn.executescript(journal.SCHEMA)
for nid, rid, artist, body_artist_title in [(n[0], n[1], n[2], n) for n in notes_input]:
    pass
for nid, rid, artist, title, body in notes_input:
    created = f"2026-06-20T10:00:0{nid}"
    conn.execute("INSERT INTO notes (id, release_id, artist, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                 (nid, rid, artist, title, body, created, created))
# v8: a typed note (person) has NULL artist/title — its label lives in `ref`, so
# feed("nigel") must find it via _ref_search_text (parity with refSearchText).
_typed_ref = {"kind": "person", "name": "Nigel Godrich", "person_id": 169094}
conn.execute("INSERT INTO notes (id, uid, artist, title, body, ref, created_at, updated_at) "
             "VALUES (?,?,?,?,?,?,?,?)",
             (6, "per:169094", None, None, "his production fingerprints",
              json.dumps(_typed_ref), "2026-06-20T10:00:06", "2026-06-20T10:00:06"))
conn.commit(); conn.close()

# Choices across artists/genres/decades/reasons
choices_input = [
  dict(chosen=dict(release_id=101, artist="Nina Simone", title="Pastel Blues", released="1965", discogs_url="u1", genres="Jazz, Blues", year=1965),
       not_chosen=dict(release_id=999, artist="X", title="Y"), reasons=["the voice","mood"], note="n1", day="06-20"),
  dict(chosen=dict(release_id=202, artist="Miles Davis", title="Kind of Blue", released="1959", discogs_url="u2", genres="Jazz", year=1959),
       not_chosen=dict(release_id=998, artist="Z", title="W"), reasons=["mood"], note=None, day="06-20"),
  dict(chosen=dict(release_id=303, artist="Burial", title="Untrue", released="2007", discogs_url="u3", genres="Electronic, Dubstep", year=2007),
       not_chosen=None, reasons=[], note=None, day="06-21"),
]
for p in choices_input:
    journal.add_choice(p["chosen"], p["not_chosen"], p["day"], p["reasons"], p["note"])

out = {
  "notes_input": [
     dict(id=n[0], release_id=n[1], artist=n[2], title=n[3], body=n[4],
          created_at=f"2026-06-20T10:00:0{n[0]}", updated_at=f"2026-06-20T10:00:0{n[0]}",
          track=None, timestamp=None)
     for n in notes_input] + [
     dict(id=6, uid="per:169094", release_id=None, artist=None, title=None,
          body="his production fingerprints", ref=_typed_ref,
          created_at="2026-06-20T10:00:06", updated_at="2026-06-20T10:00:06",
          track=None, timestamp=None)],
  "choices_input": [
     dict(chosen_id=p["chosen"]["release_id"], chosen_artist=p["chosen"]["artist"],
          chosen_title=p["chosen"]["title"], chosen_released=p["chosen"]["released"],
          chosen_discogs_url=p["chosen"]["discogs_url"], chosen_genres=p["chosen"]["genres"],
          chosen_year=p["chosen"]["year"], reasons=p["reasons"], note=p["note"],
          chosen_at=f"2026-06-20T09:00:0{i}", day_context=p["day"])
     for i, p in enumerate(choices_input)],
  "expected": {
    "subjects": journal.subjects(min_notes=2, limit=40),
    "subject_graph": journal.subject_graph(min_notes=2, limit=40),
    "choices_stats": journal.choices_stats(),
    "feed_all": journal.feed()["notes"],
    "feed_grief": journal.feed("grief")["notes"],
    "feed_nigel": journal.feed("nigel")["notes"],   # v8: typed note found via ref label
    "counts": journal.counts(),
  }
}
# Override chosen_at in DB to deterministic values so choices_stats is stable
conn = sqlite3.connect(config.JOURNAL_DB_PATH)
rows = conn.execute("SELECT id FROM choices ORDER BY id").fetchall()
for i, (pid,) in enumerate(rows):
    conn.execute("UPDATE choices SET chosen_at=? WHERE id=?", (f"2026-06-20T09:00:0{i}", pid))
conn.commit(); conn.close()
# recompute the choices-dependent expectations after fixing chosen_at
out["expected"]["choices_stats"] = journal.choices_stats()
print(json.dumps(out))
