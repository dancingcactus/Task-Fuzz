"""Human time: anchors, what each one works out to, and the Schedule options for a task.

An anchor is a small structured value the core understands, never free text:
    {"type": "before_due", "lead": "1d"}
The AI may suggest anchors (schedule_hints); labels always come from the templates here, so a
model swap can't change how the buttons read. Calendar anchors (before_event, after_event,
next_with_person, lighter_day) wait on calendar access and are not offered yet.
"""

import json
import re
from datetime import datetime, timedelta, timezone

from .db import FuzzError, iso, parse_iso

ANCHOR_TYPES = ("in", "later_today", "at_desk", "day_part", "lighter_day", "before_due",
                "before_event", "after_event", "next_with_person", "exact")
CALENDAR_TYPES = {"lighter_day", "before_event", "after_event", "next_with_person"}

PARTS = {"morning": 9, "afternoon": 13, "evening": 17}
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
LATER_TODAY_HOUR = 16   # "after your last meeting" until the calendar is readable
MAX_OPTIONS = 6
MAX_AI = 2

DUR_RE = re.compile(r"^(\d+)\s*([mhdw])$")
DUR_UNIT = {"m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def local_tz(core):
    name = core.config.get("tz") or "local"
    if name == "local":
        return datetime.now().astimezone().tzinfo
    from zoneinfo import ZoneInfo
    return ZoneInfo(name)


def duration(v, field="lead"):
    if isinstance(v, (int, float)):
        return timedelta(minutes=v)
    m = DUR_RE.match(str(v or "").strip())
    if not m:
        raise FuzzError(f"{field} must be a duration like 30m, 3h, 1d or 1w", field)
    return timedelta(**{DUR_UNIT[m.group(2)]: int(m.group(1))})


def _at(local_day, hour, tz):
    return datetime(local_day.year, local_day.month, local_day.day, hour, 0, tzinfo=tz)


def resolve(core, anchor, task=None, now=None):
    """The time an anchor works out to now (UTC datetime), or None for at_desk (fires on wake)."""
    if not isinstance(anchor, dict) or anchor.get("type") not in ANCHOR_TYPES:
        raise FuzzError(f"anchor.type must be one of {', '.join(ANCHOR_TYPES)}", "anchor.type")
    typ = anchor["type"]
    now = now or core.now()
    tz = local_tz(core)
    loc = now.astimezone(tz)
    if typ in CALENDAR_TYPES:
        raise FuzzError(f"{typ} needs calendar access, which the core doesn't have yet", "anchor.type")
    if typ == "in":
        return now + duration(anchor.get("minutes", anchor.get("for")), "anchor.minutes")
    if typ == "later_today":
        if loc.hour < LATER_TODAY_HOUR - 1:
            return _at(loc, LATER_TODAY_HOUR, tz).astimezone(timezone.utc)
        t = now + timedelta(hours=1)
        return t if t.astimezone(tz).date() == loc.date() and t.astimezone(tz).hour < 22 else None
    if typ == "at_desk":
        return None
    if typ == "day_part":
        part = anchor.get("part", "morning")
        if part not in PARTS:
            raise FuzzError("anchor.part must be morning, afternoon or evening", "anchor.part")
        day = (anchor.get("day") or "tomorrow").lower()
        d = loc.date()
        if day == "today":
            pass
        elif day == "tomorrow":
            d += timedelta(days=1)
        elif day in DAYS:
            ahead = (DAYS.index(day) - d.weekday()) % 7 or 7
            d += timedelta(days=ahead)
        elif day == "next_week":
            d += timedelta(days=7 - d.weekday() + 1)  # Tuesday of next week: "sometime next week"
        else:
            try:
                d = datetime.strptime(day, "%Y-%m-%d").date()
            except ValueError:
                raise FuzzError("anchor.day must be today, tomorrow, a weekday, next_week or YYYY-MM-DD",
                                "anchor.day")
        return _at(d, PARTS[part], tz).astimezone(timezone.utc)
    if typ == "before_due":
        due = parse_iso((task or {}).get("due"))
        if not due:
            raise FuzzError("before_due needs a task with a due date", "anchor.type")
        return due - duration(anchor.get("lead", "1d"), "anchor.lead")
    if typ == "exact":
        at = parse_iso(anchor.get("at"))
        if not at:
            raise FuzzError("anchor.at must be an ISO time for an exact anchor", "anchor.at")
        return at


def label(core, anchor):
    typ = anchor.get("type")
    if typ == "in":
        d = duration(anchor.get("minutes", anchor.get("for")), "anchor.minutes")
        mins = int(d.total_seconds() // 60)
        if mins < 60:
            return f"In {mins} minutes"
        hours = mins // 60
        return "In an hour" if hours == 1 else f"In {hours} hours"
    if typ == "later_today":
        return "Later today"
    if typ == "at_desk":
        return "When I’m back at my desk"
    if typ == "day_part":
        day, part = (anchor.get("day") or "tomorrow").lower(), anchor.get("part", "morning")
        if day == "tomorrow" and part == "morning":
            return "First thing tomorrow"
        if day == "next_week":
            return "Sometime next week"
        if day in DAYS:
            return f"{day.capitalize()} {part}"
        if day == "today":
            return f"This {part}"
        return f"{day} {part}"
    if typ == "before_due":
        return {"1h": "An hour before it’s due", "3h": "A few hours before it’s due",
                "1d": "The day before it’s due", "1w": "A week before it’s due"}.get(
            anchor.get("lead", "1d"), f"{anchor.get('lead')} before it’s due")
    if typ == "before_event":
        return f"Before {anchor.get('title') or 'the meeting'}"
    if typ == "after_event":
        return f"After {anchor.get('title') or 'this meeting'}"
    if typ == "next_with_person":
        return f"Next time I see {(anchor.get('name') or 'them').split()[0]}"
    if typ == "lighter_day":
        return "On a lighter day"
    if typ == "exact":
        if anchor.get("at"):
            loc = parse_iso(anchor["at"]).astimezone(local_tz(core))
            return loc.strftime("%a %-I:%M %p")
        return "Pick an exact time"
    return typ


def line(core, anchor):
    """Fuzz's sentence for a scheduled task, from the same templates as the buttons."""
    lab = label(core, anchor)
    return f"I’ll bring it back {lab[0].lower() + lab[1:]}."


def timeline(due, now):
    """The core's options from how much time is left (the design's table)."""
    if due is None:
        return [{"type": "later_today"}, {"type": "at_desk"}, {"type": "day_part", "day": "monday", "part": "morning"},
                {"type": "day_part", "day": "next_week", "part": "morning"}]
    left = due - now
    if left < timedelta(hours=6):
        return [{"type": "in", "minutes": 30}, {"type": "before_due", "lead": "1h"}]
    if left < timedelta(hours=48):
        return [{"type": "later_today"}, {"type": "at_desk"}, {"type": "day_part", "day": "tomorrow", "part": "morning"},
                {"type": "before_due", "lead": "3h"}]
    if left < timedelta(days=7):
        return [{"type": "day_part", "day": "tomorrow", "part": "morning"}, {"type": "before_due", "lead": "1d"}]
    return [{"type": "day_part", "day": "next_week", "part": "morning"}, {"type": "before_due", "lead": "1w"}]


def canonical(anchor):
    return json.dumps({k: anchor[k] for k in sorted(anchor) if k not in ("reason",)}, sort_keys=True)


def check_hint(core, task, anchor, now=None):
    """An AI suggestion is kept only if it is real, in the future and before the due date."""
    now = now or core.now()
    t = resolve(core, anchor, task, now)
    due = parse_iso(task.get("due"))
    if t is not None and (t <= now or (due and t > due)):
        raise FuzzError("That time is in the past or after the due date", "anchor")
    return t


def build_options(core, task, now=None):
    now = now or core.now()
    due = parse_iso(task.get("due"))
    out, seen = [], set()

    def add(anchor, source):
        try:
            t = resolve(core, anchor, task, now)
        except FuzzError:
            return
        if anchor["type"] != "at_desk" and t is None:
            return
        if t is not None and (t <= now or (due and t > due)):
            return
        lab = label(core, anchor)
        if lab in seen:
            return
        seen.add(lab)
        out.append({"anchor": anchor, "label": lab, "fire_at": iso(t) if t else None, "source": source})

    for h in (task.get("schedule_hints") or [])[:MAX_AI]:
        add({k: v for k, v in h.items() if k != "reason"}, "ai")
    for a in timeline(due, now):
        add(a, "core")
    out = out[:MAX_OPTIONS]
    out.append({"anchor": {"type": "exact"}, "label": "Pick an exact time", "fire_at": None, "source": "core"})
    return out


def pick(core, card, task, anchor):
    """Check a Schedule answer: an offered anchor, or an exact time. Returns (anchor, fire_at, source)."""
    if not isinstance(anchor, dict):
        raise FuzzError("value.anchor is required for schedule", "value.anchor")
    if anchor.get("type") == "exact":
        t = resolve(core, anchor, task)
        if t <= core.now():
            raise FuzzError("An exact time must be in the future", "value.anchor.at")
        return anchor, t, "exact"
    want = canonical(anchor)
    offered = card.get("schedule_options") or build_options(core, task)
    for o in offered:
        if canonical(o["anchor"]) == want:
            t = resolve(core, anchor, task)
            return anchor, t, o["source"]
    raise FuzzError("That time wasn't one of the options offered on this card", "value.anchor")
