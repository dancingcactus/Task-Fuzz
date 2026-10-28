"""The parked review: GTD's weekly look at Someday/Maybe, a few cards at a time.

Parked tasks never nag, so without a look now and then the list only grows. Each day a few of them come
back to triage to ask "Still want this?", one card each, oldest first: keep it parked, bring it back now,
give it a time, or let it go. How many depends on your last check-in that day (none on a rough day or
before you've checked in), and never more than the weekly cap. With gathering on, Fuzz first looks
for anything that settled it or changed it, so the card says so.
"""

from datetime import timedelta

from . import cards, config, events, tasks, timeres
from .db import iso


def _today_start(core):
    local = core.now().astimezone(timeres.local_tz(core))
    return iso(local.replace(hour=0, minute=0, second=0, microsecond=0))


def energy_today(core):
    """Your last check-in answer today, or None."""
    row = core.one("SELECT payload FROM events WHERE user_id=? AND type='checkin.answered' AND ts>=? "
                   "ORDER BY id DESC LIMIT 1", (core.user_id, _today_start(core)))
    return (row["payload"].get("data") or {}).get("answer") if row else None


def _released_since(core, since):
    return core.one("SELECT COUNT(*) n FROM events WHERE user_id=? AND type='task.review_due' AND ts>=?",
                    (core.user_id, since))["n"]


def allowance(core):
    """How many more review cards may come out now: today's share by energy, within the week's cap."""
    r = core.config["review"]
    if not r["enabled"]:
        return 0
    share = r["per_day"].get(energy_today(core) or "", 0)
    week = iso(core.now() - timedelta(days=7))
    return max(0, min(share - _released_since(core, _today_start(core)), r["weekly"] - _released_since(core, week)))


def due(core, limit):
    """Parked tasks ready to be asked about, the longest unasked first. A woken one is already in view."""
    r = core.config["review"]
    rested = iso(core.now() - timedelta(days=r["rest_days"]))
    again = iso(core.now() - timedelta(days=r["again_days"]))
    rows = core.all("SELECT * FROM tasks WHERE user_id=? AND state='parked' AND COALESCE(state_changed_at,'') < ? "
                    "AND (reviewed_at IS NULL OR reviewed_at < ?) ORDER BY COALESCE(reviewed_at, state_changed_at), id",
                    (core.user_id, rested, again))
    return [t for t in rows if "woke" not in (t.get("variant_tags") or [])][:limit]


def _day(core, ts):
    d = timeres.parse_iso(ts).astimezone(timeres.local_tz(core))
    return f"{d:%B} {d.day}"


def _ask(core, t):
    kept = t.get("reviews") or 0
    if kept >= core.config["review"]["let_go_after"]:
        return f"You've kept this parked {kept} times since {_day(core, t['created_at'])}. Let it go?"
    if kept:
        return f"You kept this parked on {_day(core, t['reviewed_at'])}. Still want it?"
    return f"Parked since {_day(core, t['state_changed_at'])}. Still want this?"


def release(core):
    """Run by the clock. Returns how many parked tasks came back to ask."""
    n = allowance(core)
    if not n:
        return 0
    look = config.gathers(core.config)
    out = 0
    for t in due(core, n):
        with core.tx("system"):
            ch = events.Changes()
            fields = dict(add_tags=("review", "gather") if look else ("review",), reason=_ask(core, t),
                          order_key=tasks.next_order(core, "back"), reviewed_at=core.now_iso())
            tasks.move(core, ch, t, "queued" if look else "triage", **fields)
            events.emit(core, "task.review_due", task_id=t["id"], changes=ch,
                        log=("status", "Back from Parked to ask if you still want it."), data={"gather": look})
            cards.sync(core, t["id"])
        out += 1
    return out
