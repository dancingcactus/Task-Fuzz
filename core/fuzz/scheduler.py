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
    sends = core.all("SELECT * FROM tasks WHERE user_id=? AND state='sending' AND lease_owner IS NOT NULL "
                     "AND lease_until < ?", (core.user_id, core.now_iso()))
    for t in sends:
        # It may have gone out before the run stopped. Sending again could send it twice, so it's yours to check.
        from . import drafts
        d = drafts.approved_draft(core, t["id"])
        if d:
            drafts.send_failed(core, t["id"], d["id"], "Fuzz's send run stopped partway, so it may or may not have "
                               "gone out. Check before you approve it again.", actor="system",
                               log="The send run stopped partway, so this came back to you to check.")
    for t in rows:
        with core.tx("system"):
            ch = events.Changes()
            tasks.move(core, ch, t, "queued")
            events.emit(core, "task.released", task_id=t["id"], changes=ch, data={"why": "lease_expired"},
                        log=("status", "Fuzz's run stopped partway, so this went back to the queue."))
    return len(rows) + len(sends)


RESULT_PROMPT = "Here’s what you asked for. Done?"


def hand_back(core, task_id, question, options=None, actor="fuzz:executor", log=None, result=False, hold=False):
    """result: the brief is the deliverable, so the card's main answer is Done, with at most one
    follow-up the human can tap to send Fuzz further.

    hold: you scheduled it, so it waits as scheduled and comes to triage, handed back, at that time."""
    if result:
        question = (question or "").strip() or RESULT_PROMPT
        if len([o for o in options or [] if o and o.strip()]) > 1:
            raise FuzzError("a result offers at most one follow-up, like “Dig into the Q3 numbers”", "options")
    if not (question or "").strip():
        raise FuzzError("question is what you need from the human", "question")
    t = tasks.require(core, task_id)
    if result and not t.get("context_md"):
        raise FuzzError("A result needs the brief first: write it with update_brief(context_md=…)", "result")
    with core.tx(actor):
        ch = events.Changes()
        tasks.move(core, ch, t, "scheduled" if hold else "triage",
                   add_tags=("handed_back", "result") if result else ("handed_back",),
                   order_key=tasks.next_order(core), **tasks.handed_back_fields(question, options))
        events.emit(core, "task.handed_back", task_id=t["id"], changes=ch,
                    data={"question": question.strip(), "result": bool(result)},
                    log=("action", log or "Finished. The result is in the brief.") if result
                    else ("blocked", log or f"Handed back: {question.strip()}"))
        cards.sync(core, t["id"])
    if result:   # the result is kept in the task's output folder too
        from . import outputs
        outputs.save_markdown(core, t["id"], "Result.md", t["context_md"], actor=actor)
    return t["id"]


def gathering(t):
    return "gather" in (t.get("variant_tags") or [])


GATHER_REFUSED = ("Task {id} is only being gathered: it goes to the person's triage next, and they decide what "
                  "happens. Write what you found with update_brief, then call finish_gathering.")


def refuse_while_gathering(t):
    if gathering(t):
        raise FuzzError(GATHER_REFUSED.format(id=t["id"]), "task_id", 409)


def holding(core, t):
    """You scheduled it and asked Fuzz to look into it meanwhile, and its time hasn't come yet."""
    a = t.get("schedule_anchor")
    if not a:
        return False
    return (t.get("schedule_fire_at") or "") > core.now_iso() if t.get("schedule_fire_at") else a.get("type") == "at_desk"


def finish_gathering(core, task_id, actor="fuzz:executor", log=None, result=False, options=None, hold=True):
    """The context is in: the task goes to triage as captured, with its card, and nothing asked.

    result: looking it up was the whole task (a summary, an agenda, an answer), so it arrives done, as a
    result whose main answer is Done, and you never had to assign it.
    hold: one you scheduled waits as scheduled until its time instead (False: its time came)."""
    t = tasks.require(core, task_id)
    if not gathering(t):
        raise FuzzError(f"Task {t['id']} isn't being gathered", "task_id", 409)
    if "plan_wait" in (t.get("variant_tags") or []):
        return _done_planning(core, t, actor, log)
    held = hold and holding(core, t)
    result = result and "review" not in (t.get("variant_tags") or [])   # a parked review only asks; you decide
    back = f" It comes back {timeres.label(core, t['schedule_anchor']).lower()}." if held else ""
    if result:
        if not core.config["gather"]["finish_results"]:
            raise FuzzError("Finishing tasks while gathering is turned off: call finish_gathering without result",
                            "result")
        return hand_back(core, t["id"], None, options, actor=actor, result=True, hold=held,
                         log=(log or "Finished while gathering. The result is in the brief.") + back)
    with core.tx(actor):
        ch = events.Changes()
        if held:
            tasks.move(core, ch, t, "scheduled")
        else:
            tasks.move(core, ch, t, "triage", schedule_anchor=None, schedule_fire_at=None)
        events.emit(core, "task.gathered", task_id=t["id"], changes=ch,
                    log=("status", (log or ("Fuzz gathered what it could find." if t.get("context_md")
                                            else "Fuzz found nothing more to add.")) + back))
        cards.sync(core, t["id"])
    return t["id"]


def _done_planning(core, t, actor, log=None):
    """Fuzz looked at a task you're waiting on: it waits, with the check-back time it picked or the default."""
    with core.tx(actor):
        ch = events.Changes()
        tasks.move(core, ch, t, "waiting", remove_tags=("plan_wait",))
        when = tasks._when(core, t["schedule_fire_at"]) if t.get("schedule_fire_at") else "in a few days"
        events.emit(core, "task.gathered", task_id=t["id"], changes=ch,
                    log=("status", log or f"Waiting on {t.get('waiting_on') or 'them'}. Fuzz checks back {when}, "
                                          "sooner if they reply."))
        cards.sync(core, t["id"])
    return t["id"]


def set_check_back(core, task_id, at, reason, beyond_a_week_because=None, actor="fuzz:executor"):
    """When to ask if they got back to you, picked from the context. Within a week unless there's a reason
    to wait longer (they're out, it's due later), and never more than a month."""
    t = require_lease(core, task_id)
    if "plan_wait" not in (t.get("variant_tags") or []):
        raise FuzzError(f"Task {t['id']} isn't waiting on anyone: check_back is only for planning_wait tasks.",
                        "check_back", 409)
    if not (reason or "").strip():
        raise FuzzError("check_back.reason says why then, in a sentence the person will read", "check_back.reason")
    when = parse_iso(timeres.local_iso(core, at))
    longest = tasks.CHECK_BACK_LONGEST if (beyond_a_week_because or "").strip() else tasks.CHECK_BACK_WEEK
    if when <= core.now() + timedelta(hours=1):
        raise FuzzError("check_back.at must be more than an hour from now", "check_back.at")
    if when > core.now() + timedelta(days=longest, hours=12):
        raise FuzzError(f"check_back.at must be within {longest} days" + ("" if longest == tasks.CHECK_BACK_LONGEST else
                        "; add beyond_a_week_because when there's strong evidence it should be later"), "check_back.at")
    why = reason.strip()[:200] + (f" ({beyond_a_week_because.strip()[:200]})" if longest == tasks.CHECK_BACK_LONGEST else "")
    with core.tx(actor):
        ch = events.Changes()
        ch.task(t["id"], schedule_fire_at=iso(when))
        renew(core, ch, t["id"])
        events.emit(core, "task.check_back_set", task_id=t["id"], changes=ch, data={"at": iso(when), "why": why},
                    log=("status", f"Fuzz will check back {tasks._when(core, iso(when))}: {why}"))
    return {"at": iso(when), "label": tasks._when(core, iso(when))}


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
    # a task waiting to be gathered goes first: you're about to see it in triage
    rows.sort(key=lambda t: (not gathering(t), -tasks.due_level(core, t), t["order_key"] or 0, t["created_at"] or ""))
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
            if t["attempts"] >= b["max_attempts"] and gathering(t):
                finish_gathering(core, t["id"], actor="system",
                                 log="Fuzz couldn't gather context for this, so it came to you as captured.")
                continue
            if t["attempts"] >= b["max_attempts"]:
                hand_back(core, t["id"], "I got stuck on this. What should I try?", ["Try again", "I’ll take it"],
                          actor="system", log=f"Claimed {t['attempts']} times with no progress, so it came back to you.")
                continue
            ch = events.Changes()
            tasks.move(core, ch, t, "working", lease_owner=caller(core), lease_until=lease_until(core),
                       attempts=t["attempts"] + 1)
            events.emit(core, "task.claimed", task_id=t["id"], changes=ch, data={"by": caller(core)},
                        log=("status", "Fuzz is gathering context." if gathering(t) else "Fuzz started on this."))
            return tasks.get(core, t["id"]), None


def sends_waiting(core):
    return core.one("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND state='sending' AND lease_owner IS NULL",
                    (core.user_id,))["n"]


def claim_next_send(core):
    """Lease the oldest approved draft waiting to go out. Returns (task, draft), or (None, why)."""
    from . import drafts
    expire_leases(core)
    with core.tx("fuzz:sender"):
        t = core.one("SELECT * FROM tasks WHERE user_id=? AND state='sending' AND lease_owner IS NULL "
                     "ORDER BY state_changed_at, id LIMIT 1", (core.user_id,))
        if t is None:
            return None, "Nothing is waiting to be sent"
        ch = events.Changes()
        ch.task(t["id"], lease_owner=caller(core), lease_until=lease_until(core))
        events.emit(core, "task.claimed", task_id=t["id"], changes=ch, data={"by": caller(core), "to": "send"})
        return tasks.get(core, t["id"]), drafts.approved_draft(core, t["id"])


def require_send_lease(core, task_id):
    t = tasks.require(core, task_id)
    if t["state"] != "sending" or t["lease_owner"] != caller(core):
        raise FuzzError(f"You don't hold task {t['id']}. Call claim_next_send first.", "task_id", 409)
    if parse_iso(t["lease_until"]) < core.now():
        raise FuzzError(f"Your lease on task {t['id']} ran out, so it went back to the human.", "task_id", 409)
    return t


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
    """Add a time to this task's Schedule options. A moment with a key the task already has replaces
    it, and a task scheduled on that moment moves with it, or comes back if it was cancelled."""
    t = tasks.require(core, task_id)
    if not isinstance(anchor, dict):
        raise FuzzError("anchor is an object like {\"type\": \"moment\", \"label\": …, \"at\": …}", "anchor")
    anchor = {k: v for k, v in anchor.items() if k != "reason"}
    moment = anchor.get("type") == "moment"
    if moment and isinstance(anchor.get("label"), str) and not anchor.get("key"):
        anchor["key"] = timeres.moment_key(anchor["label"])
    cancelled = moment and bool(anchor.get("cancelled"))
    if cancelled:
        timeres.check_moment(anchor)
    else:
        anchor.pop("cancelled", None)
        timeres.check_hint(core, t, anchor)
    key = timeres.canonical(anchor)
    hints = [h for h in (t.get("schedule_hints") or []) if timeres.canonical(h) != key]
    hints = ([dict(anchor, reason=(reason or "").strip()[:200])] + hints)[:timeres.MAX_AI]
    lab = timeres.label(core, anchor)
    on_it = (t["state"] == "scheduled" and t.get("schedule_anchor")
             and timeres.canonical(t["schedule_anchor"]) == key)
    with core.tx(actor):
        ch = events.Changes()
        ch.task(t["id"], schedule_hints=hints)
        if t["state"] == "working":
            renew(core, ch, t["id"])
        cards.refresh_schedule_options(core, ch, t["id"])
        events.emit(core, "task.schedule_suggested", task_id=t["id"], changes=ch,
                    data={"anchor": anchor, "label": lab})
        if on_it and cancelled:
            tasks.bring_back(core, t["id"], reason=f"{lab} was cancelled.", type="task.anchor_lost", actor=actor)
        elif on_it:
            fire = iso(timeres.resolve(core, anchor, t))
            if fire != t["schedule_fire_at"]:
                when = timeres.label(core, {"type": "exact", "at": fire})
                ch = events.Changes()
                ch.task(t["id"], schedule_anchor=anchor, schedule_fire_at=fire)
                events.emit(core, "task.anchor_moved", task_id=t["id"], changes=ch,
                            data={"from": t["schedule_fire_at"], "to": fire, "key": anchor["key"]},
                            log=("status", f"{lab} moved to {when}."))
    return lab


# ---------------------------------------------------------------- the clock

def tick(core):
    """Run every minute by `fuzz serve` (and by `fuzz tick`). Returns what moved."""
    from . import review
    out = {"released": expire_leases(core), "came_back": 0, "deadline": 0, "stale": 0, "gather_timeout": 0}
    now = core.now_iso()
    # Gathering never keeps a task from you for long: no run picked it up in time, so it goes to triage as is
    late = iso(core.now() - timedelta(minutes=core.config["gather"]["minutes"]))
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='queued'", (core.user_id,)):
        if not gathering(t):
            continue
        if t.get("schedule_anchor"):   # you scheduled it: Fuzz has until its time
            if not t.get("schedule_fire_at") or t["schedule_fire_at"] > now:
                continue
            lab = timeres.label(core, t["schedule_anchor"])
            log = f"Fuzz didn't get to this before {lab[0].lower() + lab[1:]}, so it came back as it was."
        elif "plan_wait" in (t.get("variant_tags") or []):   # working out when to check back: the default stands
            if (t.get("state_changed_at") or "") >= late:
                continue
            log = None
        elif "review" in (t.get("variant_tags") or []):   # a parked task back to ask: its clock starts then
            if (t.get("reviewed_at") or "") >= late:
                continue
            log = "Fuzz didn't get to look before asking, so it came back as it was."
        elif t["created_at"] < late:
            log = "Fuzz didn't get to this in time, so it came to you as captured."
        else:
            continue
        finish_gathering(core, t["id"], actor="system", log=log, hold=False)
        out["gather_timeout"] += 1
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='scheduled' AND schedule_fire_at IS NOT NULL "
                      "AND schedule_fire_at <= ?", (core.user_id, now)):
        lab = timeres.label(core, t["schedule_anchor"] or {"type": "exact"})
        tasks.bring_back(core, t["id"], reason=f"You scheduled this for {lab[0].lower() + lab[1:]}.", actor="system")
        out["came_back"] += 1
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='waiting' AND schedule_fire_at IS NOT NULL "
                      "AND schedule_fire_at <= ?", (core.user_id, now)):
        tasks.check_back(core, t["id"])
        out["checked_back"] = out.get("checked_back", 0) + 1
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
    out["review"] = review.release(core)
    return out


def wake(core):
    """You're back at your desk: everything scheduled for that comes back."""
    n = 0
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='queued'", (core.user_id,)):
        if gathering(t) and (t.get("schedule_anchor") or {}).get("type") == "at_desk":
            finish_gathering(core, t["id"], actor="system", hold=False,
                             log="You're back at your desk before Fuzz got to this, so it came back as it was.")
            n += 1
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='scheduled'", (core.user_id,)):
        if (t.get("schedule_anchor") or {}).get("type") == "at_desk":
            tasks.bring_back(core, t["id"], reason="You're back at your desk.", actor="system")
            n += 1
    return n
