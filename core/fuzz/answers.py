"""answer(card_id, option, value): one call for every card kind.

The table below mirrors "What each answer writes" in the design doc. A new kind or answer is a
code change here; the AI only fills in wording.
"""

from . import cards, drafts, events, tasks
from .db import FuzzError

POSTPONE_LIMIT = 2   # after two "Not sure yet", the core takes the safe answer
SAFE = {"duplicate": "keep_separate", "entity_person": "different", "entity_term": None, "is_task": "mine"}
CHECKIN_MOMENT = {"good": "any", "okay": "any", "tired": "low", "overloaded": "quick"}
CHECKIN_GAP_MAX = 16


def _task_answer(core, card, t, option, value):
    if option == "assign":
        return tasks.assign(core, t["id"], instructions=(value or {}).get("instructions") if isinstance(value, dict) else value,
                            card=card)
    if option == "quick":
        text = value if isinstance(value, str) else (value or {}).get("text")
        if not text or text not in (t.get("quick_answers") or []) and not (value or {}).get("custom"):
            raise FuzzError("value is one of the quick answers on this card", "value")
        with core.tx("human"):
            ch = events.Changes()
            cards.mark_answered(core, ch, card, "quick", text)
            events.emit(core, "card.answered", task_id=t["id"], changes=ch, data={"kind": "task", "option": "quick"},
                        log=("guidance", f"You answered: {text}"))
            tasks.assign(core, t["id"], instructions=text)
        return
    if option == "session":
        return tasks.session(core, t["id"], card=card)
    if option == "schedule":
        anchor = (value or {}).get("anchor") if isinstance(value, dict) else None
        return tasks.schedule(core, t["id"], anchor, card=card)
    if option == "done":
        return tasks.done(core, t["id"], card=card)
    if option == "park":
        return tasks.park(core, t["id"], card=card)
    if option == "wait":
        return tasks.wait(core, t["id"], on=value if isinstance(value, str) else None, card=card)
    if option == "drop":
        return tasks.let_go(core, t["id"], card=card)
    if option == "keep":
        return tasks.keep_stale(core, t["id"], card)


def _duplicate(core, card, t, option, value):
    from . import matching
    if option == "merge":
        return matching.merge(core, card["task_id"], card["other_id"], card=card)
    if option == "keep_separate":
        return matching.keep_separate(core, card["task_id"], card["other_id"], card=card)


def _entity_person(core, card, t, option, value):
    p = card.get("payload") or {}
    a, b = p.get("entity_a"), p.get("entity_b")
    with core.tx("human"):
        ch = events.Changes()
        cards.mark_answered(core, ch, card, option)
        if option == "same":
            core.q("UPDATE entities SET redirect_to=?, provisional=0 WHERE id=? AND user_id=?", (a, b, core.user_id))
            events.emit(core, "entity.merged", task_id=card["task_id"], changes=ch, data={"from": b, "into": a})
        else:
            core.q("INSERT OR IGNORE INTO entity_links VALUES (?,?,?)", (a, b, "different"))
            events.emit(core, "entity.kept_separate", task_id=card["task_id"], changes=ch, data={"a": a, "b": b})
        if card["task_id"]:
            cards.sync(core, card["task_id"])


def _entity_term(core, card, t, option, value):
    p = card.get("payload") or {}
    eid = p.get("entity_id")
    with core.tx("human"):
        ch = events.Changes()
        cards.mark_answered(core, ch, card, option, value)
        if option == "define":
            if not isinstance(value, str) or not value.strip():
                raise FuzzError("value is the definition", "value")
            core.q("UPDATE entities SET definition=?, provisional=0 WHERE id=? AND user_id=?", (value.strip(), eid, core.user_id))
            events.emit(core, "entity.defined", task_id=card["task_id"], changes=ch, data={"entity_id": eid})
        else:
            if not isinstance(value, int):
                raise FuzzError("value is the id of the existing entity", "value")
            core.q("UPDATE entities SET redirect_to=? WHERE id=? AND user_id=?", (value, eid, core.user_id))
            events.emit(core, "entity.merged", task_id=card["task_id"], changes=ch, data={"from": eid, "into": value})
        if card["task_id"]:
            cards.sync(core, card["task_id"])


def _is_task(core, card, t, option, value):
    if option == "mine":
        with core.tx("human"):
            ch = events.Changes()
            cards.mark_answered(core, ch, card, option)
            ch.task(t["id"], owner="me", variant_tags=tasks._tags(t, remove=("unconfirmed",)), question=None)
            events.emit(core, "task.confirmed", task_id=t["id"], changes=ch, log=("status", "You said this is yours."))
            cards.sync(core, t["id"])
        return
    if option == "not_task":
        with core.tx("human"):
            tasks.let_go(core, t["id"], card=card, option="not_task", why="You said this isn't a task.")
            core.q("INSERT INTO feedback (user_id, ts, kind, a, note) VALUES (?,?,?,?,?)",
                   (core.user_id, core.now_iso(), "not_task", t["id"], "is_task card"))
        return
    if option == "someone_else":
        return tasks.wait(core, t["id"], on=value if isinstance(value, str) else None, card=card, option="someone_else")


def _draft(core, card, t, option, value):
    if option == "approve":
        return drafts.approve(core, card)
    if option == "edit":
        return drafts.edit(core, card, value)
    if option == "send_back":
        return drafts.send_back(core, card, value)
    if option == "not_yet":
        return drafts.not_yet(core, card)


def _permission(core, card, t, option, value):
    return drafts.answer_permission(core, card, option)


def _checkin(core, card, t, option, value):
    follow = (value or {}).get("follow_up") if isinstance(value, dict) else None
    if follow not in (None, "take_5", "hold_rest", "quick_first"):
        raise FuzzError("value.follow_up must be take_5, hold_rest or quick_first", "value.follow_up")
    moment = "quick" if follow == "quick_first" else CHECKIN_MOMENT[option]
    with core.tx("human"):
        ch = events.Changes()
        cards.mark_answered(core, ch, card, option, value)
        ch.state("moment", moment)
        if follow == "take_5":
            ch.state("break_until", core.now_iso())
        events.emit(core, "checkin.answered", changes=ch, data={"answer": option, "follow_up": follow, "moment": moment})
        if follow == "hold_rest":
            for c, ct in cards.queue(core):
                if c["kind"] == "task" and ct and ct.get("deadline_level", 0) == 0:
                    tasks.schedule(core, ct["id"], {"type": "day_part", "day": "tomorrow", "part": "morning"},
                                   offered_only=False)


HANDLERS = {"task": _task_answer, "duplicate": _duplicate, "entity_person": _entity_person,
            "entity_term": _entity_term, "is_task": _is_task, "draft": _draft, "nudge": _draft,
            "permission": _permission, "checkin": _checkin}


def answer(core, card_id, option, value=None):
    card = cards.get(core, card_id)
    if card["status"] != "open":
        raise FuzzError(f"Card {card_id} is already {card['status']}", "card_id", 409)
    t = tasks.get(core, card["task_id"]) if card["task_id"] else None
    allowed = cards.options(card, t or {})
    if option not in allowed:
        raise FuzzError(f"option must be one of {', '.join(allowed)}", "option")
    with core.tx("human"):
        if option == "not_sure":
            _postpone(core, card, t)
        else:
            HANDLERS[card["kind"]](core, card, t, option, value)
            if card["kind"] != "checkin":
                _count_toward_checkin(core)
    return {"card_id": card_id, "option": option}


def _postpone(core, card, t):
    if card["postponed"] >= POSTPONE_LIMIT:
        safe = SAFE[card["kind"]]
        with core.tx("system"):
            ch = events.Changes()
            ch.card(card["id"], status="expired", answer={"option": safe, "value": None})
            events.emit(core, "card.expired", task_id=card["task_id"], changes=ch,
                        data={"kind": card["kind"], "safe_answer": safe},
                        log=("status", "Fuzz took the safe answer, since this was postponed twice."))
            if card["kind"] == "duplicate":
                from . import matching
                matching.keep_separate(core, card["task_id"], card["other_id"], card=None, feedback=False)
            if card["kind"] == "is_task" and t:
                ch = events.Changes()
                ch.task(t["id"], variant_tags=tasks._tags(t, remove=("unconfirmed",)))
                events.emit(core, "task.confirmed", task_id=t["id"], changes=ch, data={"by": "expiry"})
            if card["task_id"]:
                cards.sync(core, card["task_id"])
        return
    ch = events.Changes()
    ch.card(card["id"], postponed=card["postponed"] + 1, order_key=cards.next_order(core))
    events.emit(core, "card.postponed", task_id=card["task_id"], changes=ch, data={"kind": card["kind"]})


def _count_toward_checkin(core):
    """Check-ins come often at first, then less often: after 2 cleared cards, then 4 more, 8, 16.

    Worked out from the log (answered cards since the last checkin.due), so counting writes nothing.
    """
    last = core.one("SELECT COALESCE(MAX(id), 0) m, COUNT(*) n FROM events WHERE user_id=? AND type='checkin.due'",
                    (core.user_id,))
    since = core.one("SELECT COUNT(*) n FROM cards WHERE user_id=? AND status='answered' AND kind!='checkin' "
                     "AND answered_event_id > ?", (core.user_id, last["m"]))["n"]
    gap = min(2 ** (last["n"] + 1), CHECKIN_GAP_MAX)
    q = cards.queue(core)
    urgent = any(t and t.get("deadline_level", 0) >= 1 for c, t in q)
    if since >= gap and not urgent and q and not any(c["kind"] == "checkin" for c, _ in q):
        events.emit(core, "checkin.due", data={"after": since}, actor="system")
        cards.create(core, "checkin", where="front")
