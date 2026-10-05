"""MusicBrainz community tags -> the tags a record shows (GENRE_BACKFILL_DESIGN.md, B2).

MusicBrainz genres are the tags whose names are in its curated genre list; everything
else people tag a release with is the free folksonomy — moods, scenes, places,
instruments ("doom", "atmospheric", "berlin", "piano") and a good deal of junk. The
dump's raw tags are stored as-is (data/mb_tags.sqlite, tools/build_mb_tags.py) and this
filter runs when serving, so the rules can change without another pass over the dump.

Owner decisions (2026-10-04): keep city and nationality tags (a rough place filter, and
the start of a real one), keep single-vote tags, and show these as tags. Measured on the
2026-08 dump: ~a third of MB records that already carry genres gain at least one tag.
"""
from __future__ import annotations

import re

# Words that say nothing about the music: chart runs, awards, someone's collection, the
# medium, or the record's packaging.
_CHART = re.compile(r"chart|wochen|top ?\d|billboard|offizielle|hitparade|platinum|"
                    r"\bgold\b|award|grammy|nominee|number one|#1", re.I)
_PERSONAL = re.compile(r"favou?rite|seen live|\bowned\b|\bmy |wishlist|to listen|"
                       r"check ?(it|out)|\bbuy\b|own it|collection|\bstars?\b|rating|"
                       r"recommend|essential|need to|\btodo\b|_to_do", re.I)
_FORMAT = re.compile(r"^(vinyl|cd|cassette|digital|tape|flac|mp3|ep|lp|single|album|"
                     r"music|genre|remaster(ed)?|reissue|deluxe( edition)?|bootleg|"
                     r"compilation|mini album|debut( album| lp)?|streaming only|isrc|"
                     r"no isrc|free download|netlabel|bandcamp|spotify|soundcloud)$|"
                     r"^ミニアルバム$", re.I)
# MusicBrainz editors' own bookkeeping: project markers, review-site batches,
# availability notes, cover-art and character tagging projects.
_MARKER = re.compile(r"^ph_|folker|jazzthing|laut\.de|plattentests|rolling stone|"
                     r"worldwide except|not on |on cover$|^character:|^parody:|"
                     r"self-titled|^#|^private/|^added/", re.I)
_DATE = re.compile(r"\d{3,}|\d+[-–/.]\d+|^\d+$")
_DECADE = re.compile(r"^(\d\d)?\d0s$")


def tag_key(t):
    """Spellings that differ only in spaces / hyphens / punctuation are one tag —
    mirrors static/app.js tagKey ("post rock" = "post-rock")."""
    return re.sub(r"[\W_]+", "", (t or "").lower())


def is_junk(name):
    """True for a tag that says nothing about the music (see the module docstring).
    Places and nationalities are NOT junk (owner, 2026-10-04); decades are kept."""
    s = " ".join((name or "").split())
    if len(s) <= 1 or "/" in s:            # x/y blends are vendor genre mash-ups
        return True
    if _DATE.search(s) and not _DECADE.match(s.lower()):
        return True
    return bool(_CHART.search(s) or _PERSONAL.search(s) or _FORMAT.search(s)
                or _MARKER.search(s))


def clean_tags(pairs, *, genres="", styles="", artist="", title=""):
    """[[name, votes], ...] from the dump -> the names to show, most-voted first.
    Drops junk, any spelling of a genre or style the record already carries, and the
    record's own artist or title used as a tag. One entry per merged spelling. Every
    vote count counts, including single votes (owner, 2026-10-04)."""
    from genres import split_genres
    seen = {tag_key(g) for g in split_genres(genres or "")}
    seen |= {tag_key(s) for s in (styles or "").split(",")}
    seen |= {tag_key(artist), tag_key(title)}
    seen.discard("")
    out = []
    ordered = sorted(((n, c) for n, c in (pairs or []) if n),
                     key=lambda nc: -(nc[1] or 0))
    for name, _votes in ordered:
        name = " ".join(str(name).replace(",", " ").split())
        k = tag_key(name)
        if not k or k in seen or is_junk(name):
            continue
        seen.add(k)
        out.append(name)
    return out
