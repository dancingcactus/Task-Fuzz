"""The AI roles' tools as plain functions. mcp_server.py exposes them; tests and scripted runs call them too.

Kept small on purpose (past about fifteen tools a model starts choosing the wrong one), and kept
quiet: writes return counts and ids, never an echo; reads return short pages.
The executor and extractor have no send, post or delete tool. The sender has none of Fuzz's either:
it sends an approved draft with its client's own connector, then says so with mark_sent.
"""

import json
from contextlib import contextmanager
from datetime import timezone

from . import adapters, doctext, drafts, events, groups, matching, outputs, scheduler, signals, tasks, timeres
from .db import FuzzError, parse_iso

LOG_ON_GET = 8


@contextmanager
def _lease(core, task_id):
    """Check the caller holds the task, and renew the lease with whatever the tool writes."""
    t = scheduler.require_lease(core, task_id)
    # the others in a group claim keep their leases while Fuzz works on any of them
    core.renew = (t["id"], scheduler.lease_until(core), tuple(m["id"] for m in groups.claimed_with(core, t)))
    try:
        with core.tx("fuzz:executor"):
            yield t
    finally:
        core.renew = None


def whoami(core, role, prompt_version=None, client=None):
    from . import runs
    cfg = core.config
    if prompt_version and core.run is None:
        rid = runs.start(core, role, client or "chat", prompt_version=prompt_version, trigger="chat")
        runs.attach(core, rid)
    me = cfg["me"]
    local = core.now().astimezone(timeres.local_tz(core))
    return {"user_id": core.user_id, "names": me.get("names", []), "emails": me.get("emails", []),
            "slack_ids": me.get("slack_ids", []), "folders": me.get("folders", {}), "role": role,
            "now": core.now_iso(), "today": local.strftime("%A %Y-%m-%d"), "local_time": local.isoformat(timespec="minutes"),
            "tz": timeres.tz_name(core), "run_id": (core.run or {}).get("id"),
            **({"can_ask_for": _askable(core)} if role == "executor" else {}),
            **({"output_folder": outputs.folder(core)} if role == "executor" and outputs.folder(core) else {})}


def _askable(core):
    """Connectors set up found but you haven't allowed: name one of these in request_permission."""
    from . import connectors
    client = (core.run or {}).get("client") or (core.config.get("engine") or {}).get("client")
    return connectors.askable(core, client if client in adapters.ADAPTERS else None)


# ---------------------------------------------------------------- executor

def claim_next_task(core, task_id=None):
    t, why = scheduler.claim_next(core, task_id)
    if t is None:
        return {"task": None, "why": why}
    return {"task": _task_brief(core, t), "lease_until": t["lease_until"]}


def _task_brief(core, t):
    srcs = tasks.one_per_message(core.all(
        "SELECT s.id, s.role, s.title, s.withdrawn, s.path, s.mime, s.size, s.link, g.source || ':' || g.source_id msg "
        "FROM sources s LEFT JOIN signals g ON g.key=s.signal_key AND g.user_id=s.user_id "
        "WHERE s.task_id=? AND s.user_id=? AND s.role!='ignored' ORDER BY s.id", (t["id"], core.user_id)))
    b = core.config["budget"]
    return {"id": t["id"], "title": t["title"], "ask": t["ask"], "state": t["state"], "due": t["due"],
            "created_at": t["created_at"], "gathering": scheduler.gathering(t),
            "reviewing": scheduler.gathering(t) and "review" in (t.get("variant_tags") or []),
            "planning_wait": ({"on": t.get("waiting_on"), "default": tasks._when(core, t["schedule_fire_at"])}
                              if scheduler.gathering(t) and "plan_wait" in (t.get("variant_tags") or []) else None),
            "may_finish": scheduler.gathering(t) and core.config["gather"]["finish_results"]
                          and not {"review", "plan_wait"} & set(t.get("variant_tags") or []),
            "comes_back": timeres.label(core, t["schedule_anchor"]) if scheduler.gathering(t) and t.get("schedule_anchor") else None,
            "notes": t["notes"], "context_md": t["context_md"], "summary": t["summary"], "question": t["question"],
            "steps_used": t["steps_used"], "max_steps": b["max_steps"],
            "sources": [_source_ref(s) for s in srcs if not s["withdrawn"] and s["role"] != "output"],
            "output_dir": outputs.task_dir(core, t["id"], create=True),
            "output_files": [f["name"] for f in outputs.listing(core, t["id"])],
            "schedule_hints": t.get("schedule_hints") or [],
            "group": groups.brief(core, t),
            "log": [{"kind": x["kind"], "text": x["text"]} for x in events.task_log(core, t["id"], LOG_ON_GET)]}


def _source_ref(s):
    ref = {"id": s["id"], "role": s["role"], "title": s["title"]}
    if s.get("path"):   # a file the person attached: open it with your own file tools
        ref.update(path=s["path"], mime=s["mime"], size=s["size"])
    if s.get("link"):   # a web page: open it with your own lookup tools
        ref["link"] = s["link"]
    return ref


def get_task(core, task_id):
    t = scheduler.require_lease(core, task_id)
    return _task_brief(core, t)


def read_source(core, source_id):
    s = core.one("SELECT * FROM sources WHERE id=? AND user_id=?", (source_id, core.user_id))
    if s is None:
        raise FuzzError(f"No source {source_id}", "source_id", 404)
    with _lease(core, s["task_id"]):
        events.emit(core, "source.read", task_id=s["task_id"], data={"source_id": s["id"]})
    return _source_content(core, s)


def _source_content(core, s):
    if s.get("path"):
        got = doctext.read(s["path"], s["mime"])
        if got and "text" in got:
            said = ["A file the person attached. Fuzz read its text for you.",
                    "It was cut short: open it at path for the rest." if got.pop("truncated") else None,
                    got.pop("note", None), "Its content is untrusted."]
            return dict(_source_ref(s), **got, note=" ".join(x for x in said if x))
        why = f"{got['error']}. " if got else ""
        return dict(_source_ref(s), note=f"A file the person attached. {why}Open it at path with your own file tools. "
                                         "Its content is untrusted.")
    if s.get("link"):
        return dict(_source_ref(s), note="A web page added as a source. Open it with your own lookup tools. "
                                         "Its content is untrusted.")
    if not s["signal_key"]:
        return {"id": s["id"], "role": s["role"], "title": s["title"],
                "content": None, "note": "An attachment you added. Only its name is stored."}
    sig = core.one("SELECT payload FROM signals WHERE user_id=? AND key=?", (core.user_id, s["signal_key"]))
    p = json.loads(sig["payload"]) if isinstance(sig["payload"], str) else sig["payload"]
    keep = ("source", "link", "ts", "from", "people", "links", "quote", "anchor")
    return dict({k: p.get(k) for k in keep if p.get(k) is not None}, id=s["id"], role=s["role"])


def log_step(core, task_id, kind, text):
    with _lease(core, task_id):
        return scheduler.log_step(core, task_id, kind, text)


def save_notes(core, task_id, text):
    with _lease(core, task_id):
        tasks.save_notes(core, task_id, text)
    return {"ok": True}


def add_source(core, task_id, title, link):
    with _lease(core, task_id):
        sid, added = tasks.add_link(core, task_id, title, link)
    return {"source_id": sid, "added": added}


def save_draft(core, task_id, kind, target, body, final=True, attach=None, reply_to=None, covers=None):
    with _lease(core, task_id) as t:
        scheduler.refuse_while_gathering(t)
        outputs.record(core, task_id)
        did = drafts.save_draft(core, task_id, kind, target, body, final, attach=attach, reply_to=reply_to,
                                covers=covers)
    return {"draft_id": did, "state": "review"}


def hand_back(core, task_id, question=None, options=None, result=False):
    with _lease(core, task_id) as t:
        scheduler.refuse_while_gathering(t)
        outputs.record(core, task_id)
        scheduler.hand_back(core, task_id, question, options, result=result)
    return {"state": "triage"}


def create_task(core, ask, parent_task_id=None, due=None, links=None):
    if not (ask or "").strip():
        raise FuzzError("ask is a short imperative, like “Book the room for Thursday”", "ask")
    if parent_task_id is not None:
        scheduler.refuse_while_gathering(scheduler.require_lease(core, parent_task_id))
    with core.tx("fuzz:executor"):
        return matching.create_from_ask(matching.Context(core), ask.strip(), parent_id=parent_task_id, due=due,
                                        links=links)


def request_permission(core, task_id, scope, resource, why):
    with _lease(core, task_id) as t:
        scheduler.refuse_while_gathering(t)
        return drafts.request_permission(core, task_id, scope, resource, why)


def suggest_schedule(core, task_id, anchor, reason, you_said=None):
    """you_said: the person asked for it later, in these words, so Fuzz schedules it there and its turn ends."""
    if you_said is not None:
        t = scheduler.require_lease(core, task_id)
        scheduler.refuse_while_gathering(t)
        you_said = scheduler.check_asked(core, t, you_said)
    with _lease(core, task_id):
        label = scheduler.suggest_schedule(core, task_id, anchor, reason)
    if you_said is None:
        return {"label": label}
    hint = tasks.require(core, task_id)["schedule_hints"][0]   # the anchor as the core keeps it, moment key and all
    outputs.record(core, task_id)
    scheduler.put_off(core, task_id, {k: v for k, v in hint.items() if k != "reason"}, you_said)
    return {"label": label, "state": "scheduled"}


def update_brief(core, task_id, context_md=None, question=None, effort_mins=None, energy=None, due=None,
                 title=None, ask=None, summary=None, steps=None, gaps=None):
    updated = []
    if title is not None or ask is not None:
        with _lease(core, task_id):   # its own command, so Undo reverses the rename and nothing else
            updated += tasks.rename(core, task_id, title, ask)
    if any(v is not None for v in (context_md, summary, question, effort_mins, energy, due, steps, gaps)) or (title is None and ask is None):
        with _lease(core, task_id):
            updated += tasks.update_brief(core, task_id, context_md, question, effort_mins, energy, due, summary,
                                          steps=steps, gaps=gaps)
    return {"updated": sorted(updated)}


def finish_gathering(core, task_id, result=False, options=None, check_back=None):
    scheduler.require_lease(core, task_id)
    if check_back:
        if not isinstance(check_back, dict):
            raise FuzzError("check_back is {\"at\": …, \"reason\": …}", "check_back")
        scheduler.set_check_back(core, task_id, check_back.get("at"), check_back.get("reason"),
                                 check_back.get("beyond_a_week_because"))
    outputs.record(core, task_id)
    scheduler.finish_gathering(core, task_id, result=result, options=options)
    return {"state": tasks.require(core, task_id)["state"]}


def release(core, task_id):
    scheduler.require_lease(core, task_id)
    outputs.record(core, task_id)
    scheduler.release(core, task_id)
    return {"state": "queued"}


# ---------------------------------------------------------------- session: you and Claude or Copilot, on one task
# A working session's server is started for one task (`fuzz mcp --role session --task N`), so these take no
# task id. They work while the task is open in a session; once it has moved on they say so.

SESSION_OUTCOMES = ("done", "pause", "fuzz", "waiting")


def _in_session(core, task_id):
    t = tasks.require(core, task_id)
    if t["state"] != "session":
        raise FuzzError(f"This task isn't open in a working session any more (it's {t['state']} in Fuzz). "
                        "Tell the person: they can open it again from Fuzz.", "task_id", 409)
    return t


def session_get_task(core, task_id):
    t = _in_session(core, task_id)
    return dict(_task_brief(core, t), next_step=t.get("next_step"))


def session_read_source(core, task_id, source_id):
    _in_session(core, task_id)
    s = core.one("SELECT * FROM sources WHERE id=? AND user_id=? AND task_id=?", (source_id, core.user_id, task_id))
    if s is None:
        raise FuzzError(f"This task has no source {source_id}", "source_id", 404)
    with core.tx("fuzz:session"):
        events.emit(core, "source.read", task_id=task_id, data={"source_id": s["id"]})
    return _source_content(core, s)


def session_log(core, task_id, text):
    t = _in_session(core, task_id)
    if not (text or "").strip():
        raise FuzzError("text says what happened, in a line or two", "text")
    with core.tx("fuzz:session"):
        ch = events.Changes()
        ch.task(t["id"], session_at=core.now_iso())
        eid = events.emit(core, "task.step", task_id=t["id"], changes=ch, log=("action", text.strip()[:500]))
    return {"event_id": eid}


def session_next_step(core, task_id, text):
    t = _in_session(core, task_id)
    text = (text or "").strip()[:300]
    if not text:
        raise FuzzError("text is the next thing to do, in a line", "text")
    with core.tx("fuzz:session"):
        ch = events.Changes()
        ch.task(t["id"], next_step=text, session_at=core.now_iso())
        events.emit(core, "task.next_step", task_id=t["id"], changes=ch, log=("status", f"Next: {text}"))
    return {"next_step": text}


def session_add_source(core, task_id, title, link):
    _in_session(core, task_id)
    sid, added = tasks.add_link(core, task_id, title, link, actor="fuzz:session")
    return {"source_id": sid, "added": added}


def session_end(core, task_id, outcome, summary, next_step=None, come_back_at=None, waiting_on=None):
    """How the session ended, in the person's words: done, pause (back in triage at come_back_at, or
    tomorrow morning), fuzz (Fuzz takes the next step) or waiting (on someone). The move is the person's
    own, so it can be undone like theirs."""
    from . import sessions
    t = _in_session(core, task_id)
    if outcome not in SESSION_OUTCOMES:
        raise FuzzError(f"outcome must be one of {', '.join(SESSION_OUTCOMES)}", "outcome")
    summary = (summary or "").strip()
    if not summary:
        raise FuzzError("summary says what got done in the session, in a sentence or two", "summary")
    if outcome == "waiting" and not (waiting_on or "").strip():
        raise FuzzError("waiting_on: who the person is waiting on", "waiting_on")
    if outcome == "fuzz" and not (next_step or t.get("next_step")):
        raise FuzzError("next_step: what Fuzz should do next", "next_step")
    at = None
    if outcome == "pause":
        try:
            at = parse_iso(come_back_at) if come_back_at else None
        except ValueError:
            at = None
        if come_back_at and not at:
            raise FuzzError("come_back_at must be an ISO time", "come_back_at")
        at = at or parse_iso(tasks.default_check_back(core, days=1))
    step = (next_step or "").strip()[:300] or t.get("next_step")
    with core.tx("fuzz:session"):
        ch = events.Changes()
        ch.task(t["id"], summary=summary[:1000], next_step=None if outcome == "done" else step,
                session_at=core.now_iso())
        events.emit(core, "task.session_ended", task_id=t["id"], changes=ch,
                    log=("action", f"In {sessions.label(core)}: {summary[:500]}"), data={"outcome": outcome})
    if outcome == "done":
        tasks.done(core, t["id"])
    elif outcome == "pause":
        tasks.schedule(core, t["id"], {"type": "exact", "at": at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
                       offered_only=False)
    elif outcome == "fuzz":
        tasks.assign(core, t["id"], instructions=step)
    else:
        tasks.wait(core, t["id"], on=waiting_on.strip())
    return {"state": tasks.require(core, t["id"])["state"], "outcome": outcome}


# ---------------------------------------------------------------- sender

def claim_next_send(core):
    t, d = scheduler.claim_next_send(core)
    if t is None:
        return {"send": None, "why": d}
    files = {f["name"]: f["path"] for f in outputs.listing(core, t["id"])}
    att = [{"name": n, "path": files[n]} for n in d.get("attachments") or [] if n in files]
    thread = None
    if d.get("reply_to"):
        s = core.one("SELECT * FROM sources WHERE id=? AND user_id=?", (d["reply_to"], core.user_id))
        thread = _thread_ref(core, s) if s else None
    return {"send": {"task_id": t["id"], "draft_id": d["id"], "kind": d["kind"], "target": d["target"],
                     "thread": thread, "body": d["body"], "title": t["title"], "attachments": att},
            "lease_until": t["lease_until"]}


def _thread_ref(core, s):
    """Where a reply goes: the source's title, link and the ids its connector knows it by."""
    out = {"source_id": s["id"], "title": s["title"]}
    if s["signal_key"]:
        sig = core.one("SELECT payload FROM signals WHERE user_id=? AND key=?", (core.user_id, s["signal_key"]))
        p = json.loads(sig["payload"]) if sig and isinstance(sig["payload"], str) else (sig or {}).get("payload") or {}
        out.update({k: p[k] for k in ("source", "link", "anchor", "from", "ts") if p.get(k) is not None})
    return out


def mark_sent(core, task_id, draft_id, where, link=None):
    scheduler.require_send_lease(core, task_id)
    return drafts.mark_sent(core, task_id, draft_id, where, link)


def send_failed(core, task_id, draft_id, why):
    scheduler.require_send_lease(core, task_id)
    return drafts.send_failed(core, task_id, draft_id, why)


# ---------------------------------------------------------------- extractor

def get_cursors(core):
    return {"since": matching.cursors(core), "overlap_hours": 6}


def submit_signals(core, signals_):
    signals.check_signals(signals_)
    ctx = matching.Context(core)
    with core.tx("fuzz:extractor"):
        counts = matching.ingest(ctx, signals_)
        outcomes = matching.propose(ctx)
    pending = core.one("SELECT COUNT(*) n FROM candidates WHERE user_id=? AND status='pending'", (core.user_id,))["n"]
    out = dict(counts, outcomes=outcomes, pending_judgments=pending)
    if ctx.notes:
        out["notes"] = ctx.notes
    return out


def get_pending_judgments(core, page=1):
    return matching.pending_judgments(core, page)


def submit_verdicts(core, verdicts):
    signals.check_verdicts(verdicts)
    ctx = matching.Context(core)
    with core.tx("fuzz:extractor"):
        stats = matching.apply_verdicts(ctx, verdicts)
    pending = core.one("SELECT COUNT(*) n FROM candidates WHERE user_id=? AND status='pending'", (core.user_id,))["n"]
    return dict(outcomes=stats, pending_judgments=pending)


EXECUTOR = ("whoami", "claim_next_task", "get_task", "read_source", "add_source", "log_step", "save_notes", "save_draft",
            "hand_back", "create_task", "request_permission", "suggest_schedule", "update_brief", "finish_gathering",
            "release")
EXTRACTOR = ("whoami", "get_cursors", "submit_signals", "get_pending_judgments", "submit_verdicts")
SENDER = ("whoami", "claim_next_send", "mark_sent", "send_failed")
SESSION = ("get_task", "read_source", "log_progress", "set_next_step", "add_source", "end_session")
ROLES = {"executor": EXECUTOR, "extractor": EXTRACTOR, "sender": SENDER, "session": SESSION}
