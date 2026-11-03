"""Cards: every card is a decision. The core owns the kinds and their answers; the AI fills in content.

This module keeps the bookkeeping (one card per task, which card a state needs, queue order,
the view a UI gets). What each answer does lives in answers.py.
"""

from . import events, timeres
from .db import FuzzError

FAMILY = {"task": "routing", "duplicate": "question", "entity_person": "question", "entity_term": "question",
          "is_task": "question", "draft": "approval", "nudge": "approval", "permission": "approval"}

OPTIONS = {
    "duplicate": ["merge", "keep_separate", "not_sure"],
    "entity_person": ["same", "different", "not_sure"],
    "entity_term": ["define", "same_as", "not_sure"],
    "is_task": ["mine", "not_task", "someone_else", "not_sure"],
    "draft": ["approve", "edit", "send_back", "schedule", "done"],
    "nudge": ["approve", "edit", "not_yet", "schedule"],
    "permission": ["allow_once", "always_allow", "deny"],
}
TASK_OPTIONS = ["assign", "session", "schedule", "done", "park", "wait", "someone_else", "drop"]
REVIEW_OPTIONS = ["keep_parked", "now", "schedule", "drop"]   # a parked task back to ask "Still want this?"
CHECK_BACK_OPTIONS = ["got_it", "nudge", "keep_waiting", "drop"]   # a waiting task back to ask "Did they get back to you?"
# a task you've scheduled again and again, back to ask what's in the way: unclear (Fuzz works out the
# first step), now (it still matters: an ordinary card), or park, let go, or one more time
PUT_OFF_OPTIONS = ["unclear", "now", "schedule", "park", "drop"]
SCHEDULED = ("task", "draft", "nudge")   # cards that carry Schedule options ("Not now" on a draft picks a time)

SUGGESTED = {"duplicate": "merge", "entity_person": "same", "entity_term": "define", "is_task": "mine",
             "draft": "approve", "nudge": "approve", "permission": "allow_once"}

PROMPTS = {
    "task": "What should happen to this?",
    "duplicate": "Same as “{other}”?",
    "entity_person": "Are these the same person?",
    "entity_term": "What is {term}?",
    "is_task": "Is this a task for you?",
    "draft": "Is this draft okay?",
    "nudge": "Can Fuzz chase this reply?",
    "permission": "Can Fuzz use {resource}?",
}
PUT_OFF_PROMPT = "This keeps coming back. Is something in the way?"

# Variant tags that only make sense while the task sits in triage.
TRIAGE_TAGS = {"handed_back", "result", "returning", "reopened", "stale", "review", "check_back", "put_off"}


def open_cards(core, task_id):
    return core.all("SELECT * FROM cards WHERE user_id=? AND task_id=? AND status='open' ORDER BY id",
                    (core.user_id, task_id))


def get(core, card_id):
    c = core.one("SELECT * FROM cards WHERE id=? AND user_id=?", (card_id, core.user_id))
    if c is None:
        raise FuzzError(f"No card {card_id}", "card_id", 404)
    return c


def next_order(core, where="back"):
    if where == "front":
        row = core.one("SELECT COALESCE(MIN(order_key), 0) m FROM cards WHERE user_id=?", (core.user_id,))
        return row["m"] - 1
    row = core.one("SELECT COALESCE(MAX(order_key), 0) m FROM cards WHERE user_id=?", (core.user_id,))
    return row["m"] + 1


def withdraw(core, ch, task_id, keep=None):
    """Close the open cards of a task that is leaving the state they were about."""
    for c in open_cards(core, task_id):
        if c["id"] != keep and ch.pending("cards", c["id"]).get("status", "open") == "open":
            ch.card(c["id"], status="withdrawn")


def mark_answered(core, ch, card, option, value=None):
    ch.card(card["id"], status="answered", answer={"option": option, "value": value})


def create(core, kind, task_id=None, other_id=None, prompt=None, reason=None, suggested=None, payload=None,
           where="back"):
    """Write card.created. Runs inside the caller's transaction, so it joins the caller's undo group."""
    from . import tasks
    cid = core.new_id("cards")
    ch = events.Changes()
    fields = dict(kind=kind, task_id=task_id, other_id=other_id, prompt=prompt, reason=reason,
                  suggested=suggested or SUGGESTED.get(kind), payload=payload or {}, status="open",
                  postponed=0, order_key=next_order(core, where),
                  created_at=core.now_iso())
    if kind != "task":
        fields["options"] = OPTIONS[kind]
    if kind in SCHEDULED:
        fields["schedule_options"] = timeres.build_options(core, tasks.get(core, task_id))
    ch.card(cid, **fields)
    events.emit(core, "card.created", task_id=task_id, changes=ch, data={"kind": kind, "card_id": cid})
    return cid


def sync(core, task_id, where="back"):
    """Make sure a task has the card its state calls for. Call at the end of any command that moves a task.

    where: "front" puts a new card at the head of the queue (you pulled it back, a reply came in)."""
    from . import tasks
    t = tasks.get(core, task_id)
    if t is None:
        return None
    open_ = open_cards(core, task_id)
    tags = t.get("variant_tags") or []
    if t["state"] == "triage" and not open_ and "unconfirmed" in tags:
        # Asks from one message that may not be yours share one card, so a broadcast email is one answer
        c = _asking_card(core, t)
        if c is None:
            return create(core, "is_task", task_id, reason=t.get("reason"), payload={"asks": [task_id]}, where=where)
        have = (c.get("payload") or {}).get("asks") or [c["task_id"]]
        if task_id not in have:
            ch = events.Changes()
            ch.card(c["id"], payload=dict(c.get("payload") or {}, asks=have + [task_id]))
            events.emit(core, "card.updated", task_id=c["task_id"], changes=ch,
                        data={"kind": "is_task", "card_id": c["id"], "added": task_id})
        return c["id"]
    if t["state"] == "triage" and not open_:
        return create(core, "task", task_id, reason=t.get("reason"),
                      prompt=PUT_OFF_PROMPT if "put_off" in tags else None,
                      suggested=review_suggests(core, t) if "review" in tags else "nudge" if "check_back" in tags
                      else "unclear" if "put_off" in tags else "keep" if "stale" in tags else "done" if "result" in tags
                      else ("quick" if t.get("quick_answers") else "assign"),
                      where="back" if "handed_back" in tags else where)
    if t["state"] == "review" and not any(c["kind"] in ("draft", "nudge") for c in open_):
        d = core.one("SELECT * FROM drafts WHERE task_id=? AND status='pending' ORDER BY id DESC LIMIT 1", (task_id,))
        if d:
            kind = "nudge" if d["kind"].startswith("nudge") else "draft"
            return create(core, kind, task_id, payload={"draft_id": d["id"]})
    return None


def _asking_card(core, t):
    """The open is_task card of another task from the same origin, which this one's ask joins."""
    if not t.get("group_id"):
        return None
    return core.one("SELECT c.* FROM cards c JOIN tasks t ON t.id=c.task_id WHERE c.user_id=? AND c.kind='is_task' "
                    "AND c.status='open' AND t.group_id=? AND c.task_id!=? ORDER BY c.id LIMIT 1",
                    (core.user_id, t["group_id"], t["id"]))


def asks(core, card):
    """What an is_task card asks about: its own task first, then the ones folded in, each only while it is
    still in triage waiting for the answer."""
    from . import tasks
    ids = dict.fromkeys([card["task_id"]] + ((card.get("payload") or {}).get("asks") or []))
    out = [tasks.get(core, i) for i in ids]
    return [t for t in out if t and t["state"] == "triage" and "unconfirmed" in (t.get("variant_tags") or [])]


def covered(core, t):
    """A task with no card of its own because another task's is_task card asks about it too."""
    c = _asking_card(core, t)
    return bool(c) and t["id"] in ((c.get("payload") or {}).get("asks") or [])


def refresh_schedule_options(core, ch, task_id):
    from . import tasks
    t = dict(tasks.get(core, task_id))
    t.update(ch.pending("tasks", task_id))
    for c in open_cards(core, task_id):
        if c["kind"] in SCHEDULED:
            ch.card(c["id"], schedule_options=timeres.build_options(core, t))


def review_suggests(core, t):
    """Kept parked through enough reviews already: the card leans toward letting it go."""
    return "drop" if (t.get("reviews") or 0) >= core.config["review"]["let_go_after"] else "keep_parked"


def task_options(task):
    tags = task.get("variant_tags") or []
    if "review" in tags:
        return list(REVIEW_OPTIONS)
    if "check_back" in tags:
        return list(CHECK_BACK_OPTIONS)
    if "put_off" in tags:
        return list(PUT_OFF_OPTIONS)
    opts = list(TASK_OPTIONS)
    if "stale" in tags:
        opts.insert(0, "keep")
    if "handed_back" in tags and task.get("quick_answers"):
        opts.insert(0, "quick")
    return opts


def options(card, task):
    if card["kind"] == "task":
        return task_options(task)
    if card["kind"] in ("draft", "nudge"):   # the kind's options now, so a card made before Schedule can use it
        return OPTIONS[card["kind"]]
    return card.get("options") or OPTIONS[card["kind"]]


# ---------------------------------------------------------------- the queue

def moment(core):
    row = core.one("SELECT value FROM user_state WHERE user_id=? AND key='moment'", (core.user_id,))
    return (row or {}).get("value") or "any"


def queue(core):
    """Open cards in triage order: time-sensitive first, handbacks and postponed last, then the moment, then order.
    A card you sent to the end of the list waits behind all of them, deadline or not."""
    from . import tasks
    m = moment(core)
    cards = core.all("SELECT * FROM cards WHERE user_id=? AND status='open'", (core.user_id,))
    keyed = []
    for c in cards:
        t = tasks.get(core, c["task_id"]) if c["task_id"] else None
        tags = (t or {}).get("variant_tags") or []
        urgent = 0 if t and t.get("deadline_level", 0) >= 1 else 1
        back = 1 if ("handed_back" in tags or c["postponed"]) else 0
        fits = 0
        if m == "quick":
            fits = 0 if (t and (t.get("effort_mins") or 99) <= 5) else 1
        elif m == "low":
            fits = 0 if (t and t.get("energy") == "low") else 1
        at_end = 1 if (c.get("payload") or {}).get("at_end") else 0
        k = (at_end, urgent, back, fits, c["order_key"] or 0)
        keyed.append((k, c, t))
    return [(c, t) for _, c, t in sorted(_back_to_back(core, keyed), key=lambda x: x[0])]


def _back_to_back(core, keyed):
    """A group's cards come one after another, where its first one would be; the group you're working
    through comes before everything else, new arrivals and deadlines too. A card you sent to the end
    stays there. Returns the rows with their final keys."""
    from . import groups
    run = groups.run(core)
    lead = {}
    for k, c, t in keyed:
        gid = (t or {}).get("group_id")
        if gid and not k[0] and c["kind"] in groups.ROUTING:
            lead.setdefault(gid, []).append(k)
    lead = {g: min(ks) for g, ks in lead.items() if len(ks) > 1 or (run and run["group_id"] == g)}
    out = []
    for k, c, t in keyed:
        gid = (t or {}).get("group_id")
        if gid in lead and not k[0] and c["kind"] in groups.ROUTING:
            first = 0 if run and run["group_id"] == gid else 1
            out.append(((first,) + lead[gid] + (gid,) + k, c, t))
        else:
            out.append(((1,) + k + (0,) + k, c, t))
    return out


def task_summary(t):
    if t is None:
        return None
    keys = ("id", "state", "assignee", "title", "ask", "owner", "due", "context_md", "summary", "question",
            "quick_answers", "variant_tags", "reason", "effort_mins", "energy", "deadline_level", "notes", "waiting_on",
            "schedule_anchor", "schedule_fire_at", "created_at", "state_changed_at", "group_id", "next_step",
            "reschedules")
    return {k: t.get(k) for k in keys}


def view(core, card, task=None):
    """The card as a UI gets it: the decision, its answers and what it is about."""
    from . import tasks
    task = task if task is not None else (tasks.get(core, card["task_id"]) if card["task_id"] else None)
    other = tasks.get(core, card["other_id"]) if card.get("other_id") and card["kind"] == "duplicate" else None
    payload = card.get("payload") or {}
    prompt = card.get("prompt")
    if card["kind"] in ("task", "draft", "nudge", "is_task") and task and task.get("question"):
        prompt = task["question"]
    many = asks(core, card) if card["kind"] == "is_task" and card["status"] == "open" else []
    if not prompt and len(many) > 1:
        prompt = "Are any of these yours?"
    if not prompt:
        prompt = PROMPTS[card["kind"]].format(other=(other or {}).get("title", "another task"),
                                              term=payload.get("term", "this"),
                                              resource=payload.get("resource", "this"))
    out = {"id": card["id"], "kind": card["kind"], "family": FAMILY[card["kind"]], "status": card["status"],
           "prompt": prompt, "reason": card.get("reason") or (task or {}).get("reason"),
           "options": options(card, task or {}), "suggested": card.get("suggested"),
           "postponed": card["postponed"], "payload": payload, "task": task_summary(task),
           "created_at": card.get("created_at")}
    if len(many) > 1:
        out["asks"] = [task_summary(a) for a in many]
    if card["kind"] == "task":
        out["schedule_options"] = card.get("schedule_options") or []
    elif card["kind"] in SCHEDULED:   # a draft card made before it had Schedule options works them out now
        out["schedule_options"] = card.get("schedule_options") or (timeres.build_options(core, task) if task else [])
    if other:
        out["other"] = task_summary(other)
    if payload.get("draft_id"):
        from . import drafts
        d = core.one("SELECT * FROM drafts WHERE id=?", (payload["draft_id"],))
        out["draft"] = d
        if d and task:
            out["after_approve"] = drafts.after_approve(core, d, task)
    return out
