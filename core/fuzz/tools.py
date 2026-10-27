"""The AI roles' tools as plain functions. mcp_server.py exposes them; tests and scripted runs call them too.

Kept small on purpose (past about fifteen tools a model starts choosing the wrong one), and kept
quiet: writes return counts and ids, never an echo; reads return short pages.
The executor and extractor have no send, post or delete tool. The sender has none of Fuzz's either:
it sends an approved draft with its client's own connector, then says so with mark_sent.
"""

import json
from contextlib import contextmanager

from . import drafts, events, matching, scheduler, signals, tasks, timeres
from .db import FuzzError

LOG_ON_GET = 8


@contextmanager
def _lease(core, task_id):
    """Check the caller holds the task, and renew the lease with whatever the tool writes."""
    t = scheduler.require_lease(core, task_id)
    core.renew = (t["id"], scheduler.lease_until(core))
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
            "tz": timeres.tz_name(core), "run_id": (core.run or {}).get("id")}


# ---------------------------------------------------------------- executor

def claim_next_task(core, task_id=None):
    t, why = scheduler.claim_next(core, task_id)
    if t is None:
        return {"task": None, "why": why}
    return {"task": _task_brief(core, t), "lease_until": t["lease_until"]}


def _task_brief(core, t):
    srcs = core.all("SELECT id, role, title, withdrawn, path, mime, size FROM sources WHERE task_id=? AND user_id=? "
                    "AND role!='ignored'", (t["id"], core.user_id))
    b = core.config["budget"]
    return {"id": t["id"], "title": t["title"], "ask": t["ask"], "state": t["state"], "due": t["due"],
            "created_at": t["created_at"], "gathering": scheduler.gathering(t),
            "notes": t["notes"], "context_md": t["context_md"], "summary": t["summary"], "question": t["question"],
            "steps_used": t["steps_used"], "max_steps": b["max_steps"],
            "sources": [_source_ref(s) for s in srcs if not s["withdrawn"]],
            "schedule_hints": t.get("schedule_hints") or [],
            "log": [{"kind": x["kind"], "text": x["text"]} for x in events.task_log(core, t["id"], LOG_ON_GET)]}


def _source_ref(s):
    ref = {"id": s["id"], "role": s["role"], "title": s["title"]}
    if s.get("path"):   # a file the person attached: open it with your own file tools
        ref.update(path=s["path"], mime=s["mime"], size=s["size"])
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
    if s.get("path"):
        return dict(_source_ref(s), note="A file the person attached. Open it at path with your own file tools. "
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


def save_draft(core, task_id, kind, target, body, final=True):
    with _lease(core, task_id) as t:
        scheduler.refuse_while_gathering(t)
        did = drafts.save_draft(core, task_id, kind, target, body, final)
    return {"draft_id": did, "state": "review"}


def hand_back(core, task_id, question=None, options=None, result=False):
    with _lease(core, task_id) as t:
        scheduler.refuse_while_gathering(t)
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


def suggest_schedule(core, task_id, anchor, reason):
    with _lease(core, task_id):
        return {"label": scheduler.suggest_schedule(core, task_id, anchor, reason)}


def update_brief(core, task_id, context_md=None, question=None, effort_mins=None, energy=None, due=None,
                 title=None, ask=None, summary=None):
    updated = []
    if title is not None or ask is not None:
        with _lease(core, task_id):   # its own command, so Undo reverses the rename and nothing else
            updated += tasks.rename(core, task_id, title, ask)
    if any(v is not None for v in (context_md, summary, question, effort_mins, energy, due)) or (title is None and ask is None):
        with _lease(core, task_id):
            updated += tasks.update_brief(core, task_id, context_md, question, effort_mins, energy, due, summary)
    return {"updated": sorted(updated)}


def finish_gathering(core, task_id):
    scheduler.require_lease(core, task_id)
    scheduler.finish_gathering(core, task_id)
    return {"state": "triage"}


def release(core, task_id):
    scheduler.require_lease(core, task_id)
    scheduler.release(core, task_id)
    return {"state": "queued"}


# ---------------------------------------------------------------- sender

def claim_next_send(core):
    t, d = scheduler.claim_next_send(core)
    if t is None:
        return {"send": None, "why": d}
    return {"send": {"task_id": t["id"], "draft_id": d["id"], "kind": d["kind"], "target": d["target"],
                     "body": d["body"], "title": t["title"]}, "lease_until": t["lease_until"]}


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


EXECUTOR = ("whoami", "claim_next_task", "get_task", "read_source", "log_step", "save_notes", "save_draft",
            "hand_back", "create_task", "request_permission", "suggest_schedule", "update_brief", "finish_gathering",
            "release")
EXTRACTOR = ("whoami", "get_cursors", "submit_signals", "get_pending_judgments", "submit_verdicts")
SENDER = ("whoami", "claim_next_send", "mark_sent", "send_failed")
ROLES = {"executor": EXECUTOR, "extractor": EXTRACTOR, "sender": SENDER}
