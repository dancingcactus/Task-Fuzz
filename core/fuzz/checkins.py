"""Check-ins: how you're doing, and what it changes about the queue.

When to ask, and how, is the UI's job (it knows how long you've been at it and keeps the ADHD
niceties: spacing that backs off, a break offer, skipping with Esc). The core keeps the answers
in the log and does what an answer means for the queue.
"""

from . import cards, events, tasks
from .db import FuzzError

ANSWERS = ("good", "okay", "tired", "overloaded")
FOLLOW_UPS = ("take_5", "hold_rest", "quick_first")
MOMENT = {"good": "any", "okay": "any", "tired": "low", "overloaded": "quick"}


def record(core, answer, follow_up=None):
    """Write checkin.answered and set the moment. hold_rest schedules the cards that aren't
    time-sensitive for tomorrow morning, in the same command, so one Undo puts them all back."""
    if answer not in ANSWERS:
        raise FuzzError(f"answer must be one of {', '.join(ANSWERS)}", "answer")
    if follow_up not in (None,) + FOLLOW_UPS:
        raise FuzzError(f"follow_up must be one of {', '.join(FOLLOW_UPS)}", "follow_up")
    moment = "quick" if follow_up == "quick_first" else MOMENT[answer]
    held = 0
    with core.tx("human"):
        ch = events.Changes()
        ch.state("moment", moment)
        if follow_up == "take_5":
            ch.state("break_until", core.now_iso())
        events.emit(core, "checkin.answered", changes=ch,
                    data={"answer": answer, "follow_up": follow_up, "moment": moment})
        if follow_up == "hold_rest":
            for c, t in cards.queue(core):
                if c["kind"] == "task" and t and t.get("deadline_level", 0) == 0:
                    tasks.schedule(core, t["id"], {"type": "day_part", "day": "tomorrow", "part": "morning"},
                                   offered_only=False)
                    held += 1
    return {"moment": moment, "held": held}
