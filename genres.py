"""
Genre parsing shared across the backend.

Discogs joins an album's genres with commas, but one *official* Discogs genre —
"Folk, World, & Country" — contains commas itself. It's the only built-in genre
that does, so we protect that exact phrase before splitting so genre stats and
filters never fragment it into "Folk" / "World" / "& Country".

This logic was duplicated in server.py and journal.py (and mirrored in the
frontend's app.js). It lives here once so there's a single source of truth; the
JS copy in app.js carries a comment pointing back to this module (R4).
"""

# Genres that legitimately contain a comma and must stay atomic when splitting.
ATOMIC_GENRES = ["Folk, World, & Country"]


def split_genres(s):
    """Split a Discogs comma-joined genre string into a list, keeping the
    comma-containing atomic genres (see ATOMIC_GENRES) intact. Returns [] for
    empty/None input."""
    if not s:
        return []
    for i, g in enumerate(ATOMIC_GENRES):
        s = s.replace(g, f"@@G{i}@@")
    out = []
    for t in s.split(","):
        t = t.strip()
        if not t:
            continue
        if t.startswith("@@G") and t.endswith("@@"):
            t = ATOMIC_GENRES[int(t[3:-2])]
        out.append(t)
    return out
