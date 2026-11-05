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
    """The times Book time offers this task, best first: from the calendar the executor last reported
    (Focus time slots first), else Fuzz's own times."""
    cal = calendar(core)
    if cal is None:
        return fuzz_times(core, t, now)
    return ranked(core, t, cal, now)


# ---------------------------------------------------------------- the calendar, as the executor reads it

def _bcfg(core):
    return core.config.get("booking") or {}


def calendar(core):
    """What the executor last reported: {"slots": [{start, end, title?}], "holds": [...], "at"}, or None."""
    row = core.one("SELECT value FROM user_state WHERE user_id=? AND key='calendar'", (core.user_id,))
    v = (row or {}).get("value")
    import json
    return json.loads(v) if isinstance(v, str) and v.startswith("{") else None


def stale(core):
    """Whether the executor should read the calendar again (never read, or older than refresh_hours)."""
    cal = calendar(core)
    hours = float(_bcfg(core).get("refresh_hours", 12))
    return cal is None or parse_iso(cal["at"]) < core.now() - timedelta(hours=hours)


def is_focus(core, title):
    names = [n.lower() for n in _bcfg(core).get("slot_titles") or ["Focus time"]]
    return bool(title) and any(n in title.lower() for n in names)


def report(core, slots, holds=None, actor="fuzz:executor"):
    """The executor's report_calendar: the free time and Focus time events ahead (each {start, end, title?}),
    and what became of Fuzz's own holds ({event_id, start?, end?, cancelled?}). A hold you moved moves its
    block; one you cancelled brings the task back, as moments do. Returns counts."""
    import json
    from . import events, tasks
    from .db import FuzzError
    clean = []
    for i, s in enumerate(slots or []):
        try:
            a, b = parse_iso(s.get("start")), parse_iso(s.get("end"))
        except (TypeError, ValueError, AttributeError):
            a = b = None
        if not a or not b or b <= a:
            raise FuzzError(f"slots[{i}] needs start and end, ISO times with end after start", f"slots[{i}].start")
        clean.append({"start": iso(a), "end": iso(b), "title": (s.get("title") or "").strip()[:120] or None})
    moved = lost = 0
    with core.tx(actor):
        ch = events.Changes()
        ch.state("calendar", json.dumps({"slots": clean, "at": core.now_iso()}))
        events.emit(core, "calendar.reported", changes=ch, data={"slots": len(clean), "holds": len(holds or [])})
    for h in holds or []:
        t = _task_for_event(core, h.get("event_id"))
        if not t:
            continue
        a = dict(t["schedule_anchor"])
        if h.get("cancelled"):
            if t["state"] == "scheduled":
                tasks.bring_back(core, t["id"], reason="The hold for this was removed from your calendar.",
                                 type="task.anchor_lost", actor="system")
                lost += 1
            continue
        if h.get("start") and h.get("end") and (h["start"], h["end"]) != (a["start"], a["end"]):
            a.update(start=iso(parse_iso(h["start"])), end=iso(parse_iso(h["end"])))
            with core.tx("system"):
                ch = events.Changes()
                ch.task(t["id"], schedule_anchor=a, **({"schedule_fire_at": a["start"]} if t["state"] == "scheduled" else {}))
                events.emit(core, "task.anchor_moved", task_id=t["id"], changes=ch, data={"to": a},
                            log=("status", f"You moved its hold: now {timeres.block_label(core, a)}."))
            moved += 1
    return {"slots": len(clean), "moved": moved, "lost": lost}


def _task_for_event(core, event_id):
    if not event_id:
        return None
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND schedule_anchor IS NOT NULL AND state!='merged'", (core.user_id,)):
        if (t.get("schedule_anchor") or {}).get("event_id") == event_id:
            return t
    return None


def _holds_now(core, exclude=None):
    """Fuzz's own blocks and any hold drafts waiting, so two tasks never get the same time."""
    return own_blocks(core, exclude)


def ranked(core, t, cal, now=None):
    """The core's ranking (design, "Booking time"): inside a Focus time slot, before the due date and long
    enough; then inside one where only part fits ("Block 1 of 2"); then other free time ("Not a focus slot").
    Fuzz's own blocks are taken out first, so two shorter tasks can share a slot but never the same time."""
    import math
    now = now or core.now()
    need = timedelta(minutes=minutes_for(t))
    due = parse_iso(t.get("due"))
    taken = sorted(_holds_now(core, exclude=t["id"]))
    whole, part, other = [], [], []
    for s in cal.get("slots") or []:
        a, b = max(parse_iso(s["start"]), now), parse_iso(s["end"])
        for fa, fb in _gaps(a, b, taken):
            avail = fb - fa
            if avail < timedelta(minutes=15):
                continue
            focus = is_focus(core, s.get("title"))
            if avail >= need:
                end = fa + need
                if due and end > due:
                    continue
                (whole if focus else other).append((fa, end, focus, None))
            elif focus:
                n = math.ceil(need / avail)
                if not (due and fb > due):
                    part.append((fa, fb, True, f"Block 1 of {n}"))
    out = []
    for fa, fb, focus, note in sorted(whole) + sorted(part) + sorted(other):
        anchor = {"type": "block", "start": iso(fa), "end": iso(fb)}
        out.append({"anchor": anchor, "label": timeres.block_label(core, anchor), "fire_at": iso(fa), "source": "calendar",
                    "focus": focus, "note": note or ("In a Focus time slot" if focus else "Not a focus slot")})
        if len(out) >= OPTIONS:
            break
    return out


def _gaps(a, b, taken):
    """The parts of [a, b) not covered by taken."""
    out, cur = [], a
    for s, e in taken:
        if e <= cur or s >= b:
            continue
        if s > cur:
            out.append((cur, min(s, b)))
        cur = max(cur, e)
    if cur < b:
        out.append((cur, b))
    return out


# ---------------------------------------------------------------- the hold on your calendar

HOLD_KINDS = ("calendar_hold", "calendar_remove")


def can_hold(core):
    """Whether the sender has a calendar tool for this engine (in send.tools). Without one, the slot is
    shown for you to add, and the task is still booked in Fuzz."""
    from .config import role_engine
    client = role_engine(core.config, "sender")[0]
    names = ((core.config.get("send") or {}).get("tools") or {}).get(client) or []
    return any(k in n.lower() for n in names for k in CALENDAR_WORDS)


CALENDAR_WORDS = ("calendar", "gcal", "event")   # how calendar tools are named (Google Calendar, Outlook, …)


def link(core, t):
    return f"{(_bcfg(core).get('ui_url') or 'http://127.0.0.1:8765/').rstrip('/')}/#tasks/{t['id']}"


def hold_body(core, t):
    """A hold's body: the link to the task in Fuzz and its done-when. Its title is the task's title."""
    done_when = t.get("done_when") or t.get("ask") or t["title"]
    return f"{link(core, t)}\nDone when: {done_when}"


def ask_hold(core, t, anchor, kind="calendar_hold", why=None):
    """A draft for the sender to add (or move, or remove) the hold, through the approval gate. Always
    allow for your own calendar sends it straight on; a removal always asks first. Runs inside the
    caller's transaction. Returns the draft id, or None when there's no calendar tool."""
    from . import cards, drafts, events
    if not can_hold(core):
        return None
    auto = kind == "calendar_hold" and drafts.has_grant(core, "calendar", "own")
    did = core.new_id("drafts")
    meta = {"title": t["title"], "start": anchor.get("start"), "end": anchor.get("end"), "event_id": anchor.get("event_id")}
    ch = events.Changes()
    for d in core.all("SELECT id FROM drafts WHERE task_id=? AND user_id=? AND status='pending' AND kind=?",
                      (t["id"], core.user_id, kind)):
        ch.draft(d["id"], status="withdrawn")
    ch.draft(did, task_id=t["id"], kind=kind, target="Your calendar", body=hold_body(core, t),
             status="approved" if auto else "pending", created_at=core.now_iso(), final=1, meta=meta,
             **({"approved_by": "grant", "approved_at": core.now_iso()} if auto else {}))
    events.emit(core, "task.draft_ready", task_id=t["id"], changes=ch, data={"draft_id": did, "kind": kind, "auto": auto})
    if not auto:
        prompt = ("You finished early. Remove the hold for this from your calendar?" if kind == "calendar_remove"
                  else "Add a hold for this to your calendar?")
        reason = why or (timeres.block_label(core, anchor) if anchor.get("start") else None)
        cards.create(core, "hold", t["id"], payload={"draft_id": did, "kind": kind}, prompt=prompt, reason=reason)
    return did


def answer_hold(core, card, option):
    """Approve (the sender adds, moves or removes it), Always allow (for your own calendar, from now on), or
    Skip (no hold; the task is still booked in Fuzz)."""
    from . import cards, events
    d = core.one("SELECT * FROM drafts WHERE id=? AND user_id=?", ((card.get("payload") or {}).get("draft_id"), core.user_id))
    with core.tx("human"):
        ch = events.Changes()
        cards.mark_answered(core, ch, card, option)
        if option == "skip" or d is None or d["status"] != "pending":
            if d is not None and d["status"] == "pending":
                ch.draft(d["id"], status="withdrawn")
            events.emit(core, "card.answered", task_id=card["task_id"], changes=ch, data={"kind": "hold", "option": option},
                        log=("status", "No change to your calendar. It’s still booked in Fuzz."))
            return
        if option == "always_allow":
            gid = core.new_id("grants")
            ch.grant(gid, scope="calendar", resource="own", kind="always", task_id=card["task_id"])
        ch.draft(d["id"], status="approved", approved_by="human", approved_at=core.now_iso())
        what = {"calendar_hold": "put the hold on", "calendar_remove": "take the hold off"}[d["kind"]]
        events.emit(core, "task.approved", task_id=card["task_id"], changes=ch, data={"draft_id": d["id"], "kind": d["kind"]},
                    log=("status", f"You approved it. Fuzz will {what} your calendar."))


# ---------------------------------------------------------------- before, during and after the block

PREP = ("Your booked block starts soon. Turn what you found into a step-by-step checklist at the top of the "
        "brief (context_md), step 1 first and about two minutes, so they can start right away. Keep the title.")
BLOCK_END_OPTIONS = ["done", "keep_going", "book", "pause"]
MISSED_OPTIONS = ["book", "schedule", "park", "drop", "done"]


def _start(t):
    a = t.get("schedule_anchor") or {}
    return timeres.check_block(a) if a.get("type") == "block" else (None, None)


def tick(core):
    """Run by the clock: prep before a block, the end of a block (or a missed one), and offering to remove
    holds a task finished early no longer needs. Returns counts."""
    from . import cards, events, tasks
    out = {"prepped": 0, "ended": 0, "missed": 0, "holds_freed": 0}
    now = core.now()
    prep = timedelta(minutes=float(_bcfg(core).get("prep_minutes", 30)))
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='scheduled'", (core.user_id,)):
        tags = t.get("variant_tags") or []
        s, e = _start(t)
        if "booked" in tags and s and s - prep <= now < s and not {"prepped", "prep"} & set(tags):
            with core.tx("system"):
                ch = events.Changes()
                tasks.move(core, ch, t, "queued", add_tags=("gather", "prep"), attempts=0,
                           notes=((t.get("notes") or "") + f"\n{PREP}").strip())
                events.emit(core, "task.assigned", task_id=t["id"], changes=ch, data={"to": "fuzz", "prep": True},
                            log=("status", "Fuzz is getting the checklist ready before your block."))
            out["prepped"] += 1
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='triage'", (core.user_id,)):
        tags = t.get("variant_tags") or []
        if "block" not in tags or {"block_end", "missed_block"} & set(tags):
            continue
        s, e = _start(t)
        if not e or e > now:
            continue
        opened = core.one("SELECT 1 x FROM events WHERE user_id=? AND task_id=? AND actor='human' AND ts>=?",
                          (core.user_id, t["id"], iso(s)))
        with core.tx("system"):
            ch = events.Changes()
            cards.withdraw(core, ch, t["id"])
            if opened:
                ch.task(t["id"], variant_tags=tasks._tags(t, add=("block_end",)), reason="Your block is over. How far did you get?")
                events.emit(core, "task.block_ended", task_id=t["id"], changes=ch, log=("status", "Your block is over."))
                out["ended"] += 1
            else:
                missed = (t.get("missed_blocks") or 0) + 1
                again = missed >= 2   # repeated misses: it keeps coming back
                ch.task(t["id"], missed_blocks=0 if again else missed, order_key=tasks.next_order(core),
                        variant_tags=tasks._tags(t, add=("put_off",) if again else ("missed_block",), remove=("doing", "block")),
                        reason=tasks.PUT_OFF_REASON if again else "The block for this went by. Find another time?")
                events.emit(core, "task.block_missed", task_id=t["id"], changes=ch, data={"missed": missed},
                            log=("status", "The block for this went by without it."))
                out["missed"] += 1
            cards.sync(core, t["id"], "front" if opened else "back")
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state IN ('done', 'letgo')", (core.user_id,)):
        a = t.get("schedule_anchor") or {}
        if (a.get("type") != "block" or not a.get("event_id") or parse_iso(a["end"]) <= now
                or "hold_freed" in (t.get("variant_tags") or [])):
            continue
        with core.tx("system"):
            ch = events.Changes()
            ch.task(t["id"], variant_tags=tasks._tags(t, add=("hold_freed",)))
            events.emit(core, "card.updated", task_id=t["id"], changes=ch, data={"hold": "remove"})
            ask_hold(core, t, a, kind="calendar_remove", why="It’s done before its block.")
        out["holds_freed"] += 1
    return out


def keep_going(core, task_id, card=None):
    """Keep going: the block runs on by booking.extend_minutes, if the calendar is free then. The hold moves
    with it (the sender updates it)."""
    from . import cards, events, tasks
    from .db import FuzzError
    t = tasks.require(core, task_id)
    a = dict(t.get("schedule_anchor") or {})
    if a.get("type") != "block":
        raise FuzzError("This task has no block to extend", "option", 409)
    s, e = timeres.check_block(a)
    new_end = max(e, core.now()) + timedelta(minutes=float(_bcfg(core).get("extend_minutes", 30)))
    if not _free(e, new_end, own_blocks(core, exclude=t["id"])) or not _calendar_free(core, e, new_end):
        raise FuzzError("Your calendar isn't free after the block. Book another time instead.", "option", 409)
    a["end"] = iso(new_end)
    with core.tx("human"):
        ch = events.Changes()
        ch.task(t["id"], schedule_anchor=a, variant_tags=tasks._tags(t, remove=("block_end",)), reason=None)
        if card:
            cards.mark_answered(core, ch, card, "keep_going")
        events.emit(core, "task.block_extended", task_id=t["id"], changes=ch, data={"end": a["end"]},
                    log=("status", f"You kept going: the block now ends at {timeres.block_label(core, a, with_day=False).split('–')[1]}."))
        if a.get("event_id"):
            ask_hold(core, t, a, why="The block runs on.")
        cards.sync(core, t["id"], "front")


def _calendar_free(core, a, b):
    """Within the free time the executor last reported (no report: assumed free)."""
    cal = calendar(core)
    if cal is None:
        return True
    return any(parse_iso(s["start"]) <= a and b <= parse_iso(s["end"]) for s in cal.get("slots") or [])


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
