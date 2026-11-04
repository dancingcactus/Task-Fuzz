"""A task's size, and Book time: "I'll do it then; hold the time" (design: "Working sessions").

Every card shows a size, "≈ 1½ h · 6 steps", from the brief's effort_mins and step_count. A task is big
at work.big_minutes (45) or more, or work.big_steps (5) or more steps, and its card leads with four
choices: Do it now, Book time, After the others, Just the first step.

Book time puts the task in a block (anchor {"type": "block", "start", "end"}) and brings it back first in
the list, in work mode, when the block starts. The times offered are Fuzz's own here; with the calendar
(see "Booking time") they come from your Focus time slots first.
"""

from datetime import timedelta, timezone

from . import timeres
from .db import iso, parse_iso

DEFAULT_MINUTES = 30      # a task with no estimate is booked for half an hour
BLOCK_MAX = 120           # a longer task is booked in blocks of at most this
WORK_HOURS = (9, 17)
OPTIONS = 4


def _cfg(core):
    w = core.config.get("work") or {}
    return {"big_minutes": w.get("big_minutes", 45), "big_steps": w.get("big_steps", 5)}


def is_big(core, t):
    c = _cfg(core)
    return bool((t.get("effort_mins") or 0) >= c["big_minutes"] or (t.get("step_count") or 0) >= c["big_steps"])


def _mins(m):
    if m < 60:
        return f"≈ {m} min"
    h, r = divmod(m, 60)
    half = r >= 15 and r < 45
    h += 1 if r >= 45 else 0
    return f"≈ {h}{'½' if half else ''} h"


def size(core, t):
    """{"label": "≈ 1½ h · 6 steps", "minutes", "steps", "big"}, or None when there's no estimate yet."""
    m, n = t.get("effort_mins"), t.get("step_count")
    if not m and not n:
        return None
    parts = ([_mins(m)] if m else []) + ([f"{n} step{'s' if n != 1 else ''}"] if n else [])
    return {"label": " · ".join(parts), "minutes": m, "steps": n, "big": is_big(core, t)}


def own_blocks(core, exclude=None):
    """The blocks Fuzz has booked for other tasks, so it never double-books: [(start, end)]."""
    out = []
    for t in core.all("SELECT id, schedule_anchor FROM tasks WHERE user_id=? AND state IN ('scheduled', 'triage', 'queued')",
                      (core.user_id,)):
        a = t.get("schedule_anchor") or {}
        if a.get("type") == "block" and t["id"] != exclude:
            try:
                out.append(timeres.check_block(a))
            except Exception:
                pass
    return out


def _free(start, end, taken):
    return not any(s < end and start < e for s, e in taken)


def minutes_for(t):
    return min(int(t.get("effort_mins") or DEFAULT_MINUTES), BLOCK_MAX)


def fuzz_times(core, t, now=None):
    """Book time without a calendar: the next working-hour starts (later today, tomorrow morning and
    afternoon, the next weekday), each long enough for the task, before it's due and clear of Fuzz's own
    blocks."""
    now = now or core.now()
    tz = timeres.local_tz(core)
    loc = now.astimezone(tz)
    need = timedelta(minutes=minutes_for(t))
    due = parse_iso(t.get("due"))
    taken = own_blocks(core, exclude=t["id"])
    starts = []
    nxt = (loc + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    if loc.weekday() < 5 and WORK_HOURS[0] <= nxt.hour and (nxt + need).hour <= WORK_HOURS[1]:
        starts.append(nxt)
    d = loc.date()
    while len(starts) < 12:
        d += timedelta(days=1)
        if d.weekday() >= 5:
            continue
        for h in (WORK_HOURS[0], 14):
            starts.append(timeres._at(d, h, tz))
    out = []
    for s in starts:
        s_utc, e_utc = s.astimezone(timezone.utc), (s + need).astimezone(timezone.utc)
        if s_utc <= now or (due and e_utc > due) or not _free(s_utc, e_utc, taken):
            continue
        anchor = {"type": "block", "start": iso(s_utc), "end": iso(e_utc)}
        out.append({"anchor": anchor, "label": timeres.block_label(core, anchor), "fire_at": iso(s_utc),
                    "source": "fuzz", "focus": False})
        if len(out) >= OPTIONS:
            break
    return out


def options(core, t, now=None):
    """The times Book time offers this task, best first."""
    return fuzz_times(core, t, now)


def check(core, t, anchor):
    """A Book time answer: a block in the future, clear of Fuzz's own blocks. Returns (start, end)."""
    from .db import FuzzError
    if not isinstance(anchor, dict) or anchor.get("type") != "block":
        raise FuzzError("value.anchor is a block {type: block, start, end}", "value.anchor")
    s, e = timeres.check_block(anchor)
    if s <= core.now():
        raise FuzzError("That block has already started", "value.anchor.start")
    if not _free(s, e, own_blocks(core, exclude=t["id"])):
        raise FuzzError("Fuzz already booked another task then", "value.anchor")
    return s, e
