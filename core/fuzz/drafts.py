"""The approval gate: drafts wait for your OK, and permissions decide what Fuzz may read or use.

Approving a draft that goes somewhere moves the task to `sending`. Fuzz's sender role (its own
short run, with only the connector tools you allowed for sending) claims it, sends exactly the
approved body with its client's connector, and calls mark_sent, which writes task.sent. Until
then Undo takes the approval back; after task.sent nothing can. A note goes nowhere, so approving
one just files it.
"""

from . import cards, events, tasks
from .db import FuzzError

DRAFT_KINDS = ("email.reply", "email.new", "slack.message", "calendar.invite", "nudge.email", "nudge.slack", "note")
BODY_MAX = 32 * 1024


def save_draft(core, task_id, kind, target, body, actor="fuzz:executor"):
    if kind not in DRAFT_KINDS:
        raise FuzzError(f"kind must be one of {', '.join(DRAFT_KINDS)}", "kind")
    if not (body or "").strip():
        raise FuzzError("body is empty", "body")
    if len(body.encode()) > BODY_MAX:
        raise FuzzError(f"body is over {BODY_MAX // 1024} KB", "body")
    t = tasks.require(core, task_id)
    with core.tx(actor):
        did = core.new_id("drafts")
        ch = events.Changes()
        for d in core.all("SELECT id FROM drafts WHERE task_id=? AND status='pending'", (t["id"],)):
            ch.draft(d["id"], status="withdrawn")
        ch.draft(did, task_id=t["id"], kind=kind, target=target, body=body, status="pending",
                 created_at=core.now_iso())
        tasks.move(core, ch, t, "review")
        if not t.get("question"):
            ch.task(t["id"], question="Is this draft okay?")
        events.emit(core, "task.draft_ready", task_id=t["id"], changes=ch, data={"draft_id": did, "kind": kind},
                    log=("action", "The draft is ready. Nothing is sent until you approve it."))
        cards.sync(core, t["id"])
    return did


def _draft(core, card):
    d = core.one("SELECT * FROM drafts WHERE id=? AND user_id=?", ((card.get("payload") or {}).get("draft_id"), core.user_id))
    if d is None:
        raise FuzzError("This card's draft is gone", "card_id", 409)
    return d


def approve(core, card):
    d = _draft(core, card)
    t = tasks.require(core, d["task_id"])
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], status="approved", approved_by="human", approved_at=core.now_iso())
        if d["kind"] == "note":
            tasks.move(core, ch, t, "done", card=card, question=None)
            log = "You approved this."
        else:
            tasks.move(core, ch, t, "sending", card=card, question=None)
            log = f"You approved the draft. Fuzz will send it in {_where(d['kind'])}."
        cards.mark_answered(core, ch, card, "approve")
        events.emit(core, "task.approved", task_id=t["id"], changes=ch, data={"draft_id": d["id"], "kind": d["kind"]},
                    log=("status", log))
        cards.sync(core, t["id"])


def approved_draft(core, task_id):
    return core.one("SELECT * FROM drafts WHERE task_id=? AND user_id=? AND status='approved' ORDER BY id DESC LIMIT 1",
                    (task_id, core.user_id))


def mark_sent(core, task_id, draft_id, where, link=None, actor="fuzz:sender"):
    """The sender sent the approved draft. Writes task.sent, which no Undo reverses."""
    if not (where or "").strip():
        raise FuzzError("where says how it went out, like “Slack, #offsite-planning”", "where")
    t = tasks.require(core, task_id)
    d = approved_draft(core, t["id"])
    if d is None or d["id"] != draft_id:
        raise FuzzError(f"Draft {draft_id} isn't the approved draft on task {t['id']}", "draft_id", 409)
    with core.tx(actor):
        ch = events.Changes()
        ch.draft(d["id"], status="sent")
        tasks.move(core, ch, t, "waiting" if d["kind"].startswith("nudge") else "done")
        to = f" to {d['target']}" if d.get("target") else ""
        events.emit(core, "task.sent", task_id=t["id"], changes=ch,
                    data={"draft_id": d["id"], "kind": d["kind"], "where": where.strip(), "link": link},
                    log=("sent", f"Sent{to} ({where.strip()}) after you approved it."))
    return {"state": "waiting" if d["kind"].startswith("nudge") else "done"}


def send_failed(core, task_id, draft_id, why, actor="fuzz:sender", log=None):
    """It couldn't go out. The draft comes back to review with the reason as the question."""
    if not (why or "").strip():
        raise FuzzError("why says what stopped it, in one line", "why")
    t = tasks.require(core, task_id)
    d = approved_draft(core, t["id"])
    if d is None or d["id"] != draft_id:
        raise FuzzError(f"Draft {draft_id} isn't the approved draft on task {t['id']}", "draft_id", 409)
    with core.tx(actor):
        ch = events.Changes()
        ch.draft(d["id"], status="pending")
        tasks.move(core, ch, t, "review", question=f"{why.strip()[:300]} Send it again?")
        events.emit(core, "task.send_failed", task_id=t["id"], changes=ch, data={"draft_id": d["id"], "why": why.strip()},
                    log=("blocked", log or f"Couldn't send it: {why.strip()}"))
        cards.sync(core, t["id"])
    return {"state": "review"}


def _where(kind):
    return {"email": "Mail", "slack": "Slack", "calendar": "Calendar", "nudge": "the thread"}.get(kind.split(".")[0], "the right app")


def edit(core, card, body):
    if not isinstance(body, str) or not body.strip():
        raise FuzzError("value is the new draft body", "value")
    d = _draft(core, card)
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], body=body)
        events.emit(core, "task.draft_edited", task_id=d["task_id"], changes=ch, data={"draft_id": d["id"]},
                    log=("guidance", "You edited the draft."))


def send_back(core, card, note):
    if not isinstance(note, str) or not note.strip():
        raise FuzzError("value is your note for Fuzz", "value")
    d = _draft(core, card)
    t = tasks.require(core, d["task_id"])
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], status="sent_back")
        notes = ((t.get("notes") or "") + f"\nYou sent the draft back: {note.strip()}").strip()
        tasks.move(core, ch, t, "queued", card=card, notes=notes, question=None, attempts=0)
        cards.mark_answered(core, ch, card, "send_back", note)
        events.emit(core, "task.sent_back", task_id=t["id"], changes=ch, data={"draft_id": d["id"]},
                    log=("guidance", f"You sent the draft back: {note.strip()}"))


def not_yet(core, card):
    d = _draft(core, card)
    t = tasks.require(core, d["task_id"])
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], status="withdrawn")
        tasks.move(core, ch, t, "waiting", card=card, question=None)
        cards.mark_answered(core, ch, card, "not_yet")
        events.emit(core, "card.answered", task_id=t["id"], changes=ch, data={"kind": "nudge", "option": "not_yet"},
                    log=("status", "Not yet. Fuzz keeps waiting for the reply."))


# ---------------------------------------------------------------- permissions

def has_grant(core, scope, resource, task_id=None):
    rows = core.all("SELECT * FROM grants WHERE user_id=? AND scope=? AND resource=? AND kind!='revoked'",
                    (core.user_id, scope, resource))
    return any(g["kind"] == "always" or (g["kind"] == "once" and g["task_id"] == task_id) for g in rows)


def request_permission(core, task_id, scope, resource, why, actor="fuzz:executor"):
    if scope not in ("source", "connector"):
        raise FuzzError("scope must be source or connector", "scope")
    if not (resource or "").strip():
        raise FuzzError("resource names what Fuzz wants to read or use", "resource")
    t = tasks.require(core, task_id)
    if has_grant(core, scope, resource, t["id"]):
        return {"granted": True}
    with core.tx(actor):
        ch = events.Changes()
        tasks.move(core, ch, t, "queued", add_tags=("needs_permission",))
        events.emit(core, "permission.asked", task_id=t["id"], changes=ch,
                    data={"scope": scope, "resource": resource, "why": why},
                    log=("blocked", f"Asked to use {resource}: {why}"))
        cid = cards.create(core, "permission", t["id"], reason=why, payload={"scope": scope, "resource": resource})
    return {"granted": False, "card_id": cid, "waiting": True}


def answer_permission(core, card, option):
    p = card.get("payload") or {}
    t = tasks.require(core, card["task_id"])
    with core.tx("human"):
        ch = events.Changes()
        tags = [x for x in (t.get("variant_tags") or []) if x != "needs_permission"]
        if option == "deny":
            notes = ((t.get("notes") or "") + f"\nYou said no to {p.get('resource')}. Work without it or hand back.").strip()
            ch.task(t["id"], variant_tags=tags, notes=notes)
            cards.mark_answered(core, ch, card, option)
            events.emit(core, "permission.denied", task_id=t["id"], changes=ch, data=p,
                        log=("status", f"You said no to {p.get('resource')}."))
            return
        gid = core.new_id("grants")
        ch.grant(gid, scope=p["scope"], resource=p["resource"], kind="always" if option == "always_allow" else "once",
                 task_id=t["id"])
        ch.task(t["id"], variant_tags=tags)
        cards.mark_answered(core, ch, card, option)
        events.emit(core, "permission.granted", task_id=t["id"], changes=ch, data=dict(p, kind=option),
                    log=("status", ("You always allow " if option == "always_allow" else "You allowed ") + p["resource"] + "."))
