"""Task states and the moves between them. Undo (task.restored) is the only thing that skips this table."""

from .db import FuzzError

STATES = ("triage", "queued", "working", "review", "sending", "session", "scheduled", "waiting", "parked",
          "done", "letgo", "merged")

CLOSED = ("done", "letgo")
LIVE = ("triage", "queued", "working", "review", "sending", "session", "scheduled", "waiting", "parked")

ASSIGNEE = {"triage": "human", "queued": "fuzz", "working": "fuzz", "review": "human", "sending": "fuzz",
            "session": "session", "scheduled": "human", "waiting": None, "parked": None,
            "done": None, "letgo": None, "merged": None}

_ANY_HUMAN = {"triage", "queued", "session", "scheduled", "waiting", "parked", "done", "letgo", "merged"}

MOVES = {
    "triage": _ANY_HUMAN,
    "queued": {"working", "triage", "done", "letgo", "parked", "merged", "session", "scheduled", "waiting"},
    "working": {"queued", "review", "triage", "done", "letgo", "merged"},
    "review": {"done", "queued", "triage", "waiting", "letgo", "parked", "merged", "sending", "scheduled"},
    # approved: Fuzz's sender sends it with its own connectors, or it comes back to review if it can't
    "sending": {"done", "waiting", "review", "triage", "letgo", "merged"},
    "session": {"done", "triage", "queued", "parked", "letgo", "scheduled", "waiting", "merged"},
    "scheduled": {"triage", "done", "letgo", "merged", "queued", "parked"},
    "waiting": {"triage", "done", "letgo", "queued", "review", "parked", "merged"},
    "parked": {"triage", "done", "letgo", "queued", "merged"},
    "done": {"triage"},
    "letgo": {"triage"},
    "merged": set(),
}


def check(frm, to):
    if to not in STATES:
        raise FuzzError(f"Unknown state {to!r}", "state")
    if frm != to and to not in MOVES[frm]:
        raise FuzzError(f"A task can't move from {frm} to {to}", "state", 409)
