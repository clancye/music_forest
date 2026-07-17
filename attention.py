"""
The /admin "where should my attention be" watch-list (H4) — parse BACKLOG.md's
open items into a machine-readable triage list.

BACKLOG.md ships with the deploy (it's in git), and its Workflow section defines
a deliberately machine-parseable waiting grammar, placed right after an item's
priority tag:

    ⏳ wait: YYYY-MM-DD — what unblocks it     (a dated trigger)
    ⏳ gated: <who/what>                        (someone else's move)

Each open item — a `- [ ]` checkbox line, or the tech-debt section's
`- [P3] ...` style — yields id, priority, title (its first **bold** span), and
a state:

    due      a wait: whose date has passed — "run the check it names now"
    waiting  a wait: still in the future (days_until says how long)
    gated    parked on someone else's move
    open     workable now (no marker)

Pure text-in, dicts-out (no Flask, no filesystem beyond the caller handing us
the text), so it's trivially testable; server.py's /api/admin/attention is the
one caller.
"""
import re
from datetime import date

# An open item starts a block: a checkbox item, or the tech-debt style that
# leads with a bare priority tag. Everything until the next top-level list item
# (or a heading / horizontal rule) belongs to the block.
_ITEM_START = re.compile(r"^- (?:\[ \] |(?=\[P\d\]))")
_BLOCK_END = re.compile(r"^(?:- |#|---)")

# The trailing `[a-z]?` matches sub-ticket ids (N3a / N3b / N3d, F29b…): a base id
# plus an optional letter suffix. Without it, `N3d` fell through and the item
# parsed with no id (and N3a/N3b matched a stray `N3` in their body by luck).
_ID = re.compile(r"`([A-Za-z]{1,3}#?\d+[a-z]?|R-[a-z][a-z-]*|ONB-[A-Z])`")
_PRIORITY = re.compile(r"\[P(\d)\]")
_WAIT = re.compile(r"⏳ wait:\s*(\d{4}-\d{2}-\d{2})(?:\s*—\s*([^*\n]+?))?\s*(?:\*\*|$)",
                   re.MULTILINE)
_GATED = re.compile(r"⏳ gated:\s*([^*\n]+?)\s*(?:\*\*|$)", re.MULTILINE)
_BOLD = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)


def _blocks(text):
    """Yield each open item's full text block."""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if _ITEM_START.match(lines[i]):
            j = i + 1
            while j < len(lines) and not _BLOCK_END.match(lines[j]):
                j += 1
            yield "\n".join(lines[i:j])
            i = j
        else:
            i += 1


def _title(block, item_id=None):
    """The item's name: the first **bold** span of real length (items are
    written with their name in bold, but a ⏳ marker line can carry short
    mid-sentence emphasis like **Remaining** before it — skip those), else the
    longest early bold, else the first line. Whitespace-collapsed, capped, and
    a leading "ID — " (the tech-debt style) is dropped when it repeats the id."""
    head = block[:600]
    bolds = [re.sub(r"\s+", " ", b).strip() for b in _BOLD.findall(head)]
    raw = next((b for b in bolds if len(b) >= 16),
               max(bolds, key=len) if bolds else block.splitlines()[0])
    t = re.sub(r"\s+", " ", raw).strip().strip(".").replace("`", "")
    if item_id:
        t = re.sub(r"^" + re.escape(item_id) + r"\s*(?:[—–:-]\s*)?", "", t) or t
    return t[:140] + ("…" if len(t) > 140 else "")


def parse_watchlist(text, today=None):
    """All open BACKLOG items as triage dicts:
    {id, priority, state, title, wait_date, days_until, gated_on, why}.
    `days_until` is signed (negative = overdue). Items the parser can't name
    (no id) still appear with id None rather than being dropped — the panel is
    a mirror, not a filter."""
    today = today or date.today()
    items = []
    for block in _blocks(text):
        head = block[:400]
        idm = _ID.search(head)
        pm = _PRIORITY.search(head)
        wm = _WAIT.search(block)
        gm = _GATED.search(block)
        item_id = idm.group(1) if idm else None
        it = {
            "id": item_id,
            "priority": int(pm.group(1)) if pm else None,
            "title": _title(block, item_id),
            "wait_date": None, "days_until": None,
            "gated_on": None, "why": None,
            "state": "open",
        }
        if wm:
            it["wait_date"] = wm.group(1)
            why = re.sub(r"\s+", " ", wm.group(2) or "").strip()
            # The capture stops at the next **bold**, which can shear a
            # sentence mid-word ("run the **Remaining** check" -> "run the");
            # trim back to the last completed clause when that happens.
            if why and why[-1].isalnum():
                cut = max(why.rfind(";"), why.rfind("."), why.rfind(" — "))
                if cut > 10:
                    why = why[:cut]
            it["why"] = why or None
            try:
                y, mo, d = (int(x) for x in wm.group(1).split("-"))
                delta = (date(y, mo, d) - today).days
                it["days_until"] = delta
                it["state"] = "due" if delta <= 0 else "waiting"
            except ValueError:
                it["state"] = "waiting"
        elif gm:
            it["gated_on"] = gm.group(1).strip()
            it["state"] = "gated"
        items.append(it)
    # Triage order: overdue checks first (most overdue leading), then the
    # soonest waits, then workable items by priority, then gated.
    rank = {"due": 0, "waiting": 1, "open": 2, "gated": 3}
    items.sort(key=lambda it: (
        rank[it["state"]],
        it["days_until"] if it["days_until"] is not None else 0,
        it["priority"] if it["priority"] is not None else 9))
    return items
