"""Cards: every card is a decision. The core owns the kinds and their answers; the AI fills in content.

This module keeps the bookkeeping (one card per task, which card a state needs, queue order,
the view a UI gets). What each answer does lives in answers.py.
"""

from . import events, timeres
from .db import FuzzError

FAMILY = {"task": "routing", "duplicate": "question", "entity_person": "question", "entity_term": "question",
          "is_task": "question", "draft": "approval", "nudge": "approval", "permission": "approval",
          "checkin": "about_you"}

OPTIONS = {
    "duplicate": ["merge", "keep_separate", "not_sure"],
    "entity_person": ["same", "different", "not_sure"],
    "entity_term": ["define", "same_as", "not_sure"],
    "is_task": ["mine", "not_task", "someone_else", "not_sure"],
    "draft": ["approve", "edit", "send_back"],
    "nudge": ["approve", "edit", "not_yet"],
    "permission": ["allow_once", "always_allow", "deny"],
    "checkin": ["good", "okay", "tired", "overloaded"],
}
TASK_OPTIONS = ["assign", "session", "schedule", "done", "park", "wait", "drop"]

SUGGESTED = {"duplicate": "merge", "entity_person": "same", "entity_term": "define", "is_task": "mine",
             "draft": "approve", "nudge": "approve", "permission": "allow_once", "checkin": "good"}

PROMPTS = {
    "task": "What should happen to this?",
    "duplicate": "Same as “{other}”?",
    "entity_person": "Are these the same person?",
    "entity_term": "What is {term}?",
    "is_task": "Is this a task for you?",
    "draft": "Is this draft okay?",
    "nudge": "Can Fuzz chase this reply?",
    "permission": "Can Fuzz use {resource}?",
    "checkin": "How are you doing?",
}

# Variant tags that only make sense while the task sits in triage.
TRIAGE_TAGS = {"handed_back", "returning", "reopened", "stale"}


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
    else:
        t = tasks.get(core, task_id)
        fields["schedule_options"] = timeres.build_options(core, t)
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
    if t["state"] == "triage" and not open_:
        kind = "is_task" if "unconfirmed" in tags else "task"
        return create(core, kind, task_id, reason=t.get("reason"),
                      suggested="keep" if "stale" in tags else ("quick" if t.get("quick_answers") else "assign"),
                      where="back" if "handed_back" in tags else where)
    if t["state"] == "review" and not any(c["kind"] in ("draft", "nudge") for c in open_):
        d = core.one("SELECT * FROM drafts WHERE task_id=? AND status='pending' ORDER BY id DESC LIMIT 1", (task_id,))
        if d:
            kind = "nudge" if d["kind"].startswith("nudge") else "draft"
            return create(core, kind, task_id, payload={"draft_id": d["id"]})
    return None


def refresh_schedule_options(core, ch, task_id):
    from . import tasks
    t = dict(tasks.get(core, task_id))
    t.update(ch.pending("tasks", task_id))
    for c in open_cards(core, task_id):
        if c["kind"] == "task":
            ch.card(c["id"], schedule_options=timeres.build_options(core, t))


def task_options(task):
    tags = task.get("variant_tags") or []
    opts = list(TASK_OPTIONS)
    if "stale" in tags:
        opts.insert(0, "keep")
    if "handed_back" in tags and task.get("quick_answers"):
        opts.insert(0, "quick")
    return opts


def options(card, task):
    return task_options(task) if card["kind"] == "task" else (card.get("options") or OPTIONS[card["kind"]])


# ---------------------------------------------------------------- the queue

def moment(core):
    row = core.one("SELECT value FROM user_state WHERE user_id=? AND key='moment'", (core.user_id,))
    return (row or {}).get("value") or "any"


def queue(core):
    """Open cards in triage order: time-sensitive first, handbacks and postponed last, then the moment, then order."""
    from . import tasks
    m = moment(core)
    cards = core.all("SELECT * FROM cards WHERE user_id=? AND status='open'", (core.user_id,))
    keyed = []
    for c in cards:
        t = tasks.get(core, c["task_id"]) if c["task_id"] else None
        tags = (t or {}).get("variant_tags") or []
        if c["kind"] == "checkin":
            k = (1, 0, 0, c["order_key"])
        else:
            urgent = 0 if t and t.get("deadline_level", 0) >= 1 else 1
            back = 1 if ("handed_back" in tags or c["postponed"]) else 0
            fits = 0
            if m == "quick":
                fits = 0 if (t and (t.get("effort_mins") or 99) <= 5) else 1
            elif m == "low":
                fits = 0 if (t and t.get("energy") == "low") else 1
            k = (urgent, back, fits, c["order_key"] or 0)
        keyed.append((k, c, t))
    keyed.sort(key=lambda x: x[0])
    return [(c, t) for _, c, t in keyed]


def task_summary(t):
    if t is None:
        return None
    keys = ("id", "state", "assignee", "title", "ask", "owner", "due", "context_md", "question", "quick_answers",
            "variant_tags", "reason", "effort_mins", "energy", "deadline_level", "notes", "waiting_on",
            "schedule_anchor", "schedule_fire_at", "created_at", "state_changed_at")
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
    if not prompt:
        prompt = PROMPTS[card["kind"]].format(other=(other or {}).get("title", "another task"),
                                              term=payload.get("term", "this"),
                                              resource=payload.get("resource", "this"))
    out = {"id": card["id"], "kind": card["kind"], "family": FAMILY[card["kind"]], "status": card["status"],
           "prompt": prompt, "reason": card.get("reason") or (task or {}).get("reason"),
           "options": options(card, task or {}), "suggested": card.get("suggested"),
           "postponed": card["postponed"], "payload": payload, "task": task_summary(task),
           "created_at": card.get("created_at")}
    if card["kind"] == "task":
        out["schedule_options"] = card.get("schedule_options") or []
    if other:
        out["other"] = task_summary(other)
    if payload.get("draft_id"):
        d = core.one("SELECT * FROM drafts WHERE id=?", (payload["draft_id"],))
        out["draft"] = d
    return out
