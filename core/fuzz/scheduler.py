"""Which task a worker gets next, leases, the step budget, and the clock that brings tasks back.

All deterministic: the scheduler picks the task, never the AI.
"""

import uuid
from datetime import timedelta

from . import cards, events, tasks, timeres
from .db import FuzzError, iso, parse_iso

SESSION_OWNER = "session:" + uuid.uuid4().hex[:8]  # a chat with no run id leases as this process


def caller(core):
    return f"run:{core.run['id']}" if core.run and core.run.get("id") else SESSION_OWNER


def budget(core):
    return core.config["budget"]


def lease_until(core):
    return iso(core.now() + timedelta(minutes=budget(core)["lease_minutes"]))


def require_lease(core, task_id):
    t = tasks.require(core, task_id)
    if t["state"] != "working" or t["lease_owner"] != caller(core):
        raise FuzzError(f"You don't hold task {t['id']}. Call claim_next_task first.", "task_id", 409)
    if parse_iso(t["lease_until"]) < core.now():
        raise FuzzError(f"Your lease on task {t['id']} ran out. Call claim_next_task again.", "task_id", 409)
    return t


def expire_leases(core):
    rows = core.all("SELECT * FROM tasks WHERE user_id=? AND state='working' AND lease_until < ?",
                    (core.user_id, core.now_iso()))
    for t in rows:
        with core.tx("system"):
            ch = events.Changes()
            tasks.move(core, ch, t, "queued")
            events.emit(core, "task.released", task_id=t["id"], changes=ch, data={"why": "lease_expired"},
                        log=("status", "Fuzz's run stopped partway, so this went back to the queue."))
    return len(rows)


def hand_back(core, task_id, question, options=None, actor="fuzz:executor", log=None):
    if not (question or "").strip():
        raise FuzzError("question is what you need from the human", "question")
    t = tasks.require(core, task_id)
    with core.tx(actor):
        ch = events.Changes()
        tasks.move(core, ch, t, "triage", add_tags=("handed_back",), order_key=tasks.next_order(core),
                   **tasks.handed_back_fields(question, options))
        events.emit(core, "task.handed_back", task_id=t["id"], changes=ch, data={"question": question.strip()},
                    log=("blocked", log or f"Handed back: {question.strip()}"))
        cards.sync(core, t["id"])
    return t["id"]


def _released_by_me(core):
    """Tasks this caller released. A caller is one run (or one chat process), so a run doesn't get back
    what it just gave up; the next run will."""
    rows = core.all("SELECT task_id, payload FROM events WHERE user_id=? AND type='task.released'", (core.user_id,))
    return {r["task_id"] for r in rows if r["payload"].get("data", {}).get("by") == caller(core)}


def _eligible(core, task_id=None):
    sql = ("SELECT * FROM tasks WHERE user_id=? AND state='queued' AND assignee='fuzz'"
           + (" AND id=?" if task_id else ""))
    rows = core.all(sql, (core.user_id, task_id) if task_id else (core.user_id,))
    mine = _released_by_me(core)
    rows = [t for t in rows if "needs_permission" not in (t.get("variant_tags") or []) and t["id"] not in mine]
    rows.sort(key=lambda t: (-tasks.due_level(core, t), t["order_key"] or 0, t["created_at"] or ""))
    return rows


def claim_next(core, task_id=None):
    """Lease the next eligible task. Returns the task, or (None, why)."""
    b = budget(core)
    expire_leases(core)
    while True:
        with core.tx("fuzz:executor"):
            working = core.one("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND state='working'", (core.user_id,))["n"]
            if working >= b["max_working"]:
                return None, f"{b['max_working']} tasks are already running"
            rows = _eligible(core, task_id)
            if not rows:
                return None, ("That task isn't queued for Fuzz" if task_id else "Nothing is queued for Fuzz")
            t = rows[0]
            if t["attempts"] >= b["max_attempts"]:
                hand_back(core, t["id"], "I got stuck on this. What should I try?", ["Try again", "I’ll take it"],
                          actor="system", log=f"Claimed {t['attempts']} times with no progress, so it came back to you.")
                continue
            ch = events.Changes()
            tasks.move(core, ch, t, "working", lease_owner=caller(core), lease_until=lease_until(core),
                       attempts=t["attempts"] + 1)
            events.emit(core, "task.claimed", task_id=t["id"], changes=ch, data={"by": caller(core)},
                        log=("status", "Fuzz started on this."))
            return tasks.get(core, t["id"]), None


def log_step(core, task_id, kind, text):
    if kind not in ("research", "action", "guidance"):
        raise FuzzError("kind must be research, action or guidance", "kind")
    if not (text or "").strip():
        raise FuzzError("text says what you did, in one line", "text")
    t = require_lease(core, task_id)
    used = t["steps_used"] + 1
    with core.tx("fuzz:executor"):
        ch = events.Changes()
        ch.task(t["id"], steps_used=used, attempts=0, lease_until=lease_until(core))
        eid = events.emit(core, "task.step", task_id=t["id"], changes=ch, log=(kind, text.strip()[:500]))
        if used >= budget(core)["max_steps"]:
            hand_back(core, t["id"], "I used my step budget on this. Should I keep going?", ["Keep going", "I’ll take it"],
                      actor="system", log=f"Used all {used} steps without finishing, so it came back to you.")
    return {"event_id": eid, "steps_used": used, "handed_back": used >= budget(core)["max_steps"]}


def release(core, task_id):
    t = require_lease(core, task_id)
    with core.tx("fuzz:executor"):
        ch = events.Changes()
        tasks.move(core, ch, t, "queued")
        events.emit(core, "task.released", task_id=t["id"], changes=ch, data={"why": "released", "by": caller(core)})


def renew(core, ch, task_id):
    ch.task(task_id, lease_until=lease_until(core))


def suggest_schedule(core, task_id, anchor, reason, actor="fuzz:executor"):
    t = tasks.require(core, task_id)
    if not isinstance(anchor, dict):
        raise FuzzError("anchor is an object like {\"type\": \"before_due\", \"lead\": \"1d\"}", "anchor")
    timeres.check_hint(core, t, anchor)
    hints = [h for h in (t.get("schedule_hints") or []) if timeres.canonical(h) != timeres.canonical(anchor)]
    hints = ([dict(anchor, reason=(reason or "").strip()[:200])] + hints)[:timeres.MAX_AI]
    with core.tx(actor):
        ch = events.Changes()
        ch.task(t["id"], schedule_hints=hints)
        if t["state"] == "working":
            renew(core, ch, t["id"])
        cards.refresh_schedule_options(core, ch, t["id"])
        events.emit(core, "task.schedule_suggested", task_id=t["id"], changes=ch,
                    data={"anchor": anchor, "label": timeres.label(core, anchor)})
    return timeres.label(core, anchor)


# ---------------------------------------------------------------- the clock

def tick(core):
    """Run every minute by `fuzz serve` (and by `fuzz tick`). Returns what moved."""
    out = {"released": expire_leases(core), "came_back": 0, "deadline": 0, "stale": 0}
    now = core.now_iso()
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='scheduled' AND schedule_fire_at IS NOT NULL "
                      "AND schedule_fire_at <= ?", (core.user_id, now)):
        lab = timeres.label(core, t["schedule_anchor"] or {"type": "exact"})
        tasks.bring_back(core, t["id"], reason=f"You scheduled this for {lab[0].lower() + lab[1:]}.", actor="system")
        out["came_back"] += 1
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND due IS NOT NULL AND state NOT IN ('done','letgo','merged')",
                      (core.user_id,)):
        lvl = tasks.due_level(core, t)
        if lvl != t["deadline_level"]:
            with core.tx("system"):
                ch = events.Changes()
                tags = tasks._tags(t, add=("time_sensitive",)) if lvl else tasks._tags(t, remove=("time_sensitive",))
                ch.task(t["id"], deadline_level=lvl, variant_tags=tags)
                events.emit(core, "task.deadline_level", task_id=t["id"], changes=ch, data={"level": lvl})
            out["deadline"] += 1
    cutoff = iso(core.now() - timedelta(days=core.config["stale_days"]))
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='triage' AND state_changed_at < ?",
                      (core.user_id, cutoff)):
        if "stale" in (t.get("variant_tags") or []):
            continue
        with core.tx("system"):
            ch = events.Changes()
            ch.task(t["id"], variant_tags=tasks._tags(t, add=("stale",)), reason="Still care about this?")
            for c in cards.open_cards(core, t["id"]):
                if c["kind"] == "task":
                    ch.card(c["id"], suggested="keep")
            events.emit(core, "task.stale", task_id=t["id"], changes=ch)
        out["stale"] += 1
    return out


def wake(core):
    """You're back at your desk: everything scheduled for that comes back."""
    n = 0
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='scheduled'", (core.user_id,)):
        if (t.get("schedule_anchor") or {}).get("type") == "at_desk":
            tasks.bring_back(core, t["id"], reason="You're back at your desk.", actor="system")
            n += 1
    return n
