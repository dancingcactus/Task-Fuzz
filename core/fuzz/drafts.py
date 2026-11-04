"""The approval gate: drafts wait for your OK, and permissions decide what Fuzz may read or use.

Approving a draft that goes somewhere moves the task to `sending`. Fuzz's sender role (its own
short run, with only the connector tools you allowed for sending) claims it, sends exactly the
approved body with its client's connector, and calls mark_sent, which writes task.sent. Until
then Undo takes the approval back; after task.sent nothing can. A note goes nowhere, so approving
one just files it and closes the task, unless it is preparation (final=False) for a step still
ahead: then the task is scheduled for when that step is due.
"""

from . import cards, events, tasks
from .db import FuzzError, iso

DRAFT_KINDS = ("email.reply", "email.new", "slack.message", "calendar.invite", "nudge.email", "nudge.slack", "note")
IN_THREAD = ("email.reply", "slack.message", "nudge.email", "nudge.slack")   # kinds that can go in a source's thread
BODY_MAX = 32 * 1024


def save_draft(core, task_id, kind, target, body, final=True, actor="fuzz:executor", attach=None, reply_to=None,
               covers=None):
    """attach: file names in the task's output folder, for the sender to attach when it sends.
    reply_to: the id of the task's source whose thread it goes in. target is only who it's to.
    covers: the other tasks of a group claim this one reply answers. They wait in review with it, and
    approving it (or sending it yourself) closes them all."""
    if kind not in DRAFT_KINDS:
        raise FuzzError(f"kind must be one of {', '.join(DRAFT_KINDS)}", "kind")
    if not final and kind != "note":
        raise FuzzError("final is for notes: a message is the step itself", "final")
    if not (body or "").strip():
        raise FuzzError("body is empty", "body")
    if len(body.encode()) > BODY_MAX:
        raise FuzzError(f"body is over {BODY_MAX // 1024} KB", "body")
    t = tasks.require(core, task_id)
    attach = _attachments(core, t["id"], kind, attach)
    reply_to = _thread(core, t["id"], kind, reply_to)
    covered = _covered(core, t, covers, final)
    if not final and _comes_back(core, t)[0] is None:
        raise FuzzError("A prep note needs to know when the real step is due. Call suggest_schedule with that "
                        "time (or update_brief with due), then save the note again", "final")
    with core.tx(actor):
        did = core.new_id("drafts")
        ch = events.Changes()
        for d in core.all("SELECT id FROM drafts WHERE task_id=? AND status='pending'", (t["id"],)):
            ch.draft(d["id"], status="withdrawn")
        ch.draft(did, task_id=t["id"], kind=kind, target=target, body=body, status="pending",
                 created_at=core.now_iso(), final=1 if final else 0, attachments=attach or None,
                 reply_to=reply_to, covers=[c["id"] for c in covered] or None)
        tasks.move(core, ch, t, "review")
        for c in covered:   # answered in this one reply: they wait for your OK with it, with no card of their own
            tasks.move(core, ch, c, "review", question=None)
        if not t.get("question"):
            ch.task(t["id"], question="Is this draft okay?")
        log = "The draft is ready. Nothing is sent until you approve it."
        if covered:
            log = f"One draft answers this and {len(covered)} more from the same place. Nothing is sent until you approve it."
        events.emit(core, "task.draft_ready", task_id=t["id"], changes=ch,
                    data={"draft_id": did, "kind": kind, **({"covers": [c["id"] for c in covered]} if covered else {})},
                    log=("action", log))
        cards.sync(core, t["id"])
    return did


def _covered(core, t, covers, final):
    """The tasks a group reply also answers: others in this run's group claim, each once."""
    if not covers:
        return []
    from . import groups
    if not final:
        raise FuzzError("covers is for a reply that answers several asks, not a prep note", "covers")
    mates = {m["id"]: m for m in groups.claimed_with(core, t)}
    out = []
    for cid in dict.fromkeys(covers):
        if cid not in mates:
            raise FuzzError(f"Task {cid} isn't one you hold with task {t['id']} (get_task's group.together lists them)",
                            "covers")
        out.append(mates[cid])
    return out


def covering(core, task_id):
    """The pending or approved draft on another task that answers this one too, or None."""
    for d in core.all("SELECT * FROM drafts WHERE user_id=? AND status IN ('pending', 'approved') AND covers IS NOT NULL",
                      (core.user_id,)):
        if task_id in (d.get("covers") or []):
            return d
    return None


def group_reply(core, t):
    """A reply to t's thread still waiting for your OK (on another task in its group), or None. A late ask
    from the same thread can join it instead of getting a reply of its own."""
    if not t or not t.get("group_id"):
        return None
    for d in core.all("SELECT d.* FROM drafts d JOIN tasks x ON x.id=d.task_id WHERE d.user_id=? AND x.group_id=? "
                      "AND d.status='pending' AND d.task_id!=? ORDER BY d.id DESC", (core.user_id, t["group_id"], t["id"])):
        if d.get("covers") or d["kind"] in IN_THREAD:
            return d
    return None


def add_to_reply(core, card, t):
    """Add this ask to the reply waiting for your OK: the draft goes back to Fuzz with it, and Fuzz writes one
    reply covering every ask again (the tasks are claimed together)."""
    d = group_reply(core, t)
    if d is None:
        raise FuzzError("That reply isn't waiting for your OK any more", "option", 409)
    main = tasks.require(core, d["task_id"])
    covered = [c for c in (tasks.get(core, i) for i in d.get("covers") or []) if c and c["state"] == "review"]
    note = f"Add the new ask from the same thread to the reply: “{t['title']}”."
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], status="sent_back")
        for x in [main] + covered:
            fields = {"notes": ((x.get("notes") or "") + "\n" + note).strip()} if x["id"] == main["id"] else {}
            tasks.move(core, ch, x, "queued", question=None, attempts=0, add_tags=("together",), **fields)
        tasks.move(core, ch, t, "queued", card=card, question=None, attempts=0, add_tags=("together",))
        cards.mark_answered(core, ch, card, "add_to_reply")
        for c in cards.open_cards(core, main["id"]):
            ch.card(c["id"], status="withdrawn")
        events.emit(core, "task.sent_back", task_id=main["id"], changes=ch,
                    data={"draft_id": d["id"], "added": t["id"]}, log=("guidance", f"You added “{t['title']}” to the reply."))


def _close_covered(core, ch, d, log=None):
    """Close the tasks a group reply answered, in the same event as the one it's on."""
    for cid in d.get("covers") or []:
        c = tasks.get(core, cid)
        if c and c["state"] == "review":
            tasks.move(core, ch, c, "done", question=None)


def _thread(core, task_id, kind, source_id):
    if source_id is None:
        if kind == "email.reply":
            raise FuzzError(f"A {kind} goes in an existing thread: pass reply_to, the id of the source it answers",
                            "reply_to")
        return None
    if kind not in IN_THREAD:
        raise FuzzError(f"A {kind} doesn't go in an existing thread, so it takes no reply_to", "reply_to")
    s = core.one("SELECT id FROM sources WHERE id=? AND task_id=? AND user_id=?", (source_id, task_id, core.user_id))
    if s is None:
        raise FuzzError(f"Source {source_id} isn't one of this task's sources", "reply_to")
    return s["id"]


def _attachments(core, task_id, kind, names):
    names = [n.strip() for n in names or [] if isinstance(n, str) and n.strip()]
    if not names:
        return []
    from . import outputs
    if kind == "note":
        raise FuzzError("A note isn't sent, so it has nothing to attach to", "attach")
    if not outputs.folder(core):
        raise FuzzError("There's no output folder to attach from. Set one with `fuzz setup`", "attach")
    outputs.record(core, task_id)
    have = {f["name"] for f in outputs.listing(core, task_id)}
    missing = [n for n in names if n not in have]
    if missing:
        raise FuzzError(f"Not in this task's output folder: {', '.join(missing)}. Save the file there first",
                        "attach")
    return names


def _draft(core, card):
    d = core.one("SELECT * FROM drafts WHERE id=? AND user_id=?", ((card.get("payload") or {}).get("draft_id"), core.user_id))
    if d is None:
        raise FuzzError("This card's draft is gone", "card_id", 409)
    return d


def _comes_back(core, t):
    """When a task whose prep is filed comes back for the real step: its first suggested time, else a day
    before it's due. (anchor, fire_at), or (None, None) if it has neither."""
    from . import timeres
    hints = [h for h in (t.get("schedule_hints") or []) if not h.get("cancelled")]
    anchor = ({k: v for k, v in hints[0].items() if k != "reason"} if hints
              else {"type": "before_due", "lead": "1d"} if t.get("due") else None)
    if anchor is None:
        return None, None
    try:
        fire = timeres.resolve(core, anchor, t)
    except FuzzError:
        return None, None
    return anchor, fire


def is_prep(d):
    return d["kind"] == "note" and d.get("final") == 0


def after_approve(core, d, t):
    """What approving this draft does, in a line the card can show before you tap."""
    from . import timeres
    if d["kind"] != "note":
        return f"Fuzz sends it in {_where(d['kind'])}."
    if not is_prep(d):
        return "Filed, and the task is done."
    anchor, fire = _comes_back(core, t)
    if fire is None or fire <= core.now():
        return "Filed. The task comes back to you now for the next step."
    return f"Filed. Back for the next step: {timeres.label(core, anchor)}."


def approve(core, card):
    d = _draft(core, card)
    t = tasks.require(core, d["task_id"])
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], status="approved", approved_by="human", approved_at=core.now_iso())
        if is_prep(d):
            _file_prep(core, ch, card, d, t)
        else:
            if d["kind"] == "note":
                tasks.move(core, ch, t, "done", card=card, question=None)
                _close_covered(core, ch, d, None)
                log = "You approved this."
            else:
                tasks.move(core, ch, t, "sending", card=card, question=None)
                log = f"You approved the draft. Fuzz will send it in {_where(d['kind'])}."
            cards.mark_answered(core, ch, card, "approve")
            events.emit(core, "task.approved", task_id=t["id"], changes=ch,
                        data={"draft_id": d["id"], "kind": d["kind"]}, log=("status", log))
            cards.sync(core, t["id"])
    if d["kind"] == "note":   # an approved note is kept in the task's output folder too
        from . import outputs
        body = core.one("SELECT body FROM drafts WHERE id=?", (d["id"],))["body"]
        outputs.save_markdown(core, t["id"], outputs.markdown_name(core, t["id"], "Note"), body, actor="human")


def _file_prep(core, ch, card, d, t):
    """The note is filed; the task waits for the step it prepares, or comes back now if that is already due."""
    from . import timeres
    anchor, fire = _comes_back(core, t)
    line = after_approve(core, d, t)
    if fire is None or fire <= core.now():
        tasks.move(core, ch, t, "triage", card=card, question=None, add_tags=("returning",),
                   order_key=tasks.next_order(core), reason="You filed the prep. The real step is next.")
    else:
        tasks.move(core, ch, t, "scheduled", card=card, question=None, schedule_anchor=anchor,
                   schedule_fire_at=iso(fire))
    cards.mark_answered(core, ch, card, "approve")
    events.emit(core, "task.approved", task_id=t["id"], changes=ch,
                data={"draft_id": d["id"], "kind": d["kind"], "final": False, "anchor": anchor},
                log=("status", "You approved the prep. " + line))
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
        if d["kind"].startswith("nudge"):   # nudged: ask again in a few days if there's still no reply
            tasks.move(core, ch, t, "waiting", schedule_anchor=None, schedule_fire_at=tasks.default_check_back(core))
        else:
            tasks.move(core, ch, t, "done")
            _close_covered(core, ch, d, None)   # one reply answered them all
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
        # a group reply goes back as the group: claimed together again, for one new draft
        covered = [c for c in (tasks.get(core, i) for i in d.get("covers") or []) if c and c["state"] == "review"]
        together = ("together",) if covered else ()
        tasks.move(core, ch, t, "queued", card=card, notes=notes, question=None, attempts=0, add_tags=together)
        for c in covered:
            tasks.move(core, ch, c, "queued", question=None, attempts=0, add_tags=together)
        cards.mark_answered(core, ch, card, "send_back", note)
        events.emit(core, "task.sent_back", task_id=t["id"], changes=ch, data={"draft_id": d["id"]},
                    log=("guidance", f"You sent the draft back: {note.strip()}"))


def done_myself(core, card):
    """You're sending it yourself: the draft is set aside unsent and the task is done."""
    d = _draft(core, card)
    t = tasks.require(core, d["task_id"])
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], status="withdrawn")
        tasks.move(core, ch, t, "done", card=card, question=None)
        _close_covered(core, ch, d, None)
        cards.mark_answered(core, ch, card, "done")
        events.emit(core, "task.done", task_id=t["id"], changes=ch, data={"draft_id": d["id"], "by": "you"},
                    log=("status", "You marked this done. You're sending it yourself, so Fuzz didn't."))
        cards.sync(core, t["id"])


def not_yet(core, card):
    d = _draft(core, card)
    t = tasks.require(core, d["task_id"])
    with core.tx("human"):
        ch = events.Changes()
        ch.draft(d["id"], status="withdrawn")
        tasks.move(core, ch, t, "waiting", card=card, question=None, schedule_anchor=None,
                   schedule_fire_at=tasks.default_check_back(core))
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


def _plain(resource):
    from .onboarding import _plain as plain   # "claude.ai Gmail" is Gmail
    return plain(resource or "")


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
                        log=("status", f"You said no to {_plain(p.get('resource'))}."))
            return
        gid = core.new_id("grants")
        ch.grant(gid, scope=p["scope"], resource=p["resource"], kind="always" if option == "always_allow" else "once",
                 task_id=t["id"])
        ch.task(t["id"], variant_tags=tags)
        cards.mark_answered(core, ch, card, option)
        added = []
        if option == "always_allow" and p.get("scope") == "connector":
            # a grant only helps if the run can see the tools: put them in read.tools, as set up would
            from . import connectors
            added = [x for _, _, got in connectors.allow_for_grant(core, p["resource"]) for x in got]
        events.emit(core, "permission.granted", task_id=t["id"], changes=ch, data=dict(p, kind=option, tools=added),
                    log=("status", ("You always allow " if option == "always_allow" else "You allowed ") + _plain(p["resource"])
                         + "." + (f" Fuzz can now use {len(added)} of its lookup tools." if added else "")))
